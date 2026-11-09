// Tests for the pure selection logic in pick-account.mjs (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAccount, formatTable, countUsable } from './pick-account.mjs';

const acc = (id, extra = {}) => ({
  id,
  handle: 'h-' + id,
  state: 'ready',
  usable: true,
  busy: false,
  remaining: 0,
  premiumCredits: 0,
  ...extra,
});

test('single usable account is picked', () => {
  const a = acc('acc-1', { remaining: 100 });
  assert.equal(pickAccount([a]), a);
});

test('higher remaining wins', () => {
  const low = acc('acc-1', { remaining: 100 });
  const high = acc('acc-2', { remaining: 500 });
  assert.equal(pickAccount([low, high]), high);
  assert.equal(pickAccount([high, low]), high);
});

test('equal remaining: higher premiumCredits wins', () => {
  const a = acc('acc-1', { remaining: 300, premiumCredits: 10 });
  const b = acc('acc-2', { remaining: 300, premiumCredits: 900 });
  assert.equal(pickAccount([a, b]), b);
});

test('all equal: smallest id wins deterministically', () => {
  const a = acc('acc-10', { remaining: 300 });
  const b = acc('acc-2', { remaining: 300 });
  assert.equal(pickAccount([a, b]), b);
  assert.equal(pickAccount([b, a]), b);
});

test('busy account is never picked', () => {
  const busy = acc('acc-1', { remaining: 9999, busy: true });
  assert.equal(pickAccount([busy]), null);
  const free = acc('acc-2', { remaining: 1 });
  assert.equal(pickAccount([busy, free]), free);
});

test('all unusable returns null', () => {
  const list = [acc('acc-1', { usable: false }), acc('acc-2', { usable: false })];
  assert.equal(pickAccount(list), null);
});

test('empty array returns null', () => {
  assert.equal(pickAccount([]), null);
  assert.equal(pickAccount(undefined), null);
});

test('selectable true is preferred over merely usable', () => {
  const onlyUsable = acc('acc-1', { remaining: 900, selectable: false });
  const selectable = acc('acc-2', { remaining: 10, selectable: true });
  assert.equal(pickAccount([onlyUsable, selectable]), selectable);
  // selectable but busy stays out
  assert.equal(pickAccount([onlyUsable, { ...selectable, busy: true }]), null);
});

test('missing fields do not crash', () => {
  const slim = [{ id: 'acc-1' }, { id: 'acc-2', usable: true }];
  const best = pickAccount(slim);
  assert.equal(best.id, 'acc-2');
  const odd = [{ id: 'acc-3', usable: true }, { id: 'acc-4', usable: true, remaining: 5 }];
  assert.equal(pickAccount(odd).id, 'acc-4');
});

test('countUsable and formatTable stay ASCII', () => {
  const list = [acc('acc-1'), acc('acc-2', { usable: false })];
  assert.equal(countUsable(list), 1);
  const table = formatTable(list);
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(table));
  assert.match(table, /ID\s+HANDLE/);
  assert.match(table, /^-+ /m);
});
