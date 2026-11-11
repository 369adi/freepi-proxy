#!/usr/bin/env node
// free-pi proxy - OpenAI-compatible local gateway with multi-account rotation.
//
// One local endpoint, many free-pi accounts: the rotator measures each account's
// live budget via GET /me, keeps using the active one until it gets low, then
// switches to another existing account. A brand-new GitHub account is only
// needed when *every* known account is out of budget and no daily refill is
// imminent - see tools/lib/policy.mjs for that decision.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindRequestLifecycle } from './tools/lib/request-lifecycle.mjs';
import { relayWithStopRecovery } from './tools/lib/stream-recovery.mjs';
import { compareRoutingAccounts } from './tools/lib/routing-order.mjs';
import { isHourlyCeiling, hourlyReset } from './tools/lib/upstream-errors.mjs';
import { record as recordAlert } from './tools/alert.mjs';
import { SessionRouter } from './tools/lib/session-router.mjs';
import {upstreamSessionId} from './tools/lib/upstream-session.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { waitForSponsorDisplay } from './tools/lib/ad-recovery.mjs';
import { resolveBindConfig, extractRequestApiKey, verifyApiKey } from './tools/lib/proxy-auth.mjs';
const BIND_CONFIG = resolveBindConfig(process.env);
const STATE_DIR = process.env.FREEPI_STATE_DIR || (process.env.FREEPI_ACCOUNTS_PATH ? path.dirname(STORE_PATH) : path.join(os.homedir(), '.free-pi', 'proxy'));
const alertLastSent=new Map();
function failureAlert(kind,account,message) {
  const key=kind+':'+(account?.id||'-'), now=Date.now();
  if(now-(alertLastSent.get(key)||0)<60000)return;
  alertLastSent.set(key,now);
  recordAlert('error','freepi-proxy',message,{kind,accountId:account?.id||null});
}
const sponsorEvents=new EventEmitter();
sponsorEvents.setMaxListeners(0);
const accountTurns = new Map();
const TURN_TTL_MS = 10 * 60 * 1000;
function rememberAccountTurn(accountId, turnId) {
  if (accountId && turnId) accountTurns.set(accountId, { turnId, at: Date.now() });
}
function activeAccountTurn(accountId) {
  const entry = accountTurns.get(accountId);
  if (!entry) return null;
  if (Date.now() - entry.at > TURN_TTL_MS) {
    accountTurns.delete(accountId);
    return null;
  }
  return entry.turnId;
}
const workerBindingsFile=path.join(STATE_DIR,'worker-account-bindings.json');
const IDLE_BINDING_TTL_MS = Number(process.env.FREEPI_BINDING_TTL_MS || 30 * 60 * 1000);
const sessionRouter = new SessionRouter(Date.now,90000,{
  load:()=>{try{const value=JSON.parse(fsSync.readFileSync(workerBindingsFile,'utf8').replace(/^\uFEFF/,''));if(!Array.isArray(value)||value.some(row=>!Array.isArray(row)||typeof row[0]!=='string'||typeof row[1]?.accountId!=='string'||typeof row[1]?.sessionId!=='string'))throw Error('Invalid exclusive subagent account bindings');return value;}catch(error){if(error.code==='ENOENT')return [];throw error;}},
  save:bindings=>{fsSync.mkdirSync(path.dirname(workerBindingsFile),{recursive:true});const tmp=workerBindingsFile+'.tmp';fsSync.writeFileSync(tmp,JSON.stringify(bindings,null,2));fsSync.renameSync(tmp,workerBindingsFile);},
},IDLE_BINDING_TTL_MS);
import { createSponsorPanel } from './tools/lib/sponsor-panel.mjs';

import { loadStore, saveStore, findAccount, markExhausted, markInvalid, isMeteredDespiteFreeTier, STORE_PATH } from './tools/lib/store.mjs';
import { decide, describe, stateOf, sortForPick, USABLE, STATE } from './tools/lib/policy.mjs';
import { ensureStore, refreshAccount, refreshAll } from './tools/lib/accounts.mjs';
import { getCatalog, confirmAdDirect, submitUserConsent, resetUpstreamSession } from './tools/lib/freepi-api.mjs';
import {getClientVersion,requiredVersion,upgradeClient,runtimeStatus} from './tools/lib/client-runtime.mjs';
import { budgetSummary, modelMultiplier, burnRatePerHour, runwayHours, CREDITS_PER_HOUR, creditsToHours } from './tools/lib/budget.mjs';

const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });

const FREEPI_BASE    = 'https://api.freepi.ai';
const HOST           = BIND_CONFIG.host;
const PORT           = BIND_CONFIG.port;
const AD_INTERVAL_MS = 30_000;
const USAGE_POLL_MS  = Number(process.env.FREEPI_USAGE_POLL_MS ?? 60_000);
const CREDENTIALS_PATH = path.join(os.homedir(), '.free-pi', 'agent', 'credentials.json');
const sessionIdFor=account=>upstreamSessionId(account,STORE_PATH);

// free-pi allows exactly ONE in-flight request per account ("one request at a
// time"). Parallel clients - a harness running several subagents - would all but
// one get 429. Two layers fix that:
//   1. one lane per account, so N accounts serve N concurrent requests,
//   2. a FIFO queue, so extra requests wait instead of failing.
const MAX_QUEUE = Number(process.env.FREEPI_MAX_QUEUE ?? 64);

// Sponsor windows are opt-in: the default is headless (never open a browser
// window). The headless sponsor daemon (tools/headless-sponsor.mjs) confirms
// every impression over HTTP instead; FREEPI_AUTO_SPONSOR=1 re-enables the
// legacy auto-spawn behaviour for setups that want real windows.
const AUTO_SPONSOR = process.env.FREEPI_AUTO_SPONSOR === '1';

/**
 * Queue a request that found no free account lane. The callback is retried
 * every time a lane frees up. Unlike enqueue() this does not reserve an
 * upstream slot - lanes are the concurrency limit now.
 */
const claimWaiters = [];

function enqueueClaim(attemptClaim, extra = {}) {
  // Cancelled waiters must not consume queue slots: pruning here keeps a long
  // outage from reporting 64 waiting requests when nobody is waiting anymore.
  for (let i = claimWaiters.length - 1; i >= 0; i--) {
    if (claimWaiters[i].cancelled) claimWaiters.splice(i, 1);
  }
  if (claimWaiters.length >= MAX_QUEUE) return { accepted: false };
  // extra.pinnedId marks a waiter that wants one specific account lane: it is
  // only handed out once that lane is free, never a random free lane.
  const waiter = { attemptClaim, cancelled: false, ...extra };
  claimWaiters.push(waiter);
  const position = claimWaiters.indexOf(waiter) + 1;
  // A waiter that only wants one specific account (pinned) must not be STARVED
  // behind pinned waiters for a lane it cannot use: drop it into its own group
  // ahead of them. Unpinned waiters keep plain FIFO among themselves.
  if (!extra.pinnedId) {
    const at = claimWaiters.findIndex(w => w.pinnedId);
    if (at !== -1) { claimWaiters.pop(); claimWaiters.splice(at, 0, waiter); }
  }
  if (position > 0) console.log('[queue] waiting for a free account lane, position ' + position);
  return {
    accepted: true,
    position,
    cancel: () => {
      waiter.cancelled = true;
      // Drop it right away - a stuck lane must not keep a dead waiter counted.
      const at = claimWaiters.indexOf(waiter);
      if (at !== -1) claimWaiters.splice(at, 1);
    },
  };
}

/** Hand free lanes to waiting requests. Called whenever a lane is released. */
function pumpClaims() {
  for (let i = 0; i < claimWaiters.length; i++) {
    const waiter = claimWaiters[i];
    if (waiter.cancelled) { claimWaiters.splice(i, 1); i--; continue; }
    let claimed = false;
    if (waiter.pinnedId) {
      // A pinned waiter only competes for its own lane. Handing it a different
      // one would silently break the x-freepi-account guarantee.
      if (laneBusy.has(waiter.pinnedId)) continue;
    } else if (!usableAccounts(waiter.model).some(a => !laneBusy.has(a.id) && sessionRouter.allowed(a.id, waiter.session, waiter.worker))) continue;
    claimWaiters.splice(i, 1);
    try { claimed = waiter.attemptClaim() === true; } catch (e) { console.error('[queue] ' + e.message); }
    // attemptClaim can fail even though a lane looked free: a parallel claimFor
    // or another waiter took it in between. Dropping the waiter here used to
    // lose it for good - it was gone from the queue and hung until the client
    // timed out. Put it back (at the front, it was first) so the next release
    // pumps it again.
    if (!claimed && !waiter.cancelled) {
      claimWaiters.splice(i, 0, waiter);
      // Back at the same index: never re-run an attempt that keeps failing in
      // this pass, the next release() starts a fresh one.
      continue;
    }
    i = -1; // re-check from the start: the claim may have taken the last lane
  }
}

function queueDepth() {
  return { inFlight: laneBusy.size, waiting: claimWaiters.length, lanes: laneCount() };
}

// free-pi publishes no modality metadata at all: /client-version lists ids and
// names only, and /v1/models does not exist upstream (it is served by this
// proxy). The list below was measured with tools/probe-vision-strong.mjs, which
// sends a 64x64 image with a blue left half and a yellow right half and requires
// the answer to name both colours. Guessing from model names gets this wrong in
// both directions - it claimed vision for gpt-6-luna and muse-spark (text-only)
// and denied it for deepseek-v4.1-flash (which sees fine).
const VISION_MODELS = new Set([
  'particle',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'deepseek-v4-flash',
  'deepseek-v4.1-flash-abliterated',
  'gemma-4-uncensored',
  'gpt-6.1-terra',
  'gpt-6.1-terra-flex',
  'qwen3.5-35b-darkbloom',
]);

/** Models that only take text. Unknown ids stay conservative. */
function supportsVision(id) {
  return VISION_MODELS.has(String(id || ''));
}

/**
 * Every model id free-pi advertises, filled once discovery has run.
 *
 * Kept module-level because the completions handler has to validate the
 * requested id before it claims a lane, and that handler is defined outside
 * startServer(). Empty means "we never learned the catalog" (discovery failed,
 * e.g. offline start) - the check is skipped rather than rejecting valid work.
 */
const KNOWN_MODELS = new Set();
const DEFAULT_FREE_UNLIMITED_MODELS = ['particle', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'deepseek-v4-flash'];
const FREE_UNLIMITED_MODELS = new Set(DEFAULT_FREE_UNLIMITED_MODELS);
let catalog = [];
function updateFreeModels(models) {
  const discovered = [];
  for (const m of models || []) {
    if (m?.id && !m.unavailable && /free\s+unlimited/i.test(m.name || m.display_name || '')) {
      discovered.push(String(m.id));
    }
  }
  if (discovered.length) {
    FREE_UNLIMITED_MODELS.clear();
    for (const id of discovered) FREE_UNLIMITED_MODELS.add(id);
  } else if (!FREE_UNLIMITED_MODELS.size) {
    for (const id of DEFAULT_FREE_UNLIMITED_MODELS) FREE_UNLIMITED_MODELS.add(id);
  }
}
function modelAllowsAccount(account, model, now = Date.now()) {
  if(!account || !account.token || account.disabled || account.tokenBad)return false;
  return USABLE.has(stateOf(account, now, STORE?.settings || {})) ||
    FREE_UNLIMITED_MODELS.has(model) ||
    (!model && FREE_UNLIMITED_MODELS.size > 0);
}

/**
 * Closest catalog ids to a mistyped one, for a "did you mean" hint.
 *
 * Scores by shared hyphen/dot-separated segments (so "deepseek-v4-flsh" finds
 * "deepseek-v4-flash") and only returns ids that actually look related. When
 * nothing is close, an empty list beats a misleading guess - suggesting
 * "claude-sonnet-5.5" for "definitely-not-a-real-model-xyz" is noise.
 *
 * Results are deduped by their segment key so a single model cannot occupy two
 * suggestion slots under two spellings.
 */
function nearestModels(wanted, limit) {
  const target = String(wanted || '').toLowerCase();
  if (!target) return [];
  const parts = (s) => String(s).toLowerCase().split(/[-/._]+/).filter(Boolean);
  const want = parts(target);

  const scored = [];
  for (const id of KNOWN_MODELS) {
    const have = parts(id);
    let shared = 0;
    for (const p of have) if (want.includes(p) && p.length > 2) shared += 1;
    if (!shared) continue;                     // nothing in common, not a candidate
    // Prefer ids that share more segments and are closer in length.
    const distance = Math.abs(have.length - want.length) - shared;
    scored.push({ id, key: have.join('-'), distance, shared });
  }

  scored.sort((a, b) =>
    (b.shared - a.shared) ||
    (a.distance - b.distance) ||
    // Prefer the plain spelling over the "vendor/id" one when both survive.
    (a.id.length - b.id.length) ||
    a.id.localeCompare(b.id));

  const out = [];
  const seen = new Set();
  for (const s of scored) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s.id);
    if (out.length >= (limit || 3)) break;
  }
  return out;
}

