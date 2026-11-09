#!/usr/bin/env node
// freepi-passwords.mjs - find the sign-up password for an account.
//
// Why this exists: every GitHub account auto-add.mjs creates gets a random
// password. Without this tool that password is written into the sign-up form and
// then forgotten, which makes the account unrecoverable the moment a login is
// needed (2FA reset, token revocation, device re-auth).
//
// Usage
//   node tools/freepi-passwords.mjs              list account, handle, email
//   node tools/freepi-passwords.mjs acc-3        show one password
//   node tools/freepi-passwords.mjs gh-4@arisya.de
//   node tools/freepi-passwords.mjs --export     print every password (careful)
//
// The password is only printed when explicitly asked for, so a careless
// screenshot of the list does not leak all of them at once.
//
// A row whose key is still an email belongs to a sign-up that never produced a
// stored account: the password was saved before the submit, which is exactly
// what makes a half-finished run recoverable. Those rows are marked PENDING so
// the list does not read like N accounts exist when only some do.
import { loadSecrets, SECRETS_PATH } from './lib/secrets.mjs';

function usage() {
  console.log('usage: node tools/freepi-passwords.mjs [accountId|email|handle] [--export]');
}

const args = process.argv.slice(2);
const exportAll = args.includes('--export');
const target = args.find((a) => !a.startsWith('-'));

if (args.includes('-h') || args.includes('--help') || (target && exportAll)) {
  usage();
  if (target && exportAll) {
    console.error('');
    console.error('--export and a single lookup are different modes - pick one.');
  }
  process.exit(target && exportAll ? 2 : 0);
}

const store = await loadSecrets();
const keys = Object.keys(store.accounts || {});

if (keys.length === 0) {
  console.log('no passwords saved yet');
  console.log('file: ' + SECRETS_PATH);
  process.exit(0);
}

/** True when the row is still filed under an email, i.e. no account was stored. */
const isPending = (row) => !row || !row.accountId;

// Column widths are computed from the data: a long key silently ran into the
// handle column in the fixed-width version and made the list unreadable.
const width = (vals, min) => Math.max(min, ...vals.map((v) => String(v || '-').length));
const colKey = width(keys, 10);
const colHandle = width(keys.map((k) => store.accounts[k].handle), 16);
const colEmail = width(keys.map((k) => store.accounts[k].email), 20);
const pad = (s, n) => String(s === null || s === undefined || s === '' ? '-' : s).padEnd(n + 2).slice(0, n + 2);

if (target) {
  const lower = target.toLowerCase();
  const key =
    keys.find((k) => k.toLowerCase() === lower) ||
    keys.find((k) => String(store.accounts[k].email || '').toLowerCase() === lower) ||
    keys.find((k) => String(store.accounts[k].handle || '').toLowerCase() === lower);

  if (!key) {
    console.error('no saved password for ' + target);
    console.error('known keys: ' + keys.join(', '));
    process.exit(1);
  }
  const row = store.accounts[key];
  console.log('account : ' + key);
  console.log('email   : ' + (row.email || '-'));
  console.log('handle  : ' + (row.handle || '-'));
  console.log('savedAt : ' + (row.savedAt || '-'));
  console.log('status  : ' + (isPending(row) ? 'PENDING - saved during sign-up, no stored account yet' : 'stored'));
  console.log('password: ' + (row.password || '(none)'));
  process.exit(0);
}

if (exportAll) {
  for (const k of keys) {
    const row = store.accounts[k];
    console.log([k, row.email || '-', row.handle || '-', row.password || ''].join('\t'));
  }
  process.exit(0);
}

console.log(pad('ACCOUNT', colKey) + pad('HANDLE', colHandle) + pad('EMAIL', colEmail) + 'STATUS');
console.log('-'.repeat(colKey + colHandle + colEmail + 8));
let pending = 0;
for (const k of keys) {
  const row = store.accounts[k];
  const stale = isPending(row);
  if (stale) pending += 1;
  const status = stale ? 'PENDING (no stored account)' : 'stored';
  console.log(pad(k, colKey) + pad(row.handle, colHandle) + pad(row.email, colEmail) + status);
}
console.log('');
console.log(keys.length + ' password(s) on file, in ' + SECRETS_PATH);
if (pending > 0) {
  console.log(pending + ' of them PENDING: a sign-up was started and the password was saved,');
  console.log('but no account was written to the store. Check before reusing that email.');
}
console.log('show one with: node tools/freepi-passwords.mjs <accountId|email|handle>');
