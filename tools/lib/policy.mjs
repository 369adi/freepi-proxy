// policy.mjs — the decision brain of the rotator.
//
// Pure functions only: no I/O, no clock, no network. Everything is derived from
// the store snapshot plus an explicit `now`, which makes the whole policy
// unit-testable (see tools/test-policy.test.mjs).
//
// States
//   ready       enough budget left, fine to keep using
//   low         still usable, but below the watermark -> switch when convenient
//   exhausted   nothing left today
//   refillable  was exhausted, but refill_at has passed -> refresh, then reuse
//   stale       last measurement is too old to trust -> refresh
//   invalid     token rejected (401) -> needs a new login, never auto-used
//
// The priority order implements the requirement: reuse an existing account
// whose daily budget came back BEFORE creating a new GitHub account, and only
// mint when every known account is genuinely out of budget.

export const DEFAULT_LOW_WATERMARK = 0.1;
export const DEFAULT_MINT_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

export const STATE = {
  READY: 'ready',
  LOW: 'low',
  EXHAUSTED: 'exhausted',
  REFILLABLE: 'refillable',
  STALE: 'stale',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
};

export const USABLE = new Set([STATE.READY, STATE.LOW]);
export const NEEDS_REFRESH = new Set([STATE.REFILLABLE, STATE.STALE, STATE.UNKNOWN]);

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Effective low-watermark in credits for an account (absolute floor of 1 credit). */
export function lowThreshold(account, watermark = DEFAULT_LOW_WATERMARK) {
  const allowance = num(account?.usage?.allowanceCredits);
  if (!allowance || allowance <= 0) return 1;
  return Math.max(1, allowance * watermark);
}

export function stateOf(account, now = Date.now(), opts = {}) {
  const watermark = num(opts.lowWatermark) ?? DEFAULT_LOW_WATERMARK;
  const staleMs = num(opts.staleMs) ?? DEFAULT_STALE_MS;

  if (!account || account.disabled) return STATE.INVALID;
  if (account.tokenBad) return STATE.INVALID;
  if (!account.token) return STATE.INVALID;

  const usage = account.usage;
  if (!usage) return STATE.UNKNOWN;

  const refillAt = usage.refillAt ? Date.parse(usage.refillAt) : null;
  if (refillAt && Number.isFinite(refillAt) && now >= refillAt) return STATE.REFILLABLE;

  const fetchedAt = usage.fetchedAt ? Date.parse(usage.fetchedAt) : null;
  if (!fetchedAt || now - fetchedAt > staleMs) return STATE.STALE;

  const remaining = num(usage.remainingCreditsToday);
  if (remaining === null) return STATE.UNKNOWN;
  if (remaining <= 0) return STATE.EXHAUSTED;
  if (remaining <= lowThreshold(account, watermark)) return STATE.LOW;
  return STATE.READY;
}

/** Remaining budget as "how many more requests-ish": credits left today. */
export function remainingOf(account) {
  return num(account?.usage?.remainingCreditsToday) ?? 0;
}

/** When does this account get its budget back? (epoch ms or null) */
export function refillAtOf(account) {
  const v = account?.usage?.refillAt ? Date.parse(account.usage.refillAt) : null;
  return Number.isFinite(v) ? v : null;
}

function bestCandidate(entries) {
  // Most budget wins; ties go to the account that has been idle the longest,
  // which spreads wear across accounts instead of hammering one.
  return entries.slice().sort((a, b) => {
    const rb = remainingOf(b.account) - remainingOf(a.account);
    if (rb !== 0) return rb;
    const la = a.account.lastUsedAt ? Date.parse(a.account.lastUsedAt) : 0;
    const lb = b.account.lastUsedAt ? Date.parse(b.account.lastUsedAt) : 0;
    return la - lb;
  })[0];
}

/**
 * Decide what to do right now.
 *
 * @returns {{action:'keep'|'switch'|'refresh'|'wait'|'mint', ...}}
 *   keep    {accountId}                        current account is healthy, do nothing
 *   switch  {accountId, from, reason}          move to another existing account
 *   refresh {accountIds:[...], thenRetry:true} re-measure, then decide again
 *   wait    {until, reason, accountIds}        everything empty, but a refill is close
 *   mint    {email, reason}                    genuinely need a brand-new account
 */
