// A sponsor window only renews its account's allowance while it is the visible
// document, and a window covered by another one is not visible. Every account
// therefore needs its own place on the desktop. These checks pin the slot rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirrors safeAccountId / sponsorSlotFor in proxy.mjs.
function safeAccountId(id) {
  return String(id || 'active').replace(/[^A-Za-z0-9_-]/g, '_');
}

function slotFor(names, id) {
  let index = names.indexOf(safeAccountId(id));
  if (index < 0) index = names.length;
  const offset = index * 44;
  return { x: 30 + offset, y: 30 + offset };
}

// Mirrors the folder filter in proxy.mjs and in the two PowerShell launchers.
function slotNames(entries) {
  return entries
    .filter((name) => /^acc-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

test('the first three accounts get separate, increasing slots', () => {
  const names = slotNames(['acc-1', 'acc-2', 'acc-3']);
  assert.deepEqual(slotFor(names, 'acc-1'), { x: 30, y: 30 });
  assert.deepEqual(slotFor(names, 'acc-2'), { x: 74, y: 74 });
  assert.deepEqual(slotFor(names, 'acc-3'), { x: 118, y: 118 });
});

test('no two accounts share a slot', () => {
  const names = slotNames(['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5']);
  const seen = new Set();
  for (const id of names) {
    const slot = slotFor(names, id);
    const key = slot.x + ',' + slot.y;
    assert.equal(seen.has(key), false, 'two accounts landed on ' + key);
    seen.add(key);
  }
});

test('browser internal folders are not counted as accounts', () => {
  // A profile directory holds dozens of these; counting one of them pushed the
  // slots far right of the screen, which is why the cascade once did nothing.
  const entries = ['Crashpad', 'ShaderCache', 'GPUPersistentCache', 'Default',
    'Ad Blocking', 'Autofill', 'active', 'acc-1', 'acc-2', 'acc-3'];
  assert.deepEqual(slotNames(entries), ['acc-1', 'acc-2', 'acc-3']);
});

test('a stray active folder does not shift the accounts', () => {
  const names = slotNames(['active', 'acc-1', 'acc-2']);
  assert.deepEqual(slotFor(names, 'acc-1'), { x: 30, y: 30 });
  assert.deepEqual(slotFor(names, 'acc-2'), { x: 74, y: 74 });
});

test('accounts sort numerically, not as text', () => {
  // As text, acc-10 would sort before acc-2 and the two would swap places.
  assert.deepEqual(slotNames(['acc-10', 'acc-2', 'acc-1']), ['acc-1', 'acc-2', 'acc-10']);
});

test('an unknown account is placed after the known ones, not onto slot zero', () => {
  const names = slotNames(['acc-1', 'acc-2']);
  // Landing on slot zero would put it exactly on top of acc-1.
  assert.deepEqual(slotFor(names, 'acc-9'), { x: 118, y: 118 });
});

test('a path-like account id cannot escape its folder', () => {
  // Every character outside the safe set becomes an underscore, so a slash or a
  // dot pair can never form a path separator or a parent reference.
  const safe = safeAccountId('acc/../evil');
  assert.equal(safe, 'acc____evil');
  assert.equal(/[\/\\.]/.test(safe), false);
  assert.equal(safeAccountId(''), 'active');
  assert.equal(safeAccountId(null), 'active');
});

test('the slots stay inside a normal desktop for a realistic account count', () => {
  const names = slotNames(Array.from({ length: 6 }, (_, i) => 'acc-' + (i + 1)));
  const last = slotFor(names, 'acc-6');
  // 6 accounts at 44px steps starting at 30 must fit on a 1920x1080 screen.
  assert.ok(last.x + 760 <= 1920, 'window would leave the screen: x=' + last.x);
});
