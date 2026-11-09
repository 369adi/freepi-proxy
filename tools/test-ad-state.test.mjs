// The proxy remembers which accounts are waiting for a sponsor display. That
// knowledge used to live only in memory, so a restart made the proxy believe
// every account was fine: it stopped reopening windows and stopped telling a
// caller why their request was refused. These checks pin the rules of the
// state file that fixes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AD_COOLDOWN_MS = 10 * 60 * 1000;

// Mirrors the three functions in proxy.mjs. They are small and deliberately
// free of request handling, so the rules can be checked without a server.
function makeState(file) {
  const adBlocked = new Map();

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const [id, at] of Object.entries(data.blocked || {})) {
        if (typeof at === 'number' && now - at <= AD_COOLDOWN_MS) adBlocked.set(id, at);
      }
    } catch { /* first run or unreadable: start empty */ }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const blocked = {};
      for (const [id, at] of adBlocked) blocked[id] = at;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, blocked }) + '\n');
      fs.renameSync(tmp, file);
    } catch { /* a failed write must not break a request */ }
  }

  function mark(id) { adBlocked.set(id, Date.now()); save(); }
  function clear(id) { adBlocked.delete(id); save(); }
  function inCooldown(id, now = Date.now()) {
    const at = adBlocked.get(id);
    if (at === undefined) return false;
    if (now - at > AD_COOLDOWN_MS) { adBlocked.delete(id); save(); return false; }
    return true;
  }

  return { adBlocked, load, save, mark, clear, inCooldown };
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adstate-'));
  return path.join(dir, 'ad-state.json');
}

test('a blocked account survives a restart', () => {
  const file = tempFile();
  const first = makeState(file);
  first.mark('acc-2');
  assert.equal(first.inCooldown('acc-2'), true);

  // A new process reading the same file must know acc-2 is still blocked.
  const second = makeState(file);
  second.load();
  assert.equal(second.inCooldown('acc-2'), true);
  assert.equal(second.inCooldown('acc-1'), false);
});

test('a cleared account stays cleared after a restart', () => {
  const file = tempFile();
  const first = makeState(file);
  first.mark('acc-3');
  first.clear('acc-3');

  const second = makeState(file);
  second.load();
  assert.equal(second.inCooldown('acc-3'), false);
});

test('a block older than the cooldown is not restored', () => {
  const file = tempFile();
  // Written by hand, as if the proxy had been offline for a long time.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    blocked: { 'acc-1': Date.now() - AD_COOLDOWN_MS - 60_000 },
  }));

  const state = makeState(file);
  state.load();
  assert.equal(state.inCooldown('acc-1'), false);
  // The stale entry is dropped from memory rather than kept forever.
  assert.equal(state.adBlocked.has('acc-1'), false);
});

test('an unreadable file starts empty instead of throwing', () => {
  const file = tempFile();
  fs.writeFileSync(file, 'not json at all');
  const state = makeState(file);
  state.load();
  assert.equal(state.adBlocked.size, 0);
});

test('a missing file starts empty instead of throwing', () => {
  const state = makeState(path.join(os.tmpdir(), 'does-not-exist-' + Date.now(), 'ad-state.json'));
  state.load();
  assert.equal(state.adBlocked.size, 0);
});

test('the write is atomic so a reader never sees half a file', () => {
  const file = tempFile();
  const state = makeState(file);
  state.mark('acc-1');
  // The temp file must be gone after the rename, and the real file parseable.
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.blocked['acc-1'], 'number');
});
