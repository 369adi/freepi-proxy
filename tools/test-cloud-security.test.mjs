import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isLoopbackHost,
  parseApiKeys,
  extractRequestApiKey,
  verifyApiKey,
  resolveBindConfig,
} from './lib/proxy-auth.mjs';
import { ensureStore, importCloudSeed } from './lib/accounts.mjs';
import { emptyStore } from './lib/store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('proxy-auth resolves local defaults vs Cloud Run host/port/auth', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);

  const localCfg = resolveBindConfig({});
  assert.equal(localCfg.host, '127.0.0.1');
  assert.equal(localCfg.port, 4000);
  assert.equal(localCfg.authRequired, false);
  assert.equal(localCfg.misconfiguredPublic, false);

  const cloudNoKey = resolveBindConfig({ K_SERVICE: 'freepi-proxy', PORT: '8080' });
  assert.equal(cloudNoKey.isCloudRun, true);
  assert.equal(cloudNoKey.host, '0.0.0.0');
  assert.equal(cloudNoKey.port, 8080);
  assert.equal(cloudNoKey.authRequired, true);
  assert.equal(cloudNoKey.misconfiguredPublic, true);

  const cloudWithKey = resolveBindConfig({
    K_SERVICE: 'freepi-proxy',
    PORT: '8080',
    FREEPI_PROXY_API_KEY: '  fp_key_one\n, fp_key_two  ',
  });
  assert.equal(cloudWithKey.misconfiguredPublic, false);
  assert.equal(cloudWithKey.authRequired, true);
  assert.deepEqual(cloudWithKey.apiKeys, ['fp_key_one', 'fp_key_two']);

  const optedOut = resolveBindConfig({
    FREEPI_PROXY_API_KEY: 'fp_key_one',
    FREEPI_ALLOW_UNAUTHENTICATED: '1',
  });
  assert.equal(optedOut.authRequired, false);
});

test('proxy-auth extracts and verifies Bearer and x-api-key tokens in constant time', () => {
  const keys = parseApiKeys('fp_alpha, fp_beta\n');
  assert.equal(extractRequestApiKey({ authorization: 'bearer fp_alpha' }), 'fp_alpha');
  assert.equal(extractRequestApiKey({ 'x-api-key': ' fp_beta ' }), 'fp_beta');
  assert.equal(extractRequestApiKey({ authorization: 'Basic abc' }), null);

  assert.equal(verifyApiKey('fp_alpha', keys), true);
  assert.equal(verifyApiKey('fp_beta', keys), true);
  assert.equal(verifyApiKey('fp_wrong', keys), false);
  assert.equal(verifyApiKey('', keys), false);
});

test('importCloudSeed seeds from JSON, base64, and seed file without touching corrupt stores', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-seed-'));

  // 1. Base64 array seed
  const b64 = Buffer.from(
    JSON.stringify([{ id: 'acc-1', handle: 'cloudone', token: 'tok_one' }]),
    'utf8',
  ).toString('base64');
  const s1 = emptyStore();
  const ok1 = await importCloudSeed(s1, { FREEPI_ACCOUNTS_JSON: b64 });
  assert.equal(ok1, true);
  assert.equal(s1.accounts.length, 1);
  assert.equal(s1.activeAccountId, 'acc-1');

  // 2. Read-only seed file into writable store path via ensureStore
  const seedFile = path.join(dir, 'secret-seed.json');
  const writableStore = path.join(dir, 'writable', 'accounts.json');
  await fs.writeFile(
    seedFile,
    JSON.stringify({
      version: 1,
      activeAccountId: 'acc-2',
      accounts: [
        { id: 'acc-1', handle: 'one', token: 'tok_1' },
        { id: 'acc-2', handle: 'two', token: 'tok_2' },
      ],
    }),
  );

  const prevPath = process.env.FREEPI_ACCOUNTS_PATH;
  const prevSeed = process.env.FREEPI_ACCOUNTS_SEED_PATH;
  const prevJson = process.env.FREEPI_ACCOUNTS_JSON;
  delete process.env.FREEPI_ACCOUNTS_JSON;
  process.env.FREEPI_ACCOUNTS_SEED_PATH = seedFile;
  try {
    const { store, seeded } = await ensureStore({ file: writableStore });
    assert.equal(seeded, true);
    assert.equal(store.accounts.length, 2);
    assert.equal(store.activeAccountId, 'acc-2');
    assert.equal(fsSync.existsSync(writableStore), true);

    // 3. Existing corrupt store must STILL throw STORE_UNREADABLE
    const corrupt = path.join(dir, 'corrupt.json');
    await fs.writeFile(corrupt, '{broken json');
    await assert.rejects(() => ensureStore({ file: corrupt }), /refusing to overwrite an unreadable account store/);
  } finally {
    if (prevPath === undefined) delete process.env.FREEPI_ACCOUNTS_PATH;
    else process.env.FREEPI_ACCOUNTS_PATH = prevPath;
    if (prevSeed === undefined) delete process.env.FREEPI_ACCOUNTS_SEED_PATH;
    else process.env.FREEPI_ACCOUNTS_SEED_PATH = prevSeed;
    if (prevJson === undefined) delete process.env.FREEPI_ACCOUNTS_JSON;
    else process.env.FREEPI_ACCOUNTS_JSON = prevJson;
  }
});

