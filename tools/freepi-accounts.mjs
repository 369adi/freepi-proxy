#!/usr/bin/env node
// freepi-accounts.mjs — account + usage manager for the free-pi proxy.
//
//   node tools/freepi-accounts.mjs status        what is left, per account
//   node tools/freepi-accounts.mjs refresh       re-measure via /me
//   node tools/freepi-accounts.mjs plan          what the rotator would do next
//   node tools/freepi-accounts.mjs add           log in a new account (device flow)
//   node tools/freepi-accounts.mjs use <id>      pin an account as active
//   node tools/freepi-accounts.mjs remove <id>   forget an account
//   node tools/freepi-accounts.mjs import        seed from free-pi-cli credentials.json
//
// Nothing here ever deletes a token silently: `remove` asks for confirmation
// and `--force` exists only for scripting.

import readline from 'node:readline/promises';
import {
  loadStore,
  saveStore,
  STORE_PATH,
  findAccount,
  findAccountByEmail,
  addAccount,
  recordUsage,
} from './lib/store.mjs';
import { decide, describe, stateOf, STATE, nextMintEmail } from './lib/policy.mjs';
import {
  refreshAccount,
  refreshAll,
  loginWithDeviceFlow,
  importLegacyCredentials,
  ensureStore,
} from './lib/accounts.mjs';
import { getMe } from './lib/freepi-api.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const flag = name => args.includes('--' + name);

