#!/usr/bin/env node
// free-pi proxy ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â OpenAI-compatible local gateway with multi-account rotation.
//
// One local endpoint, many free-pi accounts: the rotator measures each account's
// live budget via GET /me, keeps using the active one until it gets low, then
// switches to another existing account. A brand-new GitHub account is only
// needed when *every* known account is out of budget and no daily refill is
// imminent ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â see tools/lib/policy.mjs for that decision.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { bindRequestLifecycle } from './tools/lib/request-lifecycle.mjs';
import { createSponsorPanel } from './tools/lib/sponsor-panel.mjs';

import { loadStore, saveStore, findAccount, markExhausted, markInvalid, STORE_PATH } from './tools/lib/store.mjs';
import { decide, describe, stateOf, sortForPick, USABLE, STATE } from './tools/lib/policy.mjs';
import { ensureStore, refreshAccount, refreshAll } from './tools/lib/accounts.mjs';
import { getCatalog } from './tools/lib/freepi-api.mjs';
import { budgetSummary, modelMultiplier, burnRatePerHour, runwayHours, CREDITS_PER_HOUR, creditsToHours } from './tools/lib/budget.mjs';

const FREEPI_BASE    = 'https://api.freepi.ai';
const FREEPI_VERSION = '0.6.15';   // keep in sync with upstream minimum
const PORT           = Number(process.env.FREEPI_PROXY_PORT ?? 4000);
const AD_INTERVAL_MS = 30_000;
const USAGE_POLL_MS  = Number(process.env.FREEPI_USAGE_POLL_MS ?? 60_000);
const CREDENTIALS_PATH = path.join(os.homedir(), '.free-pi', 'agent', 'credentials.json');
const SESSION_ID = crypto.randomUUID();

// free-pi allows exactly ONE in-flight request per account ("one request at a
// time"). Parallel clients - a harness running several subagents - would all but
// one get 429. Two layers fix that:
//   1. one lane per account, so N accounts serve N concurrent requests,
//   2. a FIFO queue, so extra requests wait instead of failing.
const MAX_QUEUE = Number(process.env.FREEPI_MAX_QUEUE ?? 64);

/**
 * Queue a request that found no free account lane. The callback is retried
 * every time a lane frees up. Unlike enqueue() this does not reserve an
 * upstream slot - lanes are the concurrency limit now.
 */
const claimWaiters = [];

