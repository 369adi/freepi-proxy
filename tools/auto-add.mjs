#!/usr/bin/env node
// auto-add.mjs — mint many free-pi accounts over a catch-all domain.
//
// THE HARD FACT THIS IS BUILT AROUND
// free-pi has exactly one auth path: GitHub OAuth. Verified against Clerk's own
// config (email_address.enabled=false, only first factors are oauth_github and
// ticket) and against the API (24 probed /auth/* routes, all email variants 404).
// So N free-pi accounts need N GitHub identities, and a catch-all domain is the
// only sane way to give each one a unique deliverable address.
//
// WHAT IS AUTOMATED
//   - a unique address per account (gh-N@arisya.de)
//   - a private browser profile per account, so no two accounts share cookies
//   - the entire free-pi side once GitHub is through: device code, consent,
//     token poll, /me, and the store write
//   - resumability: every account has a state row, a crash loses nothing
//
// THE GITHUB SIGN-UP STEP
// /signup is fronted by DataDome. Measured: the FIRST request in a fresh profile
// renders only the captcha iframe (0 inputs, empty body), but a SECOND request
// in the same profile returns the real form (21 inputs, 4 visible). So it is an
// interstitial, not a wall, and retrying is enough. Nothing here defeats the
// challenge; if it keeps appearing, the run stops and asks for a human.
//
// Email verification is NOT optional: GitHub will not let an unverified address
// "authorize OAuth app applications", and free-pi is reachable only through
// GitHub OAuth. Verification mail is read from the logged-in webmail profile
// (tools/_mail-login.mjs), because no IMAP password exists.
//
// USAGE
//   node tools\auto-add.mjs --count 50        run (waits for you per account)
//   node tools\auto-add.mjs --count 5 --dry-run
//   node tools\auto-add.mjs --resume          continue an interrupted run
//   node tools\auto-add.mjs --status
//
// ASCII only in all output.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rememberPassword, rekeySecret, SECRETS_PATH } from './lib/secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_PATH =
  process.env.FREEPI_AUTOADD_STATE || path.join(os.homedir(), '.free-pi', 'proxy', 'auto-add-state.json');
const STORE_PATH =
  process.env.FREEPI_ACCOUNTS_PATH || path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');
const SESSIONS_ROOT = path.join(os.homedir(), '.free-pi', 'sessions');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const o = { count: null, dryRun: false, resume: false, status: false, forget: false, prefix: null, start: null, keepOpen: false, waitMin: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count') o.count = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--status') o.status = true;
    else if (a === '--forget') o.forget = true;
    else if (a === '--prefix') o.prefix = argv[++i];
    else if (a === '--start') o.start = Number(argv[++i]);
    else if (a === '--keep-open') o.keepOpen = true;
    else if (a === '--wait-min') o.waitMin = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  console.log(`auto-add.mjs - mint free-pi accounts over a catch-all domain

  --count N      accounts to add in this run (default 1)
  --start N      first number to use (default: the store's next number)
  --prefix P     local-part prefix (default: store setting, "gh")
  --dry-run      print the plan, create nothing
  --resume       retry accounts that are not finished yet
  --status       print the state table and exit
  --forget       drop unfinished rows and move the counter past them
  --wait-min N   minutes to wait for the human step per account (default 15)
  --keep-open    leave the browser window and profile up after each account

Each account needs its own GitHub identity, because free-pi only accepts GitHub
OAuth. GitHub guards its sign-up page with a DataDome CAPTCHA, which this tool
will not bypass: it opens the page and waits for you to confirm once per account,
then finishes everything else automatically (verification link, device code,
consent, token, store).
`);
  process.exit(0);
}

// ---------------------------------------------------------------- helpers

const findBrowser = () => CHROME_CANDIDATES.find((c) => {
  try {
    return c && fs.existsSync(c);
  } catch {
    return false;
  }
}) || null;

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

function loadState() {
  const fresh = { version: 1, createdAt: new Date().toISOString(), runs: 0, accounts: [] };
  let raw;
  try {
    raw = fs.readFileSync(STATE_PATH, 'utf8');
  } catch {
    return fresh;
  }
  // A BOM is enough to make JSON.parse throw, and swallowing that silently
  // reset the counter, which made the next run rebuild already-burned
  // addresses. Strip it and never fail quietly on a file that exists.
  raw = raw.replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.accounts)) return parsed;
    console.warn('state file has no account list, starting a fresh one');
  } catch (e) {
    console.warn('state file is unreadable (' + (e && e.message) + '), starting a fresh one');
  }
  return fresh;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

const loadStoreRaw = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return null;
  }
};

