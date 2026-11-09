// Guards /freepi-history: the fixed-width ASCII table, the --json passthrough
// and the clean error when the proxy is down. The store path and the proxy URL
// are both read once at module load, so they are set before each import. The
// proxy itself is replaced by a stubbed globalThis.fetch - no server is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET = 'SI_SECRET_TOKEN_NEVER_SHOWN';
// lib/index.js resolves its store path once at module load, so the fixture for
// the first loadPlugin() call also receives the child processes `node --test`
// spawns for this file.
const FIRST_FIXTURE = fixture();
let fixtureUsed = false;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freepi-history-'));
  const storePath = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      activeAccountId: 'acc-1',
      nextAccountNumber: 2,
      settings: {},
      totals: {
        accountsMinted: 1,
        creditsUsedTotal: 0,
        byDay: { '2026-01-02': 6000, '2026-01-01': 2500 },
        byDayPremium: { '2026-01-02': 500 },
      },
      accounts: [
        {
          id: 'acc-1',
          number: 1,
          email: 'one@example.test',
          handle: 'one',
          token: SECRET,
          usage: { remainingCreditsToday: 100, allowanceCredits: 100, fetchedAt: new Date().toISOString() },
        },
      ],
    }),
  );
  return { dir, storePath };
}

/** The payload the real proxy answers for the fixture above (newest first). */
function historyPayload() {
  return {
    days: [
      { date: '2026-01-02', daily: 6000, premium: 500, total: 6500, hours: 1.3 },
      { date: '2026-01-01', daily: 2500, premium: 0, total: 2500, hours: 0.5 },
    ],
    totals: { daily: 8500, premium: 500, hours: 1.8 },
    creditsPerHour: 5000,
  };
}

/**
 * Install a fetch stub for the duration of one test. Returns the recorded
 * calls. Passing `undefined` makes every fetch reject like a dead proxy.
 */
function stubFetch(t, reply, status = 200) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (!reply) throw new TypeError('fetch failed');
    return { ok: status >= 200 && status < 300, status, json: async () => reply };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function loadPlugin(f) {
  if (!f && !fixtureUsed) {
    f = FIRST_FIXTURE;
    fixtureUsed = true;
  }
  process.env.FREEPI_ACCOUNTS_PATH = f.storePath;
  // Port 9 (discard) is never a proxy; a stub replaces fetch where one is
  // needed, so nothing ever reaches a real listener.
  process.env.FREEPI_PROXY_URL = 'http://127.0.0.1:9';
  const url = pathToFileURL(
    path.resolve(import.meta.dirname, '..', 'lib', 'index.js'),
  ).href;
  // Cache bust so each test gets a plugin bound to its own store.
  const mod = await import(url + '?h=' + Math.random());
  const commands = new Map();
  mod.apply({
    commands: { register: (spec) => { commands.set(spec.name, spec); return () => {}; } },
    effect: (factory) => { for (const unused of factory()) {} },
  });
  return commands;
}

const call = (commands, name, rawInput) =>
  commands.get(name).handler({ rawInput, signal: new AbortController().signal });

test('/freepi-history renders an ASCII-only table, newest day first', async (t) => {
  const f = fixture();
  const commands = await loadPlugin(f);
  const calls = stubFetch(t, historyPayload());

  const result = await call(commands, 'freepi-history');
  assert.equal(result.kind, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9/history');
  assert.doesNotMatch(result.text, /SI_SECRET/, 'credentials never appear in output');

  // Pure ASCII: no umlauts, no em dashes, no box drawing.
  assert.match(result.text, /^[\x20-\x7E\n]*$/, 'output is ASCII only');

  const lines = result.text.split('\n');
  assert.match(lines[0], /^Datum\s+daily\s+premium\s+hours$/);
  assert.match(lines[1], /^-+ -+ +-+ +-+$/);
  assert.match(lines[2], /^2026-01-02\s+6000\s+500\s+1\.300$/);
  assert.match(lines[3], /^2026-01-01\s+2500\s+0\s+0\.500$/);
  // Same values the header advertises.
  assert.match(result.text, /8500 credits|daily 8500/);
  assert.match(result.text, /1\.800 h/);
  assert.match(result.text, /5000 credits\/h/);
});

test('/freepi-history caps the table at 14 rows and says how many are left', async (t) => {
  const f = fixture();
  const commands = await loadPlugin(f);
  const many = {
    days: Array.from({ length: 20 }, (_, i) => ({
      date: `2026-02-${String(20 - i).padStart(2, '0')}`,
      daily: 1000 - i * 10,
      premium: 0,
      total: 1000 - i * 10,
      hours: 0.2,
    })),
    totals: { daily: 1, premium: 0, hours: 0.001 },
    creditsPerHour: 5000,
  };
  stubFetch(t, many);

  const result = await call(commands, 'freepi-history');
  assert.equal(result.kind, 'success');
  const rows = result.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2} /.test(l));
  assert.equal(rows.length, 14);
  assert.match(rows[0], /^2026-02-20/);
  assert.match(result.text, /6 weitere Tag\(e\)/);
});

test('/freepi-history --json returns the same numbers as the table', async (t) => {
  const f = fixture();
  const commands = await loadPlugin(f);
  stubFetch(t, historyPayload());

  const result = await call(commands, 'freepi-history', '--json');
  assert.equal(result.kind, 'success');
  assert.doesNotMatch(result.text, /SI_SECRET/, 'credentials never appear in JSON either');

  const data = JSON.parse(result.text);
  assert.deepEqual(data, historyPayload());
  assert.equal(data.days[0].date, '2026-01-02');
  assert.equal(data.days[0].daily, 6000);
  assert.equal(data.days[0].premium, 500);
  assert.equal(data.days[0].hours, 1.3);
  assert.equal(data.totals.daily, 8500);
  assert.equal(data.creditsPerHour, 5000);
});

test('/freepi-history reports an unreachable proxy instead of throwing', async (t) => {
  const f = fixture();
  const commands = await loadPlugin(f);
  stubFetch(t, undefined);

  for (const input of ['', '--json']) {
    const result = await call(commands, 'freepi-history', input);
    assert.equal(result.kind, 'error');
    assert.equal(result.text, 'Proxy nicht erreichbar auf http://127.0.0.1:9/history - laeuft er?');
  }
});

test('/freepi-history surfaces an HTTP error from the proxy', async (t) => {
  const f = fixture();
  const commands = await loadPlugin(f);
  stubFetch(t, { error: { message: 'history snapshot failed' } }, 500);

  const result = await call(commands, 'freepi-history');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /antwortet 500 auf http:\/\/127\.0\.0\.1:9\/history/);
});
