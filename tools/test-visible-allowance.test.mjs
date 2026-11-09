import test from 'node:test';
import assert from 'node:assert/strict';
import { isMeteredDespiteFreeTier } from './lib/store.mjs';

test('an account with a visible allowance is not billed for free models', () => {
  assert.equal(isMeteredDespiteFreeTier({ usage: { visibleAllowance: true } }), false);
});

test('an account without a visible allowance IS billed for free models', () => {
  assert.equal(isMeteredDespiteFreeTier({ usage: { visibleAllowance: false } }), true);
});

test('an unmeasured account is not claimed to be metered', () => {
  assert.equal(isMeteredDespiteFreeTier({}), false);
  assert.equal(isMeteredDespiteFreeTier({ usage: null }), false);
  assert.equal(isMeteredDespiteFreeTier(null), false);
});

test('a usage object without the flag is not claimed to be metered', () => {
  assert.equal(isMeteredDespiteFreeTier({ usage: {} }), false);
});

test('only an explicit false counts, never a truthy string', () => {
  assert.equal(isMeteredDespiteFreeTier({ usage: { visibleAllowance: 'false' } }), false);
  assert.equal(isMeteredDespiteFreeTier({ usage: { visibleAllowance: 0 } }), false);
});