function storeSettings() {
  const s = loadStoreRaw();
  return {
    domain: (s && s.settings && s.settings.emailDomain) || 'arisya.de',
    prefix: (s && s.settings && s.settings.emailPrefix) || 'gh',
    nextNumber: (s && s.nextAccountNumber) || ((s && s.accounts && s.accounts.length) || 0) + 1,
    taken: new Set(((s && s.accounts) || []).map((a) => (a.email || '').toLowerCase()).filter(Boolean)),
  };
}

function printStatus() {
  const state = loadState();
  const store = loadStoreRaw();
  const inStore = new Set(((store && store.accounts) || []).map((a) => (a.email || '').toLowerCase()));
  if (!state.accounts.length) {
    console.log('No auto-add runs yet (' + STATE_PATH + ').');
    console.log('store: ' + ((store && store.accounts && store.accounts.length) || 0) + ' account(s), next number ' + ((store && store.nextAccountNumber) || 1));
    console.log('passwords: ' + SECRETS_PATH + ' (read with tools\\freepi-passwords.mjs)');
    return;
  }
  const by = {};
  for (const a of state.accounts) by[a.status] = (by[a.status] || 0) + 1;
  console.log('state : ' + STATE_PATH);
  console.log('count : ' + state.accounts.length + '  (' + Object.entries(by).map(([k, v]) => k + '=' + v).join(' ') + ')');
  console.log('');
  for (const a of state.accounts) {
    const flag = inStore.has((a.email || '').toLowerCase()) ? '  IN-STORE' : '';
    console.log(
      '  ' +
        String(a.email || '?').padEnd(22) +
        String(a.status || '?').padEnd(13) +
        (a.handle ? '@' + a.handle : '').padEnd(20) +
        String(a.error || '').slice(0, 40) +
        flag,
    );
  }
  console.log('');
  console.log('passwords are in ' + SECRETS_PATH);
  console.log('read them with: node tools\\freepi-passwords.mjs');
}

// ---------------------------------------------------------------- CDP

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m.result);
        this.pending.delete(m.id);
      }
    });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('cdp websocket timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        res();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(t);
        rej(new Error('cdp websocket error'));
      });
    });
    await this.send('Page.enable');
    return this;
  }

  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        resolve(null);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (!r) return null;
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text || 'eval failed' };
    return r.result ? r.result.value : null;
  }

  navigate(url) {
    return this.send('Page.navigate', { url });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

const PAGE_STATE = `(() => {
  const vis = el => !!el && el.offsetParent !== null;
  const txt = el => ((el.innerText || el.value || '') + '').trim();
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 1200),
    inputs: Array.from(document.querySelectorAll('input')).filter(vis).map(i => ({
      name: i.name || null, id: i.id || null, type: i.type,
      placeholder: i.placeholder || null, value: i.type === 'password' ? null : (i.value || null),
    })),
    buttons: Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'))
      .filter(vis).map(txt).filter(Boolean).slice(0, 25),
    captcha: !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="captcha"], [data-sitekey]'),
  };
})()`;

async function pageTarget(port) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    return list.find((t) => t.type === 'page') || null;
  } catch {
    return null;
  }
}

async function launchBrowser(port, profileDir, url) {
  const exe = findBrowser();
  if (!exe) throw new Error('no Chrome or Edge found');
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1040,860',
      url || 'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 80; i += 1) {
    const p = await pageTarget(port);
    if (p) return { child, page: p };
    await sleep(300);
  }
  throw new Error('browser never exposed CDP on port ' + port);
}

// ---------------------------------------------------------------- free-pi

const apiMod = await import(pathToFileURL(path.join(HERE, 'lib', 'freepi-api.mjs')).href).catch(() => null);
if (!apiMod) {
  console.error('cannot load tools/lib/freepi-api.mjs');
  process.exit(1);
}
const mailbox = await import(pathToFileURL(path.join(HERE, 'lib', 'mailbox.mjs')).href).catch(() => null);
const storeMod = await import(pathToFileURL(path.join(HERE, 'lib', 'store.mjs')).href).catch(() => null);
const webHealth = await import(pathToFileURL(path.join(HERE, 'lib', 'webmail.mjs')).href).catch(() => null);

const CONSENT_VERSION = '4';

/**
 * Wait until the person has finished the GitHub sign-up in the open window and
 * a session exists. Detected by /login/device being reachable while logged in,
 * or by asking GitHub's own UI for a username.
 */
