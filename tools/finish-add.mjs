// Finish a GitHub device-flow login end to end in the already-signed-in tab.
// Loads the plugin source, exposing its internal helpers through a temporary
// patched copy so we reuse the exact same API calls and store format.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENTRY = fileURLToPath(new URL('../plugin/lib/index.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- expose internals via a temp copy ---------------------------------
let src = fs.readFileSync(ENTRY, 'utf8');
if (!/export \{ apply, inject, name \};?\s*$/.test(src)) {
  console.log('unexpected export shape, aborting');
  process.exit(1);
}
src = src.replace(
  /export \{ apply, inject, name \};?\s*$/,
  'export { apply, inject, name };\nexport const __internals = { deviceStart, devicePoll, deviceConsent, getMe, loadStore, saveStore, nextMintEmail, readSelection };\n',
);
// The copy must live next to the original so its relative imports still resolve.
const tmp = path.join(path.dirname(ENTRY), '_internals-' + Date.now() + '.mjs');
fs.writeFileSync(tmp, src, 'utf8');
const mod = await import(pathToFileURL(tmp).href);
const api = mod.__internals;

// ---- raw CDP against the running automatable browser -------------------
const list = await fetch('http://127.0.0.1:9455/json/list').then((r) => r.json());
let page = list.find((t) => t.type === 'page');
if (!page) {
  console.log('no tab open');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
  setTimeout(() => rej(new Error('ws timeout')), 8000);
});
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve(null);
      }
    }, 15000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { error: r.exceptionDetails.text };
  return r?.result?.value;
}

// ---- 1. fresh device session ------------------------------------------
const started = await api.deviceStart();
const userCode = started.user_code;
const verify =
  started.verification_uri_complete || started.verification_uri || 'https://github.com/login/device';
console.log('CODE: ' + userCode);

// ---- 2. open activation page ------------------------------------------
await send('Page.navigate', { url: verify });
await sleep(3500);

// ---- 3. walk the page -------------------------------------------------
const PAGE_STATE = `(() => ({
  url: location.href,
  text: (document.body ? document.body.innerText : '').slice(0, 1500),
  inputs: Array.from(document.querySelectorAll('input')).map(i => ({
    name: i.name, id: i.id, type: i.type, value: i.value,
    auto: i.autocomplete, vis: i.offsetParent !== null
  })),
  buttons: Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'))
    .filter(b => b.offsetParent !== null)
    .map(b => (b.innerText || b.value || '').trim()).filter(Boolean),
}))()`;

const AVOID = 'sign in with|continue with|switch account|use another|different account|sign out|log out|forgot password|passkey|sign up|create account';

async function clickByLabel(source) {
  // A regex literal transports the pattern without a second escaping layer,
  // which new RegExp("<string>") cannot do through a template literal.
  const literal = source;
  return evaluate(`(() => {
    try {
      var re = ${literal};
      var avoid = ${AVOID === null ? 'null' : '/(' + AVOID + ')/i'};
      var els = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type=submit], a[role=button]'));
      for (var i = 0; i < els.length; i++) {
        var b = els[i];
        if (!b.offsetParent || b.disabled) continue;
        var label = ((b.innerText || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
        if (!re.test(label)) continue;
        if (avoid && avoid.test(label)) continue;
        var form = b.form || (b.closest ? b.closest('form') : null);
        if (form && typeof form.requestSubmit === 'function') {
          try { form.requestSubmit(b); return label; } catch (e) {}
        }
        b.click();
        return label;
      }
      return 'none';
    } catch (err) { return 'err:' + (err && err.message); }
  })()`);
}

async function fillCode(code) {
  return evaluate(`(() => {
    try {
      var raw = ${JSON.stringify(code)};
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      function set(el, val) {
        el.focus();
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var boxes = Array.prototype.slice.call(document.querySelectorAll('input[name^="user-code-"]'))
        .filter(function (el) { return el.offsetParent !== null && el.value !== '-'; });
      if (boxes.length >= 4) {
        var chars = raw.replace(/[^A-Za-z0-9]/g, '').split('');
        boxes.slice(0, chars.length).forEach(function (el, i) { set(el, chars[i]); });
        return 'boxes:' + boxes.length + '/' + chars.length;
      }
      var single = Array.prototype.slice.call(document.querySelectorAll('input'))
        .filter(function (el) { return el.offsetParent !== null && el.type !== 'hidden'; })
        .find(function (el) {
          return /user_code|^code$/i.test(el.name || '') || /user_code|^code$/i.test(el.id || '') ||
                 el.autocomplete === 'one-time-code';
        });
      if (single) { set(single, raw); return 'single'; }
      return 'none';
    } catch (err) { return 'err:' + (err && err.message); }
  })()`);
}

let codeEntered = false;
let done = false;