/**
 * Rolling samples of the pool's remaining credits, used to estimate how fast
 * the hours disappear. Bounded so a long-running proxy does not grow.
 */
const BURN_SAMPLES = [];
const BURN_SAMPLE_LIMIT = 240;          // ~2 h at one sample every 30 s
const BURN_SAMPLE_MIN_GAP_MS = 30_000;

function recordBurnSample(creditsLeft) {
  if (typeof creditsLeft !== 'number' || !Number.isFinite(creditsLeft)) return;
  const now = Date.now();
  const last = BURN_SAMPLES[BURN_SAMPLES.length - 1];
  // Only advance when the pool actually lost credits: a refill (00:00 UTC)
  // makes the counter jump up, and mixing that in would cancel the burn out.
  if (last && (now - last.at < BURN_SAMPLE_MIN_GAP_MS || creditsLeft >= last.credits)) return;
  BURN_SAMPLES.push({ at: now, credits: creditsLeft });
  if (BURN_SAMPLES.length > BURN_SAMPLE_LIMIT) BURN_SAMPLES.splice(0, BURN_SAMPLES.length - BURN_SAMPLE_LIMIT);
}

/**
 * Hour budget for the whole account pool, at the multiplier of one model.
 * Without an explicit model, the cheapest one wins: that is what an unattended
 * agent harness burns, and it makes the number comparable over time.
 */
function budgetSnapshot(catalog, wantedModel) {
  const models = (Array.isArray(catalog) && catalog.length ? catalog : [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }])
    .filter(m => !m.unavailable);
  const priced = models.map(m => ({ id: m.id, name: m.name, multiplier: modelMultiplier(m) }));
  const cheapest = priced.slice().sort((a, b) => a.multiplier - b.multiplier)[0] || { id: 'unknown', multiplier: 1 };
  const selected = wantedModel
    ? (priced.find(m => m.id === String(wantedModel)) || { id: String(wantedModel), multiplier: modelMultiplier({ name: String(wantedModel) }) })
    : cheapest;
  const snapshot = usageSnapshot();
  const summary = budgetSummary(snapshot.accounts, selected.multiplier);
  // Burn rate is measured on base-rate credits, so it stays comparable when the
  // model (and with it the multiplier) changes mid-session.
  recordBurnSample(summary.creditsLeft);
  const burn = burnRatePerHour(BURN_SAMPLES);
  return {
    model: selected.id,
    modelMultiplier: summary.modelMultiplier,
    creditsPerHour: summary.creditsPerHour,
    cheapestModel: cheapest.id,
    accounts: summary.accounts,
    usableAccounts: summary.usableAccounts,
    totalAccounts: summary.totalAccounts,
    creditsLeft: summary.creditsLeft,
    creditsAllowance: summary.creditsAllowance,
    hoursLeft: summary.hoursLeft,
    hoursAllowance: summary.hoursAllowance,
    burnRatePerHour: burn,
    runwayHours: burn == null ? null : runwayHours(summary.creditsLeft / CREDITS_PER_HOUR, burn),
    burnSamples: BURN_SAMPLES.length,
    nextAction: snapshot.nextAction,
  };
}

let STORE = null;
let STORE_MTIME = 0;
let MANUAL_ACCOUNT_ID = null;
const MANUAL_SELECTION_PATH = path.join(path.dirname(STORE_PATH), 'selected-account.json');

async function syncManualSelection() {
  try {
    const selection = JSON.parse(await fs.readFile(MANUAL_SELECTION_PATH, 'utf8'));
    if (typeof selection.accountId !== 'string' || !selection.accountId.trim()) throw new Error('Invalid manual account selection');
    MANUAL_ACCOUNT_ID = selection.accountId;
  } catch (error) {
    if (error.code === 'ENOENT') MANUAL_ACCOUNT_ID = null;
    else throw error; // An unreadable manual selection must never silently switch to another account.
  }
}

/** mtime of the accounts file, or 0 when it does not exist yet. */
async function storeModTime() {
  try {
    const st = await fs.stat(STORE_PATH);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Accounts added while the proxy is running must show up without a restart.
 * Reload when the store file changed on disk; re-persist our own writes first
 * so live usage counters are not thrown away.
 * Serialised: several requests may call this at the same time.
 */
let SYNC_INFLIGHT = null;
const MEASURE_TRIED = new Map(); // account id -> last measurement attempt (ms)

function syncStore() {
  if (!SYNC_INFLIGHT) {
    SYNC_INFLIGHT = doSyncStore().finally(() => {
      SYNC_INFLIGHT = null;
    });
  }
  return SYNC_INFLIGHT;
}

async function doSyncStore() {
  await syncManualSelection();
  const { store } = await ensureStore();
  const mtime = await storeModTime();
  if (!STORE) {
    STORE = store;
    STORE_MTIME = mtime;
    return STORE;
  }
  if (mtime && mtime !== STORE_MTIME) {
    // Keep the freshest in-memory usage for accounts we already track. Both
    // sides stamp `usage.fetchedAt`; comparing any other field silently keeps
    // the stale disk copy and un-exhausts accounts we just marked.
    const live = new Map();
    for (const a of STORE.accounts || []) live.set(a.id, a);
    for (const a of store.accounts || []) {
      const old = live.get(a.id);
      if (!old || !old.usage) continue;
      const oldAt = Date.parse(old.usage.fetchedAt || '') || 0;
      const newAt = Date.parse(a.usage?.fetchedAt || '') || 0;
      if (oldAt > newAt) {
        a.usage = old.usage;
        a.day = old.day;
      }
      // A spend flag set in memory is never older than the disk copy.
      if (old.tokenBad && !a.tokenBad) {
        a.tokenBad = old.tokenBad;
        if (old.lastError) a.lastError = old.lastError;
      }
    }
    const fresh = (store.accounts || []).filter((a) => !live.has(a.id));
    STORE = store;
    STORE_MTIME = mtime;
    console.log(`[proxy] store reloaded: ${STORE.accounts.length} account(s)`);

    // Measure accounts we have never seen, so they become usable lanes at once
    // instead of sitting in the "stale" state until something else refreshes them.
    if (fresh.length) {
      await Promise.all(
        fresh.map((a) => refreshAccount(STORE, a, Date.now()).catch(() => null)),
      );
      await persist();
      const ready = fresh.filter((a) => a.usage && !a.tokenBad).length;
      console.log(`[proxy] measured ${ready}/${fresh.length} new account(s)`);
    }
  }

  // An account whose measurement is stale or missing cannot serve as a lane.
  // Fill that in lazily (max one attempt per account per minute) so N accounts -> N lanes.
  const now = Date.now();
  const staleMs = Number(STORE.settings?.staleMs) || 10 * 60 * 1000;
  const unmeasured = (STORE.accounts || []).filter((a) => {
    if (a.disabled || !a.token || a.tokenBad) return false;
    const fetchedAt = a.usage?.fetchedAt ? Date.parse(a.usage.fetchedAt) : 0;
    if (fetchedAt && now - fetchedAt <= staleMs) return false;
    return now - (MEASURE_TRIED.get(a.id) || 0) > 60000;
  });
  if (unmeasured.length) {
    for (const a of unmeasured) MEASURE_TRIED.set(a.id, now);
    await Promise.all(
      unmeasured.map((a) => refreshAccount(STORE, a, now).catch(() => null)),
    );
    await persist();
  }
  return STORE;
}

// ---------------------------------------------------------------- account glue

let PERSIST_CHAIN = Promise.resolve();

/**
 * Every write goes through one chain. saveStore() takes the same temp file
 * name per process, so two overlapping saves can lose an update or make the
 * rename fail - and a lost update means the proxy forgets spent credits.
 */
function persist() {
  if (!STORE) return Promise.resolve();
  PERSIST_CHAIN = PERSIST_CHAIN.then(async () => {
    if (!STORE) return;
    try {
      await saveStore(STORE);
    } catch (err) {
      // One retry: a transient rename/lock on Windows should not lose a save.
      try {
        await new Promise((r) => setTimeout(r, 50));
        await saveStore(STORE);
      } catch (again) {
        console.error('[proxy] store save failed: ' + again.message);
      }
    }
  });
  return PERSIST_CHAIN;
}

function activeAccount() {
  return STORE ? findAccount(STORE, MANUAL_ACCOUNT_ID || STORE.activeAccountId) : null;
}

/**
 * Pick the account to talk to upstream. Re-measures when data is stale or when
 * the current account is about to run dry, so the switch happens *before* the
 * budget is gone rather than after a failed request.
 */
async function chooseAccount() {
  if (!STORE) return null;
  if (MANUAL_ACCOUNT_ID) return activeAccount();
  const now = Date.now();
  let decision = decide(STORE, now, STORE.settings);

  if (decision.action === 'refresh') {
    for (const id of decision.accountIds) {
      const account = findAccount(STORE, id);
      if (account) await refreshAccount(STORE, account, now);
    }
    await persist();
    decision = decide(STORE, Date.now(), STORE.settings);
  }

  if (decision.action === 'switch') {
    const target = findAccount(STORE, decision.accountId);
    if (target) {
      STORE.activeAccountId = target.id;
      target.lastUsedAt = new Date().toISOString();
      await persist();
      console.log(`[rotator] switch -> ${target.id} (${target.handle || target.email || '?'}) - ${decision.reason}`);
      return target;
    }
  }

  if (decision.action === 'keep' || decision.action === 'switch') {
    const account = activeAccount();
    if (account) {
      account.lastUsedAt = new Date().toISOString();
      return account;
    }
  }

  if (decision.action === 'wait') {
    console.warn(`[rotator] all accounts exhausted; next refill ${decision.until} - requests will fail until then`);
    const fallback = activeAccount();
    return fallback; // let upstream answer with the real quota error
  }

  if (decision.action === 'mint') {
    console.warn('[rotator] every account is out of budget and no refill is close.');
    console.warn(`[rotator] a new account is required: ${decision.email}`);
    console.warn('[rotator] run:  node tools/freepi-accounts.mjs add   (see README "Adding an account")');
    const fallback = activeAccount();
    return fallback;
  }
  return activeAccount();
}

/**
 * Accounts a session-routing reservation may hand out for `model`. This is the
 * exact eligibility the router uses: credentialed, enabled, token-valid, not in
 * the ad cooldown (ads_required), and with a usable state for the model. It is
 * a named function so the router's filter and the unit tests stay in lockstep.
 */
function routingCandidates(model, now = Date.now(), includeTemporary = false) {
  if (!STORE) return [];
  const list = STORE.accounts
    .filter(a => a.token && !a.disabled && !a.tokenBad && !inAdCooldown(a.id, now) && (includeTemporary || !hourlyBlockedNow(a.id, now)) && modelAllowsAccount(a, model, now))
    .sort(compareRoutingAccounts);
  if (MANUAL_ACCOUNT_ID) {
    const idx = list.findIndex(a => a.id === MANUAL_ACCOUNT_ID);
    if (idx > 0) {
      const [picked] = list.splice(idx, 1);
      list.unshift(picked);
    }
  }
  return list;
}

/**
 * Candidate accounts to retry with, best first. `exclude` is an id or a set of
 * ids that already failed for this request: bouncing back to one of them burns
 * upstream requests without any chance of progress.
 */
function retryCandidates(exclude, model, session, worker) {
  if (!STORE) return [];
  if (MANUAL_ACCOUNT_ID) return [];
  const skip = exclude instanceof Set ? exclude : new Set([exclude].filter(Boolean));
  const now = Date.now();
  return STORE.accounts
    .filter(a => !a.disabled && !skip.has(a.id) && !a.tokenBad && a.token && !laneBusy.has(a.id) && !inAdCooldown(a.id, now) && !hourlyBlockedNow(a.id, now) && sessionRouter.allowed(a.id, session, worker))
    .map(a => ({ account: a, state: stateOf(a, now, STORE.settings) }))
    .filter(x => modelAllowsAccount(x.account, model, now))
    // Daily allowance first, premium-only accounts last (sortForPick).
    .sort(compareRoutingAccounts)
    .map(x => x.account);
}

// ------------------------------------------- accounts waiting for a sponsor ad
//
// free-pi answers 403 {"code":"ads_required"} until an account has really seen
// an ad. Retrying such an account on every request only produces 403s that the
// harness misreads as "API key is invalid", so it is parked until its sponsor
// window has shown something (or the cooldown expires, whichever is first).

const AD_COOLDOWN_MS = 10 * 60 * 1000;
const hourlyBlockFile=path.join(STATE_DIR,'hourly-blocks.json');
const hourlyBlocked = new Map();
try {
  const saved=JSON.parse(fsSync.readFileSync(hourlyBlockFile,'utf8').replace(/^\uFEFF/,''));
  for(const [id,until] of Object.entries(saved?.accounts||{})) if(typeof id==='string' && Number.isFinite(until) && until>Date.now()) hourlyBlocked.set(id,until);
} catch (error) { if(error.code!=='ENOENT') console.warn('[proxy] could not restore hourly blocks: '+error.message); }
function saveHourlyBlocks() {
  try { fsSync.mkdirSync(path.dirname(hourlyBlockFile),{recursive:true}); const tmp=hourlyBlockFile+'.tmp';fsSync.writeFileSync(tmp,JSON.stringify({version:1,accounts:Object.fromEntries(hourlyBlocked)}));fsSync.renameSync(tmp,hourlyBlockFile); }
  catch(error) { console.warn('[proxy] could not persist hourly blocks: '+error.message); }
}
const upstreamUnavailable = new Map();
function hourlyBlockedNow(id, now = Date.now()) {
  const hb = hourlyBlocked.get(id) || 0;
  if (hb && hb <= now) hourlyBlocked.delete(id);
  const uu = upstreamUnavailable.get(id) || 0;
  if (uu && uu <= now) upstreamUnavailable.delete(id);
  return Math.max(hb, uu) > now;
}
const adBlocked = new Map();   // account id -> when the block was recorded

// Which accounts are currently waiting for a display is worth surviving a
// restart. Without it a restarted proxy believes every account is fine, so it
// stops reopening the window and stops telling the caller why a request was
// refused. Kept next to the store but in its own file: it is derived state and
// must never risk the account data itself.
const AD_STATE_FILE = path.join(STATE_DIR, 'ad-state.json');

function loadAdState() {
  try {
    const raw = fsSync.readFileSync(AD_STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [id, at] of Object.entries(data.blocked || {})) {
      // Anything older than the cooldown is stale anyway.
      if (typeof at === 'number' && now - at <= AD_COOLDOWN_MS) adBlocked.set(id, at);
    }
  } catch { /* first run or unreadable: start empty */ }
}

function saveAdState() {
  try {
    fsSync.mkdirSync(path.dirname(AD_STATE_FILE), { recursive: true });
    const blocked = {};
    for (const [id, at] of adBlocked) blocked[id] = at;
    const tmp = AD_STATE_FILE + '.tmp';
    fsSync.writeFileSync(tmp, JSON.stringify({ version: 1, blocked }) + '\n');
    fsSync.renameSync(tmp, AD_STATE_FILE);
  } catch { /* a failed write must not break a request */ }
}

function markAdsRequired(id) {
  adBlocked.set(id, Date.now());
  saveAdState();
}

/** Called by the sponsor panel once an account has displayed a real ad. */
function clearAdsRequired(id) {
  adBlocked.delete(id);
  saveAdState();
  sponsorEvents.emit('displayed',id);
}
async function recoverSponsor(account,downstream) {
  markAdsRequired(account.id);
  if (!AUTO_SPONSOR && account && account.token) {
    try {
      const turnId = randomUUID();
      let r = await confirmAdDirect(account.token, sessionIdFor(account), 'banner', turnId);
      if (!r?.confirmed) r = await confirmAdDirect(account.token, sessionIdFor(account), 'inline', turnId);
      if (r && r.confirmed) {
        rememberAccountTurn(account.id, r.turnId);
        clearAdsRequired(account.id);
        return true;
      }
    } catch {}
    return waitForSponsorDisplay(account.id,{events:sponsorEvents,downstream,isBlocked:inAdCooldown,timeoutMs:2500});
  }
  const displayed=waitForSponsorDisplay(account.id,{events:sponsorEvents,downstream,isBlocked:inAdCooldown});
  try{openSponsorPanel(account);}catch(error){console.error('[sponsor] '+error.message);}
  return displayed;
}

function inAdCooldown(id, now = Date.now()) {
  const at = adBlocked.get(id);
  if (at === undefined) return false;
  if (now - at > AD_COOLDOWN_MS) { adBlocked.delete(id); saveAdState(); return false; }
  return true;
}

// ------------------------------------------------ multi-account request lanes
//
// free-pi allows ONE in-flight request per account, but a harness running
// several subagents needs real parallelism. So each account is a lane: a request
// claims a free account, runs on it, and frees it again. With N accounts we get
// N truly concurrent requests; a request only queues when every lane is busy.
//
// `laneBusy` is a Set of account ids on purpose, and that is NOT a container
// choice to revisit: free-pi's limit is exactly one in-flight request per
// account. Raising it (e.g. to a Map with a counter > 1) makes the upstream
// answer the second request with `concurrent` (429) or `concurrent_session`
// (409) - the requests then fail instead of running in parallel. Extra
// parallelism must come from more accounts, never from more slots per account.

const CONCURRENCY_PER_ACCOUNT = 1;

const laneBusy = new Set();   // account ids currently serving a request

/**
 * All accounts usable right now, best first: accounts with daily allowance
 * before premium-only ones, then most spendable credits, then idlest. A
 * premium-only account still gets a lane, but only after every normal one.
 */
function usableAccounts(model) {
  if (!STORE) return [];
  if (MANUAL_ACCOUNT_ID) {
    const selected = activeAccount();
    return selected && modelAllowsAccount(selected, model) && !inAdCooldown(selected.id) ? [selected] : [];
  }
  const now = Date.now();
  return STORE.accounts
    .filter(a => !a.disabled && !a.tokenBad && a.token && !inAdCooldown(a.id, now) && !hourlyBlockedNow(a.id, now))
    .map(a => ({ account: a, state: stateOf(a, now, STORE.settings) }))
    .filter(x => modelAllowsAccount(x.account, model, now))
    .sort(compareRoutingAccounts)
    .map(x => x.account);
}

/**
 * Claim a free account for one request. Returns {account, release} or null when
 * every lane is busy. A free lane is preferred over the sticky active account so
 * parallel subagents spread across accounts instead of colliding on one.
 */
function claimAccount(model, session, worker) {
  const usable = usableAccounts(model);
  if (!usable.length) {
    // No measured-but-usable account: fall back to the rotator decision path,
    // which may refresh stale data or report a quota problem.
    return null;
  }
  const free = usable.filter(a => !laneBusy.has(a.id) && sessionRouter.allowed(a.id, session, worker));
  if (!free.length) return null;
  // Balance by measured usage; least recently used breaks ties.
  free.sort(compareRoutingAccounts);
  const account = free[0];
  laneBusy.add(account.id);
  account.lastUsedAt = new Date().toISOString();
  return { account, release: makeRelease(account) };
}

/**
 * Release handle for one lane. Idempotent: several code paths (upstream end,
 * downstream close, transport error, retry) may race to free the same lane.
 */
function makeRelease(account) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    laneBusy.delete(account.id);
    setImmediate(pumpClaims);
  };
}

