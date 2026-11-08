#!/usr/bin/env node
// setup.mjs — one-command setup for the free-pi proxy (Windows-first).
//
//   node tools/setup.mjs            interactive, step by step
//   node tools/setup.mjs --check    read-only: what is installed / configured
//   node tools/setup.mjs --force    skip existing-file prompts
//
// What it does:
//   1. checks Node.js, Python-free, zero npm installs (zero-dependency)
//   2. seeds the account store from free-pi-cli's credentials.json if present
//   3. appends the "freepi" OpenAI provider to opencode.json (project or global)
//   4. appends the "freepi" DSH provider to ~/.dsh/profiles/*/[names].patch.yml
//   5. prints how to start and how to verify
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';

const HOME = os.homedir();

function log(msg = '') { console.log(msg); }
function step(msg) { log('\n== ' + msg); }
function ok(msg)  { log('   ok  ' + msg); }
function warn(msg){ log('   !!  ' + msg); }
function fail(msg){ log('   !!  ' + msg); }

/** Ask a yes/no question; returns 'y' or ''. Never called in non-interactive runs. */
async function ask(text, def = 'Y') {
  if (!process.stdin.isTTY) return def; // piped/non-interactive: take the default
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(text + ' [' + (def === 'Y' ? 'Y/n' : 'y/N') + '] ')).trim();
    if (!a) return def;
    return /^y(es)?$/i.test(a) ? 'Y' : 'N';
  } finally {
    rl.close();
  }
}

// ------------------------------------------------------------------ detection

function findGlobalConfig() {
  // opencode: project then user-level
  const candidates = [
    path.join(process.cwd(), 'opencode.json'),
    path.join(HOME, '.config', 'opencode', 'config.json'),
  ];
  return candidates.filter(p => fs.existsSync(p))[0] || null;
}

function findDshPatch() {
  const profiles = path.join(HOME, '.dsh', 'profiles');
  if (!fs.existsSync(profiles)) return null;
  let found = null;
  try {
    for (const dir of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const d = path.join(profiles, dir.name);
      for (const f of fs.readdirSync(d)) {
        if (/\.(yml|yaml)$/.test(f)) { found = path.join(d, f); break; }
      }
      if (found) break;
    }
  } catch { /* ignore */ }
  return found;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function appendOrCreateJson(file, patch) {
  const cur = readJson(file) || {};
  writeJson(file, { ...cur, ...patch });
  return file;
}

// ------------------------------------------------------------------ checks

async function checkNode() {
  try {
    const out = execSync('node --version', { encoding: 'utf8' });
    const v = out.trim();
    const major = parseInt(v.replace('v', '').split('.')[0], 10);
    if (major >= 18) { ok('Node.js ' + v); return true; }
    warn('Node.js ' + v + ' too old, need >= 18');
    return false;
  } catch {
    fail('Node.js not found on PATH');
    return false;
  }
}

async function checkAccountStore(storePath) {
  const exists = fs.existsSync(storePath);
  if (!exists) { warn('account store missing: ' + storePath); return null; }
  const store = readJson(storePath);
  if (!store || !Array.isArray(store.accounts)) { fail('account store corrupt'); return null; }
  const usable = store.accounts.filter(a => a && !a.disabled && a.token);
  if (!usable.length) { fail('account store has no usable account'); return store; }
  ok(`${usable.length} account(s) (active: ${store.activeAccountId || '-'})`);
  return store;
}

// ------------------------------------------------------------------ install

async function seedStore(storePath, force) {
  const creds = path.join(HOME, '.free-pi', 'agent', 'credentials.json');
  if (!fs.existsSync(creds)) {
    if (fs.existsSync(storePath)) { ok('account store already exists'); return; }
    warn('no free-pi credentials found, run  npx free-pi-cli  once first');
    return;
  }
  if (fs.existsSync(storePath)) {
    if (!force) { ok('account store already exists (keep)'); return; }
  }
  // delegate to accounts.mjs import which also refreshes via /me
  try {
    execSync(process.execPath + ' tools/freepi-accounts.mjs import', { encoding: 'utf8', stdio: 'inherit' });
  } catch (e) {
    fail('import failed: ' + e.message);
  }
}

async function installOpencode(force) {
  step('opencode config');
  const cfg = findGlobalConfig() || path.join(HOME, '.config', 'opencode', 'config.json');
  const cur = readJson(cfg) || {};

  // opencode >= 1.x uses  { "$schema", "provider": { "<id>": { npm, options } } }
  // while older builds read a flat  { "provider": "<id>", "<id>": {...} }.
  // Write the modern nested form; it is understood by current releases.
  if (cur.provider && typeof cur.provider === 'object' && cur.provider.freepi) {
    ok('opencode already has the freepi provider (' + cfg + ')');
    return;
  }
  if (cur.freepi) { ok('opencode already configured for freepi (' + cfg + ')'); return; }

  if (cfg !== findGlobalConfig() && fs.existsSync(cfg) === false) {
    // fresh file — nothing to ask about
  } else if (!force) {
    const answer = await ask('add the freepi provider to ' + cfg + '?', 'Y');
    if (answer !== 'Y') { warn('skipped opencode config'); return; }
  }

  const provider = (cur.provider && typeof cur.provider === 'object') ? cur.provider : {};
  provider['freepi'] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'free-pi (local proxy)',
    options: {
      baseURL: 'http://127.0.0.1:4000/v1',
      apiKey: 'freepi-proxy',
    },
    models: {
      'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash' },
      'deepseek-v4-flash':   { name: 'DeepSeek V4 Flash' },
      'deepseek-r1':         { name: 'DeepSeek R1' },
      'particle':            { name: 'Particle' },
    },
  };
  writeJson(cfg, { ...cur, provider });
  ok((fs.existsSync(cfg) ? 'updated ' : 'created ') + cfg);
}

