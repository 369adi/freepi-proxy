// store.mjs — persistent account store for the free-pi rotator.
//
// Lives OUTSIDE the repository (tokens are secrets):
//   %USERPROFILE%\.free-pi\proxy\accounts.json
// Override with FREEPI_ACCOUNTS_PATH.
//
// Everything the rotator needs to "remember" is here: which accounts exist,
// what each one has left today, when its budget refills, which one is active,
// and how much was used per day in total.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decodeJwt } from './freepi-api.mjs';

export const STORE_VERSION = 1;
export const STORE_PATH =
  process.env.FREEPI_ACCOUNTS_PATH ||
  path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');

/** Legacy single-account credentials written by free-pi-cli itself. */
export const LEGACY_CREDENTIALS_PATH = path.join(os.homedir(), '.free-pi', 'agent', 'credentials.json');

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function emptyStore() {
  return {
    version: STORE_VERSION,
    activeAccountId: null,
    nextAccountNumber: 1,
    settings: {
      lowWatermark: 0.1, // switch away below 10% of the daily allowance
      mintGraceMs: 20 * 60 * 1000, // wait instead of minting if a refill is this close
      emailDomain: 'arisya.de',
      emailPrefix: 'gh',
    },
    totals: { accountsMinted: 0, creditsUsedTotal: 0, byDay: {} },
    accounts: [],
  };
}

function normalize(store) {
  const base = emptyStore();
  const s = { ...base, ...(store && typeof store === 'object' ? store : {}) };
  s.settings = { ...base.settings, ...(s.settings && typeof s.settings === 'object' ? s.settings : {}) };
  s.totals = { ...base.totals, ...(s.totals && typeof s.totals === 'object' ? s.totals : {}) };
  if (!s.totals.byDay || typeof s.totals.byDay !== 'object') s.totals.byDay = {};
  if (!Array.isArray(s.accounts)) s.accounts = [];
  if (!Number.isFinite(s.nextAccountNumber) || s.nextAccountNumber < 1) s.nextAccountNumber = 1;
  if (!Number.isFinite(s.totals.accountsMinted)) s.totals.accountsMinted = s.accounts.length;
  if (!Number.isFinite(s.totals.creditsUsedTotal)) s.totals.creditsUsedTotal = 0;
  return s;
}

export async function loadStore(file = STORE_PATH) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return normalize(raw);
  } catch {
    return normalize(null);
  }
}

export async function saveStore(store, file = STORE_PATH) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  return file;
}

export const findAccount = (store, id) => store.accounts.find(a => a.id === id) || null;
export const findAccountByEmail = (store, email) =>
  store.accounts.find(a => a.email && a.email.toLowerCase() === String(email).toLowerCase()) || null;

export const nextEmail = (store, domain = store.settings.emailDomain, prefix = store.settings.emailPrefix) =>
  `${prefix}-${store.nextAccountNumber}@${domain}`;

/**
 * Register a fresh account. Never reuses an identity: `store.nextAccountNumber`
 * only increases, and an email that is already known is rejected.
 */
export function addAccount(store, { token, email, handle, userId, notes } = {}) {
  if (email && findAccountByEmail(store, email)) {
    throw new Error(`account for ${email} already exists`);
  }
  const n = store.nextAccountNumber++;
  const claims = token ? decodeJwt(token) : null;
  const account = {
    id: `acc-${n}`,
    number: n,
    email: email || null,
    handle: handle || null,
    userId: userId || (claims && claims.sub) || null,
    token: token || null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastError: null,
    disabled: false,
    tokenExpiresAt: claims && claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
    usage: null,
    day: null, // { date, startRemaining, lastRemaining, usedCredits }
    history: [],
    notes: notes || null,
  };
  store.accounts.push(account);
  store.totals.accountsMinted = (store.totals.accountsMinted || 0) + 1;
  if (!store.activeAccountId) store.activeAccountId = account.id;
  return account;
}

/** UTC calendar day ("YYYY-MM-DD") for an epoch-ms number or an ISO string. */
const utcDay = when => {
  if (when === null || when === undefined) return null;
  const ms = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
};

/**
 * Fold a fresh /me response into an account and into the global totals.
 * This is where "how much did this account already burn" is remembered, and
 * where exhausted accounts get their new budget after refill_at.
 */
export function recordUsage(store, account, me, now = Date.now()) {
  const allowance = num(me.allowance_credits);
  const remaining = num(me.remaining_credits_today);
  const previous = account.usage || {};

  const usage = {
    allowanceCredits: allowance,
    remainingCreditsToday: remaining,
    capUsdToday: num(me.cap_usd_today),
    remainingUsdToday: num(me.remaining_usd_today),
    refillAt: typeof me.refill_at === 'string' ? me.refill_at : null,
    tier: typeof me.tier === 'string' ? me.tier : null,
    lane: typeof me.lane === 'string' ? me.lane : null,
    premiumCredits: num(me.premium_credits),
    bonusCredits: num(me.bonus_credits),
    visibleAllowance: me.visible_allowance === true,
    fetchedAt: new Date(now).toISOString(),
  };

  // Rollover: the daily budget was refilled since we last looked.
  const refillChanged = previous.refillAt && usage.refillAt && previous.refillAt !== usage.refillAt;
  const refillPassed = previous.refillAt && now >= Date.parse(previous.refillAt);

  if (account.day) {
    const used = Number.isFinite(previous.remainingCreditsToday) && Number.isFinite(remaining)
      ? Math.max(0, Math.round(previous.remainingCreditsToday) - Math.round(remaining))
      : 0;
    account.day.usedCredits = (account.day.usedCredits || 0) + used;
    account.day.lastRemaining = remaining;
    if (used > 0) {
      store.totals.creditsUsedTotal = (store.totals.creditsUsedTotal || 0) + used;
      const key = account.day.date;
      store.totals.byDay[key] = (store.totals.byDay[key] || 0) + used;
    }
  }

  if (!account.day || refillChanged || refillPassed || account.day.date !== utcDay(now)) {
    if (account.day) {
      account.history.push({
        date: account.day.date,
        usedCredits: account.day.usedCredits || 0,
        startRemaining: account.day.startRemaining,
        endRemaining: account.day.lastRemaining,
      });
      if (account.history.length > 60) account.history = account.history.slice(-60);
    }
    account.day = {
      date: utcDay(now),
      startRemaining: remaining,
      lastRemaining: remaining,
      usedCredits: 0,
    };
  }

  account.usage = usage;
  account.handle = account.handle || (typeof me.handle === 'string' ? me.handle : null);
  account.userId = account.userId || (typeof me.user_id === 'string' ? me.user_id : null);
  account.lastError = null;
  return usage;
}

export function markInvalid(account, message) {
  account.lastError = message || 'unauthorized';
  account.tokenBad = true;
}

export function markExhausted(account, message) {
  account.lastError = message || 'quota exceeded';
  if (account.usage) account.usage.remainingCreditsToday = 0;
}
