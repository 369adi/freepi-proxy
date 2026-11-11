// accounts.mjs — account lifecycle helpers shared by the CLI and the proxy.
//
// One place that knows how to (a) measure an account, (b) log a new one in via
// the headless GitHub device flow, and (c) seed the store from the credentials
// file that free-pi-cli itself wrote.

import fs from 'node:fs/promises';
import {
  getMe,
  deviceStart,
  deviceConsent,
  devicePoll,
  ApiError,
  tokenExpired,
} from './freepi-api.mjs';
import {
  loadStore,
  mustLoadStore,
  saveStore,
  parseJsonText,
  addAccount,
  findAccount,
  findAccountByEmail,
  recordUsage,
  markExhausted,
  markInvalid,
  LEGACY_CREDENTIALS_PATH,
} from './store.mjs';
import { decide, STATE, stateOf } from './policy.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Measure one account via /me and persist what changed. */
export async function refreshAccount(store, account, now = Date.now()) {
  if (!account.token) {
    markInvalid(account, 'no token');
    return { ok: false, reason: 'no token' };
  }
  if (tokenExpired(account.token, now)) {
    markInvalid(account, 'token expired — log in again with `freepi-accounts add`');
    return { ok: false, reason: 'token expired' };
  }
  try {
    const me = await getMe(account.token);
    account.tokenBad = false;
    recordUsage(store, account, me, now);
    return { ok: true, usage: account.usage };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      markInvalid(account, 'token rejected (401)');
      return { ok: false, reason: 'unauthorized' };
    }
    if (err instanceof ApiError && err.status === 402) {
      markExhausted(account, err.message);
      return { ok: false, reason: 'exhausted' };
    }
    account.lastError = err.message;
    return { ok: false, reason: err.message };
  }
}

/** Refresh only accounts that need it (active account + anything stale). */
export async function refreshAll(store, { now = Date.now(), force = false } = {}) {
  const results = [];
  for (const account of store.accounts) {
    if (account.disabled) continue;
    if (!force) {
      const st = stateOf(account, now, store.settings);
      if (st === STATE.READY && !force) {
        // still fresh and healthy: no need to hit the API every tick
        const fetched = account.usage?.fetchedAt ? Date.parse(account.usage.fetchedAt) : 0;
        if (now - fetched < 5 * 60 * 1000) {
          results.push({ id: account.id, skipped: true });
          continue;
        }
      }
    }
    results.push({ id: account.id, ...(await refreshAccount(store, account, now)) });
  }
  return results;
}

/**
 * Run the headless GitHub device flow to obtain a token for a new (or existing)
 * GitHub account. Calls `onCode` as soon as the user code is known so the CLI
 * can print it before the long wait starts.
 *
 * @returns {Promise<{token:string}>}
 */
export async function loginWithDeviceFlow({ onCode, timeoutMs = 15 * 60 * 1000, pollMs } = {}) {
  const dev = await deviceStart();
  const deadline = Date.now() + Math.min(timeoutMs, (dev.expires_in || 900) * 1000);
  const interval = pollMs || Math.max(1, dev.interval || 5) * 1000;

  if (onCode) {
    await onCode({
      userCode: dev.user_code,
      verificationUri: dev.verification_uri || 'https://github.com/login/device',
      verificationUriComplete: dev.verification_uri_complete || null,
      sessionId: dev.session_id,
      expiresIn: dev.expires_in || 900,
    });
  }

  let consented = false;
  let networkFailures = 0;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await devicePoll(dev.session_id);
      networkFailures = 0;
    } catch (err) {
      // 403 consent_required: accept the first-run consent once, then retry.
      if (err instanceof ApiError && err.status === 403 && err.code === 'consent_required') {
        if (!consented) {
          await deviceConsent(dev.session_id);
          consented = true;
          await sleep(interval);
          continue;
        }
        throw new Error('consent accepted but the API still asks for it');
      }
      if (err instanceof ApiError && /expired/i.test(err.message || '')) {
        throw new Error('device code expired — start again');
      }
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err;
      networkFailures++;
      if (networkFailures >= 6) throw new Error(`token poll failed: ${err.message}`);
    }

    if (res && typeof res.token === 'string' && res.token) {
      return { token: res.token };
    }
    await sleep(interval);
  }
  throw new Error('login timed out — nobody authorized the code');
}

/**
 * Seed the store from free-pi-cli's own credentials.json so an existing setup
 * keeps working unchanged the first time the rotator runs.
 */
export async function importLegacyCredentials(store, path = LEGACY_CREDENTIALS_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return null;
  }
  const token = typeof parsed?.token === 'string' && parsed.token ? parsed.token : null;
  if (!token) return null;
  if (store.accounts.some(a => a.token === token)) return store.accounts.find(a => a.token === token) || null;

  const account = addAccount(store, { token, email: null, notes: 'imported from free-pi-cli credentials.json' });
  await refreshAccount(store, account);
  if (account.handle) {
    // Re-derive a stable pseudo-email so the identity is easy to recognise.
    account.email = `${account.handle}@github`;
  }
  return account;
}