const defaultModels = [
  'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-r1', 'deepseek-v3.1',
  'particle', 'grok-3-mini', 'gpt-5-mini', 'openai-gpt-4o-mini',
];

async function installDsh(force) {
  const patch = findDshPatch();
  if (!patch) { warn('no DSH profile patch found under ~/.dsh/profiles — manually add a "freepi" provider'); return; }
  const text = fs.readFileSync(patch, 'utf8');
  if (text.includes('freepi')) { ok('DSH profile already mentions freepi (' + patch + ')'); return; }
  const lines = [
    '',
    '# freepi provider (added by freepi-proxy setup)',
    'freepi:',
    '  type: openai-completions',
    '  baseUrl: http://127.0.0.1:4000/v1',
    '  apiKeyEnv: FREEPI_PROXY_API_KEY',
    '  models: [' + defaultModels.join(', ') + ']',
    '  default: deepseek-v4.1-flash',
  ];
  fs.appendFileSync(patch, '\n' + lines.join('\n') + '\n');
  ok('appended freepi provider to ' + patch);
}

async function healthCheck(port) {
  step('health check');
  const url = 'http://127.0.0.1:' + port + '/v1/models';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const j = await res.json();
      ok('proxy answers on :' + port + ' (' + (j.data ? j.data.length : 0) + ' models)');
      return true;
    }
    warn('proxy answered with HTTP ' + res.status + ' on :' + port);
    return false;
  } catch {
    warn('no proxy on :' + port + ' — is it running? (node proxy.mjs)');
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const checkOnly = args.includes('--check');
  const port = Number(process.env.FREEPI_PROXY_PORT || 4000);
  const storePath = process.env.FREEPI_ACCOUNTS_PATH ||
    path.join(HOME, '.free-pi', 'proxy', 'accounts.json');

  log('\nfree-pi proxy setup');

  log('');
  const nodeOk = await checkNode();

  if (checkOnly) {
    await checkAccountStore(storePath);
    const oc = findGlobalConfig();
    log('\nopencode config : ' + (oc || 'none (will create ~/.config/opencode/config.json)'));
    const dp = findDshPatch();
    log('dsh profile      : ' + (dp || 'none found'));
    await healthCheck(port);
    log('');
    return;
  }

  if (!nodeOk) {
    fail('install Node.js >= 18 from https://nodejs.org first, then rerun');
    process.exit(1);
  }

  step('accounts');
  await seedStore(storePath, force);

  await installOpencode(force);
  await installDsh(force);

  step('finish');
  log('');
  log('start the proxy:      node proxy.mjs   (or double-click Start-Proxy.cmd)');
  log('see status:           node tools\\freepi-accounts.mjs status');
  log('watch the terminal for ad output — that is what keeps free-pi free.');
  log('');
  await healthCheck(port);
  log('');
}

main().catch(e => { console.error('[setup] ' + (e && e.message ? e.message : e)); process.exit(1); });