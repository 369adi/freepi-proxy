#!/usr/bin/env node
// doctor.mjs — diagnose why the free-pi proxy is not working.
//
//   node tools/doctor.mjs
//
// Checks, in order: Node, credentials, account store, token validity (live),
// port availability, reachability of api.freepi.ai, and whether the configured
// client version is still accepted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadStore, STORE_PATH, LEGACY_CREDENTIALS_PATH } from './lib/store.mjs';
import { getMe, getCatalog, ApiError, VERSION, BASE, tokenExpired } from './lib/freepi-api.mjs';

const HOME = os.homedir();
const PORT = Number(process.env.FREEPI_PROXY_PORT ?? 4000);
const results = [];

const ok   = (name, detail = '') => results.push({ level: 'ok',   name, detail });
const warn = (name, detail = '') => results.push({ level: 'warn', name, detail });
const bad  = (name, detail = '') => results.push({ level: 'fail', name, detail });

function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', err => resolve(err.code === 'EADDRINUSE' ? false : true));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function proxyAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { alive: false, status: res.status };
    const j = await res.json();
    return { alive: true, models: Array.isArray(j.data) ? j.data.length : 0 };
  } catch {
    return { alive: false };
  }
}

async function main() {
  console.log('\nfree-pi proxy — doctor\n' + '='.repeat(60));

  // 1. Node
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) ok('Node.js', 'v' + process.versions.node);
  else bad('Node.js too old', 'v' + process.versions.node + ' — need >= 18');

  // 2. legacy credentials
  if (fs.existsSync(LEGACY_CREDENTIALS_PATH)) ok('free-pi credentials', LEGACY_CREDENTIALS_PATH);
  else warn('free-pi credentials missing', LEGACY_CREDENTIALS_PATH + ' (run: npx free-pi-cli once)');

  // 3. account store
  const storeExists = fs.existsSync(STORE_PATH);
  const store = await loadStore();
  if (!storeExists) {
    warn('account store missing', STORE_PATH + ' (setup seeds it from credentials.json)');
  } else {
    const usable = store.accounts.filter(a => a && !a.disabled && a.token);
    if (usable.length) ok('account store', `${usable.length} usable / ${store.accounts.length} total`);
    else bad('account store empty', 'no usable account — run: node tools/freepi-accounts.mjs add');
  }

  // 4. live token check on the active account
  const active = store.accounts.find(a => a.id === store.activeAccountId) || store.accounts[0];
  if (active && active.token) {
    if (tokenExpired(active.token)) {
      bad('active token expired', active.id + ' — log in again: node tools/freepi-accounts.mjs add');
    } else {
      try {
        const me = await getMe(active.token);
        ok('active account', `${active.id} (${me.handle}) ${me.remaining_credits_today}/${me.allowance_credits} credits, refill ${me.refill_at}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) bad('active token rejected', 'run: node tools/freepi-accounts.mjs add');
        else bad('cannot reach /me', err.message);
      }
    }
  } else {
    warn('no active account', 'nothing to measure');
  }

  // 5. client version still accepted
  try {
    const cat = await getCatalog(active ? active.token : null);
    if (cat && cat.min) {
      const need = String(cat.min);
      if (/^\d+\.\d+\.\d+$/.test(VERSION) && VERSION === cat.latest) ok('client version', VERSION + ' (latest)');
      else if (VERSION === need) warn('client version', VERSION + ' is the minimum accepted (latest ' + cat.latest + ')');
      else ok('client version', VERSION + ' (min ' + need + ', latest ' + cat.latest + ')');
    } else ok('client version', VERSION);
  } catch (err) {
    bad('cannot fetch catalog', err.message);
  }

  // 5b. DSH slash-command plugin
  const pluginEntry = path.join(HOME, '.dsh', 'plugins', 'freepi-accounts', 'lib', 'index.js');
  const repoPlugin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'lib', 'index.js');
  if (!fs.existsSync(pluginEntry)) {
    warn('DSH plugin missing', 'run: node tools\\sync-plugin.mjs  (then restart DSH)');
  } else {
    const installed = fs.readFileSync(pluginEntry);
    const wanted = fs.existsSync(repoPlugin) ? fs.readFileSync(repoPlugin) : null;
    if (!wanted) ok('DSH plugin installed', pluginEntry);
    else if (installed.equals(wanted)) ok('DSH plugin installed', 'in sync with this checkout');
    else warn('DSH plugin out of date', 'run: node tools\\sync-plugin.mjs  (then restart DSH)');
  }

  // 5c. pinned account (manual selection disables rotation)
  const selectionPath = path.join(path.dirname(STORE_PATH), 'selected-account.json');
  if (fs.existsSync(selectionPath)) {
    try {
      const sel = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
      const known = store.accounts.some(a => a.id === sel.accountId);
      if (known) warn('account pinned', (sel.accountId || '?') + ' serves every request; /freepi-auto restores rotation');
      else warn('stale pin', (sel.accountId || '?') + ' is not in the store — /freepi-auto clears it');
    } catch {
      warn('selection file unreadable', selectionPath + ' — /freepi-auto clears it');
    }
  } else {
    ok('rotation mode', 'automatic (no account pinned)');
  }

  // 6. port / running proxy
  const alive = await proxyAlive(PORT);
  if (alive.alive) ok('proxy running', `:${PORT} with ${alive.models} models`);
  else {
    const free = await portFree(PORT);
    if (free) warn('proxy not running', `port ${PORT} is free — start it with: node proxy.mjs`);
    else bad('port ' + PORT + ' busy', 'another process holds it; set FREEPI_PROXY_PORT to change');
  }

  // 7. base API reachability
  try {
    const res = await fetch(BASE + '/client-version?cli_version=' + VERSION, { signal: AbortSignal.timeout(5000) });
    ok('api.freepi.ai reachable', 'HTTP ' + res.status);
  } catch (err) {
    bad('api.freepi.ai unreachable', err.message);
  }

  // report
  console.log('');
  const pad = n => n.padEnd(26);
  for (const r of results) {
    const mark = r.level === 'ok' ? '  ok  ' : r.level === 'warn' ? '  !!  ' : '  XX  ';
    console.log(mark + pad(r.name) + (r.detail || ''));
  }
  const fails = results.filter(r => r.level === 'fail').length;
  const warns = results.filter(r => r.level === 'warn').length;
  console.log('='.repeat(60));
  console.log(fails ? `${fails} problem(s), ${warns} warning(s).` : warns ? `healthy (${warns} warning(s)).` : 'everything looks good.');
  console.log('');
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('[doctor] ' + (e && e.message ? e.message : e)); process.exit(1); });