export function decide(store, now = Date.now(), opts = {}) {
  const watermark = num(opts.lowWatermark) ?? num(store?.settings?.lowWatermark) ?? DEFAULT_LOW_WATERMARK;
  const graceMs = num(opts.mintGraceMs) ?? num(store?.settings?.mintGraceMs) ?? DEFAULT_MINT_GRACE_MS;
  const settings = { lowWatermark: watermark, staleMs: num(opts.staleMs) ?? DEFAULT_STALE_MS };

  const accounts = (store?.accounts || []).filter(a => a && !a.disabled);
  const activeId = store?.activeAccountId || null;
  const evaluated = accounts.map(account => ({ account, state: stateOf(account, now, settings) }));

  // 1. Active account still comfortable -> stay put (stability beats churn).
  const active = evaluated.find(e => e.account.id === activeId);
  if (active && active.state === STATE.READY) {
    return { action: 'keep', accountId: active.account.id, state: active.state };
  }

  // 2. Any usable account with more budget than what we have -> switch to it.
  const usable = evaluated.filter(e => USABLE.has(e.state));
  if (usable.length) {
    const pick = bestCandidate(usable);
    const activeIsUsable = active && USABLE.has(active.state);
    if (activeIsUsable && pick.account.id === active.account.id) {
      return { action: 'keep', accountId: active.account.id, state: active.state };
    }
    if (activeIsUsable && remainingOf(pick.account) <= remainingOf(active.account)) {
      // Active is low but still the best we have: keep using it to the end.
      return { action: 'keep', accountId: active.account.id, state: active.state };
    }
    return {
      action: 'switch',
      accountId: pick.account.id,
      from: activeId,
      state: pick.state,
      remaining: remainingOf(pick.account),
      reason: activeIsUsable
        ? 'better existing account available'
        : active
          ? `active account is ${active.state}`
          : 'no active account',
    };
  }

  // 3. Nothing usable, but some account information is out of date -> refresh those.
  const refreshIds = evaluated.filter(e => NEEDS_REFRESH.has(e.state)).map(e => e.account.id);
  if (refreshIds.length) {
    return { action: 'refresh', accountIds: refreshIds, thenRetry: true, reason: 'usage data outdated' };
  }

  // 4. Everything is exhausted. If a daily refill is imminent, waiting is
  //    strictly better than minting another GitHub account.
  const refills = evaluated
    .map(e => ({ id: e.account.id, at: refillAtOf(e.account) }))
    .filter(r => r.at && r.at > now)
    .sort((a, b) => a.at - b.at);

  if (refills.length && refills[0].at - now <= graceMs) {
    return {
      action: 'wait',
      until: new Date(refills[0].at).toISOString(),
      waitMs: refills[0].at - now,
      accountIds: evaluated.map(e => e.account.id),
      reason: 'all accounts exhausted, daily refill is close',
    };
  }

  // 5. Genuinely out of options -> a new account is the only way forward.
  return {
    action: 'mint',
    email: nextMintEmail(store),
    reason: refills.length
      ? `all accounts exhausted, next refill not before ${new Date(refills[0].at).toISOString()}`
      : 'all accounts exhausted',
  };
}

/** The address that a new account would get — never an identity we already know. */
export function nextMintEmail(store) {
  const domain = (store?.settings?.emailDomain || 'arisya.de').trim();
  const prefix = (store?.settings?.emailPrefix || 'gh').trim();
  const known = new Set((store?.accounts || []).map(a => (a.email || '').toLowerCase()).filter(Boolean));
  let n = Math.max(1, Number(store?.nextAccountNumber) || 1);
  for (let i = 0; i < 10000; i++, n++) {
    const email = `${prefix}-${n}@${domain}`;
    if (!known.has(email.toLowerCase())) return email;
  }
  throw new Error('no free account number available');
}

/** Human-readable one-line summary of an account, for CLI output. */
export function describe(account, now = Date.now(), opts = {}) {
  const state = stateOf(account, now, opts);
  const remaining = num(account?.usage?.remainingCreditsToday);
  const allowance = num(account?.usage?.allowanceCredits);
  const pct = remaining !== null && allowance ? Math.round((remaining / allowance) * 100) : null;
  return {
    id: account.id,
    handle: account.handle || '?',
    email: account.email || '?',
    state,
    remaining,
    allowance,
    percent: pct,
    premiumCredits: num(account?.usage?.premiumCredits),
    premiumBoughtCredits: num(account?.usage?.premiumBoughtCredits),
    premiumGiftedCredits: num(account?.usage?.premiumGiftedCredits),
    premiumExpiringCredits: num(account?.usage?.premiumExpiringCredits),
    premiumExpiresAt: account?.usage?.premiumExpiresAt || null,
    purchasedCredits: num(account?.usage?.purchasedCredits),
    regularWalletCredits: num(account?.usage?.regularWalletCredits),
    bonusWalletCredits: num(account?.usage?.bonusWalletCredits),
    usageMeasuredAt: account?.usage?.fetchedAt || null,
    refillAt: account?.usage?.refillAt || null,
    refillInMs: refillAtOf(account) ? Math.max(0, refillAtOf(account) - now) : null,
    lastError: account.lastError || null,
  };
}
