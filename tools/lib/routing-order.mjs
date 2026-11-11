// Prefer the smallest measured share of daily allowance used; use least recent
// assignment to rotate accounts when their measured usage is equal.
export function compareRoutingAccounts(a, b) {
  const account = x => x?.account ?? x;
  const usage = x => {
    const u = account(x)?.usage;
    const total = u?.allowanceCredits, remaining = u?.remainingCreditsToday;
    return Number.isFinite(total) && total > 0 && Number.isFinite(remaining)
      ? Math.max(0, Math.min(1, 1 - remaining / total)) : Infinity;
  };
  const ua = usage(a), ub = usage(b);
  if (ua !== ub) return ua < ub ? -1 : 1;
  const last = x => Date.parse(account(x)?.lastUsedAt || '') || 0;
  return last(a) - last(b) || String(account(a)?.id || '').localeCompare(String(account(b)?.id || ''));
}