test('proxy refuses to start publicly without FREEPI_PROXY_API_KEY', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-nopub-'));
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FREEPI_PROXY_HOST: '0.0.0.0',
      FREEPI_PROXY_PORT: String(await getFreePort()),
      FREEPI_ACCOUNTS_PATH: path.join(dir, 'accounts.json'),
      FREEPI_STATE_DIR: dir,
      FREEPI_PROXY_API_KEY: '',
      FREEPI_ALLOW_UNAUTHENTICATED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exitCode, 1);
  assert.match(stderr, /Refusing to listen publicly.*FREEPI_PROXY_API_KEY/i);
});

test('proxy enforces API key on all API routes and seeds accounts from FREEPI_ACCOUNTS_SEED_PATH', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-e2e-'));
  const seedFile = path.join(dir, 'readonly-seed.json');
  const storeFile = path.join(dir, 'state', 'accounts.json');
  const stateDir = path.join(dir, 'state');

  await fs.writeFile(
    seedFile,
    JSON.stringify({
      version: 1,
      activeAccountId: 'acc-1',
      accounts: [
        { id: 'acc-1', handle: 'alpha', email: 'a@example.test', token: 'secret_tok_alpha' },
        { id: 'acc-2', handle: 'beta', email: 'b@example.test', token: 'secret_tok_beta' },
      ],
    }),
  );

  // Local mock upstream so startup refreshAll + catalog fetch run offline in milliseconds
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/me')) {
      res.end(JSON.stringify({
        allowance_credits: 15000,
        remaining_credits_today: 12000,
        visible_allowance: true,
        refill_at: new Date(Date.now() + 3600_000).toISOString(),
      }));
      return;
    }
    if (req.url.startsWith('/client-version')) {
      res.end(JSON.stringify({
        latest: '0.6.18',
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · Free Unlimited' },
          { id: 'particle', name: 'Particle · Free Unlimited' },
        ],
      }));
      return;
    }
    if (req.url.startsWith('/ads/next')) {
      res.end(JSON.stringify({}));
      return;
    }
    res.end('{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const port = await getFreePort();
  const apiKey = 'fp_test_super_secret_key_2026';
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FREEPI_API_BASE: `http://127.0.0.1:${upstream.address().port}`,
      FREEPI_PROXY_HOST: '127.0.0.1',
      FREEPI_PROXY_PORT: String(port),
      FREEPI_PROXY_API_KEY: apiKey,
      FREEPI_AUTO_SPONSOR: '0',
      FREEPI_ACCOUNTS_PATH: storeFile,
      FREEPI_ACCOUNTS_SEED_PATH: seedFile,
      FREEPI_STATE_DIR: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c.toString('utf8'); });
  child.stderr.on('data', (c) => { logs += c.toString('utf8'); });
  t.after(() => {
    try { child.kill(); } catch {}
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(ready, true, `proxy failed to become ready. Logs:\n${logs}`);
  assert.doesNotMatch(logs, new RegExp(apiKey), 'API key must never appear in startup logs');

  // Unauthenticated /health succeeds with minimal body
  const healthUnauth = await fetch(`${base}/health`);
  assert.equal(healthUnauth.status, 200);
  const healthUnauthBody = await healthUnauth.json();
  assert.equal(healthUnauthBody.status, 'ok');
  assert.equal('accounts' in healthUnauthBody, false);

  // Authenticated /health returns full body
  const healthAuth = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(healthAuth.status, 200);
  assert.equal((await healthAuth.json()).accounts, 2);

  // CORS preflight passes without auth
  const optRes = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
  assert.equal(optRes.status, 204);

  // Protected routes reject missing or wrong keys
  for (const [method, route] of [
    ['GET', '/v1/models'],
    ['GET', '/usage'],
    ['GET', '/accounts'],
    ['GET', '/budget'],
    ['GET', '/history'],
    ['GET', '/session-routing'],
    ['GET', '/sponsor'],
    ['POST', '/v1/chat/completions'],
  ]) {
    const rMissing = await fetch(`${base}${route}`, { method });
    assert.equal(rMissing.status, 401, `${method} ${route} must require API key`);
    const rWrong = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: 'Bearer wrong_key' },
    });
    assert.equal(rWrong.status, 401, `${method} ${route} must reject wrong API key`);
  }

  // Valid Bearer & x-api-key succeed and reflect seeded accounts without leaking tokens
  const modelsRes = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(modelsRes.status, 200);
  const modelsJson = await modelsRes.json();
  assert.equal(modelsJson.object, 'list');
  assert.ok(modelsJson.data.some((m) => m.id === 'deepseek-v4.1-flash'));

  const usageRes = await fetch(`${base}/usage`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(usageRes.status, 200);
  const usageText = await usageRes.text();
  const usageJson = JSON.parse(usageText);
  assert.deepEqual(usageJson.accounts.map((a) => a.id), ['acc-1', 'acc-2']);
  assert.doesNotMatch(usageText, /secret_tok_/);
  assert.equal(fsSync.existsSync(storeFile), true);
});