/**
 * Claim a specific account's lane (used when the rotator picked an account
 * before a lane existed). Returns null if that lane is already busy.
 */
function claimFor(id, model, session, worker) {
  if (!sessionRouter.allowed(id, session, worker)) return null;
  const candidate = STORE?.accounts?.find(a => a.id === id);
  const account = candidate && candidate.token && !candidate.disabled && !candidate.tokenBad && !inAdCooldown(id) && !hourlyBlockedNow(id) &&
    modelAllowsAccount(candidate, model) ? candidate : null;
  if (!account) return null;
  if (laneBusy.has(account.id)) return null;
  laneBusy.add(account.id);
  account.lastUsedAt = new Date().toISOString();
  return { account, release: makeRelease(account) };
}

function laneCount() {
  return usableAccounts().length;
}

// ------------------------------------------------- pinned account (per request)
//
// A caller may reserve one account for a request with the header
// `x-freepi-account: <id|handle>`. Unlike the global MANUAL_ACCOUNT_ID (which
// narrows the pool for every request) this pin applies to a single request and
// is honoured without ever falling back to another account: the caller chose
// that account, a silent swap would send the work to the wrong quota.
const PIN_HEADER = 'x-freepi-account';
const PIN_WAIT_TIMEOUT_MS = Math.max(0, Number(process.env.FREEPI_PIN_WAIT_MS ?? 120000));

/** 409 for a pin we cannot honour: unusable account, or lane still busy. */
function sendPinnedError(status, id, account, code, model) {
  const now = Date.now();
  const label = (account && (account.handle || account.id)) || id;
  const why = pinnedUnusableReason(account, now, model);
  const budgetState = account ? stateOf(account, now, STORE ? STORE.settings : {}) : 'missing';
  const adsRequired = why === 'waiting for a sponsor ad';
  if(adsRequired) {status=403;code='ads_required';}
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
  let message;
  if (code === 'account_busy') {
    const retryAfter = Math.max(1, Math.ceil(PIN_WAIT_TIMEOUT_MS / 1000));
    headers['retry-after'] = String(retryAfter);
    message = 'account \'' + label + '\' is busy (one request per account) and no lane '
      + 'freed up within ' + retryAfter + 's. Retry after ' + retryAfter + 's.';
  } else {
    message = 'account \'' + label + '\' cannot be used right now: ' + (why || 'state ' + budgetState) + '.';
  }
  const payload = {
    error: {
      message,
      type: adsRequired ? 'free_pi_error' : status === 429 ? 'rate_limit_error' : 'invalid_request_error',
      param: PIN_HEADER,
      code,
      ...(code === 'account_busy' ? { retry_after: Math.ceil(PIN_WAIT_TIMEOUT_MS / 1000) } : {}),
      account: id,
      state: adsRequired ? 'ads_required' : modelAllowsAccount(account, model) ? 'model_available' : budgetState,
      budgetState,
    },
  };
  headers['content-length'] = Buffer.byteLength(JSON.stringify(payload));
  return { status, headers, body: JSON.stringify(payload) };
}

/** Account id for a pin value: exact id or handle, both case-insensitive. */
function resolvePinnedAccountId(raw) {
  const want = String(raw ?? '').trim().toLowerCase();
  if (!want || !STORE) return null;
  const accounts = STORE.accounts || [];
  const byId = accounts.find(a => String(a.id || '').toLowerCase() === want);
  if (byId) return byId.id;
  const byHandle = accounts.find(a => String(a.handle || '').toLowerCase() === want);
  return byHandle ? byHandle.id : null;
}

/** True when the header name is the pin header (it must never go upstream). */
function isPinHeader(name) {
  return String(name || '').toLowerCase() === PIN_HEADER;
}

/** Why a pinned account cannot serve right now, or null when it can. */
function pinnedUnusableReason(account, now = Date.now(), model) {
  if (!account) return 'missing';
  if (!account.token) return 'no credential';
  if (account.disabled) return 'disabled';
  if (account.tokenBad) return 'token rejected (' + (account.lastError || '401') + ')';
  const state = stateOf(account, now, STORE ? STORE.settings : {});
  if (!modelAllowsAccount(account, model, now)) return 'state ' + state;
  if (inAdCooldown(account.id, now)) return 'waiting for a sponsor ad';
  if (hourlyBlockedNow(account.id, now)) return 'hourly limit active';
  return null;
}

async function promote(account, reason) {
  if (!STORE || !account) return;
  STORE.activeAccountId = account.id;
  account.lastUsedAt = new Date().toISOString();
  await persist();
  console.log(`[rotator] retry on ${account.id} (${account.handle || account.email || '?'}) - ${reason}`);
}

// ---------------------------------------------------------------- upstream I/O

function httpsGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchCatalogFor(token) {
  try {
    const r = await getCatalog(token);
    return (typeof r === 'object' && r) ? r : {};
  } catch { return {}; }
}

/**
 * Keep the known-model set in step with free-pi.
 *
 * It is read once at startup, which means a model free-pi launches later would
 * be rejected with 404 (and a misleading "does not exist") until the proxy is
 * restarted. Refreshing in the background fixes that without making any request
 * wait on a catalog fetch.
 *
 * Failures are ignored on purpose: a dropped refresh must not shrink the set and
 * start rejecting ids that worked a second ago. Only a non-empty answer is
 * applied, and the previous set is kept otherwise.
 */
let catalogRefreshTimer = null;
function startCatalogRefresh(getToken, intervalMs) {
  if (catalogRefreshTimer) return;
  const every = intervalMs || 30 * 60 * 1000;
  catalogRefreshTimer = setInterval(async function () {
    try {
      const token = typeof getToken === 'function' ? getToken() : null;
      const fresh = await fetchCatalogFor(token);
      const list = fresh && (Array.isArray(fresh.models) ? fresh.models : (Array.isArray(fresh.data) ? fresh.data : null));
      if (!list || !list.length) return;
      const next = new Set();
      for (const m of list) {
        if (m && m.id) next.add(String(m.id));
      }
      if (!next.size) return;
      catalog = list;
      updateFreeModels(list);
      for (const m of DEFAULT_CATALOG) {
        if (m && m.id) next.add(String(m.id));
      }
      let added = 0;
      for (const id of next) if (!KNOWN_MODELS.has(id)) added += 1;
      if (added) console.log('[proxy] model catalog refreshed, ' + added + ' new id(s) now accepted');
      KNOWN_MODELS.clear();
      for (const id of next) KNOWN_MODELS.add(id);
    } catch { /* keep the old set */ }
  }, every);
  if (catalogRefreshTimer.unref) catalogRefreshTimer.unref();
}

