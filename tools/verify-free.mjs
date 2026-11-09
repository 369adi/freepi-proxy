#!/usr/bin/env node
// Checks the things that have to stay true for the pool to be free at all.
//
// Every one of these has silently broken before, and each failure has the same
// shape: nothing reports an error, the account simply stops being served and
// free-pi quietly bills it or refuses it. Run this after any change.
//
//   node tools/verify-free.mjs
//
// Exit code 0 means every check passed. The output is ASCII only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.FREEPI_PROXY_BASE || 'http://127.0.0.1:4000';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

async function getJson(pathname, init) {
  const response = await fetch(BASE + pathname, { signal: AbortSignal.timeout(30000), ...init });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}

// Reads one cookie out of a response without depending on the newer
// getSetCookie helper, which is not available on every Node version.
function cookieFrom(response, name) {
  const raw = response.headers.get('set-cookie') || '';
  for (const part of raw.split(',')) {
    const pair = part.split(';')[0].trim();
    if (pair.startsWith(name + '=')) return pair;
  }
  return '';
}

// The proxy has to answer at all. Everything below depends on this.
async function checkHealth() {
  try {
    const { status, body } = await getJson('/health');
    const ok = status === 200 && body.status === 'ok';
    record('proxy answers on /health', ok, ok ? `${body.accounts} accounts, up ${body.uptimeSeconds}s` : JSON.stringify(body));
    return ok;
  } catch (error) {
    record('proxy answers on /health', false, error.message);
    return false;
  }
}

// Two processes keep the pool alive. If either stops, the next crash is
// permanent: the proxy stays down or the windows stay closed.
function checkProcesses() {
  for (const [label, pattern] of [['guardian runs', 'Guardian\\.ps1'], ['watchdog runs', 'Watch-Proxy\\.ps1']]) {
    let found = 0;
    try {
      const listing = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match '${pattern}' }).Count`],
        { encoding: 'utf8', timeout: 20000 }
      );
      found = Number(String(listing).trim()) || 0;
    } catch { found = 0; }
    record(label, found >= 1, found + ' process(es)');
  }
}

// The sponsor windows are the only legitimate route to the free state. They must
// exist, be unminimised, and - the part that kept silently failing - have
// confirmed a display recently. A window that is open but silent unlocks nothing.
async function checkSponsorWindows() {
  let payload = null;
  try {
    // The panel guards its account list with its own cookie, so the session has
    // to visit /sponsor first, exactly as a window does.
    const boot = await fetch(BASE + '/sponsor', { signal: AbortSignal.timeout(20000) });
    const cookie = cookieFrom(boot, 'freepi_sponsor');
    if (!cookie) { record('sponsor cookie handed out', false, 'no set-cookie on /sponsor'); return; }
    record('sponsor cookie handed out', true, 'ok');
    const response = await fetch(BASE + '/sponsor/accounts', {
      headers: { cookie }, signal: AbortSignal.timeout(20000)
    });
    payload = await response.json();
  } catch (error) {
    record('sponsor accounts reachable', false, error.message);
    return;
  }
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  if (accounts.length === 0) { record('sponsor accounts listed', false, 'empty list'); return; }
  record('sponsor accounts listed', true, accounts.length + ' accounts');

  const now = Date.now();
  for (const account of accounts) {
    const at = account?.lastDisplay?.at;
    if (!at) {
      record(`display for ${account.id}`, false, 'never confirmed');
      continue;
    }
    const ageMinutes = (now - Date.parse(at)) / 60000;
    // An account that is spent needs no display; it cannot be served anyway.
    const ok = Number.isFinite(ageMinutes) && ageMinutes < 30;
    record(`display for ${account.id}`, ok, `${ageMinutes.toFixed(1)} min ago`);
  }
}

// The persisted pieces. Without the cookie every open window is locked out after
// a restart; without the display times every window looks unconfirmed and the
// guardian reopens the whole pool for nothing.
function checkPersistedState() {
  const home = path.join(os.homedir(), '.free-pi', 'proxy');
  for (const [label, file, validate] of [
    ['sponsor cookie persisted', 'sponsor-cookie', (text) => /^[0-9a-f]{48}$/.test(text.trim())],
    ['display times persisted', 'sponsor-displays.json', (text) => {
      try { return typeof JSON.parse(text)?.accounts === 'object'; } catch { return false; }
    }]
  ]) {
    const full = path.join(home, file);
    try {
      const text = fs.readFileSync(full, 'utf8');
      record(label, validate(text), full);
    } catch (error) {
      record(label, false, error.code || error.message);
    }
  }
}

// The real proof: a free model answers and the credits do not move. Anything
// else is a proxy for the truth; this is the truth.
async function checkFreeCompletion() {
  let usage = null;
  try {
    const { body } = await getJson('/usage');
    usage = body;
  } catch (error) {
    record('usage readable', false, error.message);
    return;
  }
  const before = new Map((usage?.accounts || []).map((a) => [a.id, a.remaining]));
  record('usage readable', true, before.size + ' accounts');

  const usable = (usage?.accounts || []).filter((a) => a.usable);
  if (usable.length === 0) { record('an account is usable', false, 'none'); return; }
  const target = usable[0];
  record('an account is usable', true, target.id);

  try {
    const response = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-freepi-account': target.id },
      body: JSON.stringify({ model: 'particle', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
      signal: AbortSignal.timeout(90000)
    });
    const text = await response.text();
    if (response.status !== 200) {
      record('free model answers', false, `status ${response.status}: ${text.slice(0, 160)}`);
      return;
    }
    record('free model answers', true, 'status 200');
  } catch (error) {
    record('free model answers', false, error.message);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const { body } = await getJson('/usage');
    const after = new Map((body?.accounts || []).map((a) => [a.id, a.remaining]));
    const changed = [...before.entries()].filter(([id, remaining]) => after.get(id) !== remaining);
    record('no credits were spent', changed.length === 0, changed.length === 0 ? 'unchanged' : JSON.stringify(changed));
  } catch (error) {
    record('no credits were spent', false, error.message);
  }
}

const alive = await checkHealth();
checkPersistedState();
checkProcesses();
if (alive) {
  await checkSponsorWindows();
  await checkFreeCompletion();
}

for (const { name, ok, detail } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(failed.length === 0 ? 'all checks passed' : `${failed.length} check(s) failed`);
process.exit(failed.length === 0 ? 0 : 1);