/**
 * Seed an empty store from container env (`FREEPI_ACCOUNTS_JSON`) or a mounted
 * Secret Manager file (`FREEPI_ACCOUNTS_SEED_PATH`). Never runs when the local
 * store already holds accounts, so live counters and rotations are preserved.
 */
export async function importCloudSeed(store, env = process.env) {
  let raw = typeof env.FREEPI_ACCOUNTS_JSON === 'string' ? env.FREEPI_ACCOUNTS_JSON.trim() : '';
  let sourceLabel = 'FREEPI_ACCOUNTS_JSON';
  if (raw) {
    if (!raw.startsWith('{') && !raw.startsWith('[') && !raw.startsWith('\uFEFF')) {
      raw = Buffer.from(raw, 'base64').toString('utf8');
    }
  } else if (typeof env.FREEPI_ACCOUNTS_SEED_PATH === 'string' && env.FREEPI_ACCOUNTS_SEED_PATH.trim()) {
    const seedPath = env.FREEPI_ACCOUNTS_SEED_PATH.trim();
    sourceLabel = `FREEPI_ACCOUNTS_SEED_PATH (${seedPath})`;
    try {
      raw = await fs.readFile(seedPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw new Error(`Cannot read ${sourceLabel}: ${err.message}`);
    }
  } else {
    return false;
  }

  let parsed;
  try {
    parsed = parseJsonText(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${sourceLabel}: ${err.message}`);
  }

  const rawAccounts = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)
      ? parsed.accounts
      : null;

  if (!rawAccounts) {
    throw new Error(`${sourceLabel} must contain an accounts array`);
  }

  const validAccounts = rawAccounts.filter(
    (a) => a && typeof a === 'object' && typeof a.token === 'string' && a.token.trim(),
  );
  if (!validAccounts.length) {
    throw new Error(`${sourceLabel} contains no accounts with a valid token`);
  }

  if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
    if (parsed.settings && typeof parsed.settings === 'object') {
      store.settings = { ...store.settings, ...parsed.settings };
    }
    if (parsed.totals && typeof parsed.totals === 'object') {
      store.totals = { ...store.totals, ...parsed.totals };
    }
    if (Number.isFinite(parsed.nextAccountNumber) && parsed.nextAccountNumber >= 1) {
      store.nextAccountNumber = parsed.nextAccountNumber;
    }
    if (typeof parsed.activeAccountId === 'string' && parsed.activeAccountId) {
      store.activeAccountId = parsed.activeAccountId;
    }
  }

  const seenIds = new Set();
  for (const src of validAccounts) {
    const n = Number.isFinite(src.number) && src.number >= 1 ? src.number : store.nextAccountNumber++;
    let id = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : `acc-${n}`;
    while (seenIds.has(id)) id = `acc-${store.nextAccountNumber++}`;
    seenIds.add(id);
    if (n >= store.nextAccountNumber) store.nextAccountNumber = n + 1;
    store.accounts.push({
      id,
      number: n,
      email: src.email || null,
      handle: src.handle || null,
      userId: src.userId || null,
      token: src.token.trim(),
      createdAt: src.createdAt || new Date().toISOString(),
      lastUsedAt: src.lastUsedAt || null,
      lastError: null,
      disabled: Boolean(src.disabled),
      tokenBad: Boolean(src.tokenBad),
      tokenExpiresAt: src.tokenExpiresAt || null,
      usage: src.usage || null,
      day: src.day || null,
      history: Array.isArray(src.history) ? src.history : [],
      notes: src.notes || null,
    });
  }

  if (!store.activeAccountId || !findAccount(store, store.activeAccountId)) {
    const first = store.accounts.find((a) => !a.disabled && !a.tokenBad) || store.accounts[0] || null;
    store.activeAccountId = first ? first.id : null;
  }
  return true;
}

/** Make sure the store has at least one account and a valid activeAccountId. */
export async function ensureStore({ file } = {}) {
  // This function may write, so it must not treat an unreadable store as empty:
  // that would seed a fresh one and overwrite the original file.
  const store = await mustLoadStore(file);
  if (!store.accounts.length) {
    const seededFromCloud = await importCloudSeed(store);
    if (seededFromCloud) {
      await saveStore(store, file);
      return { store, seeded: true };
    }
    const imported = await importLegacyCredentials(store);
    if (imported) await saveStore(store, file);
    return { store, seeded: Boolean(imported) };
  }
  if (!store.activeAccountId || !findAccount(store, store.activeAccountId)) {
    const first = store.accounts.find(a => !a.disabled) || null;
    store.activeAccountId = first ? first.id : null;
  }
  return { store, seeded: false };
}

export { decide };