async function fetchAd(account) {
  try {
    return await httpsGet(`${FREEPI_BASE}/ads/next?slot=banner`, {
      authorization: `Bearer ${account.token}`,
      'x-session-id': sessionIdFor(account),
      'x-client-version': getClientVersion(),
    });
  } catch { return null; }
}

function renderAd(ad) {
  if (!ad || typeof ad.body !== 'object' || !ad.body) return;
  const b = ad.body;
  const lines = [];
  const text = b.text ?? b.content ?? b.message ?? b.title
    ?? (b.creative ? [b.creative.headline, b.creative.body, b.creative.cta].filter(Boolean).join('\n') : null);
  const url  = b.url  ?? b.link   ?? b.click_url ?? b.href ?? null;
  const img  = b.image_url ?? b.image ?? null;
  if (text) lines.push(String(text).trim());
  if (url)  lines.push('-> ' + String(url).trim());
  if (img)  lines.push('[img] ' + String(img).trim());
  if (!lines.length) return;
  const W = 54, bar = '-'.repeat(W);
  console.log('\n+' + bar + '+');
  console.log('| ' + 'free-pi sponsor'.padEnd(W-1) + '|');
  console.log('+' + bar + '+');
  for (const line of lines)
    for (let i = 0; i < Math.max(line.length, 1); i += W)
      console.log('| ' + line.slice(i, i + W).padEnd(W-1) + '|');
  console.log('+' + bar + '+');
}

// ------------------------------------------------------------ sponsor nudge
//
// free-pi sometimes answers 403 {"code":"ads_required"}: the account has to see
// a sponsor card before it may use the model again. The honest fix is to show
// the real card - the panel only reports an impression once the card has
// actually been visible for a second - so we open it and say so, instead of
// passing a bare 403 to the client.
const SPONSOR_URL = 'http://127.0.0.1:' + PORT + '/sponsor';
const SPONSOR_NUDGE_MS = 5 * 60 * 1000;
// One app window per account at most per cooldown window. In memory on purpose:
// after a proxy restart a fresh attempt is fine, the browser window survives.
const SPONSOR_WINDOW_COOLDOWN_MS = 600_000;
const sponsorNudgedAt = new Map();   // account id -> last successful window open

// At most this many sponsor windows are started per pass. With many accounts
// every request path could hit ads_required at once and spawn a window each,
// which would flood the desktop and the memory. The rest are simply tried on
// their next blocked request, so nothing is lost.
const SPONSOR_MAX_OPEN_PER_PASS = 2;
let sponsorOpenBudgetAt = 0;
let sponsorOpenBudgetLeft = SPONSOR_MAX_OPEN_PER_PASS;

function takeSponsorOpenSlot(now) {
  if (now - sponsorOpenBudgetAt >= 60_000) {
    sponsorOpenBudgetAt = now;
    sponsorOpenBudgetLeft = SPONSOR_MAX_OPEN_PER_PASS;
  }
  if (sponsorOpenBudgetLeft <= 0) return false;
  sponsorOpenBudgetLeft -= 1;
  return true;
}

/** Window URL for one account; every account needs its own. */
function sponsorUrlFor(account) {
  return account?.id ? SPONSOR_URL + '?account=' + encodeURIComponent(account.id) : SPONSOR_URL;
}

// Chrome/Edge app windows with a dedicated profile, so sponsorship of several
// accounts never mixes with the user's own browser session. Same pattern as
// Show-Sponsor.ps1: one profile directory per account.
const SPONSOR_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];

let sponsorBrowserPath;   // undefined = not looked up yet, null = none found
let sponsorBrowserWarned = false;

function findSponsorBrowser() {
  if (sponsorBrowserPath !== undefined) return sponsorBrowserPath;
  sponsorBrowserPath = SPONSOR_BROWSERS.find(p => fsSync.existsSync(p)) || null;
  return sponsorBrowserPath;
}

function safeAccountId(id) {
  return String(id || 'active').replace(/[^A-Za-z0-9_-]/g, '_');
}

function sponsorProfileDir(id) {
  return path.join(os.homedir(), '.free-pi', 'sponsor-window', safeAccountId(id));
}

/**
 * Desktop slot for one account. The allowance of an account is only renewed
 * while its card is the visible document, and a window is only visible when it
 * is neither minimised nor fully covered. A browser opens every app window at
 * the same spot, so without a distinct slot per account only the topmost one
 * ever counts and the others stay paused.
 *
 * Only acc-<n> folders are slots: a browser profile holds dozens of internal
 * folders and one of them may sit in this directory, which would push the slots
 * far right. Unknown ids go after the known ones instead of onto slot zero.
 */
function sponsorSlots() {
  const root = path.join(os.homedir(), '.free-pi', 'sponsor-window');
  let names = [];
  try {
    names = fsSync.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^acc-\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch { names = []; }
  names.sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  return names;
}

function sponsorSlotFor(id) {
  const names = sponsorSlots();
  let index = names.indexOf(safeAccountId(id));
  if (index < 0) index = names.length;
  const offset = index * 44;
  return { x: 30 + offset, y: 30 + offset };
}

/**
 * Open the sponsor window of one account in its own browser profile. Returns
 * true when a process was started, false when nothing was opened. Never throws:
 * this runs in the request path, where a browser problem must not become a 500.
 */
function openSponsorPanel(account) {
  if (!AUTO_SPONSOR) return false;
  if(process.platform==='win32') {
    const helper=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(path.dirname(fileURLToPath(import.meta.url)),'Show-Sponsor.ps1'),
      ...(account?.id?['-AccountId',account.id]:[])],{detached:true,stdio:'ignore',windowsHide:true});
    helper.on('error',error=>console.error('[sponsor] launcher: '+error.message));helper.unref();
    sponsorNudgedAt.set(account?.id||'-',Date.now());return true;
  }
  // Must match safeAccountId's own fallback ('active'), otherwise the same
  // account ends up with two profiles: proxy.mjs used '-', Show-Sponsor.ps1
  // uses 'active' - two windows, separate logins, both fighting over the ad.
  const key = safeAccountId(account?.id);
  const now = Date.now();
  // Per account: a blocked account needs its own window even when another one
  // was opened a moment ago.
  if (now - (sponsorNudgedAt.get(key) || 0) < SPONSOR_WINDOW_COOLDOWN_MS) return false;
  // Throttle across accounts as well, so a burst of blocked accounts does not
  // open a whole screenful of windows within the same second.
  if (!takeSponsorOpenSlot(now)) return false;
  const exe = findSponsorBrowser();
  if (!exe) {
    if (!sponsorBrowserWarned) {
      sponsorBrowserWarned = true;
      console.error('[sponsor] no Edge/Chrome/Brave found - open ' + SPONSOR_URL + ' manually or set FREEPI_AUTO_SPONSOR=0');
    }
    return false;
  }
  const url = sponsorUrlFor(account);
  const profile = sponsorProfileDir(key);
  try {
    fsSync.mkdirSync(profile, { recursive: true });
    // Suppress everything that could steal the window from the sponsor page:
    // the sync prompt, the default-browser question, the welcome tab and the
    // component promos all open their own page and then the sponsor card is no
    // longer the visible document, which pauses the allowance for that account.
    fsSync.writeFileSync(path.join(profile, 'First Run'), '', { flag: 'w' });
    const slot = sponsorSlotFor(key);
    const child = spawn(exe, [
      '--app=' + url,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=EdgeSyncConfirmation,MsEdgeFirstRunExperience,EdgePromoPopup',
      '--no-service-autorun',
      '--disable-component-update',
      // The card plus the usage grid needs roughly 700px of height; a window
      // smaller than the card would keep the display confirmation paused.
      '--window-size=760,820',
      // Own place on the desktop, so this window is not covered by the previous
      // account's window and can confirm its display.
      '--window-position=' + slot.x + ',' + slot.y,
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.error('[sponsor] could not start the sponsor window: ' + err.message);
    });
    child.unref();
  } catch (err) {
    console.error('[sponsor] could not open a browser: ' + err.message);
    return false;
  }
  // Stamp only after a successful start, so a failed attempt does not lock the
  // account out of a retry for the whole cooldown window.
  sponsorNudgedAt.set(key, now);
  console.log('[sponsor] free-pi asked for a sponsor view - opening ' + url + ' (profile ' + profile + ')');
  return true;
}

/** ISO timestamp of the last sponsor window we opened for this account. */
function sponsorWindowAt(id) {
  const at = sponsorNudgedAt.get(id);
  return at ? new Date(at).toISOString() : null;
}

/**
 * Turn an upstream ads_required body into an actionable error for the client.
 * `opened` says whether a window was really started - the message must not
 * claim one when FREEPI_AUTO_SPONSOR=0 or no browser was found.
 */
function adsRequiredBody(opened, account) {
  const url = SPONSOR_URL + (account?.id ? '?account=' + encodeURIComponent(account.id) : '');
  return Buffer.from(JSON.stringify({
    error: {
      message: 'Free-Pi requires a sponsor view for ' + (account?.id || 'this account') +
        '. Open its sponsor window and keep the complete card visible until it says Sponsor displayed, then retry. ' + url,
      type: 'ads_required',
      sponsor_url: url,
      sponsor_window_requested: opened === true,
    },
  }));
}

/**
 * free-pi allows a signed-in account only a few parallel CLI sessions. Crashed
 * or abandoned runs keep their slot until it expires, and the upstream wording
 * ("run /close-other-session") only applies to the official CLI, not here.
 */
function sessionCapBody(account, retryAfterSeconds) {
  const wait = retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds / 60) : 0;
  return Buffer.from(JSON.stringify({
    error: {
      message:
        'free-pi reports too many parallel sessions on ' + (account.handle || account.id) +
        '. This is a session cap, not a credit problem - no credits were used. ' +
        (wait ? 'A slot frees itself in about ' + wait + ' min. ' : '') +
        'Waiting or switching account helps; retrying immediately does not.',
      type: 'concurrent_session',
      retry_after_seconds: retryAfterSeconds || 0,
    },
  }));
}

/**
 * Wrap a raw upstream error payload in the OpenAI error envelope. Clients
 * render `error.message`; a bare upstream body is silently swallowed.
 */
function upstreamErrorBody(raw, fallbackMessage) {
  let code, retryAfter;
  let message = fallbackMessage;
  let type = 'upstream_error';
  const text = raw && raw.length ? raw.toString() : '';
  if (text) {
    try {
      const parsed = JSON.parse(text);
      code=parsed?.error?.code||parsed?.code;
      retryAfter=parsed?.retry_after_seconds||parsed?.error?.retry_after_seconds;
      const err = parsed && parsed.error;
      if (typeof err === 'string' && err) {
        message = err;
      } else if (err && typeof err === 'object') {
        if (err.message) message = String(err.message);
        if (err.type) type = String(err.type);
      } else if (typeof parsed.message === 'string' && parsed.message) {
        message = parsed.message;
      } else if (typeof parsed.detail === 'string' && parsed.detail) {
        message = parsed.detail;
      }
    } catch {
      // Not JSON (a proxy or gateway page). Keep the status text only.
      if (/^[\x20-\x7e\s]{0,300}$/.test(text)) message = text.trim().slice(0, 300) || message;
    }
  }
  return Buffer.from(JSON.stringify({ error: { message, type, ...(typeof code==='string'?{code}:{}), ...(typeof retryAfter==='number'?{retry_after_seconds:retryAfter}:{}) } }));
}

/**
 * Keep a display available for every account that owns a window, not just the
 * active one. free-pi pauses an account whose card is never shown, so an account
 * that sits idle for a while comes back blocked and its first request is
 * refused with ads_required. Refreshing all of them means each window always
 * has a card ready and the account never drifts into that state.
 *
 * The active account still goes first so the account most likely to serve the
 * next request is the freshest one.
 */
async function runAdLoop() {
  const tick = async () => {
    if (!STORE) return;
    const withToken = STORE.accounts.filter((a) => !a.disabled && !a.tokenBad && a.token);
    if (!withToken.length) return;

    const active = activeAccount();
    const order = [];
    if (active && active.token && !active.disabled && !active.tokenBad) order.push(active);
    for (const a of withToken) if (!order.includes(a)) order.push(a);

    for (const account of order) {
      try {
        const direct = await confirmAdDirect(account.token, sessionIdFor(account), 'banner');
        if (direct && direct.confirmed) {
          rememberAccountTurn(account.id, direct.turnId);
          clearAdsRequired(account.id);
        }
      } catch { /* continue with next account */ }
    }
  };
  await tick();
  setInterval(tick, AD_INTERVAL_MS);
}

