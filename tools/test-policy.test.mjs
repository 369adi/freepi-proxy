// test-policy.test.mjs — node --test tools/test-policy.test.mjs
//
// The rotation policy is the part that decides when a *new GitHub account* is
// created, so it gets real tests. Every case below is a requirement from the
// brief: remember usage, switch shortly before exhaustion, prefer reusing an
// already-created account, and only mint when everything is really used up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, stateOf, STATE, nextMintEmail, lowThreshold } from './lib/policy.mjs';
import { recordUsage, emptyStore, addAccount } from './lib/store.mjs';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const HOUR = 3600_000;

function acct(store, id, { remaining, allowance = 15000, refillIn = 12 * HOUR, fetchedAgo = 60_000, lastUsedAgo = HOUR } = {}) {
  const now = NOW;
  const account = {
    id,
    token: 'tok-' + id,
    email: `${id}@arisya.de`,
    handle: id,
    disabled: false,
    lastUsedAt: new Date(now - lastUsedAgo).toISOString(),
    usage: {
      allowanceCredits: allowance,
      remainingCreditsToday: remaining,
      refillAt: new Date(now + refillIn).toISOString(),
      fetchedAt: new Date(now - fetchedAgo).toISOString(),
      capUsdToday: 1.125,
      remainingUsdToday: 1.1,
    },
  };
  store.accounts.push(account);
  return account;
}

test('healthy active account is kept', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 12000 });
  store.activeAccountId = a.id;
  assert.equal(decide(store, NOW).action, 'keep');
});

test('switches shortly before the budget is gone', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 900 }); // 6% < 10% watermark
  const b = acct(store, 'acc-2', { remaining: 14000 });
  store.activeAccountId = a.id;
  const d = decide(store, NOW);
  assert.equal(stateOf(a, NOW, store.settings), STATE.LOW);
  assert.equal(d.action, 'switch');
  assert.equal(d.accountId, b.id);
});

test('a low account is used to the end when it is the best one left', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 500 });
  store.activeAccountId = a.id;
  assert.equal(decide(store, NOW).action, 'keep');
});

test('exhausted accounts are not candidates', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 0 });
  const b = acct(store, 'acc-2', { remaining: 0 });
  store.activeAccountId = a.id;
  const d = decide(store, NOW, { mintGraceMs: HOUR / 2 });
  assert.equal(stateOf(a, NOW, store.settings), STATE.EXHAUSTED);
  assert.equal(stateOf(b, NOW, store.settings), STATE.EXHAUSTED);
  assert.equal(d.action, 'mint'); // refill is 12h away, grace is 30min
});

test('waits instead of minting when a refill is imminent', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 0, refillIn: 5 * 60_000 });
  store.activeAccountId = a.id;
  const d = decide(store, NOW, { mintGraceMs: 20 * 60_000 });
  assert.equal(d.action, 'wait');
  assert.ok(d.waitMs > 0 && d.waitMs <= 20 * 60_000);
});

test('a refilled account is reused before anything new is created', () => {
  const store = emptyStore();
  // Budget came back: refill_at now lies in the past.
  const a = acct(store, 'acc-1', { remaining: 0, refillIn: -60_000 });
  store.activeAccountId = a.id;
  const d = decide(store, NOW);
  assert.equal(stateOf(a, NOW, store.settings), STATE.REFILLABLE);
  assert.equal(d.action, 'refresh');
  assert.deepEqual(d.accountIds, ['acc-1']);
});

test('stale data triggers a refresh before any minting', () => {
  const store = emptyStore();
  acct(store, 'acc-1', { remaining: 0, refillIn: 12 * HOUR, fetchedAgo: 2 * HOUR });
  const d = decide(store, NOW, { staleMs: 600_000 });
  assert.equal(d.action, 'refresh');
});

test('invalid token is never used', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 9000 });
  a.tokenBad = true;
  store.activeAccountId = a.id;
  assert.equal(stateOf(a, NOW, store.settings), STATE.INVALID);
  const b = acct(store, 'acc-2', { remaining: 100 });
  const d = decide(store, NOW);
  assert.equal(d.action, 'switch');
  assert.equal(d.accountId, b.id);
});

test('picks the account with the most budget left', () => {
  const store = emptyStore();
  const a = acct(store, 'acc-1', { remaining: 2000 });
  const b = acct(store, 'acc-2', { remaining: 9000 });
  const c = acct(store, 'acc-3', { remaining: 5000 });
  store.activeAccountId = null;
  const d = decide(store, NOW);
  assert.equal(d.action, 'switch');
  assert.equal(d.accountId, b.id);
});

test('mint address never collides with a known identity', () => {
  const store = emptyStore();
  store.nextAccountNumber = 3;
  acct(store, 'acc-1').email = 'gh-3@arisya.de';
  const email = nextMintEmail(store);
  assert.notEqual(email, 'gh-3@arisya.de');
  assert.match(email, /^gh-\d+@arisya\.de$/);
});

test('low watermark scales with the allowance', () => {
  assert.equal(lowThreshold({ usage: { allowanceCredits: 15000 } }, 0.1), 1500);
  assert.equal(lowThreshold({ usage: { allowanceCredits: 0 } }, 0.1), 1);
});

test('usage is remembered and rolled over at refill', () => {
  const store = emptyStore();
  const account = addAccount(store, { token: 't', email: 'gh-1@arisya.de' });
  const me = now => ({
    allowance_credits: 15000,
    remaining_credits_today: now,
    refill_at: '2026-11-09T00:00:00.000Z',
    cap_usd_today: 1.125,
    remaining_usd_today: 1,
  });
  recordUsage(store, account, me(15000), NOW);
  recordUsage(store, account, me(12000), NOW + HOUR);
  recordUsage(store, account, me(9000), NOW + 2 * HOUR);
  assert.equal(account.day.usedCredits, 6000);
  assert.equal(store.totals.creditsUsedTotal, 6000);

  // Next day: budget came back -> a history entry is pushed.
  recordUsage(store, account, { ...me(15000), refill_at: '2026-11-10T00:00:00.000Z' }, NOW + 24 * HOUR);
  assert.equal(account.history.length, 1);
  assert.equal(account.history[0].usedCredits, 6000);
  assert.equal(account.day.usedCredits, 0);
});
