// Poll the approved device code and store the account.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(REPO, 'plugin', 'lib', 'index.js');
const COPY = path.join(REPO, 'plugin', 'lib', '_internals-poll.mjs');

fs.copyFileSync(ENTRY, COPY);
fs.appendFileSync(
  COPY,
  '\nexport const __internals = { deviceStart, devicePoll, deviceConsent, getMe, loadStore, saveStore };\n',
);
const api = await import(pathToFileURL(COPY).href);
const I = api.__internals;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessionId = process.argv[2];
if (!sessionId) {
  console.log('usage: node tools/poll-and-store.mjs <session_id>');
  process.exit(1);
}

let token = null;
let consented = false;
for (let i = 0; i < 40 && !token; i++) {
  try {
    const res = await I.devicePoll(sessionId);
    if (typeof res?.token === 'string' && res.token) token = res.token;
  } catch (err) {
    const code = String(err?.code || '');
    const m = String(err?.message || err);
    if (code === 'consent_required' || /consent required/i.test(m)) {
      if (!consented) {
        await I.deviceConsent(sessionId);
        consented = true;
        console.log('consent accepted');
      }
      continue;
    }
    if (/expired/i.test(m) || code === 'expired_token') {
      console.log('EXPIRED');
      break;
    }
    console.log('poll [' + code + ']: ' + m);
  }
  if (!token) await sleep(2000);
}

if (!token) {
  console.log('NO TOKEN');
  process.exit(1);
}
console.log('token ok (' + token.length + ' chars)');

const me = await I.getMe(token);
console.log('handle: ' + (me.handle || me.username || me.login));

const store = I.loadStore();
const handle = me.handle || me.username || me.login;
const existing = store.accounts.find((a) => a.handle === handle);

if (existing) {
  existing.token = token;
  existing.tokenBad = false;
  existing.disabled = false;
  existing.lastError = null;
  existing.userId = me.id || existing.userId;
  console.log('UPDATE ' + existing.id + ' / ' + handle);
} else {
  const n = store.nextAccountNumber || store.accounts.length + 1;
  store.nextAccountNumber = n + 1;
  store.accounts.push({
    id: 'acc-' + n,
    number: n,
    email: 'gh-' + n + '@' + (store.settings?.emailDomain || 'example.com'),
    handle: handle,
    userId: me.id || null,
    token: token,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastError: null,
    disabled: false,
    tokenBad: false,
    tokenExpiresAt: null,
    usage: null,
    day: { date: null, startRemaining: null, lastRemaining: null, usedCredits: 0 },
    history: [],
    notes: '',
  });
  console.log('ADDED acc-' + n + ' / ' + handle);
}

I.saveStore(store);
console.log('accounts now: ' + store.accounts.map((a) => a.id + '=' + a.handle).join(', '));

try {
  fs.unlinkSync(COPY);
} catch {}