// Local rolling audit contains account IDs and balances, never tokens or prompts.
const creditAuditFile=path.join(STATE_DIR,'credit-usage.jsonl');
function auditCredit(record) {
  try { fsSync.mkdirSync(path.dirname(creditAuditFile),{recursive:true});fsSync.appendFileSync(creditAuditFile,JSON.stringify({at:new Date().toISOString(),...record})+'\n'); }
  catch(error) { console.error('[usage audit] '+error.message); }
}
function auditBalances() {
  for(const a of STORE?.accounts||[]) { const u=a.usage; if(!u)continue;
    auditCredit({event:'balance',account:a.id,measuredAt:u.fetchedAt,daily:u.remainingCreditsToday,allowance:u.allowanceCredits,premium:u.premiumCredits,visibleAllowance:u.visibleAllowance}); }
}

/** Background: keep the usage numbers warm and rotate before the budget dies. */
async function runUsageLoop() {
  const tick = async () => {
    if (!STORE) return;
    try {
      await syncManualSelection();
      if (MANUAL_ACCOUNT_ID) {
        const selected = activeAccount();
        if (selected) await refreshAccount(STORE, selected, Date.now());
        await persist();
        auditBalances();
        return;
      }
      await refreshAll(STORE, { now: Date.now() });
      await persist();
      auditBalances();
      const d = decide(STORE, Date.now(), STORE.settings);
      if (d.action === 'switch') {
        const target = findAccount(STORE, d.accountId);
        if (target) {
          STORE.activeAccountId = target.id;
          await persist();
          console.log(`[rotator] proactive switch -> ${target.id} - ${d.reason}`);
        }
      } else if (d.action === 'mint') {
        console.warn(`[rotator] budget exhausted everywhere; new account would be ${d.email}`);
      }
    } catch (err) {
      console.error('[rotator] usage poll failed: ' + err.message);
    }
  };
  await tick();
  setInterval(tick, USAGE_POLL_MS);
}

// ---------------------------------------------------------------- chat proxy

// 409 carries free-pi's session-cap rejection ("concurrent_session"), which is
// not a credit problem; it is handled separately below and must not fall
// through to the generic error path, where the reason is lost.
const QUOTA_STATUS = new Set([402, 409, 429]);

/**
 * Forward one chat completion. If the upstream rejects it because the account's
 * budget is used up, that account is marked exhausted and the same request is
 * retried on the next usable account (nothing has been sent to the client yet).
 */
