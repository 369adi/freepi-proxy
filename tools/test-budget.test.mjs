import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS_PER_HOUR,
  parseMultiplier,
  modelMultiplier,
  creditsToHours,
  hoursToCredits,
  runwayHours,
  burnRatePerHour,
  fmtHours,
  budgetSummary,
} from './lib/budget.mjs';

test('parses the multiplier out of the catalog name', () => {
  assert.equal(parseMultiplier('DeepSeek V4.1 Flash Ultrafast 🔥🔥🔥 · ~295x usage'), 295);
  assert.equal(parseMultiplier('GPT-6 Luna · ~2.0x usage'), 2);
  assert.equal(parseMultiplier('Laguna S 2.1 · free preview · free, then ~1.8x usage'), 1.8);
  assert.equal(parseMultiplier('DeepSeek V4.1 Flash · 🔥 Free Unlimited: limited time'), null);
  assert.equal(parseMultiplier(undefined), null);
});

test('a model without a multiplier costs the base rate', () => {
  assert.equal(modelMultiplier({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · ~unlimited' }), 1);
  assert.equal(modelMultiplier({ id: 'x', name: 'x · ~41x usage' }), 41);
  assert.equal(modelMultiplier({ id: 'x', name: 'x · ~2.0x usage', multiplier: 3 }), 3);
  assert.equal(modelMultiplier(null), 1);
});

test('credits convert to hours and back at the model multiplier', () => {
  assert.equal(creditsToHours(15000, 1), 3);
  assert.equal(creditsToHours(15000, 2), 1.5);
  assert.equal(creditsToHours(0, 1), 0);
  assert.equal(creditsToHours(null, 1), null);
  assert.equal(hoursToCredits(3, 1), CREDITS_PER_HOUR * 3);
  assert.equal(hoursToCredits(1.5, 2), 15000);
});

test('runway needs a positive burn rate', () => {
  assert.equal(runwayHours(4.2, 1.4), 4.2 / 1.4);
  assert.equal(runwayHours(4.2, 0), null);
  assert.equal(runwayHours(null, 1), null);
});

test('burn rate ignores samples that are too close together', () => {
  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  assert.equal(burnRatePerHour([{ at: start, credits: 0 }, { at: start + 5000, credits: 900 }]), null);
  assert.equal(burnRatePerHour([{ at: start, credits: 0 }]), null);
  assert.equal(burnRatePerHour(null), null);
  // 5000 credits (= 1 hour) spent in 30 minutes -> 2 base-hours per hour.
  assert.equal(burnRatePerHour([{ at: start, credits: 0 }, { at: start + 30 * 60_000, credits: 5000 }]), 2);
});

test('hours are formatted for a narrow status line', () => {
  assert.equal(fmtHours(4.234), '4.2 h');
  assert.equal(fmtHours(12.7), '13 h');
  assert.equal(fmtHours(0.5), '30 min');
  assert.equal(fmtHours(0.001), '<1 min');
  assert.equal(fmtHours(null), '-');
  assert.equal(fmtHours(-0.5), '-');
});

test('summary only counts accounts that can still serve a request', () => {
  const accounts = [
    { id: 'a', state: 'ready', remaining: 15000, allowance: 15000 },
    { id: 'b', state: 'low', remaining: 900, allowance: 15000 },
    { id: 'c', state: 'exhausted', remaining: 0, allowance: 15000 },
    { id: 'd', state: 'stale', remaining: 4200, allowance: 15000 },
  ];
  const s = budgetSummary(accounts, 1);
  assert.equal(s.usableAccounts, 2);
  assert.equal(s.totalAccounts, 4);
  assert.equal(s.creditsLeft, 15900);
  assert.equal(s.creditsAllowance, 30000);
  assert.equal(s.hoursLeft, 3.18);
  assert.equal(s.hoursAllowance, 6);
  assert.equal(s.accounts.find(a => a.id === 'c').usable, false);
  assert.equal(s.accounts.find(a => a.id === 'd').usable, false);
});

test('a 20x model turns the same allowance into a twentieth of the hours', () => {
  const accounts = [{ id: 'a', state: 'ready', remaining: 15000, allowance: 15000 }];
  assert.equal(budgetSummary(accounts, 1).hoursLeft, 3);
  assert.equal(budgetSummary(accounts, 20).hoursLeft, 0.15);
  assert.equal(budgetSummary(accounts, 1).modelMultiplier, 1);
});
