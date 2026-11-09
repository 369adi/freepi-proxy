// Guards the account lifecycle commands: /freepi-remove and /freepi-auto, plus
// the mode line in /freepi-status. The store path is read once at module load,
// so the env var has to be set before the plugin is imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET = 'SI_SECRET_TOKEN_NEVER_SHOWN';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freepi-lifecycle-'));
  const storePath = path.join(dir, 'accounts.json');
  const selectionPath = path.join(dir, 'selected-account.json');
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      activeAccountId: 'acc-1',
      nextAccountNumber: 3,
      settings: {},
      totals: { accountsMinted: 2, creditsUsedTotal: 0, byDay: {} },
      accounts: [
        {
          id: 'acc-1',
          number: 1,
          email: 'one@example.test',
          handle: 'one',
          token: SECRET,
          usage: { remainingCreditsToday: 100, allowanceCredits: 100, fetchedAt: new Date().toISOString() },
        },
        {
          id: 'acc-2',
          number: 2,
          email: 'two@example.test',
          handle: 'two',
          token: SECRET,
          usage: { remainingCreditsToday: 50, allowanceCredits: 50, fetchedAt: new Date().toISOString() },
        },
      ],
    }),
  );
  return { dir, storePath, selectionPath };
}

async function loadPlugin(f) {
  process.env.FREEPI_ACCOUNTS_PATH = f.storePath;
  // Port 9 (discard) is never a proxy, so /freepi-doctor finds it unreachable
  // instead of hitting whatever happens to listen on the default port.
  process.env.FREEPI_PROXY_URL = 'http://127.0.0.1:9';
  const url = pathToFileURL(
    path.resolve(import.meta.dirname, '..', 'lib', 'index.js'),
  ).href;
  // Cache bust so each test gets a plugin bound to its own store.
  const mod = await import(url + '?f=' + Math.random());
  const commands = new Map();
  mod.apply({
    commands: { register: (spec) => { commands.set(spec.name, spec); return () => {}; } },
    effect: (factory) => { for (const unused of factory()) {} },
  });
  return commands;
}

const call = (commands, name, rawInput) =>
  commands.get(name).handler({ rawInput, signal: new AbortController().signal });

test('a pinned selection can be undone with /freepi-auto', async () => {
  const f = fixture();
  fs.writeFileSync(f.selectionPath, JSON.stringify({ accountId: 'acc-2' }));
  const commands = await loadPlugin(f);

  assert.equal(fs.existsSync(f.selectionPath), true);
  const result = await call(commands, 'freepi-auto');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /acc-2/);
  assert.equal(fs.existsSync(f.selectionPath), false);

  const again = await call(commands, 'freepi-auto');
  assert.equal(again.kind, 'success');
  assert.match(again.text, /schon automatisch/i);
});

test('removing an account drops it, repoints the active one and clears a stale pin', async () => {
  const f = fixture();
  fs.writeFileSync(f.selectionPath, JSON.stringify({ accountId: 'acc-2' }));
  const commands = await loadPlugin(f);

  const result = await call(commands, 'freepi-remove', 'acc-2');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /acc-2/);

  const store = JSON.parse(fs.readFileSync(f.storePath, 'utf8'));
  assert.deepEqual(store.accounts.map((a) => a.id), ['acc-1']);
  assert.equal(fs.existsSync(f.selectionPath), false, 'pin pointing at the removed account is gone');
  assert.equal(store.accounts[0].token, SECRET, 'remaining account keeps its credential');
  assert.doesNotMatch(result.text, /SI_SECRET/, 'credentials never appear in output');
});

test('removing the active account moves the active pointer to a survivor', async () => {
  const f = fixture();
  const commands = await loadPlugin(f);
  await call(commands, 'freepi-remove', 'acc-1');
  const store = JSON.parse(fs.readFileSync(f.storePath, 'utf8'));
  assert.equal(store.activeAccountId, 'acc-2');
});

test('an unknown or ambiguous account is refused without touching the store', async () => {
  const f = fixture();
  const commands = await loadPlugin(f);
  const before = fs.readFileSync(f.storePath, 'utf8');
  for (const input of ['acc-9', 'example.test', '']) {
    const result = await call(commands, 'freepi-remove', input);
    assert.equal(result.kind, input === '' ? 'success' : 'error');
  }
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), before);
});

test('the store path override keeps the selection file next to the store', async () => {
  const f = fixture();
  const commands = await loadPlugin(f);
  await call(commands, 'freepi-switch', 'acc-2');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(f.selectionPath, 'utf8')),
    { accountId: 'acc-2' },
    'selection is written next to the overridden store, not into the default home',
  );
  assert.equal(fs.existsSync(path.join(f.dir, 'selected-account.json')), true);
});

test('/freepi-status names the rotation mode', async () => {
  const f = fixture();
  const commands = await loadPlugin(f);

  const auto = await call(commands, 'freepi-status');
  assert.match(auto.text, /automatische Rotation zwischen 2/);

  fs.writeFileSync(f.selectionPath, JSON.stringify({ accountId: 'acc-2' }));
  const pinned = await call(commands, 'freepi-status');
  assert.match(pinned.text, /gepinnt/);
  assert.match(pinned.text, /acc-2/);
});

test('/freepi-doctor reports the store and survives a dead proxy', async () => {
  const f = fixture();
  const commands = await loadPlugin(f);

  const result = await call(commands, 'freepi-doctor');
  assert.match(result.text, /free-pi doctor/);
  assert.match(result.text, /2 nutzbar \/ 2 gespeichert/);
  assert.match(result.text, /automatische Rotation/);
  assert.doesNotMatch(result.text, /SI_SECRET/, 'doctor never prints tokens');
  // No proxy listens on the test port, so it must say so instead of throwing.
  assert.match(result.text, /nicht erreichbar/);
  assert.equal(result.kind, 'error');
});

test('/freepi-doctor flags a pinned account', async () => {
  const f = fixture();
  const commands = await loadPlugin(f);
  fs.writeFileSync(f.selectionPath, JSON.stringify({ accountId: 'acc-2' }));

  const pinned = await call(commands, 'freepi-doctor');
  assert.match(pinned.text, /gepinnt auf acc-2/);
  assert.match(pinned.text, /\/freepi-auto/);
});