function proxyCompletions(inReq, inRes, attempt = 0) {
  const chunks = [];
  inReq.on('data', c => chunks.push(c));
  inReq.on('end', async () => {
    let body = Buffer.concat(chunks);
    if(runtimeStatus().restartPending){inRes.writeHead(503,{'content-type':'application/json','retry-after':'15'});inRes.end(JSON.stringify({error:{code:'upgrade_required',message:'Official CLI updated; restarting proxy and restoring active sessions.'}}));return;}
    const routingSession = typeof inReq.headers['x-freepi-session'] === 'string' ? inReq.headers['x-freepi-session'].slice(0,200) : undefined;
    const routingWorker = typeof inReq.headers['x-freepi-worker'] === 'string' ? inReq.headers['x-freepi-worker'].slice(0,200) : undefined;
    if(routingWorker && inReq.headers['x-freepi-chat']!==routingWorker){inRes.writeHead(400,{'content-type':'application/json'});inRes.end(JSON.stringify({error:{code:'worker_chat_mismatch',message:'A subagent must use its own chat identity.'}}));return;}
    if (!routingSession && MANUAL_ACCOUNT_ID && (!activeAccount()?.token || activeAccount()?.disabled || activeAccount()?.tokenBad)) {
      inRes.writeHead(401, { 'content-type': 'application/json' });
      inRes.end(JSON.stringify({ error: { message: 'The selected account needs a valid sign-in. Use /freepi-switch to select an existing account.', type: 'selected_account_unavailable' } }));
      return;
    }
    // Reject model ids the catalog does not know, BEFORE a lane is claimed.
    //
    // free-pi does not error on an unknown id: it silently substitutes a default
    // and answers 200 with a different "model" in the body. Measured: asking for
    // "definitely-not-a-real-model-xyz" returned 200 served by
    // deepseek-ai/deepseek-v41-flash-1017. A client that mistypes a model would
    // therefore believe it got what it asked for, and our own "failed" counter
    // could never move. Answer with an OpenAI-shaped 404 instead, which is what
    // OpenAI, vLLM and Ollama all do for an unknown model.
    //
    // An empty catalog means discovery failed (offline start); in that case we
    // cannot judge and must not block, so the check is skipped rather than
    // guessing.
    let wantedModel = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.model === 'string') wantedModel = parsed.model.trim();
      if (routingWorker && (!wantedModel || wantedModel === 'particle')) {
        wantedModel = 'deepseek-v4.1-flash';
        if (parsed && typeof parsed === 'object') {
          parsed.model = wantedModel;
          body = Buffer.from(JSON.stringify(parsed));
        }
      }
      if (wantedModel) console.log('[proxy] -> ' + JSON.stringify(wantedModel));
    } catch {}
    if (wantedModel && KNOWN_MODELS.size && !KNOWN_MODELS.has(wantedModel)) {
      const near = nearestModels(wantedModel, 3);
      inRes.writeHead(404, { 'content-type': 'application/json' });
      inRes.end(JSON.stringify({
        error: {
          message: 'The model `' + wantedModel + '` does not exist or you do not have access to it.'
            + (near.length ? ' Did you mean ' + near.map(m => '`' + m + '`').join(', ') + '?' : '')
            + ' GET /v1/models lists every id this proxy accepts.',
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      }));
      return;
    }

    // Optional per-request account pin: x-freepi-account: <id|handle>, matched
    // case-insensitively. Resolved BEFORE a lane is claimed so a bad pin cannot
    // steal a lane from a legitimate request. The header is read here and never
    // forwarded upstream (see the whitelist in send()).
    const pinRaw = inReq.headers[PIN_HEADER];
    let pinnedAccountId = null;
    if (typeof pinRaw === 'string' && pinRaw.trim()) {
      pinnedAccountId = resolvePinnedAccountId(pinRaw);
      if (!pinnedAccountId) {
        inRes.writeHead(404, { 'content-type': 'application/json' });
        inRes.end(JSON.stringify({
          error: {
            message: 'account \'' + pinRaw.trim() + '\' not found',
            type: 'invalid_request_error',
            param: PIN_HEADER,
            code: 'account_not_found',
          },
        }));
        return;
      }
      const pinnedAccount = STORE ? findAccount(STORE, pinnedAccountId) : null;
      let why = pinnedUnusableReason(pinnedAccount, Date.now(), wantedModel);
      if(why==='waiting for a sponsor ad') {
        const displayed=await recoverSponsor(pinnedAccount,inRes);
        if(inRes.destroyed)return;
        if(!displayed){
          // The pinned account is in the ad cooldown and its sponsor window did
          // not confirm in time. If another free account can serve this model,
          // fall back to it instead of failing the whole request with 503.
          // The pin only narrows the pool; it never makes a usable request fail
          // just because the chosen lane is temporarily blocked.
          const alt = retryCandidates(new Set([pinnedAccountId]), wantedModel, routingSession, routingWorker)[0];
          if (alt) { pinnedAccountId = null; why = null; }
          else { const error=sendPinnedError(503,pinnedAccountId,pinnedAccount,'ads_required',wantedModel);inRes.writeHead(503,error.headers);inRes.end(error.body);return; }
        }
        why=pinnedUnusableReason(pinnedAccount,Date.now(),wantedModel);
      }
      if (why && routingSession) {
        const movedId = sessionRouter.moveReservation(routingSession, routingWorker, pinnedAccountId, routingCandidates(wantedModel), laneBusy);
        if (movedId) {
          pinnedAccountId = movedId;
          why = null;
        }
      }
      if (why) {
        const pinned = sendPinnedError(409, pinnedAccountId, pinnedAccount, 'account_unusable', wantedModel);
        inRes.writeHead(pinned.status, pinned.headers);
        inRes.end(pinned.body);
        return;
      }
    }

    // Take a free account lane if one exists; otherwise wait in the queue and
    // claim a lane as soon as another request frees it.
    //
    // `pin` holds the account id a caller forced with x-freepi-account. It is a
    // local variable of exactly this request: every claim below uses claimFor(pin)
    // and every retry path is told about it, so the pin survives the whole
    // request and is never widened to "any account".
    let pin = pinnedAccountId;
    const relayPinnedError = (id, acc, code) => {
      const status = code === 'account_busy' ? 429 : 409;
      const err = sendPinnedError(status, id, acc, code, wantedModel);
      if (inRes.headersSent) { inRes.end(); return; }
      inRes.writeHead(err.status, err.headers);
      inRes.end(err.body);
    };

    const start = (claimed) => {
      let account = claimed ? claimed.account : null;
      let releaseLane = claimed ? claimed.release : () => {};

      const withAccount = async () => {
        if (!account && pin) {
          // A pinned request never falls back unless it is a session-router
          // reservation that can safely rebind to another free candidate.
          let pinned = STORE ? findAccount(STORE, pin) : null;
          releaseLane();
          if (pinnedUnusableReason(pinned, Date.now(), wantedModel) || laneBusy.has(pin)) {
            if (routingSession) {
              const movedId = sessionRouter.moveReservation(routingSession, routingWorker, pin, routingCandidates(wantedModel), laneBusy);
              if (movedId) {
                pin = movedId;
                pinned = STORE ? findAccount(STORE, pin) : null;
              }
            }
            if (pinnedUnusableReason(pinned, Date.now(), wantedModel)) { relayPinnedError(pin, pinned, 'account_unusable'); return; }
          }
          const reclaimed = claimFor(pin, wantedModel, routingSession, routingWorker);
          if (reclaimed) { account = reclaimed.account; releaseLane = reclaimed.release; }
        }
        if (!account && !pin) {
          // No lane was claimed (nothing usable at claim time). The fallback
          // still has to hold a lane, otherwise this request could run beside
          // another one on the same account and trigger a "concurrent" reject.
          const fallback = await chooseAccount();
          const reclaimed = fallback ? claimFor(fallback.id, wantedModel, routingSession, routingWorker) : null;
          if (reclaimed) { account = reclaimed.account; releaseLane = reclaimed.release; }
        }
        if (!account || !account.token) {
          releaseLane();
          if (pin) { relayPinnedError(pin, STORE ? findAccount(STORE, pin) : null, 'account_unusable'); return; }
          inRes.writeHead(503, { 'content-type': 'application/json' });
          inRes.end(JSON.stringify({
            error: {
              message: 'no usable free-pi account. run: node tools/freepi-accounts.mjs add',
              type: 'no_account',
            },
          }));
          return;
        }
        run(account, releaseLane);
      };
      withAccount();
    };

    const tryClaim = () => {
      // Pinned: only that lane is acceptable, unless this is a session-router
      // reservation and the pinned lane is busy while another candidate is free.
      let claimed = pin ? claimFor(pin, wantedModel, routingSession, routingWorker) : claimAccount(wantedModel, routingSession, routingWorker);
      if (!claimed && pin && routingSession) {
        const movedId = sessionRouter.moveReservation(routingSession, routingWorker, pin, routingCandidates(wantedModel), laneBusy);
        if (movedId) {
          pin = movedId;
          claimed = claimFor(pin, wantedModel, routingSession, routingWorker);
        }
      }
      if (claimed) { start(claimed); return true; }
      return false;
    };

    if (!tryClaim()) {
      // Every lane busy: queue, and claim a lane when one frees up.
      let pinTimer = null;
      const slot = enqueueClaim(() => {
        const claimed = tryClaim();
        if (claimed && pinTimer) clearTimeout(pinTimer);
        return claimed;
      }, { model: wantedModel, session: routingSession, worker: routingWorker, ...(pin && !routingSession ? { pinnedId: pin } : {}) });
      if (!slot.accepted) {
        inRes.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
        inRes.end(JSON.stringify({
          error: {
            message: 'proxy queue full (' + MAX_QUEUE + ' waiting) - retry shortly.',
            type: 'queue_full',
          },
        }));
        return;
      }
      {
        // The caller picked this account on purpose, so waiting beats a 409 in a
        // retry loop - but not forever. When the lane is still occupied after
        // the timeout the answer is an explicit, retryable error.
        pinTimer = setTimeout(() => {
          if (inRes.writableEnded || inRes.destroyed) return;
          slot.cancel?.();
          if (tryClaim()) return;
          if (pin) {
            const errStatus = routingSession ? 429 : 409;
            const bodyPin = sendPinnedError(errStatus, pin, STORE ? findAccount(STORE, pin) : null, 'account_busy', wantedModel);
            inRes.writeHead(bodyPin.status, bodyPin.headers);
            inRes.end(bodyPin.body);
          } else {
            inRes.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
            inRes.end(JSON.stringify({ error: { message: 'All account lanes are busy. Queue wait timed out; retry shortly.', type: 'queue_timeout' } }));
          }
        }, PIN_WAIT_TIMEOUT_MS);
        pinTimer.unref?.();
      }
      inRes.on('close', () => {
        if (pinTimer) clearTimeout(pinTimer);
        if (!inRes.writableEnded) slot.cancel?.();
      });
      return;
    }

    function run(account, releaseLane) {
    // Delegate to the current `releaseLane` function (each `makeRelease` handle
    // is already idempotent per claim), so swapping to a new account properly
    // releases the new account's lane when the request finishes.
    const releaseLaneOnce = () => {
      releaseLane();
    };

    let retries = 0;
    let sponsorRetries = 0;
    let consentRetries = 0;
    const tried = new Set();      // accounts that already failed this request
    const MAX_RETRIES = 4;        // concurrent races tolerated on one account
    const MAX_SWAPS = 5;          // account switches for one client request
    let swaps = 0;

    // Upstream headers are an explicit whitelist, never a copy of inReq.headers.
    // That is what keeps x-freepi-account (and every other client header) local:
    // there is no spread of inReq.headers here, and isPinHeader() below is a
    // second guard in case someone adds one later.
    const upstreamHeaders = {
      'content-type': 'application/json',
      'content-length': body.length,
    };
    for (const [name, value] of Object.entries(inReq.headers)) {
      if (isPinHeader(name)) continue;
      if (name === 'accept' || name === 'x-request-id') upstreamHeaders[name] = value;
    }

    const send = (token) => {
      auditCredit({event:'request',account:account.id,model:wantedModel});
      let responseWillRetry=false;
      const turnId = activeAccountTurn(account.id);
      const upReq = https.request({
        hostname: 'api.freepi.ai',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        agent: upstreamAgent,
        headers: { ...upstreamHeaders, authorization: 'Bearer ' + token, 'x-session-id':sessionIdFor(account),'x-client-version':getClientVersion(), ...(turnId ? { 'x-turn-id': turnId } : {}) },
      }, upRes => {
        auditCredit({event:'response',account:account.id,model:wantedModel,status:upRes.statusCode});
        if (!inRes.headersSent && (upRes.statusCode === 426 || upRes.statusCode === 502 || QUOTA_STATUS.has(upRes.statusCode) || upRes.statusCode === 401 || upRes.statusCode === 403)) {
          // Prevent bindRequestLifecycle's response.once('end') from releasing
          // the lane before our buffered error/retry handlers below run.
          responseWillRetry = true;
        }
        if(upRes.statusCode===426&&!inRes.headersSent){
          const chunks=[];upRes.on('data',chunk=>chunks.push(chunk));upRes.on('end',async()=>{
            releaseLaneOnce();let error;try{error=JSON.parse(Buffer.concat(chunks).toString());}catch{}
            if(error?.code!=='upgrade_required'&&error?.error?.code!=='upgrade_required'){relay(426,upstreamErrorBody(Buffer.concat(chunks),'Client upgrade required'));return;}
            try{await upgradeClient(requiredVersion(error));if(!inRes.destroyed)relay(503,Buffer.from(JSON.stringify({error:{code:'upgrade_required',message:'Official CLI updated to '+getClientVersion()+'. Proxy is restarting; the active chat will resume.'}})));}
            catch(updateError){console.error('[upgrade] '+updateError.message);if(!inRes.destroyed)relay(503,Buffer.from(JSON.stringify({error:{code:'client_update_failed',message:updateError.message}})));}
          });return;
        }
        if(upRes.statusCode===502 && !inRes.headersSent) {
          const errors=[];upRes.on('data',chunk=>errors.push(chunk));upRes.on('end',()=>{
            const raw=Buffer.concat(errors);
            if (/upstream responded 402/i.test(raw.toString())) {
              failureAlert('upstream_402',account,'Free-Pi backend returned 502 / upstream 402; the proxy will try another eligible account.');
              // This is an upstream failure, not evidence of an empty local
              // balance. Briefly avoid hammering this account and try another
              // only for an active routed session with an exclusive lane.
              upstreamUnavailable.set(account.id,Date.now()+60000);
              if(routingSession && swaps<MAX_SWAPS) {
                const from=account.id;
                const nextId=sessionRouter.moveReservation(routingSession,routingWorker,from,routingCandidates(wantedModel),laneBusy);
                if(nextId) {
                  const next=claimFor(nextId,wantedModel,routingSession,routingWorker);
                  if(next) {
                    releaseLane();releaseLane=next.release;account=next.account;
                    swaps++;retries=0;responseWillRetry=true;
                    console.log(`[proxy] upstream 402: ${from} -> ${nextId}`);
                    send(account.token);return;
                  }
                }
              }
            }
            releaseLaneOnce();relay(502,upstreamErrorBody(raw,'Free-Pi upstream temporarily unavailable.'));
          });return;
        }
        if (QUOTA_STATUS.has(upRes.statusCode) && !inRes.headersSent) {
          const errChunks = [];
          upRes.on('data', d => errChunks.push(d));
          upRes.on('end', async () => {
            const raw = Buffer.concat(errChunks);
            if (isHourlyCeiling(raw)) {
              const reset=hourlyReset(raw,upRes.headers);
              failureAlert('hourly_ceiling',account,'Free-Pi reported a temporary account limit; retry after the recorded reset.');
              hourlyBlocked.set(account.id,reset.until);
              saveHourlyBlocks();
              try {
                const parsed = JSON.parse(raw.toString());
                const rem = Number(parsed?.remaining_credits_today ?? parsed?.error?.remaining_credits_today);
                if (Number.isFinite(rem) && rem >= 0 && account.usage) account.usage.remainingCreditsToday = rem;
              } catch {}
              console.log(`[proxy] temporary rate block for ${account.id} until ${new Date(reset.until).toISOString()} (${reset.source})`);
              if (routingSession && swaps < MAX_SWAPS) {
                const from=account.id;
                const nextId=sessionRouter.moveReservation(routingSession,routingWorker,from,routingCandidates(wantedModel),laneBusy);
                if(nextId) {
                  const next=claimFor(nextId,wantedModel,routingSession,routingWorker);
                  if(next) {
                    releaseLane(); releaseLane=next.release; account=next.account;
                    swaps++; retries=0; responseWillRetry=true;
                    console.log(`[proxy] rate limit: ${from} -> ${nextId}`);
                    send(account.token); return;
                  }
                }
              }
              if (await tryNext('temporary rate limit')) return;
              releaseLaneOnce();
              relay(429, upstreamErrorBody(raw, 'Free-Pi reported an hourly limit.'));
              return;
            }
            // "concurrent" means *we* sent two requests at once, not that the
            // account is out of credits - never mark it exhausted for that.
            let code = '';
            try { const p = JSON.parse(raw.toString()); code = p?.error?.code || p?.code || ''; } catch { /* ignore */ }
            if (code === 'model_at_capacity' || code === 'model_busy') {
              // Capacity describes the model, never the account's balance.
              releaseLaneOnce();
              relay(503, upstreamErrorBody(raw,'Model temporarily busy; retry shortly.'));
              return;
            }
            if (code === 'concurrent' || raw.toString().includes('one request at a time')) {
              // Another client raced us on this account (e.g. the pi TUI). The
              // lane stays ours, so retry on it after a short backoff.
              console.warn('[proxy] upstream said concurrent - retrying after backoff');
              retries++;
              if (retries > MAX_RETRIES) { releaseLaneOnce(); relay(429, raw); return; }
              responseWillRetry=true;
              setTimeout(() => {
                if (inRes.destroyed) { releaseLaneOnce(); return; }
                send(account.token);
              }, 400 * retries);
              return;
            }
            if (code === 'concurrent_session') {
              // Different from `concurrent`: this is an account-wide cap on
              // parallel CLI sessions, usually from crashed or abandoned runs.
              // Self-heal via POST /session/reset and rotate if another account is free.
              resetUpstreamSession(account.token).catch(() => {});
              let retryAfter = 0;
              try { retryAfter = Number(JSON.parse(raw.toString()).retry_after_seconds) || 0; } catch { /* ignore */ }
              upstreamUnavailable.set(account.id, Date.now() + Math.min(300000, Math.max(15000, (retryAfter || 60) * 1000)));
              console.warn(
                '[proxy] upstream session cap reached on ' + account.id +
                (retryAfter ? ' - frees in about ' + Math.ceil(retryAfter / 60) + ' min' : ''),
              );
              if (await tryNext('session cap')) return;
              releaseLaneOnce();
              relay(429, sessionCapBody(account, retryAfter));
              return;
            }
            onQuota(upRes.statusCode, raw);
          });
          return;
        }
        if (upRes.statusCode === 401 && !inRes.headersSent) {
          const errChunks = [];
          upRes.on('data', d => errChunks.push(d));
          upRes.on('end', () => { onUnauthorized(Buffer.concat(errChunks)); });
          return;
        }
        if (upRes.statusCode === 403 && !inRes.headersSent) {
          const errChunks = [];
          upRes.on('data', d => errChunks.push(d));
          upRes.on('end', async () => {
            const raw = Buffer.concat(errChunks);
            const rawStr = raw.toString();
            if (rawStr.includes('consent_required') && consentRetries++ < 1) {
              try {
                await submitUserConsent(account.token);
                if (!inRes.destroyed) { send(account.token); return; }
              } catch {}
            }
            if (rawStr.includes('account_review')) {
              markInvalid(account, 'account under review (403)');
              await persist();
              if (await tryNext('account review')) return;
            }
            if (rawStr.includes('ads_required')) {
              failureAlert('ads_required',account,'Free-Pi requires a visible sponsor display; confirming sponsor impression.');
              // Park this account until its sponsor impression is confirmed,
              // so the next requests go to a working account instead of
              // repeating the same 403 on every call.
              responseWillRetry=true;
              markAdsRequired(account.id);
              if(sponsorRetries++<1) {
                const displayed=await recoverSponsor(account,inRes);
                if(inRes.destroyed){releaseLaneOnce();return;}
                if(displayed){send(account.token);return;}
              }
              if (await tryNext('ads required')) return;
              releaseLaneOnce();
              let opened = false;
              try { opened = openSponsorPanel(account) === true; } catch (e) { console.error('[sponsor] ' + e.message); }
              relay(503, adsRequiredBody(opened, account));
              return;
            }
            // Never hand a raw upstream payload to the client: an OpenAI client
            // expects {error:{message,type}} and otherwise shows nothing useful.
            releaseLaneOnce();
            relay(403, upstreamErrorBody(raw, 'upstream refused the request (403)'));
          });
          return;
        }
        const h = {
          'access-control-allow-origin': '*',
          'content-type': upRes.headers['content-type'] || 'application/json',
          // Which lane actually served this request. Without it you cannot tell
          // rotation from "one account did everything" - the number that matters
          // when a client suddenly starts getting throttled.
          'x-free-pi-account': account.id,
          'x-free-pi-handle': encodeURIComponent(account.handle || ''),
          // Exposed so browser clients can read it at all.
          'access-control-expose-headers': 'x-free-pi-account, x-free-pi-handle',
        };
        if (upRes.headers['cache-control'])     h['cache-control']     = upRes.headers['cache-control'];
        if (upRes.headers['transfer-encoding']) h['transfer-encoding'] = upRes.headers['transfer-encoding'];
        noteServed(account, upRes.statusCode);
        responseWillRetry = true;
        const requestContinuation = (nextBody, attempt) => new Promise((resolve, reject) => {
          if (inRes.destroyed) { reject(new Error('client closed')); return; }
          auditCredit({ event: 'continuation_request', account: account.id, model: wantedModel, attempt });
          const continuationTurnId = activeAccountTurn(account.id);
          const contHeaders = {
            ...upstreamHeaders,
            'content-length': nextBody.length,
            authorization: 'Bearer ' + token,
            'x-session-id': sessionIdFor(account),
            'x-client-version': getClientVersion(),
            ...(continuationTurnId ? { 'x-turn-id': continuationTurnId } : {}),
          };
          if (contHeaders['x-request-id']) contHeaders['x-request-id'] = contHeaders['x-request-id'] + '-c' + attempt;
          const contReq = https.request({
            hostname: 'api.freepi.ai',
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            agent: upstreamAgent,
            headers: contHeaders,
          }, contRes => {
            auditCredit({ event: 'continuation_response', account: account.id, model: wantedModel, attempt, status: contRes.statusCode });
            resolve({ upReq: contReq, upRes: contRes });
          });
          contReq.on('error', reject);
          bindRequestLifecycle(contReq, inRes, () => {});
          contReq.write(nextBody);
          contReq.end();
        });
        void relayWithStopRecovery({
          upReq,
          upRes,
          inRes,
          headersOut: h,
          origBody: body,
          requestAttempt: requestContinuation,
          releaseOnce: releaseLaneOnce,
          onRecoveryAttempt: ({ attempt, reasoningChars }) => {
            console.warn(`[proxy] ${account.id} sent premature mid-thought stop (${reasoningChars} reasoning chars) - auto-continuing (attempt ${attempt})`);
          },
        }).catch(err => {
          console.error('[proxy] stream recovery error: ' + err.message);
          releaseLaneOnce();
        });
      });
      upReq.on('error', err => {
        console.error('[proxy] upstream error: ' + err.message);
        failureAlert('transport',account,'Connection to Free-Pi failed; retrying where possible.');
        if (inRes.destroyed) { releaseLaneOnce(); return; }
        // The upstream transport failing says nothing about the account, so try
        // a different lane instead of handing the client a 502 straight away.
        if (!inRes.headersSent && retries < 2) {
          retries++;
          tried.add(account.id);
          let next = null;
          if (!pin) {
            for (const cand of retryCandidates(tried, wantedModel, routingSession, routingWorker)) {
              const nextClaim = claimFor(cand.id, wantedModel, routingSession, routingWorker);
              if (nextClaim) {
                releaseLane();
                releaseLane = nextClaim.release;
                next = nextClaim.account;
                break;
              }
            }
          }
          if (!next && pin && routingSession) {
            const candidates = routingCandidates(wantedModel).filter(a => !tried.has(a.id));
            const nextId = sessionRouter.moveReservation(routingSession, routingWorker, account.id, candidates, laneBusy);
            const nextClaim = nextId ? claimFor(nextId, wantedModel, routingSession, routingWorker) : null;
            if (nextClaim) {
              releaseLane();
              releaseLane = nextClaim.release;
              pin = nextId;
              next = nextClaim.account;
            }
          }
          if (next) {
            console.warn(`[proxy] ${account.id} unreachable (${err.message}) - retrying on ${next.id}`);
            account = next;
            responseWillRetry = true;
            setTimeout(() => { if (!inRes.destroyed) send(next.token); else releaseLaneOnce(); }, 300 * retries);
            return;
          }
          if (pin) {
            console.warn(`[proxy] ${account.id} transport error (${err.message}) - retrying same pinned account`);
            responseWillRetry = true;
            setTimeout(() => { if (!inRes.destroyed) send(account.token); else releaseLaneOnce(); }, 300 * retries);
            return;
          }
        }
        if (!inRes.headersSent) {
          releaseLaneOnce();
          inRes.writeHead(502, { 'content-type': 'application/json' });
          inRes.end(JSON.stringify({ error: { message: 'upstream: ' + err.message, type: 'proxy_error' } }));
        } else { inRes.destroy(err); releaseLaneOnce(); }
      });
      bindRequestLifecycle(upReq, inRes, ()=>{if(!responseWillRetry)releaseLaneOnce();});
      upReq.write(body);
      upReq.end();
    };

    const relay = (status, buf) => {
      if (inRes.headersSent) { inRes.end(); return; }
      // Count the refusal against the lane that caused it, so /usage shows a
      // lane that keeps failing instead of one that merely looks busy.
      noteServed(account, status);
      inRes.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      inRes.end(buf);
    };

    /**
     * Switch this request to another account while keeping its lane. Accounts
     * that already failed for this request are never retried: bouncing A->B->A
     * burns upstream requests without any chance of progress.
     */
    const tryNext = async (reason) => {
      if (swaps >= MAX_SWAPS) return false;
      tried.add(account.id);
      if (pin) {
        if (!routingSession) {
          console.warn('[proxy] ' + pin + ' pinned by x-freepi-account - not switching (' + reason + ')');
          return false;
        }
        const candidates = routingCandidates(wantedModel).filter(a => !tried.has(a.id));
        const nextId = sessionRouter.moveReservation(routingSession, routingWorker, account.id, candidates, laneBusy);
        if (!nextId) return false;
        const nextClaim = claimFor(nextId, wantedModel, routingSession, routingWorker);
        if (!nextClaim) return false;
        releaseLane();
        releaseLane = nextClaim.release;
        pin = nextId;
        swaps++;
        await promote(nextClaim.account, reason);
        account = nextClaim.account;
        retries = 0;
        responseWillRetry = true;
        send(account.token);
        return true;
      }
      for (const cand of retryCandidates(tried, wantedModel, routingSession, routingWorker)) {
        const nextClaim = claimFor(cand.id, wantedModel, routingSession, routingWorker);
        if (!nextClaim) continue;
        releaseLane();
        releaseLane = nextClaim.release;
        swaps++;
        await promote(nextClaim.account, reason);
        account = nextClaim.account;
        retries = 0;   // a fresh account deserves a fresh "concurrent" budget
        responseWillRetry = true;
        send(account.token);
        return true;
      }
      return false;
    };

    const onQuota = async (status, buf) => {
      markExhausted(account, `upstream ${status}`);
      account.usage = account.usage || {};
      account.usage.remainingCreditsToday = 0;
      await persist();
      console.log(`[rotator] ${account.id} returned ${status} (budget spent) - rotating`);
      if (await tryNext('budget spent (' + status + ')')) return;
      releaseLaneOnce();
      relay(status, buf);
    };

    const onUnauthorized = async (buf) => {
      markInvalid(account, 'token rejected (401)');
      await persist();
      console.log(`[rotator] ${account.id} token rejected - rotating`);
      if (await tryNext('token rejected')) return;
      releaseLaneOnce();
      relay(401, buf);
    };

    // The lane is already claimed and free-pi allows one request per account,
    // so go straight upstream. releaseLaneOnce fires when the response ends.
    if (inRes.destroyed) { releaseLane(); return; }
    send(account.token);
    }
  });
}