function enqueueClaim(attemptClaim) {
  // Cancelled waiters must not consume queue slots: pruning here keeps a long
  // outage from reporting 64 waiting requests when nobody is waiting anymore.
  for (let i = claimWaiters.length - 1; i >= 0; i--) {
    if (claimWaiters[i].cancelled) claimWaiters.splice(i, 1);
  }
  if (claimWaiters.length >= MAX_QUEUE) return { accepted: false };
  const waiter = { attemptClaim, cancelled: false };
  claimWaiters.push(waiter);
  const position = claimWaiters.length;
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
    if (!usableAccounts().some(a => !laneBusy.has(a.id))) return; // no lane free
    claimWaiters.splice(i, 1);
    try { waiter.attemptClaim(); } catch (e) { console.error('[queue] ' + e.message); }
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
      console.log(`[rotator] switch -> ${target.id} (${target.handle || target.email || '?'}) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${decision.reason}`);
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
    console.warn(`[rotator] all accounts exhausted; next refill ${decision.until} ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â requests will fail until then`);
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
 * Candidate accounts to retry with, best first. `exclude` is an id or a set of
 * ids that already failed for this request: bouncing back to one of them burns
 * upstream requests without any chance of progress.
 */
function retryCandidates(exclude) {
  if (!STORE) return [];
  if (MANUAL_ACCOUNT_ID) return [];
  const skip = exclude instanceof Set ? exclude : new Set([exclude].filter(Boolean));
  const now = Date.now();
  return STORE.accounts
    .filter(a => !a.disabled && !skip.has(a.id) && !a.tokenBad && a.token && !laneBusy.has(a.id) && !inAdCooldown(a.id, now))
    .map(a => ({ account: a, state: stateOf(a, now, STORE.settings) }))
    .filter(x => USABLE.has(x.state))
    // Daily allowance first, premium-only accounts last (sortForPick).
    .sort(sortForPick)
    .map(x => x.account);
}

// ------------------------------------------- accounts waiting for a sponsor ad
//
// free-pi answers 403 {"code":"ads_required"} until an account has really seen
// an ad. Retrying such an account on every request only produces 403s that the
// harness misreads as "API key is invalid", so it is parked until its sponsor
// window has shown something (or the cooldown expires, whichever is first).

const AD_COOLDOWN_MS = 10 * 60 * 1000;
const adBlocked = new Map();   // account id -> when the block was recorded

function markAdsRequired(id) {
  adBlocked.set(id, Date.now());
}

/** Called by the sponsor panel once an account has displayed a real ad. */
function clearAdsRequired(id) {
  adBlocked.delete(id);
}

function inAdCooldown(id, now = Date.now()) {
  const at = adBlocked.get(id);
  if (at === undefined) return false;
  if (now - at > AD_COOLDOWN_MS) { adBlocked.delete(id); return false; }
  return true;
}

// ------------------------------------------------ multi-account request lanes
//
// free-pi allows ONE in-flight request per account, but a harness running
// several subagents needs real parallelism. So each account is a lane: a request
// claims a free account, runs on it, and frees it again. With N accounts we get
// N truly concurrent requests; a request only queues when every lane is busy.

const laneBusy = new Set();   // account ids currently serving a request

/**
 * All accounts usable right now, best first: accounts with daily allowance
 * before premium-only ones, then most spendable credits, then idlest. A
 * premium-only account still gets a lane, but only after every normal one.
 */
function usableAccounts() {
  if (!STORE) return [];
  if (MANUAL_ACCOUNT_ID) {
    const selected = activeAccount();
    return selected && selected.token && !selected.disabled && !selected.tokenBad ? [selected] : [];
  }
  const now = Date.now();
  return STORE.accounts
    .filter(a => !a.disabled && !a.tokenBad && a.token)
    .map(a => ({ account: a, state: stateOf(a, now, STORE.settings) }))
    .filter(x => USABLE.has(x.state))
    .sort(sortForPick)
    .map(x => x.account);
}

/**
 * Claim a free account for one request. Returns {account, release} or null when
 * every lane is busy. A free lane is preferred over the sticky active account so
 * parallel subagents spread across accounts instead of colliding on one.
 */
function claimAccount() {
  const usable = usableAccounts();
  if (!usable.length) {
    // No measured-but-usable account: fall back to the rotator decision path,
    // which may refresh stale data or report a quota problem.
    return null;
  }
  const free = usable.filter(a => !laneBusy.has(a.id));
  if (!free.length) return null;
  // Round-robin-ish: least recently used among free lanes keeps wear even.
  free.sort((a, b) => {
    const la = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
    const lb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
    return la - lb;
  });
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
function claimFor(id) {
  const account = usableAccounts().find(a => a.id === id) || null;
  if (!account) return null;
  if (laneBusy.has(account.id)) return null;
  laneBusy.add(account.id);
  account.lastUsedAt = new Date().toISOString();
  return { account, release: makeRelease(account) };
}

function laneCount() {
  return usableAccounts().length;
}

async function promote(account, reason) {
  if (!STORE || !account) return;
  STORE.activeAccountId = account.id;
  account.lastUsedAt = new Date().toISOString();
  await persist();
  console.log(`[rotator] retry on ${account.id} (${account.handle || account.email || '?'}) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${reason}`);
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

async function fetchAd(token) {
  try {
    return await httpsGet(`${FREEPI_BASE}/ads/next?slot=banner`, {
      authorization: `Bearer ${token}`,
      'x-session-id': SESSION_ID,
      'x-client-version': FREEPI_VERSION,
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
const sponsorNudgedAt = new Map();   // account id -> last time we opened its panel

/** Window URL for one account; every account needs its own. */
function sponsorUrlFor(account) {
  return account?.id ? SPONSOR_URL + '?account=' + encodeURIComponent(account.id) : SPONSOR_URL;
}

function openSponsorPanel(account) {
  const now = Date.now();
  const key = account?.id || '-';
  // Per account: a blocked account needs its own window even when another one
  // was opened a moment ago.
  if (now - (sponsorNudgedAt.get(key) || 0) < SPONSOR_NUDGE_MS) return false;
  sponsorNudgedAt.set(key, now);
  const url = sponsorUrlFor(account);
  console.log('[sponsor] free-pi asked for a sponsor view - opening ' + url);
  try {
    // `start` needs an empty title argument; the URL is ours, not user input.
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    console.error('[sponsor] could not open a browser: ' + err.message);
  }
  return true;
}

/** Turn an upstream ads_required body into an actionable error for the client. */
function adsRequiredBody() {
  return Buffer.from(JSON.stringify({
    error: {
      message:
        'free-pi requires a sponsor view for this account. ' + SPONSOR_URL +
        ' was opened - keep the card visible for a moment, then retry.',
      type: 'ads_required',
      sponsor_url: SPONSOR_URL,
    },
  }));
}

/**
 * Wrap a raw upstream error payload in the OpenAI error envelope. Clients
 * render `error.message`; a bare upstream body is silently swallowed.
 */
function upstreamErrorBody(raw, fallbackMessage) {
  let message = fallbackMessage;
  let type = 'upstream_error';
  const text = raw && raw.length ? raw.toString() : '';
  if (text) {
    try {
      const parsed = JSON.parse(text);
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
  return Buffer.from(JSON.stringify({ error: { message, type } }));
}

async function runAdLoop() {
  const tick = async () => {
    const account = activeAccount();
    if (!account || !account.token) return;
    const a = await fetchAd(account.token);
    if (a && a.status === 200) renderAd(a);
  };
  await tick();
  setInterval(tick, AD_INTERVAL_MS);
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
        return;
      }
      await refreshAll(STORE, { now: Date.now() });
      await persist();
      const d = decide(STORE, Date.now(), STORE.settings);
      if (d.action === 'switch') {
        const target = findAccount(STORE, d.accountId);
        if (target) {
          STORE.activeAccountId = target.id;
          await persist();
          console.log(`[rotator] proactive switch -> ${target.id} ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${d.reason}`);
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

const QUOTA_STATUS = new Set([402, 429]);

/**
 * Forward one chat completion. If the upstream rejects it because the account's
 * budget is used up, that account is marked exhausted and the same request is
 * retried on the next usable account (nothing has been sent to the client yet).
 */
function proxyCompletions(inReq, inRes, attempt = 0) {
  const chunks = [];
  inReq.on('data', c => chunks.push(c));
  inReq.on('end', async () => {
    const body = Buffer.concat(chunks);
    if (MANUAL_ACCOUNT_ID && !usableAccounts().length) {
      inRes.writeHead(401, { 'content-type': 'application/json' });
      inRes.end(JSON.stringify({ error: { message: 'The selected account needs a valid sign-in. Use /freepi-switch to select an existing account.', type: 'selected_account_unavailable' } }));
      return;
    }
    try { const p = JSON.parse(body); if (p.model) console.log('[proxy] -> ' + p.model); } catch {}

    // Take a free account lane if one exists; otherwise wait in the queue and
    // claim a lane as soon as another request frees it.
    const start = (claimed) => {
      let account = claimed ? claimed.account : null;
      let releaseLane = claimed ? claimed.release : () => {};

      const withAccount = async () => {
        if (!account) {
          // No lane was claimed (nothing usable at claim time). The fallback
          // still has to hold a lane, otherwise this request could run beside
          // another one on the same account and trigger a "concurrent" reject.
          const fallback = await chooseAccount();
          const reclaimed = fallback ? claimFor(fallback.id) : null;
          if (reclaimed) { account = reclaimed.account; releaseLane = reclaimed.release; }
        }
        if (!account || !account.token) {
          releaseLane();
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
      const claimed = claimAccount();
      if (claimed) { start(claimed); return true; }
      return false;
    };

    if (!tryClaim()) {
      // Every lane busy: queue, and claim a lane when one frees up.
      const slot = enqueueClaim(() => { tryClaim(); });
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
      inRes.on('close', () => { if (!inRes.writableEnded) slot.cancel?.(); });
      return;
    }

    function run(account, releaseLane) {
    // The lane is claimed once for the whole client request. A retry only swaps
    // the *account*, never the lane: releasing it here would let a queued
    // request claim the same account and collide with our own retry.
    let laneReleased = false;
    const releaseLaneOnce = () => {
      if (laneReleased) return;
      laneReleased = true;
      releaseLane();
    };

    let retries = 0;
    const tried = new Set();      // accounts that already failed this request
    const MAX_RETRIES = 4;        // concurrent races tolerated on one account
    const MAX_SWAPS = 3;          // account switches for one client request
    let swaps = 0;

    const send = (token) => {
      const upReq = https.request({
        hostname: 'api.freepi.ai',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: Object.assign(
          {
            'content-type': 'application/json',
            'content-length': body.length,
            'authorization': 'Bearer ' + token,
            'x-session-id': SESSION_ID,
            'x-client-version': FREEPI_VERSION,
          },
          inReq.headers['accept']        ? { accept: inReq.headers['accept'] } : {},
          inReq.headers['x-request-id'] ? { 'x-request-id': inReq.headers['x-request-id'] } : {},
        ),
      }, upRes => {
        if (QUOTA_STATUS.has(upRes.statusCode) && inRes.headersSent) {
          // The upstream refused us after we had already committed a 200 to the
          // client (it happens on streamed responses). Nothing can be salvaged,
          // so make sure the account is retired and the client sees a real
          // error instead of a silently truncated body.
          const errChunks = [];
          upRes.on('data', d => errChunks.push(d));
          upRes.on('end', () => {
            markExhausted(account, `upstream ${upRes.statusCode}`);
            account.usage = account.usage || {};
            account.usage.remainingCreditsToday = 0;
            persist().catch(() => {});
            console.warn(`[rotator] ${account.id} returned ${upRes.statusCode} mid-stream - aborting response`);
            inRes.destroy(new Error('upstream quota exhausted mid-stream (' + upRes.statusCode + ')'));
            releaseLaneOnce();
          });
          return;
        }
        if (QUOTA_STATUS.has(upRes.statusCode) && !inRes.headersSent) {
          const errChunks = [];
          upRes.on('data', d => errChunks.push(d));
          upRes.on('end', () => {
            const raw = Buffer.concat(errChunks);
            // "concurrent" means *we* sent two requests at once, not that the
            // account is out of credits - never mark it exhausted for that.
            let code = '';
            try { code = JSON.parse(raw.toString()).code || ''; } catch { /* ignore */ }
            if (code === 'concurrent' || raw.toString().includes('one request at a time')) {
              // Another client raced us on this account (e.g. the pi TUI). The
              // lane stays ours, so retry on it after a short backoff.
              console.warn('[proxy] upstream said concurrent - retrying after backoff');
              retries++;
              if (retries > MAX_RETRIES) { releaseLaneOnce(); relay(429, raw); return; }
              setTimeout(() => {
                if (inRes.destroyed) { releaseLaneOnce(); return; }
                send(account.token);
              }, 400 * retries);
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
          upRes.on('end', () => {
            const raw = Buffer.concat(errChunks);
            releaseLaneOnce();
            if (raw.toString().includes('ads_required')) {
              // Park this account until its own sponsor window has shown an ad,
              // so the next requests go to a working account instead of
              // repeating the same 403 on every call.
              markAdsRequired(account.id);
              openSponsorPanel(account);
              relay(403, adsRequiredBody());
              return;
            }
            // Never hand a raw upstream payload to the client: an OpenAI client
            // expects {error:{message,type}} and otherwise shows nothing useful.
            relay(403, upstreamErrorBody(raw, 'upstream refused the request (403)'));
          });
          return;
        }
        const h = {
          'access-control-allow-origin': '*',
          'content-type': upRes.headers['content-type'] || 'application/json',
        };
        if (upRes.headers['cache-control'])     h['cache-control']     = upRes.headers['cache-control'];
        if (upRes.headers['transfer-encoding']) h['transfer-encoding'] = upRes.headers['transfer-encoding'];
        inRes.writeHead(upRes.statusCode, h);
        upRes.pipe(inRes);
        upRes.on('end', releaseLaneOnce);
        upRes.on('error', releaseLaneOnce);
      });
      upReq.on('error', err => {
        console.error('[proxy] upstream error: ' + err.message);
        if (inRes.destroyed) { releaseLaneOnce(); return; }
        // The upstream transport failing says nothing about the account, so try
        // a different lane instead of handing the client a 502 straight away.
        if (!inRes.headersSent && retries < 2) {
          retries++;
          tried.add(account.id);
          const next = retryCandidates(tried)[0];
          if (next) {
            console.warn(`[proxy] ${account.id} unreachable (${err.message}) - retrying on ${next.id}`);
            account = next;
            setTimeout(() => { if (!inRes.destroyed) send(next.token); }, 300 * retries);
            return;
          }
        }
        if (!inRes.headersSent) {
          releaseLaneOnce();
          inRes.writeHead(502, { 'content-type': 'application/json' });
          inRes.end(JSON.stringify({ error: { message: 'upstream: ' + err.message, type: 'proxy_error' } }));
        } else { inRes.destroy(err); releaseLaneOnce(); }
      });
      bindRequestLifecycle(upReq, inRes, releaseLaneOnce);
      upReq.write(body);
      upReq.end();
    };

    const relay = (status, buf) => {
      if (inRes.headersSent) { inRes.end(); return; }
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
      const next = retryCandidates(tried)[0];
      if (!next) return false;
      swaps++;
      await promote(next, reason);
      account = next;
      retries = 0;   // a fresh account deserves a fresh "concurrent" budget
      send(next.token);
      return true;
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
    accounts: (STORE ? STORE.accounts : []).map(a => ({
      ...describe(a, now, STORE.settings),
      // true while free-pi wants a sponsor view for this account; the window at
      // /sponsor?account=<id> clears it once the ad was really displayed.
      adsRequired: inAdCooldown(a.id, now),
    })),
  };
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

function startServer(models, sponsorHtml) {
  const catalog = (Array.isArray(models) && models.length)
    ? models
    : [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }];

  const sponsorPanel = createSponsorPanel({
    currentAccount: async () => { await syncStore(); return activeAccount(); },
    accounts: async () => { await syncStore(); return STORE.accounts || []; },
    sessionId: SESSION_ID,
    usage: usageSnapshot,
    html: sponsorHtml,
    port: PORT,
    onDisplayed: (accountId) => clearAdsRequired(accountId),
  });
  const server = http.createServer(async function(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
    if (url.pathname.startsWith('/sponsor')) { await sponsorPanel(req, res, url); return; }
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-request-id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

  server.listen(PORT, '127.0.0.1', function() {
    const W = 60, sep = '='.repeat(W);
    console.log('\n' + sep);
    console.log(' free-pi proxy  ->  http://127.0.0.1:' + PORT + '/v1');
    console.log(sep);
    console.log(' opencode.json:');
    console.log('   {');
    console.log('     "provider": "openai",');
    console.log('     "openai": {');
    console.log('       "baseUrl": "http://127.0.0.1:' + PORT + '/v1",');
    console.log('       "apiKey": "freepi-proxy"');
    console.log('     }');
    console.log('   }');
    console.log(sep);
    console.log(' usage:   GET http://127.0.0.1:' + PORT + '/usage');
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
}

async function main() {
  const { store, seeded } = await ensureStore();
  STORE = store;
  await syncManualSelection();
  if (!STORE.accounts.length) {
    console.error('No free-pi account available.');
    console.error('Run  npx free-pi-cli  once, or:  node tools/freepi-accounts.mjs add');
    console.error('Expected credentials: ' + CREDENTIALS_PATH);
    process.exit(1);
  }
  if (seeded) console.log('[rotator] imported existing credentials from ' + CREDENTIALS_PATH);

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
  const data = await fetchCatalogFor(active ? active.token : null);
  const models = Array.isArray(data.models) && data.models.length ? data.models : null;
  if (data.notice) console.log('[free-pi] ' + data.notice);
  // free-pi publishes no modality metadata, so VISION_KNOWN stays empty and
  // supportsVision() falls back to the family lists above.
  if (models) {
    const withVision = models.filter(function(m) { return supportsVision(m.id); }).map(function(m) { return m.id; });
    console.log('[free-pi] image input: ' + (withVision.length ? withVision.join(', ') : 'none'));
  }

  const sponsorHtml = await fs.readFile(new URL('./tools/sponsor.html', import.meta.url), 'utf8');
  startServer(models, sponsorHtml);
  runUsageLoop().catch(function() {});
  console.log('[sponsor] Open http://127.0.0.1:' + PORT + '/sponsor and keep the sponsor card visible.');
}

main().catch(function(err) { console.error('[proxy] Fatal:', err); process.exit(1); });
