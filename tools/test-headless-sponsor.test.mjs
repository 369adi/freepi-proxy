// Hermetic tests for tools/headless-sponsor.mjs (the window-less sponsor daemon).
//
// A fake sponsor panel (real http server on 127.0.0.1:0) implements the same
// contract as tools/lib/sponsor-panel.mjs: /sponsor sets a freepi_sponsor
// cookie, /sponsor/accounts lists accounts, /sponsor/ad hands out fresh
// nonces (or noAd / 404), /sponsor/impression accepts {nonce, visible:true}
// and /sponsor/status reports the last display. The daemon is spawned as a
// child process against this fake panel; no real network, no accounts file,
// no browser. The cookie file env is pointed at a path that does not exist so
// every run has to go through the /sponsor Set-Cookie fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAEMON = path.join(ROOT, 'tools', 'headless-sponsor.mjs');
const HEX = '0123456789abcdef';

function randomHex(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

// Spawn a fake panel + return helpers to run the daemon against it.
async function fixture(t, { failImpressionFor = new Set() } = {}) {
  const cookie = randomHex(48);
  const nonces = new Map();          // accountId -> issued nonce
  const adTimes = new Map();         // accountId -> ad fetch timestamp
  const impressions = [];            // every accepted attempt {account, nonce, visible, time, cookie, origin}
  const requests = [];               // every panel request {method, path, query, cookie, origin}
  let sponsorGets = 0;

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: url.search, cookie: req.headers.cookie, origin: req.headers.origin });
    const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

    if (req.method === 'GET' && url.pathname === '/sponsor') {
      sponsorGets++;
      res.writeHead(200, { 'set-cookie': `freepi_sponsor=${cookie}; HttpOnly; SameSite=Strict; Path=/sponsor` });
      res.end('<html>fake sponsor panel</html>');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sponsor/accounts') {
      json(200, { accounts: [{ id: 'acc-1' }, { id: 'acc-2' }, { id: 'acc-3' }, { id: 'acc-4' }] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sponsor/ad') {
      const account = url.searchParams.get('account');
      if (account === 'acc-1' || account === 'acc-2') {
        const nonce = randomHex(48);
        nonces.set(account, nonce);
        adTimes.set(account, Date.now());
        json(200, { nonce, accountId: account, creative: { headline: 'Test ad' } });
        return;
      }
      if (account === 'acc-3') { json(200, { noAd: true, accountId: 'acc-3' }); return; }
      res.writeHead(404); res.end('unknown account');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sponsor/impression') {
      let body;
      try { body = await readBody(req); } catch { json(400, { error: 'bad body' }); return; }
      const lookups = [...nonces.entries()].filter(([, n]) => n === body?.nonce);
      const account = lookups.length ? lookups[0][0] : null;
      impressions.push({ account, nonce: body?.nonce, visible: body?.visible, time: Date.now(), cookie: req.headers.cookie, origin: req.headers.origin });
      if (!account) { json(409, { error: 'unknown nonce' }); return; }
      if (failImpressionFor.has(account)) { json(409, { error: 'already confirmed' }); return; }
      json(200, { displayed: true, accountId: account });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sponsor/status') {
      const account = url.searchParams.get('account');
      const imp = impressions.find(i => i.account === account);
      json(200, { accountId: account, lastDisplay: imp ? { at: new Date(imp.time).toISOString() } : null, usage: {} });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  // Env: cookie file must NOT exist so the daemon has to re-capture the cookie
  // from the panel's Set-Cookie header on every run.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-test-'));
  const missingCookie = path.join(tempDir, 'no-such-cookie');
  t.after(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  function runDaemon(extraArgs = [], extraEnv = {}) {
    return new Promise(resolve => {
      const args = ['--once', '--base', `http://127.0.0.1:${server.address().port}`, ...extraArgs];
      const env = { ...process.env, FREEPI_COOKIE_FILE: missingCookie, ...extraEnv };
      const child = spawn(process.execPath, [DAEMON, ...args], { cwd: ROOT, env });
      let out = '', err = '';
      child.stdout.on('data', c => out += c);
      child.stderr.on('data', c => err += c);
      child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
    });
  }

  return { cookie, server, requests, impressions, nonces, adTimes, runDaemon, missingCookie };
}

const TARGETS = ['--accounts', 'acc-1,acc-2,acc-3,acc-4,acc-unknown'];

test('headless daemon confirms each valid impression via HTTP with visible:true and the panel cookie', async t => {
  const f = await fixture(t);
  const run = await f.runDaemon([...TARGETS, '--delay', '1500', '--verbose']);
  assert.equal(run.code, 0, run.err || run.out);
  assert.match(run.out, /2 confirmed, 0 failed/);

  assert.equal(f.impressions.length, 2, 'exactly one impression per ad-bearing account');
  for (const account of ['acc-1', 'acc-2']) {
    const imp = f.impressions.find(i => i.account === account);
    assert.ok(imp, `impression attempt for ${account}`);
    assert.equal(imp.visible, true, `visible must be strict boolean true for ${account}`);
    assert.equal(imp.nonce, f.nonces.get(account), `nonce for ${account} must match the issued one`);
    assert.ok(imp.time - f.adTimes.get(account) >= 1500, `>=1500 ms between ad fetch and impression for ${account}`);
    assert.ok(imp.cookie && imp.cookie.includes(`freepi_sponsor=${f.cookie}`), `${account} must carry the panel cookie`);
    assert.equal(imp.origin, undefined, `no Origin header may be sent (panel contract)`);
  }
  // acc-3 (noAd) and acc-4 (404 from the panel) must be skipped, never confirmed.
  assert.equal(f.impressions.filter(i => i.account === 'acc-3' || i.account === 'acc-4' || i.account === null).length, 0);
  assert.ok(f.requests.some(r => r.path === '/sponsor' && r.method === 'GET'), 'cookie fallback via GET /sponsor must be used');
  assert.ok(f.requests.some(r => r.path === '/sponsor/ad' && r.query.includes('acc-3')), 'noAd account must still be probed and skipped');
  assert.ok(f.requests.some(r => r.path === '/sponsor/ad' && r.query.includes('acc-4')), '404 account must still be probed and skipped');
  // acc-unknown is not in the panel account list, so the daemon must never probe it.
  assert.ok(!f.requests.some(r => r.path === '/sponsor/ad' && r.query.includes('acc-unknown')), 'unknown account is never probed');
});

test('dry-run fetches ads but never posts an impression', async t => {
  const f = await fixture(t);
  const run = await f.runDaemon([...TARGETS, '--delay', '1500', '--dry-run']);
  assert.equal(run.code, 0, run.err || run.out);
  assert.match(run.out, /dry-run/);
  assert.equal(f.impressions.length, 0, 'dry-run must not confirm anything');
  assert.ok(f.requests.some(r => r.path === '/sponsor/ad'), 'ads must still be fetched');
});

test('409 responses are tolerated and the pass still exits 0', async t => {
  const f = await fixture(t, { failImpressionFor: new Set(['acc-2']) });
  const run = await f.runDaemon([...TARGETS, '--delay', '1500']);
  assert.equal(run.code, 0, run.err || run.out);
  assert.match(run.out, /1 confirmed, 1 failed/);
  assert.match(run.out, /409/);
  assert.equal(f.impressions.filter(i => i.account === 'acc-1').length, 1, 'acc-1 impression must be posted');
  assert.equal(f.impressions.filter(i => i.account === 'acc-2').length, 1, 'acc-2 impression must be attempted even when the panel rejects it');
});

test('--verify exits 1 when the ad-state marks an account blocked, 0 when clean', async t => {
  const f = await fixture(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-verify-'));
  const adState = path.join(tempDir, 'ad-state.json');
  t.after(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  fs.writeFileSync(adState, JSON.stringify({ version: 1, blocked: { 'acc-1': 1234567890123 } }));
  const blockedRun = await f.runDaemon(['--accounts', 'acc-1', '--delay', '1500', '--verify'], { FREEPI_AD_STATE_FILE: adState });
  assert.equal(blockedRun.code, 1, 'verify must fail while an account is ads-blocked');
  assert.match(blockedRun.out, /ad-blocked=true/);

  fs.writeFileSync(adState, JSON.stringify({ version: 1, blocked: {} }));
  const cleanRun = await f.runDaemon(['--accounts', 'acc-1', '--delay', '1500', '--verify'], { FREEPI_AD_STATE_FILE: adState });
  assert.equal(cleanRun.code, 0, 'verify must pass once nothing is blocked');
  assert.match(cleanRun.out, /verify result: OK/);
  // The impression from this second run must be visible in /sponsor/status.
  assert.ok(cleanRun.out.includes('lastDisplay=') || f.impressions.some(i => i.account === 'acc-1'));
});