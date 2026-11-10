// Visibility is a conservative risk signal, not a promise of free billing.
export function creditGuardAllows(account, model, freeModels, now = Date.now()) {
  const measured = Date.parse(account?.usage?.fetchedAt || '');
  return freeModels.has(model) && account?.usage?.visibleAllowance === true &&
    Number.isFinite(measured) && now - measured >= 0 && now - measured < 10 * 60 * 1000;
}