async function waitForGitHubSession(cdp, { timeoutMs, onTick }) {
  const deadline = Date.now() + timeoutMs;
  let lastNote = '';
  while (Date.now() < deadline) {
    const state = await cdp.eval(PAGE_STATE);
    if (state && !state.__error && state.url) {
      const url = String(state.url);
      const text = String(state.text || '');
      // Signed-in GitHub pages carry the user's own login in the header nav.
      const signedIn =
        /\/login\/device/.test(url) ||
        /\/settings|\/dashboard|dashboard\.github/.test(url) ||
        /signed in as|your profile/i.test(text);
      if (signedIn) return { ok: true, url, text };
      const note = /captcha/i.test(text) ? 'captcha on screen' : url.replace('https://github.com', '');
      if (note !== lastNote) {
        if (onTick) onTick(note);
        lastNote = note;
      }
    }
    await sleep(2000);
  }
  return { ok: false };
}

/** Ask GitHub who is logged in, by reading the meta user-login tag. */
async function githubUser(cdp) {
  const r = await cdp.eval(
    `(() => { const m = document.querySelector('meta[name="user-login"]'); return m ? m.content : null; })()`,
  );
  return typeof r === 'string' && r ? r : null;
}

/**
 * The full free-pi side of one account: device code, consent, token.
 * `approve` is the callback that gets the code approved on GitHub in the
 * browser the caller already has open.
 */
async function freePiLogin({ approve, timeoutMs = 240000, log }) {
  const started = await apiMod.deviceStart();
  const sessionId = started.session_id;
  log('device code ' + started.user_code);

  const verify =
    started.verification_uri_complete || started.verification_uri || 'https://github.com/login/device';
  await approve(verify, started.user_code);

  // Consent is required before /auth/token will hand out anything.
  try {
    await apiMod.deviceConsent(sessionId);
  } catch (err) {
    log('consent: ' + (err && err.message ? err.message : String(err)));
  }

  const deadline = Date.now() + timeoutMs;
  let delay = Math.max(2, Number(started.interval) || 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(delay);
    let res;
    try {
      res = await apiMod.devicePoll(sessionId, { timezone: 'Europe/Berlin', locale: 'de' });
    } catch (err) {
      if (err && err.code === 'consent_required') {
        try {
          await apiMod.deviceConsent(sessionId);
        } catch {
          /* retried below */
        }
        continue;
      }
      if (err && err.code === 'authorization_pending') continue;
      if (err && err.code === 'slow_down') {
        delay += 2000;
        continue;
      }
      throw err;
    }
    if (res && res.token) return res.token;
    if (res && res.status === 'pending') continue;
    if (res && res.error === 'authorization_pending') continue;
    if (res && res.error === 'slow_down') {
      delay += 2000;
      continue;
    }
    if (res && res.error === 'expired_token') throw new Error('device code expired');
  }
  throw new Error('GitHub approval never arrived');
}

/** Click the authorize button on the device confirmation page. */
async function authorizeDevicePage(cdp) {
  const expr = `(() => {
    var els = Array.prototype.slice.call(
      document.querySelectorAll('button, input[type=submit], a[role=button]'));
    for (var i = 0; i < els.length; i++) {
      var b = els[i];
      if (!b.offsetParent) continue;
      var label = ((b.innerText || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
      if (!/^authorize|authorize /i.test(label)) continue;
      if (/cancel|deny|different/i.test(label)) continue;
      // The Authorize button ships disabled and is enabled by a page script
      // that CDP may never trigger; the server still validates the session.
      if (b.disabled) { b.disabled = false; b.removeAttribute('disabled'); }
      var form = b.form || (b.closest ? b.closest('form') : null);
      if (form && typeof form.requestSubmit === 'function') {
        try { form.requestSubmit(b); return 'submitted:' + label; } catch (e) {}
      }
      b.click();
      return 'clicked:' + label;
    }
    return 'no-button';
  })()`;
  return cdp.eval(expr);
}

// ---------------------------------------------------------------- signup

const crypto = await import('node:crypto');

/** A password we can regenerate and that GitHub's strength meter accepts. */
function makePassword() {
  const words = ['amber', 'cedar', 'falcon', 'harbor', 'jasper', 'meadow', 'orbit', 'pixel', 'quartz', 'raven'];
  const w = () => words[crypto.randomInt(words.length)];
  const digits = String(crypto.randomInt(1000, 9999));
  return `${w()}-${w()}-${digits}-${crypto.randomBytes(2).toString('hex')}`;
}

/** A GitHub username derived from the local part, made unique-ish. */
function makeUsername(email, attempt = 0) {
  const base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
  // Attempt 0 used to carry no suffix at all, so a plain "gh-8" was sent and
  // GitHub answered "not available". Every attempt now gets its own suffix.
  if (!attempt) {
    const tail = crypto.randomBytes(3).toString('hex');
    return (base + '-' + tail).slice(0, 30);
  }
  const tail = crypto.randomBytes(3).toString('hex') + String(crypto.randomInt(10, 99));
  return (base + '-' + tail).slice(0, 30);
}

