// budget.mjs - translate free-pi credits into the unit that actually runs out.
//
// free-pi meters usage in hours: one hour of the base model costs 1 hour of
// balance, and every model shows a multiplier ("~2.0x usage", "~41x usage").
// 1 hour = 5 bucks = 5000 credits, so an account with 15000 credits per day has
// 3 hours on a 1x model - but only 4.2 hours across two cheap accounts. That is
// the number an agent harness runs out of first, and it is invisible while you
// only look at credits.
//
// Pure functions: no clock, no I/O, so tools/test-budget.test.mjs can pin the
// arithmetic down.

export const CREDITS_PER_HOUR = 5000;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse "~2.0x usage" / "~295x usage" / "1.8x" out of a catalog name. */
export function parseMultiplier(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/(\d+(?:\.\d+)?)\s*x\b/i);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Multiplier for one catalog entry. Defaults to 1 (= base rate) when the name
 * carries no hint, which matches the free "unlimited" models free-pi lists.
 */
export function modelMultiplier(entry) {
  if (!entry) return 1;
  const explicit = num(entry.multiplier);
  if (explicit && explicit > 0) return explicit;
  return parseMultiplier(entry.name) ?? 1;
}

/** Credits -> hours at a given multiplier. */
export function creditsToHours(credits, multiplier = 1) {
  const c = num(credits);
  const m = num(multiplier) ?? 1;
  if (c === null || m <= 0) return null;
  return c / CREDITS_PER_HOUR / m;
}

/** Hours -> credits, the inverse, used when sizing a daily budget. */
export function hoursToCredits(hours, multiplier = 1) {
  const h = num(hours);
  const m = num(multiplier) ?? 1;
  if (h === null) return null;
  return h * CREDITS_PER_HOUR * m;
}

/**
 * How long an account lasts at a given pace.
 * @param {number} hours   hours left at the model's multiplier
 * @param {number} perHour hours burned per wall-clock hour
 * @returns {number|null}  wall-clock hours, null when the burn rate is unknown
 */
export function runwayHours(hours, perHour) {
  const h = num(hours);
  const p = num(perHour);
  if (h === null || p === null || p <= 0) return null;
  return h / p;
}

/**
 * Rolling burn rate in hours-of-base-rate per wall-clock hour, from a burn
 * sample series [{ at, credits }] (credits spent, monotonic counters).
 * Returns null when there is less than a minute of data, so a single request
 * never produces a wild estimate.
 */
export function burnRatePerHour(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spent = num(last.credits) - num(first.credits);
  const elapsedMs = num(last.at) - num(first.at);
  if (spent === null || elapsedMs === null || elapsedMs < 60_000 || spent <= 0) return null;
  const creditsPerHour = spent / (elapsedMs / 3_600_000);
  return creditsPerHour / CREDITS_PER_HOUR;
}

/** "4.2 h", "38 min", "-" for null. Deliberately short for table output. */
export function fmtHours(hours) {
  const h = num(hours);
  if (h === null) return '-';
  if (h >= 10) return `${Math.round(h)} h`;
  if (h >= 1) return `${h.toFixed(1)} h`;
  const minutes = Math.round(h * 60);
  if (minutes >= 1) return `${minutes} min`;
  return '<1 min';
}

/**
 * Aggregate a usage snapshot (/usage -> accounts[]) into the hour picture.
 * @param {Array} accounts  from describe(): {id, state, remaining, allowance}
 * @param {number} multiplier model multiplier
 * @param {Set<string>} usableStates states that may still serve requests
 */
export function budgetSummary(accounts, multiplier = 1, usableStates = new Set(['ready', 'low'])) {
  const list = Array.isArray(accounts) ? accounts : [];
  let creditsLeft = 0;
  let creditsTotal = 0;
  const perAccount = [];
  for (const a of list) {
    const remaining = num(a.remaining) ?? 0;
    const allowance = num(a.allowance) ?? 0;
    const usable = usableStates.has(a.state);
    if (usable) {
      creditsLeft += remaining;
      creditsTotal += allowance;
    }
    perAccount.push({
      id: a.id ?? null,
      state: a.state ?? null,
      usable,
      hoursLeft: creditsToHours(remaining, multiplier),
      allowanceHours: creditsToHours(allowance, multiplier),
    });
  }
  return {
    modelMultiplier: multiplier,
    creditsPerHour: CREDITS_PER_HOUR,
    usableAccounts: perAccount.filter(a => a.usable).length,
    totalAccounts: perAccount.length,
    creditsLeft,
    creditsAllowance: creditsTotal,
    hoursLeft: creditsToHours(creditsLeft, multiplier),
    hoursAllowance: creditsToHours(creditsTotal, multiplier),
    accounts: perAccount,
  };
}