// ---------------------------------------------------------------- local server

function usageSnapshot() {
  const now = Date.now();
  return {
    activeAccountId: MANUAL_ACCOUNT_ID || (STORE ? STORE.activeAccountId : null),
    manualAccountId: MANUAL_ACCOUNT_ID,
    nextAction: MANUAL_ACCOUNT_ID ? { action: 'manual', accountId: MANUAL_ACCOUNT_ID } : STORE ? decide(STORE, now, STORE.settings) : null,
    totals: STORE ? STORE.totals : null,
    queue: queueDepth(),
    // The upstream limit every caller has to plan around: free-pi serves one
    // request per account, so N accounts allow N parallel requests, never more.
    concurrencyPerAccount: CONCURRENCY_PER_ACCOUNT,
    accounts: (STORE ? STORE.accounts : []).map(a => ({
      ...describe(a, now, STORE.settings),
      // true while free-pi wants a sponsor view for this account; the window at
      // /sponsor?account=<id> clears it once the ad was really displayed.
      adsRequired: inAdCooldown(a.id, now),
      // ISO time of the last sponsor window this proxy opened for the account,
      // null when none was opened yet. Informational only: the window must stay
      // visible for free-pi to record the impression itself.
      sponsorWindowAt: sponsorWindowAt(a.id),
      // free-pi advertises a set of "Free Unlimited" models, but it only stops
      // billing for them while the upstream reports a visible allowance. If
      // that flag is false the same models silently draw down the daily
      // allowance, which is how two accounts here reached 0 while every logged
      // request was a free-unlimited id. Surfaced so the drain is visible in
      // /usage instead of only in the cost ledger after the fact.
      meteredDespiteFreeTier: isMeteredDespiteFreeTier(a),
      // When this lane last served a request, and whether it is serving one
      // right now. Without these two a stuck lane is invisible: every number
      // looks healthy while one account quietly does all the work.
      lastUsedAt: a.lastUsedAt || null,
      busy: laneBusy.has(a.id),
      hourlyBlocked: hourlyBlockedNow(a.id, now),
      hourlyBlockedUntil: hourlyBlockedNow(a.id, now) ? new Date(Math.max(hourlyBlocked.get(a.id) || 0, upstreamUnavailable.get(a.id) || 0)).toISOString() : null,
      // True when `x-freepi-account: <id>` would be accepted right now - the
      // exact condition claimFor() uses (usable state, token, free lane, no ad
      // cooldown). A caller can plan its pin from this instead of probing.
      selectable: modelAllowsAccount(a, undefined, now)
        && !!a.token && !laneBusy.has(a.id) && !inAdCooldown(a.id, now) && !hourlyBlockedNow(a.id, now),
    })),
    // The hour picture the dollar-like credit numbers hide. free-pi meters in
    // hours (1 h = 5000 credits) and each model costs a multiple of the base
    // rate, so "12705 credits left" is anywhere between 2.5 h and 40 min
    // depending on the model. Computed from the same rows, at 1x: the number an
    // agent harness actually runs out of first.
    budget: (() => {
      const rows = (STORE ? STORE.accounts : []).map(a => describe(a, now, STORE.settings));
      const summary = budgetSummary(rows, 1, USABLE);
      const freeEligible = (STORE ? STORE.accounts : []).filter(a => modelAllowsAccount(a, undefined, now)).length;
      if (freeEligible > summary.usableAccounts) {
        summary.usableAccounts = freeEligible;
        for (const row of summary.accounts) {
          const src = STORE?.accounts?.find(a => a.id === row.id);
          if (src && modelAllowsAccount(src, undefined, now)) row.usable = true;
        }
      }
      return summary;
    })(),
    // Filled in from the cost ledger by /usage: who served what.
    served: laneServed,
  };
}

/**
 * Per-account request tally since the proxy started. Cheap to read and the
 * only way to tell "rotation works" from "one account is doing everything".
 *
 * ok counts responses we passed through with a 2xx status; failed counts the
 * rest, so a lane that keeps erroring is visible instead of looking busy.
 */
const laneServed = {};

function noteServed(account, status) {
  if (!account || !account.id) return;
  const row = laneServed[account.id] || (laneServed[account.id] = { ok: 0, failed: 0, lastAt: null, lastStatus: null });
  if (status >= 200 && status < 300) row.ok += 1;
  else row.failed += 1;
  row.lastAt = new Date().toISOString();
  row.lastStatus = status;
}


/**
 * Per-day consumption history from the store totals. daily and premium are
 * separate wallets and are never added into one counter; `total` only sums
 * them for reading, `hours` converts the total at the base rate.
 *
 * dates is the union of both maps, newest first. ?limit keeps the newest N.
 */
function historySnapshot(limit) {
  const totals = (STORE && STORE.totals) || {};
  const byDay = totals.byDay && typeof totals.byDay === 'object' ? totals.byDay : {};
  const byDayPremium = totals.byDayPremium && typeof totals.byDayPremium === 'object' ? totals.byDayPremium : {};
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const days = [...new Set([...Object.keys(byDay), ...Object.keys(byDayPremium)])]
    .filter(d => DAY.test(d))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(function (date) {
      const daily = byDay[date] ?? 0;
      const premium = byDayPremium[date] ?? 0;
      const total = Math.round((daily + premium) * 1e6) / 1e6;
      return {
        date,
        daily,
        premium,
        total,
        hours: Math.round((creditsToHours(total) ?? 0) * 1000) / 1000,
      };
    });
  const sum = key => Math.round(days.reduce((acc, d) => acc + d[key], 0) * 1e6) / 1e6;
  const daily = sum('daily');
  const premium = sum('premium');
  return {
    days,
    totals: { daily, premium, hours: Math.round((creditsToHours(daily + premium) ?? 0) * 1000) / 1000 },
    creditsPerHour: CREDITS_PER_HOUR,
  };
}

/** ?limit=N, default 30, capped at 365. Anything non-numeric is ignored. */
function historyLimit(url) {
  const raw = url.searchParams.get('limit');
  if (raw === null || !/^\d+$/.test(raw.trim())) return 30;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(n, 365);
}

