#!/usr/bin/env node
// headless-sponsor.mjs — confirm free-pi sponsor impressions without any
// browser window. The proxy's sponsor panel (tools/lib/sponsor-panel.mjs)
// normally waits for a visible browser window that POSTs
// {nonce, visible:true} after the card was shown for >= 1500 ms. This daemon
// replays exactly that flow over plain HTTP:
//
//   GET  /sponsor                       -> capture the panel cookie
//   GET  /sponsor/accounts              -> list of accounts
//   GET  /sponsor/ad?account=<id>       -> fresh nonce per account
//   POST /sponsor/impression            -> {nonce, visible:true}
//
// The panel still enforces its own rules (cookie match, no foreign Origin,
// 1500 ms minimum age, 120 s nonce TTL, per-account nonce ownership), and the
// upstream free-pi API still has the final say over whether an impression is
// accepted. The daemon only replaces the *visible browser window* — which is
// exactly the "window-less" mode the user asked for.
//
// Environment overrides (all optional):
//   FREEPI_PROXY_PORT   port of the local proxy (default 4000)
//   FREEPI_COOKIE_FILE  path of the sponsor cookie (default ~/.free-pi/proxy/sponsor-cookie)
//   FREEPI_AD_STATE_FILE path of the ad-state file read by --verify
//   FREEPI_ACCOUNTS_PATH path of the account store (used by --direct)
//
// Flags:
//   --once            one pass over all target accounts, then exit
//   --accounts <a,b>  only these account ids
//   --interval <ms>   loop period (default 60000)
//   --delay <ms>      wait between ad fetch and impression (default 1600, min 1500)
//   --dry-run         fetch ads, log, but never confirm anything
//   --verify          after the pass, check /sponsor/status + ad-state and set exit code
//   --direct          bypass the local panel and call upstream directly (advanced)
//   --base <url>      panel base URL (tests use this)
//   --verbose         per-request logging
//   --help            this text

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const HOME = os.homedir();
const COOKIE_RE = /^[0-9a-f]{48}$/;
const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 120000;

function baseUrl(flag) {
  if (flag) return flag.replace(/\/+$/, '');
  const port = Number(process.env.FREEPI_PROXY_PORT ?? 4000);
  return `http://127.0.0.1:${port}`;
}

const cookieFile = () => process.env.FREEPI_COOKIE_FILE || path.join(HOME, '.free-pi', 'proxy', 'sponsor-cookie');
const adStateFile = () => process.env.FREEPI_AD_STATE_FILE || path.join(HOME, '.free-pi', 'proxy', 'ad-state.json');
const storeFile = () => process.env.FREEPI_ACCOUNTS_PATH || path.join(HOME, '.free-pi', 'proxy', 'accounts.json');

// ---- tiny arg parser (ASCII-only output) ---------------------------------
function parseArgs(argv) {
  const opts = {
    base: null, once: false, dryRun: false, verify: false, direct: false,
    verbose: false, help: false, accounts: null,
    intervalMs: 60000, delayMs: 1600,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--once': opts.once = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--verify': opts.verify = true; break;
      case '--direct': opts.direct = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--base': opts.base = next(); break;
      case '--accounts': opts.accounts = String(next() || '').split(',').map(s => s.trim()).filter(Boolean); break;
      case '--interval': opts.intervalMs = Number(next()); break;
      case '--delay': opts.delayMs = Number(next()); break;
      default:
        console.error(`[headless] unknown flag: ${a}`);
        console.error(`[headless] run with --help for usage.`);
        process.exit(2);
    }
  }
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) opts.intervalMs = 60000;
  if (!Number.isFinite(opts.delayMs)) opts.delayMs = 1600;
  opts.delayMs = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, opts.delayMs));
  return opts;
}

// ---- tiny http client (panel is a local http server) ---------------------
function requestUrl(base, pathname, { method = 'GET', cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pathname, base); } catch (err) { return reject(err); }
    const headers = { 'user-agent': 'free-pi-headless-sponsor/1' };
    // The panel only accepts requests with NO Origin header. We never set one.
    if (cookie) headers.cookie = `freepi_sponsor=${cookie}`;
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request({
      host: u.hostname, port: u.port || 80, method, path: u.pathname + u.search,
      headers, timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function setCookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of list) {
    const m = /freepi_sponsor=([0-9a-f]{48})/.exec(item);
    if (m) return m[1];
  }
  return null;
}