/**
 * GitHub names the usernames it would accept when ours is taken. Those are
 * guaranteed free, so use them instead of guessing again.
 */
async function suggestUsername(cdp) {
  const r = await cdp.eval(`(() => {
    const t = document.body ? document.body.innerText : '';
    const m = t.match(/if you want to use it[,:]?\\s*([a-z0-9-]{3,30})/i);
    if (m) return m[1];
    const all = t.match(/\\b([a-z0-9][a-z0-9-]{4,28}[a-z0-9])\\b/gi) || [];
    const bad = /username|github|available|account|email|password|cookies|privacy|terms|sign|create|continue/i;
    for (const c of all) if (!bad.test(c)) return c;
    return null;
  })()`);
  return typeof r === 'string' && r ? r : null;
}

/**
 * Get the real sign-up form. The first hit is usually the DataDome
 * interstitial; a retry in the same profile loads the form. We only ever
 * retry - we never try to solve or bypass the challenge.
 */
async function loadSignupForm(cdp, { attempts = 6, log } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    await cdp.navigate('https://github.com/signup');
    for (let w = 0; w < 16; w += 1) {
      await sleep(700);
      const st = await cdp.eval(SIGNUP_STATE);
      if (!st || st.__error) continue;
      if (st.ready) {
        if (i > 1 && log) log('  sign-up form appeared on attempt ' + i);
        return { ok: true, state: st };
      }
      // The challenge needs a moment; if it is present, let it settle.
      if (st.captcha) break;
      if (st.emailVisible) return { ok: true, state: st };
    }
    if (log && i > 1) log('  attempt ' + i + ': still the interstitial');
    await sleep(2500);
  }
  return { ok: false };
}

const SIGNUP_STATE = `(() => {
  const vis = el => !!el && el.offsetParent !== null;
  const all = Array.from(document.querySelectorAll('input'));
  const email = document.querySelector('input[name="user[email]"], #email');
  const pass = document.querySelector('input[name="user[password]"], #password');
  return {
    url: location.href,
    title: document.title,
    captcha: !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="captcha"], [data-sitekey]'),
    inputs: all.filter(vis).map(i => ({ name: i.name || null, id: i.id || null, type: i.type })),
    emailVisible: !!(email && vis(email)),
    passwordVisible: !!(pass && vis(pass)),
    ready: !!(email && vis(email)) || all.filter(vis).length >= 3,
  };
})()`;

/** Fill the three sign-up fields and submit. */
async function fillSignup(cdp, { email, password, username }) {
  const expr = `(() => {
    const set = (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    };
    const email = ${JSON.stringify(email)};
    const pass = ${JSON.stringify(password)};
    const user = ${JSON.stringify(username)};
    const okEmail = set('input[name="user[email]"], #email', email);
    const okPass = set('input[name="user[password]"], #password', pass);
    const okUser = set('input[name="user[login]"], #login', user);
    return { okEmail, okPass, okUser };
  })()`;
  const filled = await cdp.eval(expr);
  if (!filled || filled.__error) return { ok: false, error: 'could not fill the form' };
  if (!filled.okEmail) return { ok: false, error: 'email field missing' };

  // Let GitHub's own validation run before submitting.
  await sleep(1200);
  const submitted = await cdp.eval(`(() => {
    // Only the real submit control may be used. The page also carries
    // "Continue with Google" / "Sign up with Apple" buttons, and a loose
    // /continue|sign up/ test matched those first, which navigated the whole
    // flow off to an OAuth provider and looked like "the form never redirected".
    const btns = Array.from(document.querySelectorAll('button[type=submit], input[type=submit], button'));
    const label = el => (el.innerText || el.value || '').trim();
    const isOauth = el => {
      const t = label(el).toLowerCase();
      const cls = (el.className || '') + ' ' + (el.getAttribute('data-test-selector') || '');
      return /google|apple|microsoft|oauth|sso|social|passkey/.test(t) || /oauth|social|provider/i.test(cls);
    };
    const exact = btns.find(el => el.offsetParent !== null && !isOauth(el) && /^create account$/i.test(label(el)));
    const loose = btns.find(el => el.offsetParent !== null && !isOauth(el) && /create account/i.test(label(el)));
    const b = exact || loose;
    if (!b) return 'no-button';
    if (b.disabled) { b.disabled = false; b.removeAttribute('disabled'); }
    const f = b.form || b.closest('form');
    if (f && f.requestSubmit) { try { f.requestSubmit(b); return 'submitted'; } catch (e) {} }
    b.click();
    return 'clicked';
  })()`);
  return { ok: submitted === 'submitted' || submitted === 'clicked', result: submitted, filled };
}