const DEFAULT_CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · Free Unlimited' },
  { id: 'particle', name: 'Particle · Free Unlimited' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash · Free Unlimited' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash · Free Unlimited' },
  { id: 'glm-5.1', name: 'GLM-5.1 · 1.2x' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5 · 0.6x' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 · 1.2x' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7 · 0.3x' },
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2 · 0.3x' },
  { id: 'qwen3.5', name: 'Qwen3.5 · 0.4x' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus · 0.5x' },
  { id: 'gemma-4', name: 'Gemma 4 · 0.2x' },
  { id: 'gpt-oss-120b', name: 'GPT-OSS 120B · 0.2x' },
  { id: 'nemotron-3-super', name: 'Nemotron 3 Super · 0.2x' },
];

function startServer(models, sponsorHtml) {
  const discovered = Array.isArray(models) && models.length > 0;
  catalog = discovered ? models : DEFAULT_CATALOG;

  // Teach the completions handler which ids are real.
  //
  // Only the ids free-pi itself reports are accepted. An earlier version also
  // accepted a "vendor/id" spelling on the assumption that clients like to write
  // it; a live probe proved free-pi rejects that form with 404, so accepting it
  // here would only hide the real reason behind a clear local error.
  KNOWN_MODELS.clear();
  updateFreeModels(catalog);
  if (discovered) {
    for (const m of DEFAULT_CATALOG) {
      if (m && m.id) KNOWN_MODELS.add(String(m.id));
    }
    for (const m of catalog) {
      if (m && m.id) KNOWN_MODELS.add(String(m.id));
    }
  }
  if (!KNOWN_MODELS.size) {
    // Validation is skipped when the set is empty, which would silently restore
    // the behaviour this check exists to prevent. Say so instead.
    console.log('[proxy] WARNING: model catalog empty, model ids are NOT validated');
  }

  const sponsorPanel = createSponsorPanel({
    currentAccount: async () => { await syncStore(); return activeAccount(); },
    accounts: async () => { await syncStore(); return STORE.accounts || []; },
    sessionId: sessionIdFor,
    usage: usageSnapshot,
    html: sponsorHtml,
    port: PORT,
    stateDir: STATE_DIR,
    onDisplayed: (accountId, turnId) => {
      rememberAccountTurn(accountId, turnId);
      clearAdsRequired(accountId);
    },
  });
  const server = http.createServer(async function(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1:' + PORT));
    } catch {
      url = new URL(req.url, 'http://127.0.0.1:' + PORT);
    }
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, x-request-id, x-freepi-account, x-freepi-session, x-freepi-worker, x-freepi-chat, x-freepi-control');
    // Let browser clients read which lane served a request (see send()).
    res.setHeader('access-control-expose-headers', 'x-free-pi-account, x-free-pi-handle');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const requestAuthorized = !BIND_CONFIG.authRequired
      || verifyApiKey(extractRequestApiKey(req.headers), BIND_CONFIG.apiKeys);

    // Cheap liveness probe for the supervisor and Cloud Run. Must answer from
    // memory only: no account, no lane, no upstream.
    if (req.method === 'GET' && url.pathname === '/health') {
      const payload = requestAuthorized
        ? {
            status: 'ok',
            creditGuard: 'disabled-by-user',
            clientRuntime: runtimeStatus(),
            uptimeSeconds: Math.floor(process.uptime()),
            inFlight: queueDepth().inFlight,
            waiting: queueDepth().waiting,
            accounts: STORE ? STORE.accounts.length : 0,
          }
        : {
            status: 'ok',
            creditGuard: 'disabled-by-user',
            uptimeSeconds: Math.floor(process.uptime()),
          };
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (!requestAuthorized) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({
        error: {
          message: 'Invalid or missing API key.',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      }));
      return;
    }

    if (url.pathname.startsWith('/sponsor')) { await sponsorPanel(req, res, url); return; }
    if (url.pathname === '/session-routing') {
      if(req.method==='GET') {
        const now=Date.now();
        const valid=STORE?STORE.accounts.filter(a=>a.token&&!a.disabled&&!a.tokenBad):[];
        const total=valid.length;
        const available=routingCandidates(undefined,now).length;
        const hourly=valid.filter(a=>hourlyBlockedNow(a.id,now)).length;
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({accounts:{total,available,busy:laneBusy.size,hourlyBlocked:hourly},sessions:sessionRouter.snapshot(laneBusy),workers:sessionRouter.workerSnapshot(),waitingWorkers:sessionRouter.waitingWorkerSnapshot()})); return;
      }
      if(req.method!=='POST' || req.headers['x-freepi-control']!=='session-routing' || req.headers.origin) {
        res.writeHead(403);res.end();return;
      }
      try {
        let raw=''; for await (const chunk of req) {raw+=chunk; if(raw.length>4096) throw Error('Request too large');}
        const data=JSON.parse(raw);
        if(typeof data.sessionId!=='string' || !data.sessionId || data.sessionId.length>200) throw Error('Missing session ID');
        let result={ok:true};
        if(data.action==='release') {sessionRouter.release(data.sessionId);setImmediate(pumpClaims);}
        else if(data.action==='release-worker') {sessionRouter.releaseWorker(data.sessionId);setImmediate(pumpClaims);}
        else if(data.action==='touch') sessionRouter.touch(data.sessionId);
        else if(data.action==='notice') sessionRouter.notice(data.sessionId,data.message,data.retryAt);
        else if(data.action==='reserve'||data.action==='cowork') {
          if (data.action === 'cowork' && (!data.model || data.model === 'particle')) {
            data.model = 'deepseek-v4.1-flash';
          }
          // Only hand out accounts that can actually serve the request. The
          // router used to accept every credentialed account, so a session that
          // landed on an exhausted one was pinned there and failed with 409
          // account_unusable on every later call, including every subagent.
          const now=Date.now();
          const candidates=routingCandidates(data.model,now);
          const temporarilyBlocked = !candidates.length && routingCandidates(data.model,now,true).some(a=>hourlyBlockedNow(a.id,now));
          if(temporarilyBlocked) {
            const eligible=routingCandidates(data.model,now,true);
            const next=Math.min(...eligible.map(a=>Math.max(hourlyBlocked.get(a.id)||0,upstreamUnavailable.get(a.id)||0)).filter(t=>t>now));
            result={accountId:null,status:'waiting',message:'Waiting for Free-Pi account or backend to become available',retryAt:Number.isFinite(next)?next:null};
          } else {
            result=data.action==='cowork' ? sessionRouter.reserveWorker(data.workerId,data.sessionId,candidates,laneBusy) : sessionRouter.reserve(data.sessionId,candidates,laneBusy);
          }
        } else throw Error('Unknown action');
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
      } catch(error) {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
      return;
    }

    // Diagnostics path handled above (/health) before auth; keep remaining routes authenticated.

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const body = JSON.stringify({
        object: 'list',
        data: catalog.map(function(m) {
          const out = { id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'free-pi', display_name: m.name };
          // free-pi reports `capabilities.vision` per model; pass that through so
          // a client that gates image attachments on this flag matches reality.
          out.capabilities = { vision: supportsVision(m.id) };
          if (m.unavailable) out.unavailable = true;
          return out;
        }),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // Hour budget per account: how many hours of *this* model are still left.
    // free-pi meters in hours (1 h = 5 bucks) and every model costs a multiple
    // of the base rate, so the same 15000 credits are only 4.2 hours on a 2.0x
    // model. ?model=<id> selects the multiplier (default: the cheapest model).
    if (req.method === 'GET' && url.pathname === '/budget') {
      syncStore()
        .catch(() => null)
        .then(function () {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(budgetSnapshot(catalog, url.searchParams.get('model')), null, 2));
        })
        .catch(function (err) {
          // Read-only diagnostics must never take the proxy down: without this
          // an exception inside the snapshot is an unhandled rejection.
          console.error('[/budget] ' + err.message);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'budget snapshot failed', type: 'proxy_error' } }));
        });
      return;
    }

    // Local diagnostics: what is left, what the rotator plans to do.
    if (req.method === 'GET' && (url.pathname === '/usage' || url.pathname === '/accounts')) {
      syncStore()
        .catch(() => null)
        .then(function () {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(usageSnapshot(), null, 2));
        })
        .catch(function (err) {
          console.error('[/usage] ' + err.message);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'usage snapshot failed', type: 'proxy_error' } }));
        });
      return;
    }

    // Per-day consumption: credits per UTC day from the persisted totals.
    // ?limit=N returns the newest N days (default 30, max 365).
    if (req.method === 'GET' && url.pathname === '/history') {
      syncStore()
        .catch(() => null)
        .then(function () {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(historySnapshot(historyLimit(url)), null, 2));
        })
        .catch(function (err) {
          console.error('[/history] ' + err.message);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'history snapshot failed', type: 'proxy_error' } }));
        });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      syncStore()
        .then(function () { proxyCompletions(req, res); }, function () {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Cannot read the account selection. Check the local proxy settings.', type: 'account_selection_unavailable' } }));
        });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
  });

  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + PORT + ' in use. Set FREEPI_PROXY_PORT=other.');
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, HOST, function() {
    const W = 60, sep = '='.repeat(W);
    const displayHost = HOST === '0.0.0.0' ? '0.0.0.0' : HOST;
    console.log('\n' + sep);
    console.log(' free-pi proxy  ->  http://' + displayHost + ':' + PORT + '/v1' + (BIND_CONFIG.authRequired ? ' (API key required)' : ''));
    console.log(sep);
    console.log(' opencode.json:');
    console.log('   {');
    console.log('     "provider": "openai",');
    console.log('     "openai": {');
    console.log('       "baseUrl": "http://' + displayHost + ':' + PORT + '/v1",');
    console.log('       "apiKey": "' + (BIND_CONFIG.authRequired ? '<FREEPI_PROXY_API_KEY>' : 'freepi-proxy') + '"');
    console.log('     }');
    console.log('   }');
    console.log(sep);
    console.log(' usage:   GET http://' + displayHost + ':' + PORT + '/usage');
    console.log(' accounts: node tools/freepi-accounts.mjs status');
    console.log(sep);
    console.log(' Models (copy an ID into the opencode "model" setting):');
    console.log(sep);
    for (const m of catalog)
      console.log('   ' + m.id.padEnd(44) + ' ' + m.name);
    console.log(sep);
    console.log(' Suggested: "model": "' + catalog[0].id + '"');
    console.log(sep + '\n');
  });
  return server;
}

async function main() {
  if (BIND_CONFIG.misconfiguredPublic) {
    console.error('[security] Refusing to listen publicly on ' + HOST + ':' + PORT + ' without FREEPI_PROXY_API_KEY.');
    console.error('[security] Set FREEPI_PROXY_API_KEY (or keep FREEPI_PROXY_HOST=127.0.0.1 for local use).');
    process.exit(1);
  }
  const { store, seeded } = await ensureStore();
  STORE = store;
  // Restore which accounts were waiting for a display before the last stop, so
  // their windows get reopened instead of the proxy pretending all is well.
  loadAdState();
  await syncManualSelection();
  if (!STORE.accounts.length) {
    console.error('No free-pi account available.');
    console.error('Run  npx free-pi-cli  once, or:  node tools/freepi-accounts.mjs add');
    console.error('Expected credentials: ' + CREDENTIALS_PATH);
    process.exit(1);
  }
  if (seeded) console.log('[rotator] seeded account store at ' + STORE_PATH);

  // Measure everything once at startup so the very first request is routed well.
  const results = await refreshAll(STORE, { force: true });
  await persist();
  for (const r of results) {
    const a = findAccount(STORE, r.id);
    const u = a && a.usage;
    console.log(
      `[rotator] ${String(r.id).padEnd(8)} ${String(a && (a.handle || a.email)).padEnd(16)} ` +
      (u ? `${u.remainingCreditsToday} / ${u.allowanceCredits} credits left` : (r.reason || '?')),
    );
  }

  const active = activeAccount();
  const tokenCandidates = [];
  if (active && active.token) tokenCandidates.push(active.token);
  for (const a of STORE.accounts || []) {
    if (a && a.token && !a.disabled && !tokenCandidates.includes(a.token)) tokenCandidates.push(a.token);
  }
  let data = {};
  let models = null;
  for (const tok of (tokenCandidates.length ? tokenCandidates : [null])) {
    data = await fetchCatalogFor(tok);
    if (Array.isArray(data.models) && data.models.length) {
      models = data.models;
      break;
    }
  }
  if (data.notice) console.log('[free-pi] ' + data.notice);
  // free-pi publishes no modality metadata, so VISION_KNOWN stays empty and
  // supportsVision() falls back to the family lists above.
  if (models) {
    const withVision = models.filter(function(m) { return supportsVision(m.id); }).map(function(m) { return m.id; });
    console.log('[free-pi] image input: ' + (withVision.length ? withVision.join(', ') : 'none'));
  }

  const sponsorHtml = await fs.readFile(new URL('./tools/sponsor.html', import.meta.url), 'utf8');
  const server = startServer(models, sponsorHtml);
  const shutdown = () => {
    try { server.close(() => process.exit(0)); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  // Pick up models free-pi launches later instead of 404ing them until a restart.
  startCatalogRefresh(function () {
    const a = activeAccount() || (STORE && STORE.accounts && STORE.accounts.find(x => x && x.token && !x.disabled));
    return a ? a.token : null;
  }, 30 * 60 * 1000);
  runUsageLoop().catch(function() {});
  runAdLoop().catch(function() {});
  if (!BIND_CONFIG.isCloudRun) {
    console.log('[sponsor] Open http://127.0.0.1:' + PORT + '/sponsor and keep the sponsor card visible.');
  }
}

main().catch(function(err) { console.error('[proxy] Fatal:', err); process.exit(1); });