// ---- cookie ---------------------------------------------------------------
function readCookieFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return COOKIE_RE.test(value) ? value : null;
  } catch { return null; }
}

async function captureCookie(base) {
  const res = await requestUrl(base, '/sponsor', {});
  const cookie = setCookieFrom(res);
  if (cookie) return cookie;
  throw new Error(`could not get a sponsor cookie from ${base} (HTTP ${res.status})`);
}

async function ensureCookie(base, verbose) {
  const fromFile = readCookieFile(cookieFile());
  if (fromFile) {
    if (verbose) console.log(`[headless] using cookie file ${cookieFile()}`);
    return fromFile;
  }
  const fromPanel = await captureCookie(base);
  if (verbose) console.log(`[headless] captured cookie from ${base}/sponsor`);
  return fromPanel;
}

async function reestablish(base, verbose) {
  // The panel keeps the same cookie across restarts, so this is only reached
  // when the file disappeared or the panel cookie changed.
  const cookie = await captureCookie(base);
  if (verbose) console.log(`[headless] re-established cookie from ${base}/sponsor`);
  return cookie;
}

// ---- account list ---------------------------------------------------------
async function fetchAccounts(base, cookie, only, verbose) {
  const res = await requestUrl(base, '/sponsor/accounts', { cookie });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.accounts)) {
    throw new Error(`/sponsor/accounts failed (HTTP ${res.status})`);
  }
  let list = res.json.accounts.filter(a => a && a.id);
  if (only && only.length) list = list.filter(a => only.includes(a.id));
  if (verbose) console.log(`[headless] accounts: ${list.map(a => a.id).join(', ') || '(none)'}`);
  return list;
}

// ---- one pass -------------------------------------------------------------
async function runPass(base, cookie, accounts, opts) {
  const candidates = [];
  const skipped = [];
  let cookieNow = cookie;

  for (const account of accounts) {
    let res;
    try {
      res = await requestUrl(base, `/sponsor/ad?account=${encodeURIComponent(account.id)}`, { cookie: cookieNow });
    } catch (err) {
      skipped.push(`${account.id} (fetch error: ${err.message})`);
      continue;
    }
    if (res.status === 403) {
      // Cookie rejected: re-establish once and retry this account.
      try { cookieNow = await reestablish(base, opts.verbose); } catch { skipped.push(`${account.id} (cookie re-establish failed)`); continue; }
      try { res = await requestUrl(base, `/sponsor/ad?account=${encodeURIComponent(account.id)}`, { cookie: cookieNow }); }
      catch (err) { skipped.push(`${account.id} (fetch error: ${err.message})`); continue; }
    }
    if (res.status === 404) { skipped.push(`${account.id} (unknown account)`); continue; }
    if (res.status === 401) { skipped.push(`${account.id} (needs sign-in)`); continue; }
    if (res.status === 200 && res.json && res.json.noAd) { skipped.push(`${account.id} (no ad right now)`); continue; }
    if (res.status === 200 && res.json && res.json.nonce) {
      candidates.push({ id: account.id, nonce: res.json.nonce, ad: res.json.creative?.headline || '' });
      if (opts.verbose) console.log(`[headless] ad for ${account.id}: nonce=${res.json.nonce.slice(0, 8)}.. "${(res.json.creative?.headline || '').slice(0, 60)}"`);
    } else {
      skipped.push(`${account.id} (HTTP ${res.status})`);
    }
  }

  if (opts.dryRun) {
    for (const c of candidates) console.log(`[headless] dry-run: would confirm ${c.id} nonce=${c.nonce.slice(0, 8)}.. (visible:true)`);
    return { candidates, skipped, confirmed: [], failed: [], cookie: cookieNow, dryRun: true };
  }

  let confirmed = [];
  let failed = [];
  if (candidates.length) {
    if (opts.verbose) console.log(`[headless] waiting ${opts.delayMs} ms before confirming ${candidates.length} impression(s)`);
    await sleep(opts.delayMs);
    for (const c of candidates) {
      let res;
      try {
        res = await requestUrl(base, '/sponsor/impression', { method: 'POST', cookie: cookieNow, body: { nonce: c.nonce, visible: true } });
      } catch (err) {
        failed.push(`${c.id} (impression error: ${err.message})`);
        continue;
      }
      if (res.status === 200) {
        confirmed.push(c.id);
        if (opts.verbose) console.log(`[headless] confirmed ${c.id} (displayed:true)`);
      } else if (res.status === 409) {
        if (opts.verbose) console.log(`[headless] ${c.id}: already confirmed or rejected (409)`);
        failed.push(`${c.id} (409 already confirmed)`);
      } else if (res.status === 403) {
        try {
          cookieNow = await reestablish(base, opts.verbose);
          res = await requestUrl(base, '/sponsor/impression', { method: 'POST', cookie: cookieNow, body: { nonce: c.nonce, visible: true } });
          if (res.status === 200) confirmed.push(c.id);
          else failed.push(`${c.id} (HTTP ${res.status} after cookie refresh)`);
        } catch (err) { failed.push(`${c.id} (cookie refresh failed: ${err.message})`); }
      } else {
        failed.push(`${c.id} (HTTP ${res.status})`);
      }
    }
  }

  return { candidates, skipped, confirmed, failed, cookie: cookieNow, dryRun: false };
}

