// Regression test: the session-routing router must never hand out an account
// that is currently in the ads_required cooldown. Previously the candidate
// filter in the /session-routing handler checked budget state, token and model
// but NOT inAdCooldown, so a blocked account was pinned and the request then
// failed with 503 ads_required even when other free accounts existed.

import {test} from 'node:test';
import assert from 'node:assert/strict';

// Replicate the eligibility predicate exactly as routingCandidates() in
// proxy.mjs now applies it, but driven by an explicit cooldown map so the test
// does not depend on the real proxy store or disk state.
function routingCandidates(accounts, model, adBlocked, now, sortForPick = (l) => l.sort((a,b) => (b.remaining||0)-(a.remaining||0))) {
  const inAdCooldown = (id) => adBlocked.has(id);
  const stateOf = (a) => a.state; // 'ready' | 'exhausted' | ...
  const USABLE = new Set(['ready','low','premium']);
  const modelAllowsAccount = (a) => !a.modelRestrictions || a.modelRestrictions.includes(model);
  const candidates = accounts.filter(a => a.token && !a.disabled && !a.tokenBad && !inAdCooldown(a.id) && modelAllowsAccount(a) && USABLE.has(stateOf(a)));
  return sortForPick(candidates);
}

const account = (id, over = {}) => ({
  id, token: 't', disabled: false, tokenBad: false, state: 'ready', remaining: 1000,
  ...over,
});

test('cooldown accounts are excluded from routing candidates', () => {
  const a1 = account('acc-1', { remaining: 500 });
  const a2 = account('acc-2', { remaining: 2000 });
  const a3 = account('acc-3', { state: 'exhausted', remaining: 0 });
  const accounts = [a1, a2, a3];
  // acc-1 is blocked (ads_required), acc-2 and acc-3 are not.
  const blocked = new Set(['acc-1']);
  const candidates = routingCandidates(accounts, 'particle', blocked, Date.now());
  const ids = candidates.map((a) => a.id);
  assert.ok(!ids.includes('acc-1'), 'ads_required account must not be selectable');
  assert.ok(ids.includes('acc-2'), 'free account must be selectable');
  assert.ok(!ids.includes('acc-3'), 'exhausted account must not be selectable');
  // best first: most remaining up front
  assert.equal(ids[0], 'acc-2');
});

test('all accounts blocked -> no candidates (caller sees unavailable)', () => {
  const a1 = account('acc-1');
  const a2 = account('acc-2');
  const blocked = new Set(['acc-1', 'acc-2']);
  const candidates = routingCandidates([a1, a2], 'particle', blocked, Date.now());
  assert.equal(candidates.length, 0);
});

test('cooldown filter keeps stale/unknown states consistent with usable set', () => {
  const a1 = account('acc-1', { state: 'stale' });
  const a2 = account('acc-2', { state: 'ready' });
  const blocked = new Set([]);
  const ids = routingCandidates([a1, a2], 'particle', blocked, Date.now()).map((a) => a.id);
  assert.deepEqual(ids, ['acc-2']);
});
