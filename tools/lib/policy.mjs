// policy.mjs — the decision brain of the rotator.
//
// Pure functions only: no I/O, no clock, no network. Everything is derived from
// the store snapshot plus an explicit `now`, which makes the whole policy
// unit-testable (see tools/test-policy.test.mjs).
//
// States
//   ready       enough daily budget left, fine to keep using
//   low         daily budget below the watermark -> switch when convenient
//   premium     daily allowance spent, but premium credits are left -> still
//               usable, and only ever picked after a normal account
//   exhausted   nothing left at all: no daily allowance and no premium credits
//   refillable  was exhausted, but refill_at has passed -> refresh, then reuse
//   stale       last measurement is too old to trust -> refresh
//   invalid     token rejected (401) -> needs a new login, never auto-used
//
// The priority order implements the requirement: reuse an existing account
// whose daily budget came back BEFORE creating a new GitHub account, and only
// mint when every known account is genuinely out of budget.
//
// Two separate questions, kept apart on purpose:
//   hasDailyAllowance(account)  remaining_credits_today > 0 (ready / low)
//   hasUsableBalance(account)   daily allowance > 0 OR premium credits > 0
// Premium credits are spendable, so a 0-remaining account that still has them
// stays in the pool - as a *fallback*, labelled `premium`, never as `ready`.

export const DEFAULT_LOW_WATERMARK = 0.1;
export const DEFAULT_MINT_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

export const STATE = {
  READY: 'ready',
  LOW: 'low',
  PREMIUM: 'premium',
  EXHAUSTED: 'exhausted',
  REFILLABLE: 'refillable',
  STALE: 'stale',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
};

/** States that may serve a request. `premium` is usable, but last in line. */
export const USABLE = new Set([STATE.READY, STATE.LOW, STATE.PREMIUM]);
/** The subset that still holds daily allowance (premium-only accounts are not). */
export const DAILY = new Set([STATE.READY, STATE.LOW]);
export const NEEDS_REFRESH = new Set([STATE.REFILLABLE, STATE.STALE, STATE.UNKNOWN]);

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Daily allowance left (`remaining_credits_today`) as a number, 0 when unknown. */
export function remainingOf(account) {
  return num(account?.usage?.remainingCreditsToday) ?? 0;
}

/** Premium credits left. Bought and gifted are a breakdown of this, not extra. */
export function premiumOf(account) {
  const premium = num(account?.usage?.premiumCredits);
  return premium === null || premium <= 0 ? 0 : premium;
}

/** Can this account still meet requests out of its *daily* allowance? */
export function hasDailyAllowance(account) {
  return remainingOf(account) > 0;
}

/**
 * Is there anything left to spend at all? Daily allowance first, premium
 * credits second. Says nothing about token health - see `isUsableAccount`.
 */
export function hasUsableBalance(account) {
  return hasDailyAllowance(account) || premiumOf(account) > 0;
}

/**
 * Only premium credits left: the daily allowance is spent, so the account is a
 * fallback. An account with daily allowance is never premium-only.
 */
export function isPremiumOnly(account) {
  return !hasDailyAllowance(account) && premiumOf(account) > 0;
}

/**
 * Structurally usable: not disabled, not marked bad, measured, and with any
 * spendable balance left. Ignores the clock on purpose; the state adds that.
 */
export function isUsableAccount(account) {
  return Boolean(account && !account.disabled && !account.tokenBad && account.token) && hasUsableBalance(account);
}

/**
 * Total spendable credits: daily allowance plus premium credits (only when the
 * account is used at all). Kept as one number for sorting and hours.
 */
export function spendableOf(account) {
  return remainingOf(account) + premiumOf(account);
}

/** 0 = daily allowance, 1 = premium only. Sorts normal accounts first. */
export function pickRank(account) {
  return hasDailyAllowance(account) ? 0 : 1;
}

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
  if (remaining === null && premiumOf(account) <= 0) return STATE.UNKNOWN;
  if (remaining !== null && remaining > 0) {
    return remaining <= lowThreshold(account, watermark) ? STATE.LOW : STATE.READY;
  }
  // Daily allowance is spent (or not reported). Premium credits are spendable,
  // so the account is not dead - it is a fallback for when the pool runs dry.
  if (premiumOf(account) > 0) return STATE.PREMIUM;
  return STATE.EXHAUSTED;
}


/** When does this account get its budget back? (epoch ms or null) */
export function refillAtOf(account) {
  const v = account?.usage?.refillAt ? Date.parse(account.usage.refillAt) : null;
  return Number.isFinite(v) ? v : null;
}