/** Read any inline error GitHub is showing on the sign-up form. */
async function signupError(cdp) {
  return cdp.eval(`(() => {
    const errs = Array.from(document.querySelectorAll('.error, [class*="error" i], [role=alert]'))
      .filter(e => e.offsetParent !== null).map(e => (e.innerText||'').trim()).filter(Boolean);
    return errs.slice(0, 4).join(' | ') || null;
  })()`);
}


/** Does the account already have a verified address? */
async function checkVerified(cdp) {
  const r = await cdp.eval(`(() => {
    const t = (document.body ? document.body.innerText : '') || '';
    // The negative test MUST run first: the "please verify" banner contains
    // the words "verify" and "email" and would otherwise look positive.
    if (/please verify your email|verify your email address|confirm your email/i.test(t)) return false;
    if (/email verified|verified email|your email has been verified/i.test(t)) return true;
    // A stored address on the account page is already verified in practice.
    const el = document.querySelector('[class*="verified" i], .verified-email, [data-testid*="verified" i]');
    if (el) return true;
    return null;
  })()`);
  return r === true;
}

/**
 * Open the verification link from the mailbox, in the sign-up profile.
 * The mail profile stays logged in, so this needs no credentials.
 */
async function verifyByMail(email, { timeoutMs = 240000, log } = {}) {
  let webmail;
  try {
    webmail = await webHealth.openBrowser({ url: webHealth.WEBMAIL_URL });
  } catch (e) {
    return { ok: false, error: 'could not open the mail profile: ' + (e && e.message) };
  }
  try {
    const inThere = await webHealth.isLoggedIn(webmail.cdp);
    if (!inThere) {
      return { ok: false, error: 'mail profile is logged out - run `node tools\\_mail-login.mjs` once' };
    }
    const found = await webHealth.findGithubLinks(webmail.cdp, {
      to: email,
      timeoutMs,
      onPoll: (n) => log('  mail: ' + n),
    });
    if (!found.ok) return { ok: false, error: 'no verification mail arrived' };

    // The inbox row does not carry the confirm link; open the message itself.
    const opened = await webmail.cdp.eval(`(() => {
      const local = ${JSON.stringify(String(email).split('@')[0].toLowerCase())};
      const els = Array.from(document.querySelectorAll('a, tr, [role=row]'));
      for (const el of els) {
        const t = (el.innerText || '').toLowerCase();
        if (!t.includes(local)) continue;
        if (!/github|verif|confirm|best/i.test(t)) continue;
        const a = el.matches && el.matches('a') ? el : (el.querySelector && el.querySelector('a'));
        if (a) { a.click(); return 'clicked'; }
        el.click();
        return 'clicked-row';
      }
      return 'not-found';
    })()`);
    if (opened !== 'clicked' && opened !== 'clicked-row') {
      return { ok: false, error: 'found the mail but could not open it (' + opened + ')' };
    }

    // Now read the verification link out of the opened message.
    let link = null;
    for (let w = 0; w < 10; w += 1) {
      await sleep(1500);
      link = await webmail.cdp.eval(`(() => {
        const as = Array.from(document.querySelectorAll('a[href]'));
        for (const a of as) {
          const h = a.href || '';
          if (!/github\\.com/.test(h)) continue;
          if (/\\.(css|js|png|svg|ico)$/i.test(h)) continue;
          if (/account_verifications|email_verification|verify-email|confirm/i.test(h)) return h;
        }
        return null;
      })()`);
      if (typeof link === 'string' && link) break;
    }
    if (typeof link !== 'string' || !link) {
      return { ok: false, error: 'the mail had no GitHub verification link' };
    }
    return { ok: true, link, row: found.row };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    if (webmail) webmail.kill();
  }
}

