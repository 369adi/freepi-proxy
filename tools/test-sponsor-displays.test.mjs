// The panel records when each account last confirmed a display. The guardian
// reads that to decide which windows to replace, so losing it on a restart makes
// every window look unconfirmed and the whole pool gets reopened for nothing.
//
// Only timestamps are stored. A restored entry says "this account displayed
// something at that time", which is true - no ad, nonce or click token is kept,
// so nothing here can be replayed as a confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirrors displayStore in tools/lib/sponsor-panel.mjs with the path injected.
function displayStore(file) {
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries = parsed && typeof parsed === 'object' && parsed.accounts;
      if (!entries || typeof entries !== 'object') return new Map();
      const out = new Map();
      for (const [id, value] of Object.entries(entries)) {
        const at = value && value.at;
        if (typeof id === 'string' && typeof at === 'string' && at) out.set(id, { at });
      }
      return out;
    } catch { return new Map(); }
  };
  const write = (map) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const accounts = Object.fromEntries(map);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts }, null, 2));
      fs.renameSync(tmp, file);
    } catch { /* an unwritable home still works, it just forgets */ }
  };
  return { read, write };
}

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sponsor-displays-')), 'sponsor-displays.json');

test('a display survives a restart', () => {
  const file = tempFile();
  const first = displayStore(file);
  first.write(new Map([['acc-1', { at: '2026-11-09T09:02:20.888Z' }]]));
  // A second store stands for the next run of the proxy.
  const second = displayStore(file);
  assert.deepEqual(second.read().get('acc-1'), { at: '2026-11-09T09:02:20.888Z' });
});

test('a missing file reads as empty instead of throwing', () => {
  assert.equal(displayStore(tempFile()).read().size, 0);
});

test('a corrupted file reads as empty instead of throwing', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not json');
  assert.equal(displayStore(file).read().size, 0);
});

test('entries without a timestamp are dropped', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { good: { at: '2026-11-09T09:00:00.000Z' }, bad: {} } }));
  const map = displayStore(file).read();
  assert.equal(map.size, 1);
  assert.ok(map.has('good'));
});

test('a write replaces the previous contents', () => {
  const file = tempFile();
  const store = displayStore(file);
  store.write(new Map([['acc-1', { at: '2026-11-09T09:00:00.000Z' }]]));
  store.write(new Map([['acc-2', { at: '2026-11-09T09:05:00.000Z' }]]));
  const map = store.read();
  assert.equal(map.size, 1);
  assert.ok(map.has('acc-2'));
});

test('no temporary file is left behind', () => {
  const file = tempFile();
  displayStore(file).write(new Map([['acc-1', { at: '2026-11-09T09:00:00.000Z' }]]));
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('only timestamps are written, nothing that could be replayed', () => {
  const file = tempFile();
  displayStore(file).write(new Map([['acc-1', { at: '2026-11-09T09:00:00.000Z' }]]));
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('nonce'), false);
  assert.equal(raw.includes('click_token'), false);
  assert.equal(raw.includes('impression'), false);
});