/**
 * Order accounts the way the rotator should try them, best first:
 *   1. accounts with daily allowance before premium-only ones (premium is the
 *      fallback - it must not be burnt while free daily budget is on the table)
 *   2. then most spendable credits first (daily + premium)
 *   3. ties: the account idle the longest, which spreads wear instead of
 *      hammering one account
 * Accepts bare accounts or {account, state} entries and returns the same shape.
 * Pure: a negative `now` only matters through the timestamps it compares.
 */
export function compareForPick(a, b) {
  const left = a && a.account ? a.account : a;
  const right = b && b.account ? b.account : b;
  const rank = pickRank(left) - pickRank(right);
  if (rank !== 0) return rank;
  const credits = spendableOf(right) - spendableOf(left);
  if (credits !== 0) return credits;
  const la = left?.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
  const lb = right?.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
  const laMs = Number.isFinite(la) ? la : 0;
  const lbMs = Number.isFinite(lb) ? lb : 0;
  return laMs - lbMs;
}

/** Sorted copy of `items` (accounts or {account, ...} entries), best first. */
export function sortForPick(items) {
  return (Array.isArray(items) ? items : []).slice().sort(compareForPick);
}

/** The account the rotator would try first, or null for an empty list. */
export function pickBest(items) {
  return sortForPick(items)[0] || null;
}

function bestCandidate(entries) {
  return pickBest(entries);
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

  // 1. Active account still comfortable with its daily allowance -> stay put
  //    (stability beats churn). Premium-only accounts never pin the active slot.
  const active = evaluated.find(e => e.account.id === activeId);
  if (active && active.state === STATE.READY) {
    return { action: 'keep', accountId: active.account.id, state: active.state };
  }

  // 2. Any usable account with more budget than what we have -> switch to it.
  //    `sortForPick` puts daily allowance before premium-only accounts.
  const usable = evaluated.filter(e => USABLE.has(e.state));
  if (usable.length) {
    const pick = bestCandidate(usable);
    const activeIsUsable = active && USABLE.has(active.state);
    if (activeIsUsable && pick.account.id === active.account.id) {
      return { action: 'keep', accountId: active.account.id, state: active.state };
    }
    // Same tier (daily allowance vs premium only) and no more credits: the
    // active account is the best we have, use it to the end.
    if (activeIsUsable && pickRank(active.account) <= pickRank(pick.account) &&
        spendableOf(pick.account) <= spendableOf(active.account)) {
      return { action: 'keep', accountId: active.account.id, state: active.state };
    }
    return {
      action: 'switch',
      accountId: pick.account.id,
      from: activeId,
      state: pick.state,
      premiumOnly: pick.state === STATE.PREMIUM,
      remaining: remainingOf(pick.account),
      premiumCredits: premiumOf(pick.account) || null,
      reason: !active
        ? 'no active account'
        : activeIsUsable
          ? pick.state === STATE.PREMIUM
            ? 'daily allowance spent - falling back to premium credits'
            : 'better existing account available'
          : pick.state === STATE.PREMIUM
            ? `active account is ${active.state} - using premium credits`
            : `active account is ${active.state}`,
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
  const premium = num(account?.usage?.premiumCredits);
  const pct = remaining !== null && allowance ? Math.round((remaining / allowance) * 100) : null;
  // Why this account is (still) in the pool, and with what.
  const usable = USABLE.has(state);
  const premiumOnly = usable && isPremiumOnly(account);
  const dailyCreditsLeft = usable ? Math.max(0, remainingOf(account)) : 0;
  const premiumCreditsLeft = usable ? premiumOf(account) : 0;
  return {
    id: account.id,
    handle: account.handle || '?',
    email: account.email || '?',
    state,
    usable,
    premiumOnly,
    remaining,
    allowance,
    percent: pct,
    premiumCredits: premium,
    premiumBoughtCredits: num(account?.usage?.premiumBoughtCredits),
    premiumGiftedCredits: num(account?.usage?.premiumGiftedCredits),
    premiumExpiringCredits: num(account?.usage?.premiumExpiringCredits),
    premiumExpiresAt: account?.usage?.premiumExpiresAt || null,
    purchasedCredits: num(account?.usage?.purchasedCredits),
    regularWalletCredits: num(account?.usage?.regularWalletCredits),
    bonusWalletCredits: num(account?.usage?.bonusWalletCredits),
    dailyCreditsLeft,
    premiumCreditsLeft,
    // Spendable now: daily allowance plus premium credits (auditable parts above).
    creditsLeft: dailyCreditsLeft + premiumCreditsLeft,
    usageMeasuredAt: account?.usage?.fetchedAt || null,
    refillAt: account?.usage?.refillAt || null,
    refillInMs: refillAtOf(account) ? Math.max(0, refillAtOf(account) - now) : null,
    lastError: account.lastError || null,
  };
}