const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US') : '?');
const dur = ms => {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

async function cmdStatus() {
  const { store } = await ensureStore();
  const now = Date.now();
  const rows = store.accounts.map(a => describe(a, now, store.settings));

  console.log(`store: ${STORE_PATH}`);
  if (!rows.length) {
    console.log('no accounts yet — run: node tools/freepi-accounts.mjs import');
    return;
  }
  console.log('');
  console.log('ID       HANDLE        STATE       REMAINING        REFILL   LAST ERROR');
  console.log('-'.repeat(88));
  for (const r of rows) {
    const active = r.id === store.activeAccountId ? '*' : ' ';
    const budget = r.remaining === null ? '?' : `${fmt(r.remaining)} / ${fmt(r.allowance)}`;
    const pct = r.percent === null ? '' : ` (${r.percent}%)`;
    console.log(
      active + r.id.padEnd(8) +
      String(r.handle).slice(0, 13).padEnd(14) +
      r.state.padEnd(12) +
      (budget + pct).padEnd(17) +
      dur(r.refillInMs).padEnd(9) +
      (r.lastError || ''),
    );
  }
  console.log('-'.repeat(88));
  console.log(`* active   accounts: ${rows.length}   accounts minted all-time: ${store.totals.accountsMinted}`);
  console.log(`credits used all-time: ${fmt(store.totals.creditsUsedTotal)}`);
  const days = Object.keys(store.totals.byDay || {}).sort().slice(-7);
  if (days.length) {
    console.log('last days: ' + days.map(d => `${d}=${fmt(store.totals.byDay[d])}`).join('  '));
  }
  const d = decide(store, now);
  console.log('');
  console.log(`rotator would: ${describeDecision(d, store)}`);
}

function describeDecision(d, store) {
  switch (d.action) {
    case 'keep': return `keep ${d.accountId} (${d.state})`;
    case 'switch': return `switch to ${d.accountId} — ${d.reason}`;
    case 'refresh': return `re-measure ${d.accountIds.join(', ')} — ${d.reason}`;
    case 'wait': return `wait until ${d.until} (${dur(d.waitMs)}) — ${d.reason}`;
    case 'mint': return `create a NEW account ${d.email} — ${d.reason}`;
    default: return d.action;
  }
}

async function cmdRefresh() {
  const { store } = await ensureStore();
  const results = await refreshAll(store, { force: true });
  await saveStore(store);
  for (const r of results) {
    const a = findAccount(store, r.id);
    const me = a?.usage;
    console.log(
      `${r.id.padEnd(8)} ${(r.ok ? 'ok' : r.reason).padEnd(24)} ` +
      (me ? `${fmt(me.remainingCreditsToday)} / ${fmt(me.allowanceCredits)} credits left` : ''),
    );
  }
  console.log(`saved -> ${STORE_PATH}`);
}

async function cmdPlan() {
  let { store } = await ensureStore();
  let d = decide(store, Date.now());
  if (d.action === 'refresh') {
    console.log('usage data outdated — re-measuring first...');
    await refreshAll(store, { force: true });
    await saveStore(store);
    d = decide(store, Date.now());
  }
  console.log(describeDecision(d, store));
  if (d.action === 'mint') {
    console.log('');
    console.log('a new account is genuinely required. next steps:');
    console.log(`  1. create a GitHub account for  ${d.email}`);
    console.log(`     (catch-all on ${store.settings.emailDomain} delivers the verification mail to the Webmaster mailbox)`);
    console.log('  2. read the verification link with:');
    console.log(`       node tools/fetch-verify-mail.mjs ${d.email}`);
    console.log('  3. authorize the new GitHub account for free-pi:');
    console.log('       node tools/freepi-accounts.mjs add');
  }
}

async function cmdAdd() {
  const { store } = await ensureStore();
  const suggested = nextMintEmail(store);
  console.log('Logging in a GitHub account for free-pi.');
  console.log(`suggested address for a brand-new account: ${suggested}`);
  console.log('(use any address you control — this is only shown for convenience)');
  console.log('');

  const { token } = await loginWithDeviceFlow({
    onCode: c => {
      console.log('+----------------------------------------------------------+');
      console.log('|  Open:  ' + (c.verificationUriComplete || c.verificationUri));
      console.log('|  Code:  ' + c.userCode);
      console.log('+----------------------------------------------------------+');
      console.log(`waiting for authorization (expires in ${Math.round((c.expiresIn || 900) / 60)} min)...`);
    },
  });

  // Ask the API who this account actually is before storing it.
  const me = await getMe(token);
  const handle = typeof me.handle === 'string' ? me.handle : null;
  const userId = typeof me.user_id === 'string' ? me.user_id : null;

  const existing = store.accounts.find(a => a.userId && userId && a.userId === userId);
  if (existing) {
    existing.token = token;
    existing.tokenBad = false;
    existing.disabled = false;
    recordUsage(store, existing, me);
    await saveStore(store);
    console.log(`this GitHub account was already known as ${existing.id} (${existing.handle}) — token refreshed.`);
    return;
  }

  const account = addAccount(store, { token, handle, userId, email: suggested });
  recordUsage(store, account, me);
  store.activeAccountId = account.id;
  await saveStore(store);
  console.log('');
  console.log(`added ${account.id}  handle=${handle}  email=${suggested}`);
  console.log(`remaining today: ${fmt(me.remaining_credits_today)} / ${fmt(me.allowance_credits)} credits, refills ${me.refill_at}`);
}

async function cmdUse() {
  const id = args[1];
  const { store } = await ensureStore();
  const account = findAccount(store, id) || findAccountByEmail(store, id);
  if (!account) {
    console.error(`unknown account: ${id}`);
    process.exit(1);
  }
  store.activeAccountId = account.id;
  await saveStore(store);
  console.log(`active account -> ${account.id} (${account.handle || account.email || '?'})`);
}

async function cmdRemove() {
  const id = args[1];
  const { store } = await ensureStore();
  const account = findAccount(store, id);
  if (!account) {
    console.error(`unknown account: ${id}`);
    process.exit(1);
  }
  if (!flag('force')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`really forget ${account.id} (${account.handle || account.email})? [y/N] `);
    rl.close();
    if (!/^\s*y(es)?\s*$/i.test(answer)) {
      console.log('aborted.');
      return;
    }
  }
  account.disabled = true; // keep the history, just stop using it
  if (store.activeAccountId === account.id) {
    const next = store.accounts.find(a => !a.disabled && a.id !== account.id);
    store.activeAccountId = next ? next.id : null;
  }
  await saveStore(store);
  console.log(`disabled ${account.id} (history kept for the usage totals)`);
}

async function cmdImport() {
  const store = await loadStore();
  const account = await importLegacyCredentials(store);
  if (!account) {
    console.log('nothing to import (no ~/.free-pi/agent/credentials.json or already known).');
  } else {
    console.log(`imported ${account.id}  handle=${account.handle || '?'}`);
  }
  await saveStore(store);
  console.log(`saved -> ${STORE_PATH}`);
}

const commands = {
  status: cmdStatus,
  refresh: cmdRefresh,
  plan: cmdPlan,
  add: cmdAdd,
  use: cmdUse,
  remove: cmdRemove,
  import: cmdImport,
  help: async () => {
    console.log('usage: node tools/freepi-accounts.mjs <status|refresh|plan|add|use|remove|import>');
  },
};

const run = commands[cmd] || commands.help;
run().catch(err => {
  console.error('[accounts] ' + (err && err.message ? err.message : err));
  process.exit(1);
});