async function addOne({ email, port, profileDir, keepOpen, waitMin, log }) {
  let cdp = null;
  let child = null;
  try {
    const password = makePassword();
    let username = makeUsername(email);

    // Save the password before it is used anywhere. If the run dies mid-signup
    // the account may still exist on GitHub, and this file is then the only way
    // back in. Keyed by email for now; re-keyed to the account id once stored.
    //
    // A failure here is not cosmetic: the account would be unrecoverable, so the
    // run stops instead of continuing with a password that exists only in memory.
    try {
      await rememberPassword(email, { email, password, note: 'github sign-up, auto-add' });
    } catch (err) {
      return {
        ok: false,
        stage: 'secrets',
        needsHuman: true,
        error: 'could not save the password to ~/.free-pi/proxy/secrets.json: ' + err.message,
        email,
        password,
      };
    }

    // The sign-up profile starts blank so each account is genuinely separate.
    const launched = await launchBrowser(port, profileDir, 'https://github.com/signup');
    child = launched.child;
    cdp = await new CdpPage(launched.page.webSocketDebuggerUrl).open();
    await sleep(2000);

    // --- step 1: get the real form ----------------------------------------
    log('loading the sign-up form');
    let form = await loadSignupForm(cdp, { log });
    if (!form.ok) {
      return { ok: false, stage: 'signup', needsHuman: true, error: 'sign-up form never appeared (DataDome kept the door shut)' };
    }

    // --- step 2: create the account ---------------------------------------
    let filled = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        username = makeUsername(email, attempt);
        form = await loadSignupForm(cdp, { log });
        if (!form.ok) return { ok: false, stage: 'signup', needsHuman: true, error: 'sign-up form disappeared' };
      }
      log('creating @' + username + ' for ' + email);
      filled = await fillSignup(cdp, { email, password, username });
      if (!filled.ok) return { ok: false, stage: 'signup', error: filled.error };

      // Wait for GitHub to actually leave the sign-up page. Staying on
      // /signup means the submit did not take, whatever the page claims.
      let settled = null;
      let sawCaptcha = false;
      for (let w = 0; w < 16; w += 1) {
        await sleep(1500);
        const st = await cdp.eval(SIGNUP_STATE);
        if (!st || st.__error) continue;
        const url = String(st.url);
        if (st.captcha) {
          // DataDome re-checks on the POST itself. It clears on its own after
          // the challenge page has run for a while; we never interact with it.
          sawCaptcha = true;
          continue;
        }
        // Still on a sign-up-ish page? Keep waiting unless it is a real
        // verification screen, which IS progress.
        if (/\/account_verifications|\/verify/i.test(url)) {
          settled = { url, signedUp: true };
          break;
        }
        if (/\/signup|\/join|\/session\/|layout|render|reveal|plan|select/i.test(url)) continue;
        // Anything else means we were redirected somewhere real.
        settled = { url, signedUp: true };
        break;
      }

      // The challenge often outlasts the first window. Give it one more pass
      // before deciding the submit failed.
      if (!settled && sawCaptcha) {
        if (log) log('  datadome challenge on submit - waiting it out');
        for (let w = 0; w < 12; w += 1) {
          await sleep(2500);
          const st = await cdp.eval(SIGNUP_STATE);
          if (!st || st.__error) continue;
          if (st.captcha) continue;
          const url = String(st.url);
          if (/\/signup|\/join/i.test(url) && !st.emailVisible) {
            settled = { url, signedUp: true };
            break;
          }
          if (/\/signup|\/join/i.test(url)) continue;
          settled = { url, signedUp: true };
          break;
        }
      }

      if (settled) break;

      // No redirect: look for the reason before spending an attempt.
      const raw = await signupError(cdp);
      // Cut the cookie/consent boilerplate off; GitHub mixes it into the
      // same container as the real error.
      const err = raw
        ? String(raw)
            .split('|')
            .map((s) => s.trim())
            .filter((s) => s && !/use optional cookies|manage cookies|privacy statement|third-party/i.test(s))
            .join(' | ')
            .trim()
        : null;
      if (err) log('  github says: ' + err);

      // A challenge that survived the wait is a hard stop, not a validation
      // error. Report it as what it is so the summary is not misleading.
      if (sawCaptcha && !err) {
        return {
          ok: false,
          stage: 'signup',
          needsHuman: true,
          error: 'DataDome CAPTCHA on the sign-up POST - needs a human click',
          email,
          // The password is already in ~/.free-pi/proxy/secrets.json, but echo it
          // so a human solving the captcha in this very window can finish by hand.
          password,
        };
      }

      const retryable =
        !!err && /already taken|not available|unavailable|too (short|long|common)|is invalid|is reserved/i.test(err);
      if (retryable && attempt < 2) {
        // Prefer the names GitHub itself offered.
        const suggested = await suggestUsername(cdp);
        if (suggested) {
          log('  taking github\'s suggestion: @' + suggested);
          username = suggested;
        }
        continue;
      }
      return {
        ok: false,
        stage: 'signup',
        needsHuman: !!err && !retryable,
        error: err || 'the sign-up form never redirected (9)',
        email,
        password,
      };
    }

    // --- step 3: verify the email -----------------------------------------
    // Required: GitHub refuses OAuth authorisation for unverified addresses.
    // The verification link must be opened in THIS profile, because the
    // session it verifies is the one logged in here.
    let verified = await checkVerified(cdp);
    if (!verified) {
      log('verifying ' + email + ' via the logged-in webmail');
      const v = await verifyByMail(email, { log });
      if (!v.ok) {
        return {
          ok: false,
          stage: 'verify',
          needsHuman: true,
          error: v.error || 'could not verify the email',
          email,
          password,
        };
      }

      log('opening the verification link');
      await cdp.navigate(v.link);
      await sleep(4000);
      for (let w = 0; w < 12; w += 1) {
        const st = await cdp.eval(PAGE_STATE);
        if (st && !st.__error) {
          const blob = String(st.url) + ' ' + String(st.text || '');
          if (/verified|confirmed|success|ok/i.test(blob) && !/could not|invalid|expired/i.test(blob)) break;
        }
        await sleep(2000);
      }
      verified = await checkVerified(cdp);
      log(verified ? 'email confirmed on GitHub' : 'link opened; GitHub shows no verify banner');
    }

    // Backup for the normal path: GitHub sometimes wants the address confirmed
    // before OAuth, and the banner only shows up on the settings page.
    if (!verified) {
      await cdp.navigate('https://github.com/settings/emails');
      await sleep(3000);
      const still = await checkVerified(cdp);
      if (!still) {
        const pending = await cdp.eval(`(() => {
          const t = document.body ? document.body.innerText : '';
          return /unverified|not verified|verify/i.test(t);
        })()`);
        if (pending) {
          return {
            ok: false,
            stage: 'verify',
            needsHuman: true,
            error: 'GitHub still lists the address as unverified',
            email,
            password,
          };
        }
      }
      verified = still;
    }

    const handle = (await githubUser(cdp)) || username;
    log('GitHub session is up as @' + handle);

    // --- everything below is automatic ------------------------------------
    const token = await freePiLogin({
      log,
      approve: async (verifyUrl, code) => {
        log('approving device code on GitHub');
        await cdp.navigate(verifyUrl);
        const until = Date.now() + 120000;
        while (Date.now() < until) {
          await sleep(2500);
          const st = await cdp.eval(PAGE_STATE);
          if (!st || st.__error) continue;
          if (/device\/success|connected/i.test(String(st.url) + ' ' + String(st.text))) return;
          const r = await authorizeDevicePage(cdp);
          if (r && String(r).startsWith('submitted')) return;
        }
        throw new Error('device page never accepted the code');
      },
    });
    log('token received');

    const me = await apiMod.getMe(token).catch(() => null);
    handle = (me && me.handle) || handle || null;
    const credits = me && typeof me.remaining_credits_today === 'number' ? me.remaining_credits_today : null;
    log('account confirmed' + (handle ? ' @' + handle : '') + (credits !== null ? ', ' + credits + ' credits today' : ''));

    // --- store -------------------------------------------------------------
    const store = await storeMod.loadStore();
    if (store.accounts.some((a) => (a.email || '').toLowerCase() === email.toLowerCase())) {
      return { ok: true, handle, email, note: 'already in store' };
    }
    storeMod.addAccount(store, { token, email, handle, notes: 'auto-add.mjs' });
    if (me) {
      const acc = store.accounts[store.accounts.length - 1];
      storeMod.recordUsage(store, acc, me);
    }
    await storeMod.saveStore(store);
    const stored = store.accounts[store.accounts.length - 1];
    log('written to store as ' + stored.id);

    // Move the password from the email key to the account id, so a later lookup
    // by either still works and the file reads like the store does.
    const rekeyed = await rekeySecret(email, stored.id).catch(err => {
      log('WARNING could not re-key the saved password: ' + err.message);
      return null;
    });
    if (rekeyed && rekeyed.conflict) {
      // Another password already owned that id. Nothing was lost - the sign-up
      // password stays reachable under its email - but say so instead of
      // pretending the file is tidy.
      log('WARNING a different password already used the key ' + stored.id + '; the new one stays under ' + email);
    }

    return { ok: true, token, handle, email, accountId: stored.id };
  } catch (err) {
    return { ok: false, stage: 'login', error: err && err.message ? err.message : String(err) };
  } finally {
    if (cdp) cdp.close();
    // keepOpen used to mean "leave the profile on disk". It now also means
    // "leave the window up", which is what a human debugging a failure needs.
    // Leaving the profile AND killing the window was the worst of both worlds.
    if (child && !keepOpen) {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    } else if (child && keepOpen) {
      child.unref();
      log('  browser left open on port ' + port + ' (profile ' + profileDir + ')');
    }
  }
}