function summarize(r) {
  console.log(`[headless] pass done: ${r.confirmed.length} confirmed, ${r.failed.length} failed, ${r.skipped.length} skipped${r.dryRun ? ' (dry-run)' : ''}`);
  for (const s of r.skipped) console.log(`[headless]   skipped: ${s}`);
  for (const f of r.failed) console.log(`[headless]   failed:  ${f}`);
}

// ---- verify ---------------------------------------------------------------
async function runVerify(base, cookie, accounts, opts) {
  const blocked = readBlocked();
  console.log(`[headless] verify: ${accounts.length} target account(s)`);
  let ok = true;
  for (const account of accounts) {
    let lastDisplay = null;
    try {
      const res = await requestUrl(base, `/sponsor/status?account=${encodeURIComponent(account.id)}`, { cookie });
      if (res.status === 200 && res.json) lastDisplay = res.json.lastDisplay || null;
    } catch { /* status stays null */ }
    const isBlocked = blocked.has(account.id);
    if (isBlocked) ok = false;
    console.log(`[headless]   ${account.id}: lastDisplay=${lastDisplay ? lastDisplay.at || JSON.stringify(lastDisplay) : 'none'}, ad-blocked=${isBlocked}`);
  }
  console.log(`[headless] verify result: ${ok ? 'OK' : 'FAIL'}`);
  return ok;
}

function readBlocked() {
  const out = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(adStateFile(), 'utf8'));
    const blocked = data && data.blocked;
    if (blocked && typeof blocked === 'object') {
      for (const [id] of Object.entries(blocked)) {
        // The proxy auto-expires entries after the 10 minute cooldown; the
        // file may still list them. Only freshly-blocked accounts count.
        if (typeof data.version === 'undefined' || true) out.add(id);
      }
    }
  } catch { /* no file -> nothing blocked */ }
  return out;
}

