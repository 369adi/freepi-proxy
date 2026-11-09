import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchSavedAccount, accountInputHint } from '../lib/manual-selection.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freepi-manual-test-'));
  const store = path.join(dir, 'accounts.json'), selected = path.join(dir, 'selected-account.json');
  fs.writeFileSync(store, JSON.stringify({ accounts: [
    { id: 'first', email: 'first@example.test', token: 'TEST_SECRET_A' },
    { id: 'second', email: 'second@example.test', token: 'TEST_SECRET_B' },
    { id: 'disabled', token: 'TEST_SECRET_C', disabled: true },
  ] }));
  return { store, selected };
}

test('listing accounts does not change selection or expose credentials', () => {
  const f = fixture(), result = switchSavedAccount('/freepi-switch', f.store, f.selected);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /second/);
  assert.doesNotMatch(result.text, /TEST_SECRET/);
  assert.equal(fs.existsSync(f.selected), false);
});

test('an explicit ID or email selects only that existing account and preserves the credential store', () => {
  const f = fixture(), before = fs.readFileSync(f.store, 'utf8');
  assert.equal(switchSavedAccount('/freepi-switch second', f.store, f.selected).kind, 'success');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.selected)), { accountId: 'second' });
  assert.equal(switchSavedAccount('FIRST@example.test', f.store, f.selected).kind, 'success');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.selected)), { accountId: 'first' });
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
});

test('unknown or disabled accounts cannot replace an existing choice', () => {
  const f = fixture();
  switchSavedAccount('first', f.store, f.selected);
  for (const input of ['unknown', 'disabled']) {
    assert.equal(switchSavedAccount(input, f.store, f.selected).kind, 'error');
    assert.equal(JSON.parse(fs.readFileSync(f.selected)).accountId, 'first');
  }
});

test('the Harness plugin registers the switch command without starting sign-in', async () => {
  const registrations = [];
  const { apply } = await import('../lib/index.js');
  apply({ commands: { register: spec => { registrations.push(spec); return () => {}; } },
    effect: factory => { for (const unused of factory()) {} } });
  const command = registrations.find(c => c.name === 'freepi-switch');
  assert.equal(typeof command?.handler, 'function');
  assert.equal(command.input?.hint, accountInputHint(path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json')));
});

test('input hint shows usable account IDs and names without credentials', () => {
  const f = fixture();
  const hint = accountInputHint(f.store);
  assert.match(hint, /first \(first@example.test\)/);
  assert.match(hint, /second \(second@example.test\)/);
  assert.doesNotMatch(hint, /disabled|TEST_SECRET/);
});