// ---------------------------------------------------------------- main

async function main() {
  if (ARGS.status) {
    printStatus();
    return;
  }

  // --forget drops the failed rows so the counter moves on to fresh addresses.
  // An address that reached GitHub's form is spent: its sign-up was partially
  // attempted and reusing it just replays the same rejection.
  if (ARGS.forget) {
    const state = loadState();
    const keep = [];
    let dropped = 0;
    let highest = 0;
    for (const a of state.accounts) {
      // Track the highest number over ALL rows, including the ones dropped
      // here. Otherwise forgetting every row resets the counter to the store's
      // value and the next run rebuilds the very addresses just burned.
      const n = Number((String(a.email).match(/-(\d+)@/) || [])[1]) || 0;
      highest = Math.max(highest, n);
      if (a.status === 'done') {
        keep.push(a);
      } else {
        console.log('forgetting ' + a.email + ' (' + a.status + ')');
        dropped += 1;
      }
    }
    state.accounts = keep;
    const settings = storeSettings();
    // The store has no writable next-number field, so the hint goes to the
    // state file, which the plan builder reads back on the next run.
    state.nextNumber = Math.max(state.nextNumber || 0, settings.nextNumber || 1, highest + 1);
    saveState(state);
    console.log('forgot ' + dropped + ', kept ' + keep.length + ', next number ' + state.nextNumber);
    return;
  }

  const settings = storeSettings();
  const prefix = ARGS.prefix || settings.prefix;
  const domain = settings.domain;

  const state = loadState();
  const known = new Set(state.accounts.map((a) => a.email));
  const plan = [];

  if (ARGS.resume) {
    for (const a of state.accounts) if (a.status !== 'done') plan.push(a.email);
  }

  const want = ARGS.count || (ARGS.resume ? 0 : 1);
  // --start wins, then the counter left behind by --forget, then the store.
  let n = ARGS.start || state.nextNumber || settings.nextNumber;
  let guard = 0;
  while (plan.length < want && guard++ < 100000) {
    const email = `${prefix}-${n}@${domain}`;
    n += 1;
    if (known.has(email) || settings.taken.has(email.toLowerCase())) continue;
    plan.push(email);
    known.add(email);
  }

  if (!plan.length) {
    console.log('nothing to do.');
    return;
  }

  console.log('auto-add: ' + plan.length + ' account(s)');
  console.log('  domain : ' + domain);
  console.log('  state  : ' + STATE_PATH);
  console.log('  store  : ' + STORE_PATH);
  if (ARGS.dryRun) {
    for (const e of plan) console.log('  would add: ' + e);
    console.log('\n--dry-run: nothing created.');
    return;
  }
  if (!findBrowser()) {
    console.error('no Chrome or Edge found');
    process.exit(1);
  }
  console.log('');

  state.runs = (state.runs || 0) + 1;
  let ok = 0;
  let bad = 0;
  const t0 = Date.now();

  for (let i = 0; i < plan.length; i += 1) {
    const email = plan[i];
    const slot = `[${i + 1}/${plan.length}]`;
    const log = (m) => console.log(`${slot} ${email}: ${m}`);

    const row = state.accounts.find((a) => a.email === email) || { email };
    if (!state.accounts.includes(row)) state.accounts.push(row);
    row.status = 'running';
    row.startedAt = new Date().toISOString();
    row.error = null;
    saveState(state);

    const port = await freePort();
    const profileDir = path.join(SESSIONS_ROOT, 'auto-' + Date.now().toString(36) + '-' + i);

    const res = await addOne({ email, port, profileDir, keepOpen: ARGS.keepOpen, waitMin: ARGS.waitMin, log });

    row.finishedAt = new Date().toISOString();
    if (res.ok) {
      row.status = 'done';
      row.handle = res.handle || null;
      row.error = null;
      ok += 1;
      log('OK');
    } else {
      row.status = res.needsHuman ? 'needs-human' : 'failed';
      row.stage = res.stage || null;
      row.error = res.error || 'unknown';
      bad += 1;
      log('not done at ' + (res.stage || '?') + ': ' + res.error);
      if (res.needsHuman) {
        saveState(state);
        console.log('');
        console.log('Stopped: ' + (res.error || 'this step needs a human'));
        if (!ARGS.keepOpen) {
          console.log('Re-run with --keep-open to keep the browser window up and do the');
          console.log('human step yourself, then `node tools\\auto-add.mjs --resume`.');
        } else {
          console.log('The browser window is still open. Do the human step there, then run');
          console.log('`node tools\\auto-add.mjs --resume` to continue.');
        }
        break;
      }
    }
    saveState(state);

    if (!ARGS.keepOpen) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* locked, cleaned next run */
      }
    }
  }

  console.log('');
  console.log(`finished in ${Math.round((Date.now() - t0) / 1000)}s: ${ok} ok, ${bad} not done`);
  if (ok) console.log('restart the proxy so it picks up the new accounts.');
}

main().catch((e) => {
  console.error('auto-add failed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