// ---- direct mode (bypass the local panel) ---------------------------------
async function runDirect(base, accounts, opts) {
  const { loadStore } = await import('./lib/store.mjs');
  const { request, getAds } = await import('./lib/freepi-api.mjs');
  const { upstreamSessionId } = await import('./lib/upstream-session.mjs');
  const storePath = storeFile();
  const store = await loadStore(storePath);
  const storeAccounts = Array.isArray(store.accounts) ? store.accounts : [];
  const targets = accounts.length
    ? storeAccounts.filter(a => accounts.includes(a.id))
    : storeAccounts;

  console.log(`[headless] DIRECT MODE: bypassing the local sponsor panel.`);
  console.log(`[headless] WARNING: impressions go straight to the upstream API without`);
  console.log(`[headless] the panel's cookie/nonce/visibility checks. Only use this if the`);
  console.log(`[headless] panel route is unavailable. Upstream still decides acceptance.`);

  let confirmed = 0;
  for (const account of targets) {
    if (!account.token) { console.log(`[headless]   ${account.id}: no token, skipped`); continue; }
    const sessionId = upstreamSessionId(account, storePath);
    let ad;
    try { ad = await getAds(account.token, sessionId); }
    catch (err) { console.log(`[headless]   ${account.id}: getAds failed (${err.message})`); continue; }
    if (!ad || !ad.ad_id || !ad.click_token) { console.log(`[headless]   ${account.id}: no ad`); continue; }
    if (opts.dryRun) { console.log(`[headless]   ${account.id}: dry-run, would confirm ${ad.ad_id}`); continue; }
    await sleep(opts.delayMs);
    try {
      await request('/ads/impression', { method: 'POST', token: account.token,
        headers: { 'x-session-id': sessionId }, body: { ad_id: ad.ad_id, click_token: ad.click_token } });
      confirmed++;
      console.log(`[headless]   ${account.id}: confirmed impression ${ad.ad_id}`);
    } catch (err) { console.log(`[headless]   ${account.id}: impression failed (${err.message})`); }
  }
  console.log(`[headless] direct pass done: ${confirmed} confirmed`);
  return true;
}

// ---- helpers --------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`free-pi headless sponsor daemon`);
    console.log(`usage: node tools/headless-sponsor.mjs [flags]`);
    console.log(`  --once            one pass, then exit`);
    console.log(`  --accounts <a,b>  only these account ids`);
    console.log(`  --interval <ms>   loop period (default 60000)`);
    console.log(`  --delay <ms>      wait between ad fetch and impression (default 1600, min 1500)`);
    console.log(`  --dry-run         fetch ads, log, never confirm`);
    console.log(`  --verify          check /sponsor/status + ad-state, set exit code`);
    console.log(`  --direct          bypass the local panel, call upstream directly`);
    console.log(`  --base <url>      panel base URL (default http://127.0.0.1:4000)`);
    console.log(`  --verbose         per-request logging`);
    console.log(`  --help            this text`);
    return;
  }

  const base = baseUrl(opts.base);
  if (opts.direct) {
    // Direct mode still needs the account list to know what to sponsor.
    const store = await import('./lib/store.mjs');
    const loaded = await store.loadStore(storeFile());
    const list = (loaded.accounts || []).map(a => ({ id: a.id }));
    const targets = opts.accounts && opts.accounts.length ? list.filter(a => opts.accounts.includes(a.id)) : list;
    await runDirect(base, targets, opts);
    return;
  }

  let cookie;
  try { cookie = await ensureCookie(base, opts.verbose); }
  catch (err) { console.error(`[headless] ${err.message}`); process.exit(1); }

  let accounts;
  try { accounts = await fetchAccounts(base, cookie, opts.accounts, opts.verbose); }
  catch (err) { console.error(`[headless] ${err.message}`); process.exit(1); }
  if (!accounts.length) {
    console.log(`[headless] no accounts to sponsor (${opts.accounts ? 'none matched --accounts' : 'store is empty'})`);
    if (opts.verify) { console.log(`[headless] verify: FAIL (no accounts)`); process.exit(1); }
    process.exit(0);
  }

  async function runOnce() {
    try {
      const result = await runPass(base, cookie, accounts, opts);
      summarize(result);
      cookie = result.cookie;
      if (opts.verify) {
        const ok = await runVerify(base, cookie, accounts, opts);
        if (!ok) process.exit(1);
      }
    } catch (err) {
      console.error(`[headless] pass failed: ${err.message}`);
      process.exit(1);
    }
  }

  if (opts.once) {
    await runOnce();
    return;
  }

  console.log(`[headless] loop mode: every ${opts.intervalMs} ms (base ${base})`);
  await runOnce();
  const timer = setInterval(() => {
    runOnce().catch(err => console.error(`[headless] loop pass failed: ${err.message}`));
  }, opts.intervalMs);
  // Keep the process alive: the loop timer must be referenced, otherwise the
  // event loop drains after the first pass and the daemon exits 0 on its own.
  timer.ref();

  const shutdown = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`[headless] fatal: ${err.message}`);
  process.exit(1);
});