for (let step = 0; step < 45 && !done; step++) {
  await sleep(1200);
  const st = await evaluate(PAGE_STATE);
  if (!st || st.error) continue;
  const url = st.url || '';
  const text = (st.text || '').toLowerCase();
  console.log('step ' + step + ' url=' + url + ' boxes=' +
    (st.inputs || []).filter((i) => /^user-code-/.test(i.name || '')).length +
    ' codeEntered=' + codeEntered + ' btns=' + JSON.stringify(st.buttons));

  if (/device connected|you are now|all set|congratulations|successfully authenticated|you can close/i.test(text)) {
    console.log('step ' + step + ': SUCCESS');
    done = true;
    break;
  }

  const hasBoxes = (st.inputs || []).some((i) => /^user-code-/.test(i.name || ''));
  const hasField = (st.inputs || []).some(
    (i) => /user_code|^code$/i.test(i.name || '') || i.auto === 'one-time-code',
  );

  if (!codeEntered && (hasBoxes || hasField)) {
    const filled = await fillCode(userCode);
    console.log('step ' + step + ': filled ' + filled);
    if (filled !== 'none' && !String(filled).startsWith('err')) {
      codeEntered = true;
      await sleep(900);
      const sub = await clickByLabel('/\\bcontinue\\b|\\bweiter\\b|\\bsubmit\\b/i');
      console.log('step ' + step + ': submit -> ' + sub);
      await sleep(2500);
      continue;
    }
  }

  if (/device activation|signed in as/i.test(text) && !codeEntered) {
    const cont = await clickByLabel('/\\bcontinue as\\s+\\S|\\bweiter als\\s+\\S|^continue$|^weiter$/i');
    console.log('step ' + step + ': continue -> ' + JSON.stringify(cont));
    if (cont !== 'none' && !String(cont).startsWith('err')) {
      await sleep(2500);
      continue;
    }
  }

  if (/authorize|authorisieren/i.test(text)) {
    // GitHub ships the OAuth authorize button disabled and enables it from a
    // page script. When that script has not run, the button stays disabled and
    // requestSubmit(disabledButton) is a no-op, so re-enable it first.
    const ok = await evaluate(`(() => {
      var els = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type=submit]'));
      for (var i = 0; i < els.length; i++) {
        var b = els[i];
        var label = ((b.innerText || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
        if (!/authorize|grant access|autorisieren/i.test(label)) continue;
        if (/cancel|different|sign out/i.test(label)) continue;
        var was = b.disabled;
        b.disabled = false;
        b.removeAttribute('disabled');
        var form = b.form || (b.closest ? b.closest('form') : null);
        if (form && typeof form.requestSubmit === 'function') {
          try { form.requestSubmit(b); return label + ' (unlocked ' + was + ')'; } catch (e) {}
        }
        b.click();
        return label + ' (clicked, was ' + was + ')';
      }
      return 'none';
    })()`);
    console.log('step ' + step + ': authorize -> ' + JSON.stringify(ok));
    if (ok !== 'none' && !String(ok).startsWith('err')) {
      await sleep(2500);
      continue;
    }
  }
}

// ---- 4. poll for token ------------------------------------------------
let token = null;
let consented = false;
for (let i = 0; i < 40 && !token; i++) {
  await sleep(2000);
  try {
    const res = await api.devicePoll(started.session_id);
    if (typeof res?.token === 'string') token = res.token;
  } catch (err) {
    // ApiError carries the code on the object, not only in the message.
    const code = String(err?.code || '');
    const m = String(err?.message || err);
    if (code === 'consent_required' || /consent required|consent_required/i.test(m)) {
      if (!consented) {
        await api.deviceConsent(started.session_id);
        consented = true;
        console.log('consent accepted');
      }
      continue;
    }
    if (code === 'authorization_pending' || code === 'slow_down' || /pending|slow_down/i.test(m)) {
      continue;
    }
    if (code === 'expired_token' || /expired/i.test(m)) {
      console.log('EXPIRED');
      break;
    }
    console.log('poll [' + code + ']: ' + m);
  }
}

if (!token) {
  console.log('NO TOKEN');
  ws.close();
  process.exit(1);
}
console.log('token ok (' + token.length + ' chars)');

const me = await api.getMe(token);
console.log('handle: ' + (me.handle || me.login || me.user_id));

// ---- 5. save ---------------------------------------------------------
const store = api.loadStore();
const existing = (store.accounts || []).find((a) => a.userId && me.user_id && a.userId === me.user_id);
const now = new Date().toISOString();

if (existing) {
  existing.token = token;
  existing.tokenBad = false;
  existing.disabled = false;
  existing.lastError = null;
  existing.updatedAt = now;
  if (me.remaining_credits_today != null) {
    existing.usage = existing.usage || {};
    existing.usage.remainingCreditsToday = me.remaining_credits_today;
    existing.usage.allowanceCredits = me.allowance_credits;
    existing.usage.refillAt = me.refill_at;
    existing.usage.tier = me.tier;
    existing.usage.lane = me.lane;
    existing.usage.fetchedAt = now;
  }
  api.saveStore(store);
  console.log('UPDATED existing account ' + existing.id);
} else {
  const n = store.nextAccountNumber || (store.accounts?.length || 0) + 1;
  const account = {
    id: 'acc-' + n,
    number: n,
    email: null,
    handle: me.handle || me.login || null,
    userId: me.user_id || null,
    token,
    createdAt: now,
    lastUsedAt: now,
    lastError: null,
    disabled: false,
    tokenBad: false,
    usage: {
      remainingCreditsToday: me.remaining_credits_today,
      allowanceCredits: me.allowance_credits,
      refillAt: me.refill_at,
      tier: me.tier,
      lane: me.lane,
      fetchedAt: now,
    },
    day: {
      date: now.slice(0, 10),
      startRemaining: me.remaining_credits_today,
      lastRemaining: me.remaining_credits_today,
      usedCredits: 0,
    },
    history: [],
    notes: 'added via finish-add.mjs (' + userCode + ')',
  };
  store.accounts = [...(store.accounts || []), account];
  store.nextAccountNumber = n + 1;
  store.activeAccountId = account.id;
  store.totals = store.totals || { accountsMinted: 0, creditsUsedTotal: 0, byDay: {} };
  store.totals.accountsMinted = (store.totals.accountsMinted || 0) + 1;
  api.saveStore(store);
  console.log('ADDED new account ' + account.id + ' @' + account.handle);
}

console.log('accounts now: ' + api.loadStore().accounts.length);
ws.close();
fs.unlinkSync(tmp);
