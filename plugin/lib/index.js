/**
 * Slash commands for the local free-pi proxy.
 *
 *   /freepi-add     add a free-pi account (opens GitHub, code pre-filled)
 *   /freepi-status  per-account budget and refill time
 *   /freepi-usage   live proxy load: lanes, in-flight, queue
 *   /freepi-history credits used per day, newest first
 *   /freepi-doctor  one-shot health check for store, tokens, proxy
 *
 * Zero dependencies beyond Node itself. Account state lives in the proxy's
 * own store (~/.free-pi/proxy/accounts.json), so a newly added account is
 * picked up by the running proxy without a restart.
 *
 * @module dsh-command-freepi
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchSavedAccount, accountInputHint } from './manual-selection.js';

const name = 'command-freepi';
const inject = ['commands'];

const API_BASE = 'https://api.freepi.ai';
const CLIENT_VERSION = '0.6.15';
const CONSENT_VERSION = '4';
const PROXY_URL = process.env.FREEPI_PROXY_URL || 'http://127.0.0.1:4000';
const PROXY_USAGE = PROXY_URL + '/usage';
const PROXY_BUDGET = PROXY_URL + '/budget';
const PROXY_HISTORY = PROXY_URL + '/history';
const STORE_PATH =
  process.env.FREEPI_ACCOUNTS_PATH ||
  path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');
// The proxy reads this file on every request; deleting it means "rotate again".
const SELECTION_PATH = path.join(path.dirname(STORE_PATH), 'selected-account.json');
const DAILY_CREDITS = 15000;
// Mirrors tools/lib/policy.mjs so /freepi-doctor judges freshness the same way.
const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_LOW_WATERMARK = 0.1;

// ---------------------------------------------------------------- utilities

/**
 * Open a URL in the browser we actually drive.
 *
 * This must never fall back to the OS default browser: on this machine that is
 * Brave, which is not the profile the automation is attached to. Whatever the
 * user sees would then be a different browser than the one being driven.
 */
function openBrowser(url, target = persistentBrowser()) {
  try {
    const exe = findBrowser();
    if (!exe) return false;
    fs.mkdirSync(target.profileDir, { recursive: true });
    const child = spawn(
      exe,
      [
        `--remote-debugging-port=${target.port}`,
        `--user-data-dir=${target.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1024,820',
        url,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Put text on the clipboard. Returns false when no tool is available. */
function copyToClipboard(text) {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['clip', []]
        : process.platform === 'darwin'
          ? ['pbcopy', []]
          : ['xclip', ['-selection', 'clipboard']];
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(text);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- browser automation

const BROWSER_ROOT = path.join(os.homedir(), '.free-pi');
// Kept for the --reuse path and for older configs.
const BROWSER_DIR =
  process.env.FREEPI_BROWSER_DIR || path.join(BROWSER_ROOT, 'browser');
const CDP_PORT = Number(process.env.FREEPI_CDP_PORT || 9455);
// Every add gets its own throw-away profile, so the account that is currently
// signed in is never touched and no sign-out is needed. These live side by side
// with the persistent profile and are deleted once the account is in the store.
const SESSIONS_ROOT = path.join(BROWSER_ROOT, 'sessions');
// Deliberately Chrome/Edge only. Brave is NOT a fallback: it ignores the
// debugging port in some builds and hardens the sign-in page against scripted
// logins. The flow never copies cookie databases either, so profile encryption
// is never an obstacle -- the browser is driven live over CDP instead.
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

// Pinned first-run set so a stale profile can never point the flow at a
// different browser than the one we launch.
const BROWSER_FORBIDDEN = /brave|vivaldi|opera/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function cdpVersion(port = CDP_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Ask the OS for a port that is free right now. */
async function findFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A browser target: which profile to use and on which debug port.
 * `ephemeral` marks a throw-away profile that is deleted after the add, so the
 * next add starts with empty cookies and never disturbs the signed-in account.
 */
async function newSessionBrowser() {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const profileDir = path.join(SESSIONS_ROOT, id);
  return {
    profileDir,
    port: await findFreePort(),
    ephemeral: true,
    label: 'neues Profil (leere Cookies)',
  };
}

function persistentBrowser() {
  return {
    profileDir: BROWSER_DIR,
    port: CDP_PORT,
    ephemeral: false,
    label: 'gespeichertes Profil',
  };
}

/** Close the browser that owns this profile, if it is still running. */
async function closeBrowser(target) {
  try {
    const version = await cdpVersion(target.port);
    if (!version?.webSocketDebuggerUrl) return;
    const session = new CdpSession(version.webSocketDebuggerUrl);
    await session.connect();
    try {
      await session.send('Browser.close');
    } catch {
      /* the socket dies as the browser goes away */
    } finally {
      session.close();
    }
  } catch {
    /* nothing running, nothing to close */
  }
}

/** Delete a throw-away profile. Safe to call more than once. */
async function removeProfile(target) {
  if (!target?.ephemeral) return;
  try {
    await fs.promises.rm(target.profileDir, { recursive: true, force: true });
  } catch {
    /* a locked file is not worth failing the command over */
  }
}

/** Start a browser for this target with remote debugging, or reuse a live one. */
async function ensureBrowser(target = persistentBrowser()) {
  const port = target.port;
  let version = await cdpVersion(port);
  if (version) {
    const who = String(version.Browser || '');
    if (BROWSER_FORBIDDEN.test(who)) {
      // Something other than our Chrome/Edge is squatting on the port; driving
      // it would be unreliable, so say so instead of silently using it.
      throw new ApiError(
        0,
        'wrong_browser',
        `auf Port ${port} laeuft ${who} - bitte schliessen, dann erneut versuchen`,
      );
    }
    return { started: false, browser: who };
  }

  const exe = findBrowser();
  if (!exe) throw new ApiError(0, 'no_browser', 'kein Chrome/Edge gefunden');

  fs.mkdirSync(target.profileDir, { recursive: true });
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${target.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1024,820',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    version = await cdpVersion(port);
    if (version) return { started: true, browser: version.Browser };
  }
  throw new ApiError(0, 'no_browser', 'Browser reagiert nicht auf Debug-Port');
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 10000);
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timeout`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'eval failed');
    }
    return res.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Open a URL in the automatable browser and attach to its tab. */
async function openTab(url, target = persistentBrowser()) {
  await ensureBrowser(target);
  const port = target.port;
  let page = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) page = await res.json();
  } catch {
    /* fall through to the list-based lookup */
  }
  if (!page) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    page = list.find((t) => t.type === 'page') || list[0];
  }
  if (!page?.webSocketDebuggerUrl) throw new ApiError(0, 'no_browser', 'kein Tab verfuegbar');
  const session = new CdpSession(page.webSocketDebuggerUrl);
  await session.connect();
  return session;
}

const PAGE_STATE = `(() => {
  const txt = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    text: txt.slice(0, 1200),
    inputs: Array.from(document.querySelectorAll('input')).map(i => ({
      name: i.name, id: i.id, type: i.type, value: i.value,
      auto: i.autocomplete, vis: i.offsetParent !== null
    })),
    buttons: Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'))
      .filter(b => b.offsetParent !== null)
      .map(b => (b.innerText || b.value || '').trim()).filter(Boolean),
  };
})()`;

async function pageState(session) {
  return session.eval(PAGE_STATE);
}

/** Type the device code into GitHub's form, whatever layout it uses. */
async function enterDeviceCode(session, code) {
  return session.eval(`(() => {
    try {
      var raw = ${JSON.stringify(code)};
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      function set(el, val) {
        el.focus();
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Layout A: one box per character, named user-code-0..N (a '-' slot is hidden).
      var boxes = Array.prototype.slice.call(
        document.querySelectorAll('input[name^="user-code-"]'))
        .filter(function (el) { return el.offsetParent !== null && el.value !== '-'; });
      if (boxes.length >= 4) {
        var chars = raw.replace(/[^A-Za-z0-9]/g, '').split('');
        // Only the visible boxes take a character; the dash slot is skipped.
        boxes.slice(0, chars.length).forEach(function (el, i) {
          set(el, chars[i]);
        });
        return 'boxes:' + boxes.length + '/' + chars.length;
      }

      // Layout B: a single field for the whole code.
      var single = Array.prototype.slice.call(document.querySelectorAll('input'))
        .filter(function (el) {
          return el.type !== 'hidden' && el.type !== 'submit' &&
            el.offsetParent !== null && !/password/i.test(el.type);
        });
      var named = document.querySelector(
        'input[name="user_code"], input#user_code, input[autocomplete="one-time-code"]');
      if (named && (!single.length || named.offsetParent !== null)) {
        set(named, raw);
        return 'named';
      }
      if (single.length === 1) {
        set(single[0], raw);
        return 'single';
      }
      return 'none:' + single.length;
    } catch (err) {
      return 'err:' + (err && err.message ? err.message : String(err));
    }
  })()`);
}

/** Click the first visible button whose label matches `source` (a regex body). */
async function clickByLabel(session, source, avoid) {
  const avoidText = avoid == null ? '' : String(avoid);
  const avoidSrc = avoidText.replace(/^\/|\/[a-z]*$/g, '');
  const avoidFlags = avoidText.match(/\/([a-z]*)$/)?.[1] || '';
  const expression = `(() => {
    try {
      var re = new RegExp(${JSON.stringify(source.replace(/^\/|\/[a-z]*$/g, ''))},
                            ${JSON.stringify(source.match(/\/([a-z]*)$/)?.[1] || '')});
      var avoid = ${avoidSrc ? `new RegExp(${JSON.stringify(avoidSrc)}, ${JSON.stringify(avoidFlags)})` : 'null'};
      var els = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type=submit], a[role=button]'));
      for (var i = 0; i < els.length; i++) {
        var b = els[i];
        if (!b.offsetParent || b.disabled) continue;
        var label = ((b.innerText || b.value || '') + ' ' +
          (b.getAttribute('aria-label') || '')).trim();
        if (!re.test(label)) continue;
        if (avoid && avoid.test(label)) continue;
        b.click();
        return label;
      }
      return 'none';
    } catch (err) {
      return 'err:' + (err && err.message ? err.message : String(err));
    }
  })()`;
  try {
    return await session.eval(expression);
  } catch {
    return 'err';
  }
}

/**
 * Drive the GitHub device-login page end to end: enter the code, continue,
 * authorize. Requires the persistent browser profile to be signed in already;
 * if it is not, this throws a login_required error so the caller can tell the
 * user to sign in once.
 */
async function driveGithubLogin(session, code, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs || 120000);
  const signal = opts.signal;
  const deviceUrl = opts.verificationUriComplete || opts.verificationUri || null;
  const safe = '/sign up|create account|new to github|cancel|abbrechen|different account|another account|sign out|log out/i';
  let codeEntered = false;
  let sawLogin = false;
  let everSawLogin = false;
  let loginSeenAt = 0;
  let passedPicker = false;
  let lastSignature = '';
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ApiError(0, 'aborted', 'abgebrochen');
    await sleep(1000);

    let state;
    try {
      state = await pageState(session);
    } catch {
      continue;
    }
    const url = state.url || '';
    const text = (state.text || '').toLowerCase();

    // GitHub asks to sign in first: this profile has no session yet. With a
    // throw-away profile that is the normal case, not an error - the window is
    // on screen, so wait for the user to sign in as the account to add instead
    // of aborting. Nothing about the already-signed-in profile is touched.
    if (/\/login\b/.test(url) && /sign in to github|username or email/i.test(text)) {
      if (!sawLogin) {
        sawLogin = true;
        everSawLogin = true;
        loginSeenAt = Date.now();
      }
      const pw = state.inputs.find((i) => i.type === 'password');
      if (pw && pw.value) {
        const clicked = await clickByLabel(session, '/^sign in/i', safe);
        if (clicked !== 'none') continue;
      }
      if (opts.waitForLogin) {
        if (Date.now() - loginSeenAt > (opts.loginWaitMs || 10 * 60 * 1000)) {
          throw new ApiError(
            0,
            'login_required',
            'kein Login im geoeffneten Fenster - bitte erneut versuchen',
          );
        }
        continue; // keep the window open and wait
      }
      throw new ApiError(
        0,
        'login_required',
        'bitte einmal im geoeffneten Chrome-Fenster bei GitHub einloggen',
      );
    }
    sawLogin = false;

    // Already finished?
    if (/device connected|you are now|all set|congratulations|successfully authenticated|you can close|fenster schliessen/i.test(text)) {
      return { ok: true, url };
    }

    // Account chooser: "Signed in as X" + a "Continue as <user>" button.
    if (!passedPicker && /select_account|signed in as/i.test(url + ' ' + text)) {
      const go = await clickByLabel(session, '/^continue|^weiter/i', /different|another/i);
      if (go !== 'none' && go !== 'err') {
        passedPicker = true;
        await sleep(2500);
        continue;
      }
    }

    // Device code form: type the code, then Continue.
    const hasCodeBoxes = state.inputs.some((i) => /^user-code-/.test(i.name || ''));
    const codeField =
      hasCodeBoxes ||
      state.inputs.some(
        (i) => /user_code|^code$/i.test(i.name || '') || i.auto === 'one-time-code',
      );

    if (!codeEntered && codeField) {
      const filled = await enterDeviceCode(session, code);
      if (filled !== 'none' && !/^(err|none)/.test(filled)) {
        codeEntered = true;
        await sleep(800);
        await clickByLabel(session, '/^continue|^weiter|^submit|^next/i', safe);
        await sleep(2500);
        continue;
      }
    }

    // Authorize / grant access.
    const clicked = await clickByLabel(
      session,
      '/authorize|autorisieren|grant access|^continue|^weiter|^confirm|approve access|^accept/i',
      safe,
    );
    if (clicked !== 'none' && clicked !== 'err') {
      await sleep(2000);
      continue;
    }

    // Nowhere left to go. If we walked the account picker already but never saw
    // the code form, jump straight to the code URL rather than giving up.
    if (passedPicker && !codeEntered && deviceUrl && !/device\?user_code/.test(url)) {
      codeEntered = false;
      try {
        await session.eval(`(() => { location.href = ${JSON.stringify(deviceUrl)}; return 'go'; })()`);
      } catch {
        /* navigation may drop the context */
      }
      await sleep(3500);
      continue;
    }

    // Nothing clickable: give up only once the page has been static a while.
    // While the person is still signing in, a static page is normal - they may
    // be typing, reading a 2FA prompt, or waiting on a password manager. Give
    // that case the full login window instead of a 15 s stall timeout, so a
    // thorough sign-in is never mistaken for a dead page.
    const signature = url + '|' + (state.buttons || []).join(',');
    if (signature === lastSignature) {
      const stallMs = opts.waitForLogin && sawLogin ? (opts.loginWaitMs || 10 * 60 * 1000) : 15000;
      if (Date.now() - stableSince > stallMs) {
        // A signed-in page that never reaches the authorize step is not a
        // "nobody logged in" failure; report it as such so the caller can tell
        // the person what to finish rather than claiming the login is missing.
        if (sawLogin) {
          throw new ApiError(
            0,
            'login_required',
            'Login gesehen, aber die Autorisierung wurde nicht abgeschlossen',
          );
        }
        break;
      }
    } else {
      lastSignature = signature;
      stableSince = Date.now();
    }
  }

  if (sawLogin || everSawLogin) {
    throw new ApiError(
      0,
      'login_required',
      'Login gesehen, aber die Autorisierung wurde nicht abgeschlossen',
    );
  }
  throw new ApiError(0, 'login_timeout', 'GitHub-Seite hat nicht reagiert');
}

// ---------------------------------------------------------------- device flow

/** Human-friendly "2h14m" style duration. */function human(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const total = Math.floor(ms / 60000);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

const num = (n) => Number(n ?? 0).toLocaleString('en-US');

/**
 * Does this command invocation ask for machine-readable output?
 *
 * `\b--json\b` never matches: `-` is not a word character, so there is no word
 * boundary before it. Match the flag as a real token instead, which also keeps
 * `x--json` from counting.
 */
function wantsJson(invocation) {
  const raw = typeof invocation === 'string' ? invocation : String(invocation?.rawInput ?? '');
  return /(^|\s)--json(\s|$)/.test(raw);
}

// --------------------------------------------------------------- store access

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

/** Next unused gh-N@domain suggestion, matching the proxy's own minting rule. */
function nextMintEmail(store) {
  const domain = store?.settings?.emailDomain || 'arisya.de';
  const prefix = store?.settings?.emailPrefix || 'gh';
  const taken = new Set((store?.accounts || []).map((a) => a.email));
  let n = store?.nextAccountNumber || (store?.accounts?.length || 0) + 1;
  for (let i = 0; i < 10000; i += 1) {
    const email = `${prefix}-${n}@${domain}`;
    if (!taken.has(email)) return email;
    n += 1;
  }
  return `${prefix}-new@${domain}`;
}

// ---------------------------------------------------------------- free-pi API

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function api(endpoint, { method = 'GET', token, body, signal } = {}) {
  const headers = {
    'x-client-version': CLIENT_VERSION,
    accept: 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new ApiError(0, 'network', `network error: ${error.message}`);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const code = data?.code || data?.error?.code || '';
    let message = data?.message || data?.error?.message || text.slice(0, 200);
    // The API reports a missing consent as 403; surface it as its own code.
    if (res.status === 403 && /consent/i.test(message || code)) {
      throw new ApiError(403, 'consent_required', message);
    }
    throw new ApiError(res.status, code, message);
  }
  return data;
}

const getMe = (token, signal) => api('/me', { token, signal });
const deviceStart = (signal) =>
  api('/auth/github/device', { method: 'POST', body: {}, signal });
const devicePoll = (sessionId, signal) =>
  api('/auth/token', {
    method: 'POST',
    body: {
      session_id: sessionId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      locale: 'en',
    },
    signal,
  });
const deviceConsent = (sessionId, signal) =>
  api('/auth/consent', {
    method: 'POST',
    body: { session_id: sessionId, consent_version: CONSENT_VERSION },
    signal,
  });

// ------------------------------------------------------------- device flow

/**
 * Run one GitHub device-flow login and return a live free-pi token.
 * onCode receives { userCode, verificationUri, verificationUriComplete, expiresIn }.
 *
 * When `autoApprove` is set the code is submitted automatically through the
 * browser in `browser` (a target from newSessionBrowser()/persistentBrowser()).
 * With a throw-away profile the GitHub sign-in page is expected and the driver
 * waits for it instead of aborting, so the account already signed in elsewhere
 * never has to be signed out.
 */
async function loginWithDeviceFlow({
  onCode,
  signal,
  timeoutMs = 15 * 60 * 1000,
  pollMs,
  autoApprove = false,
  browser = persistentBrowser(),
}) {
  const started = await deviceStart(signal);
  const sessionId = started.session_id;
  const interval = pollMs || Math.max(1, Number(started.interval) || 5) * 1000;
  const deadline = Date.now() + Math.min(timeoutMs, (Number(started.expires_in) || 900) * 1000);
  const userCode = started.user_code;

  if (onCode) {
    onCode({
      userCode,
      verificationUri: started.verification_uri || 'https://github.com/login/device',
      verificationUriComplete: started.verification_uri_complete || null,
      sessionId,
      expiresIn: Number(started.expires_in) || 900,
    });
  }

  let consented = false;
  let networkFailures = 0;
  let approved = false;
  let automatonError = null;
  let automation = null;

  if (autoApprove) {
    // Open the GitHub tab immediately and drive it in the background while we
    // poll the token endpoint.
    automation = (async () => {
      try {
        const session = await openTab(
          started.verification_uri_complete ||
            started.verification_uri ||
            'https://github.com/login/device',
          browser,
        );
        try {
          // openTab may reuse an existing tab; make sure we are on the code page
          // before the driver starts looking for the account picker.
          try {
            const here = await session.eval('location.href');
            const want = started.verification_uri_complete || started.verification_uri;
            if (want && !/login\/device/.test(String(here))) {
              await session.eval(`(() => { location.href = ${JSON.stringify(want)}; return 'go'; })()`);
              await sleep(3500);
            }
          } catch {
            /* navigation can drop the execution context; the driver re-reads state */
          }

          await driveGithubLogin(session, userCode, {
            signal,
            waitForLogin: Boolean(browser.ephemeral),
            loginWaitMs: Math.max(60_000, Math.min(deadline - Date.now(), 10 * 60 * 1000)),
            timeoutMs: Math.max(60_000, Math.min(deadline - Date.now(), 10 * 60 * 1000)),
            verificationUriComplete:
              started.verification_uri_complete || started.verification_uri,
          });
          approved = true;
        } finally {
          session.close();
        }
      } catch (error) {
        automatonError = error;
      }
    })();
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ApiError(0, 'aborted', 'cancelled');

    // The browser cannot log in on its own: stop early instead of hanging.
    // With a throw-away profile the person is signing in by hand, so a driver
    // that gave up on the page is NOT a fatal error - the token poll below is
    // the source of truth. Keep waiting for GitHub to confirm the code, which
    // is what actually proves the login worked.
    if (automatonError) {
      if (automation) await automation;
      const failure = automatonError;
      automatonError = null;
      const recoverable = failure.code === 'login_required' || failure.code === 'no_browser';
      if (!recoverable) throw failure;
      if (!browser.ephemeral && failure.code === 'login_required') throw failure;
      // else: fall through and keep polling until the code is approved or the
      // device code expires. No explicit action needed from the caller.
    }

    let result;
    try {
      result = await devicePoll(sessionId, signal);
      networkFailures = 0;
    } catch (error) {
      // 403 consent_required: accept the first-run consent once, then retry.
      if (error.status === 403 && error.code === 'consent_required') {
        if (!consented) {
          await deviceConsent(sessionId, signal);
          consented = true;
          continue;
        }
        throw new ApiError(403, 'consent_required', 'consent accepted but the API still asks for it');
      }
      if (/expired/i.test(error.message || '')) {
        throw new ApiError(error.status, 'expired_token', 'der Code ist abgelaufen');
      }
      if (error.status >= 400 && error.status < 500) throw error;
      networkFailures += 1;
      if (networkFailures >= 6) throw new ApiError(0, 'network', `token poll failed: ${error.message}`);
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }

    if (result && typeof result.token === 'string' && result.token) {
      return { token: result.token };
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new ApiError(0, 'timeout', 'Zeit abgelaufen - hat niemand den Code bestaetigt?');
}

// ------------------------------------------------------------ command handlers

function usageLine(account) {
  const used = account?.usage?.remainingCreditsToday;
  const total = account?.usage?.allowanceCredits || DAILY_CREDITS;
  if (typeof used !== 'number') return 'noch nicht gemessen';
  const pct = Math.round((used / total) * 100);
  const premium = account?.usage?.premiumCredits;
  return `${num(used)} / ${num(total)} daily (${pct}%) | Premium: ${typeof premium === 'number' ? num(premium) : 'not reported'}`;
}

function stateOf(account) {
  if (account.disabled) return 'off';
  if (account.tokenBad) return 'token kaputt';
  const remaining = account?.usage?.remainingCreditsToday;
  if (typeof remaining !== 'number') return 'unbekannt';
  if (remaining <= 0) return 'leer';
  if (remaining <= (account?.usage?.allowanceCredits || DAILY_CREDITS) * 0.1) return 'fast leer';
  return 'bereit';
}

// A crashed run must not leave a profile behind forever, and two adds at the
// same time would fight over the same GitHub device flow.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADD_LOCK = path.join(BROWSER_ROOT, 'add.lock');
const ADD_LOCK_STALE_MS = 20 * 60 * 1000;

async function sweepStaleSessions() {
  let entries;
  try {
    entries = await fs.promises.readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SESSIONS_ROOT, entry.name);
    try {
      const stat = await fs.promises.stat(dir);
      if (now - stat.mtimeMs < SESSION_MAX_AGE_MS) continue;
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* a profile still held open by a browser is retried on the next add */
    }
  }
  return removed;
}

function acquireAddLock() {
  try {
    const stat = fs.statSync(ADD_LOCK);
    if (Date.now() - stat.mtimeMs < ADD_LOCK_STALE_MS) return false;
  } catch {
    /* no lock present */
  }
  try {
    fs.mkdirSync(path.dirname(ADD_LOCK), { recursive: true });
    fs.writeFileSync(ADD_LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch {
    /* if the lock cannot be written, never block the add because of it */
  }
  return true;
}

function releaseAddLock() {
  try {
    fs.rmSync(ADD_LOCK, { force: true });
  } catch {
    /* nothing to release */
  }
}

/**
 * Run one add with its own browser target and always clean the throw-away
 * profile up again, whether the add succeeded, timed out or was cancelled.
 */
async function handleAdd(ctx, invocation) {
  if (!acquireAddLock()) {
    return {
      kind: 'error',
      text:
        'Es laeuft schon ein /freepi-add.\n\n' +
        'Zwei Adds gleichzeitig wuerden sich denselben GitHub-Login teilen.\n' +
        'Warte, bis das offene Fenster fertig ist, und starte dann den naechsten.',
    };
  }
  let browser = null;
  try {
    await sweepStaleSessions();
    const raw = invocation?.rawInput || '';
    // --reuse keeps the persistent profile (re-auth of the account signed in
    // there). Everything else gets fresh cookies so no sign-out is ever needed.
    const reuseProfile = /--reuse|--same-profile/.test(raw);
    browser = reuseProfile ? persistentBrowser() : await newSessionBrowser();
    return await addAccountWithBrowser(ctx, invocation, browser);
  } finally {
    if (browser?.ephemeral) {
      await closeBrowser(browser);
      await removeProfile(browser);
    }
    releaseAddLock();
  }
}

async function addAccountWithBrowser(ctx, invocation, browser) {
  const store = loadStore();
  if (!store) {
    return {
      kind: 'error',
      text: `Kein Proxy-Store unter ${STORE_PATH} - laeuft der Proxy schon einmal?`,
    };
  }

  const raw = invocation.rawInput || '';
  // --email lets you record the address you actually registered, instead of the
  // suggested catch-all one.
  const emailArg = (raw.match(/--email[=\s]+(\S+)/i) || [])[1];
  const suggestion = emailArg || nextMintEmail(store);
  let shown = null;

  // -y / --yes / auto forces the browser to do the whole GitHub flow itself.
  const wantsAuto = !/--manual|--no-auto/.test(raw);
  const wantsManual = /--manual|--no-auto/.test(raw);

  let result;
  try {
    result = await loginWithDeviceFlow({
      signal: invocation.signal,
      autoApprove: wantsAuto && !wantsManual,
      browser,
      onCode: (code) => {
        shown = code;
        copyToClipboard(code.userCode);
      },
    });
  } catch (error) {
    if (error.code === 'login_required') {
      const message = String(error.message || '');
      const sawSignIn = /gesehen|Login gesehen/i.test(message);
      if (sawSignIn) {
        return {
          kind: 'error',
          text:
            'Login war da, aber die Freigabe fuer free-pi wurde nicht abgeschlossen.\n\n' +
            'Im offenen Fenster fehlt noch der letzte Schritt:\n' +
            '  1. "Authorize" / "Autorisieren" klicken\n' +
            '  2. Fenster offen lassen, bis "Device connected" erscheint\n\n' +
            `Code falls noch sichtbar: ${shown ? shown.userCode : 'siehe Fenster'}\n\n` +
            'Tipp: mit /freepi-add --manual bestaetigst du jeden Schritt selbst.',
        };
      }
      return {
        kind: 'error',
        text:
          'Zeit abgelaufen: im geoeffneten Fenster wurde nicht bei GitHub eingeloggt.\n\n' +
          `Beim Add wird bewusst ein ${browser.label} benutzt - dein bereits\n` +
          'angemeldeter Account bleibt unberuehrt, du musst dich NICHT ausloggen.\n' +
          'Melde im neuen Fenster einfach den Account an, der hinzugefuegt werden soll.\n\n' +
          'Tipp: mit /freepi-add --manual bestaetigst du jeden Account selbst.',
      };
    }
    throw error;
  }

  const me = await getMe(result.token, invocation.signal);

  const fresh = loadStore() || store;
  const existing = (fresh.accounts || []).find(
    (a) => a.userId && me.user_id && a.userId === me.user_id,
  );

  if (existing) {
    existing.token = result.token;
    existing.tokenBad = false;
    existing.disabled = false;
    existing.lastError = null;
    existing.usage = {
      ...(existing.usage || {}),
      remainingCreditsToday: me.remaining_credits_today,
      allowanceCredits: me.allowance_credits,
      refillAt: me.refill_at,
      fetchedAt: new Date().toISOString(),
    };
    existing.lastUsedAt = new Date().toISOString();
    saveStore(fresh);
    return {
      kind: 'success',
      text: [
        `Dieser Account ist schon drin: ${existing.id} (@${existing.handle || me.handle})`,
        `Token aufgefrischt, wieder aktiv.`,
        `Kontingent: ${usageLine(existing)}`,
        '',
        'Der Proxy nutzt ihn sofort, ohne Neustart.',
      ].join('\n'),
    };
  }

  const account = {
    id: `acc-${fresh.nextAccountNumber || (fresh.accounts?.length || 0) + 1}`,
    number: fresh.nextAccountNumber || (fresh.accounts?.length || 0) + 1,
    email: suggestion,
    handle: me.handle || null,
    userId: me.user_id || null,
    token: result.token,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    lastError: null,
    disabled: false,
    tokenBad: false,
    usage: {
      remainingCreditsToday: me.remaining_credits_today,
      allowanceCredits: me.allowance_credits,
      refillAt: me.refill_at,
      tier: me.tier,
      lane: me.lane,
      // The proxy treats a measurement without fetchedAt as stale forever, which
      // would keep this account out of the lane pool. We just measured it.
      fetchedAt: new Date().toISOString(),
    },
    // The proxy expects day to be an object it can update; a plain date string
    // makes it throw "Cannot create property 'usedCredits' on string".
    day: {
      date: new Date().toISOString().slice(0, 10),
      startRemaining: me.remaining_credits_today,
      lastRemaining: me.remaining_credits_today,
      usedCredits: 0,
    },
    history: [],
    notes: `added via DSH /freepi-add (${shown?.userCode || 'device flow'})`,
  };

  fresh.accounts = [...(fresh.accounts || []), account];
  fresh.nextAccountNumber = (fresh.nextAccountNumber || account.number) + 1;
  fresh.activeAccountId = account.id;
  fresh.totals = fresh.totals || { accountsMinted: 0, creditsUsedTotal: 0, byDay: {} };
  fresh.totals.accountsMinted = (fresh.totals.accountsMinted || 0) + 1;
  saveStore(fresh);

  const parallel = fresh.accounts.filter((a) => !a.disabled && !a.tokenBad).length;
  const pinned = readSelection();

  const lines = [
    `Account hinzugefuegt: ${account.id}  @${account.handle || 'unbekannt'}  (${account.email})`,
    `Kontingent: ${usageLine(account)}`,
    `Refill: in ${human(Date.parse(me.refill_at) - Date.now())}`,
    '',
    `Der Proxy hat jetzt ${parallel} Lane(s) - also ${parallel} echte parallel Requests.`,
    'Kein Neustart noetig, er liest den Store bei jedem Request neu.',
    'Das temporaere Browser-Profil wird wieder geloescht.',
  ];
  if (pinned && pinned !== account.id) {
    lines.push(
      '',
      `Hinweis: der Proxy ist gerade auf ${pinned} gepinnt, der neue Account bekommt also noch keine Anfragen.`,
      '/freepi-auto hebt das auf und nutzt alle Accounts abwechselnd.',
    );
  }

  return { kind: 'success', text: lines.join('\n') };
}

async function handleStatus(invocation) {
  const store = loadStore();
  if (!store) {
    return { kind: 'error', text: `Kein Store unter ${STORE_PATH}` };
  }
  const accounts = store.accounts || [];
  if (accounts.length === 0) {
    return { kind: 'success', text: 'Noch kein Account. /freepi-add legt einen an.' };
  }

  // Machine-readable form for scripts and for an agent that wants raw numbers.
  if (wantsJson(invocation)) {
    let live = null;
    try {
      const res = await fetch(PROXY_USAGE, { signal: AbortSignal.timeout(2000) });
      if (res.ok) live = await res.json();
    } catch {
      /* proxy down: the store still answers everything that is persisted */
    }
    return {
      kind: 'success',
      text: JSON.stringify({
        storePath: STORE_PATH,
        pinned: readSelection(),
        activeAccountId: store.activeAccountId,
        totals: store.totals || {},
        accounts: accounts.map((a) => ({
          id: a.id,
          handle: a.handle,
          email: a.email,
          state: stateOf(a),
          disabled: Boolean(a.disabled),
          tokenBad: Boolean(a.tokenBad),
          tokenExpiresAt: a.tokenExpiresAt || null,
          remaining: a.usage?.remainingCreditsToday ?? null,
          allowance: a.usage?.allowanceCredits ?? null,
          premiumCredits: a.usage?.premiumCredits ?? null,
          refillAt: a.usage?.refillAt ?? null,
          usageMeasuredAt: a.usage?.fetchedAt ?? null,
          lastError: a.lastError || null,
        })),
        proxy: live ? live.queue || null : null,
      }, null, 2),
    };
  }

  const lines = [];
  for (const a of accounts) {
    const active = a.id === store.activeAccountId ? '*' : ' ';
    const refill = a.usage?.refillAt ? human(Date.parse(a.usage.refillAt) - Date.now()) : '?';
    lines.push(
      `${active} ${a.id.padEnd(7)} @${(a.handle || '?').padEnd(14)} ${stateOf(a).padEnd(10)} ` +
        `${usageLine(a).padEnd(22)} refill ${refill}`,
    );
    if (a.lastError) lines.push(`    letzter Fehler: ${a.lastError}`);
    const premiumBought = a.usage?.premiumBoughtCredits, premiumGifted = a.usage?.premiumGiftedCredits;
    if (typeof premiumBought === 'number' || typeof premiumGifted === 'number') {
      lines.push(`    Premium breakdown: purchased ${typeof premiumBought === 'number' ? num(premiumBought) : '?'}, gifted ${typeof premiumGifted === 'number' ? num(premiumGifted) : '?'}`);
    }
  }

  const usable = accounts.filter((a) => !a.disabled && !a.tokenBad).length;
  const pinned = readSelection();
  lines.push('');
  lines.push(
    pinned
      ? `Modus: fest auf ${pinned} gepinnt (max 1 Request gleichzeitig) - /freepi-auto hebt das auf.`
      : `Modus: automatische Rotation zwischen ${usable} Account(s) -> ${usable} parallele Requests.`,
  );
  lines.push(`${accounts.length} Account(s), davon ${usable} nutzbar.`);

  let proxy = 'Proxy nicht erreichbar';
  try {
    const res = await fetch(PROXY_USAGE, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const u = await res.json();
      proxy = `Proxy laeuft - inFlight ${u.queue?.inFlight ?? 0}, waiting ${u.queue?.waiting ?? 0}, lanes ${u.queue?.lanes ?? usable}`;
    }
  } catch {
    /* keep the fallback text */
  }
  lines.push(proxy);
  lines.push(`Measured consumption: daily ${num(store.totals?.creditsUsedTotal)} + premium ${num(store.totals?.premiumCreditsUsedTotal)} credits.`);
  return { kind: 'success', text: lines.join('\n') };
}

async function handleUsage(invocation) {
  const wantJson = wantsJson(invocation);
  try {
    const res = await fetch(PROXY_USAGE, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { kind: 'error', text: `Proxy antwortet ${res.status} auf ${PROXY_USAGE}` };
    }
    const u = await res.json();
    const q = u.queue || {};
    const selected = (u.accounts || []).find(a => a.id === u.activeAccountId);

    // Hours, not credits: free-pi meters in hours and every model costs a
    // multiple of the base rate, so credits alone hide the real remaining time.
    let budget = null;
    try {
      const bres = await fetch(PROXY_BUDGET, { signal: AbortSignal.timeout(2000) });
      if (bres.ok) budget = await bres.json();
    } catch {
      /* older proxy without /budget - the rest of the output still works */
    }

    if (wantJson) {
      return { kind: 'success', text: JSON.stringify({ queue: q, activeAccountId: u.activeAccountId, selected, totals: u.totals, budget }, null, 2) };
    }

    const hours = budget && typeof budget.hoursLeft === 'number' ? `${budget.hoursLeft.toFixed(2)} h` : '?';
    const hoursAll = budget && typeof budget.hoursAllowance === 'number' ? `${budget.hoursAllowance.toFixed(2)} h` : '?';
    // Burn rate says how fast the remaining hours disappear; without it the
    // hours figure alone cannot answer "how long do I still have?".
    const burn = budget && typeof budget.burnRatePerHour === 'number' ? budget.burnRatePerHour : null;
    const runway = budget && typeof budget.runwayHours === 'number' ? budget.runwayHours : null;
    const burnLine = burn == null
      ? 'Verbrauch:                      noch keine Messung'
      : burn <= 0
        ? 'Verbrauch:                      keine Aktivitaet - die Stunden bleiben stehen'
        : `Verbrauch:                      ${burn.toFixed(2)} h/h` +
          (runway != null && Number.isFinite(runway) ? ` -> noch ${runway.toFixed(2)} h bei diesem Tempo` : '');
    return {
      kind: 'success',
      text: [
        `Lanes (gleichzeitig moeglich): ${q.lanes ?? '?'}`,
        `gerade aktiv:                   ${q.inFlight ?? 0}`,
        `in der Warteschlange:           ${q.waiting ?? 0}`,
        `Stunden-Budget:                 ${hours} von ${hoursAll} (Modell ${budget?.model ?? '?'}, ${budget?.modelMultiplier ?? 1}x Rate)`,
        burnLine,
        ...(selected ? [`Daily allowance: ${num(selected.remaining)} / ${num(selected.allowance)} credits`,
          `Premium balance: ${selected.premiumCredits == null ? 'not reported' : num(selected.premiumCredits)} credits`,
          `Premium breakdown: purchased ${selected.premiumBoughtCredits == null ? '?' : num(selected.premiumBoughtCredits)}, gifted ${selected.premiumGiftedCredits == null ? '?' : num(selected.premiumGiftedCredits)}`,
          `Measured consumption: daily ${num(u.totals?.creditsUsedTotal)} + premium ${num(u.totals?.premiumCreditsUsedTotal)} credits.`] : []),
        '',
        q.waiting > 0
          ? 'Es warten Requests - ein weiterer Account wuerde direkt Durchsatz bringen (/freepi-add).'
          : 'Alles frei, keine Warteschlange.',
      ].join('\n'),
    };
  } catch {
    return { kind: 'error', text: `Proxy nicht erreichbar auf ${PROXY_USAGE} - laeuft er?` };
  }
}

/**
 * Per-day consumption from GET /history. Fixed-width ASCII table, newest day
 * first, at most 14 rows in text mode (the proxy defaults to 30).
 */
async function handleHistory(invocation) {
  const wantJson = wantsJson(invocation);
  try {
    const res = await fetch(PROXY_HISTORY, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { kind: 'error', text: `Proxy antwortet ${res.status} auf ${PROXY_HISTORY}` };
    }
    const data = await res.json();

    if (wantJson) {
      return { kind: 'success', text: JSON.stringify(data, null, 2) };
    }

    const days = Array.isArray(data.days) ? data.days : [];
    if (days.length === 0) {
      return { kind: 'success', text: `Noch keine Verbrauchsdaten auf ${PROXY_HISTORY}.` };
    }
    const shown = days.slice(0, 14);
    const cell = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '?');
    const lines = [
      'Datum       daily    premium      hours',
      '---------- -------  ---------  ---------',
      ...shown.map((d) => `${String(d.date || '?').padEnd(10)} ${cell(d.daily, 0).padStart(7)}  ${cell(d.premium, 0).padStart(9)}  ${cell(d.hours, 3).padStart(9)}`),
    ];
    if (days.length > shown.length) {
      lines.push(`... ${days.length - shown.length} weitere Tag(e), /freepi-history --json zeigt alle.`);
    }
    const t = data.totals || {};
    lines.push('');
    lines.push(
      `Summe der gezeigten ${shown.length} Tag(e): daily ${cell(t.daily, 0)}, ` +
        `premium ${cell(t.premium, 0)}, ${cell(t.hours, 3)} h (${data.creditsPerHour ?? 5000} credits/h)`,
    );
    return { kind: 'success', text: lines.join('\n') };
  } catch {
    return { kind: 'error', text: `Proxy nicht erreichbar auf ${PROXY_HISTORY} - laeuft er?` };
  }
}

/**
 * Open the sponsor window of every account.
 *
 * free-pi pauses free completions for an account until THAT account has shown
 * an ad, so one window is not enough - a pool of two accounts needs two
 * visible windows or every second request fails. This opens one per account
 * and says so; it never confirms anything itself. The confirmation happens in
 * the browser, and only after the card was really visible.
 */
async function handleAds(invocation) {
  const input = String(invocation.rawInput || '').replace(/^\/?freepi-ads\b\s*/i, '').trim();
  const store = loadStore();
  const accounts = (store && store.accounts) || [];
  if (!accounts.length) {
    return { kind: 'error', text: `Kein Account gespeichert unter ${STORE_PATH} - zuerst /freepi-add.` };
  }

  const only = input ? accounts.find((a) => a.id === input) : null;
  if (input && !only) {
    return {
      kind: 'error',
      text: [
        `Unbekannter Account "${input}". Verfuegbar:`,
        ...accounts.map((a) => `  ${a.id}  @${a.handle || '?'}  ${a.email || ''}`),
      ].join('\n'),
    };
  }

  const targets = only ? [only] : accounts;
  const lines = ['Werbefenster je Account - offen lassen, sonst pausiert free-pi den Account.'];
  for (const account of targets) {
    const url = `${PROXY_URL}/sponsor?account=${encodeURIComponent(account.id)}`;
    let opened = false;
    try {
      // `start` needs an empty title argument; the URL is built from an id.
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
      opened = true;
    } catch {}
    lines.push(`  ${account.id}  @${account.handle || '?'}  ${opened ? url : 'konnte nicht geoeffnet werden: ' + url}`);
  }
  lines.push('');
  lines.push('Das Fenster bestaetigt die Anzeige selbst, sobald die Werbekarte sichtbar ist.');
  lines.push('Zustand: /freepi-status zeigt "Werbung fehlt" bei Accounts, die noch warten.');
  return { kind: 'success', text: lines.join('\n') };
}

/**
 * Forget an account. The token is gone afterwards, so this always names the
 * account instead of accepting an index.
 */
function handleRemove(invocation) {
  const input = String(invocation.rawInput || '').replace(/^\/?freepi-remove\b\s*/i, '').trim();
  const store = loadStore();
  if (!store) return { kind: 'error', text: `Kein Store unter ${STORE_PATH}` };
  const accounts = store.accounts || [];
  if (!input) {
    return {
      kind: 'success',
      text: [
        'Welchen Account entfernen?',
        '',
        ...accounts.map((a) => `  ${a.id}  @${a.handle || '?'}  ${a.email || ''}`),
        '',
        'Aufruf: /freepi-remove <id>',
      ].join('\n'),
    };
  }
  const matches = accounts.filter(
    (a) => a.id.toLowerCase() === input.toLowerCase() || (a.email || '').toLowerCase() === input.toLowerCase(),
  );
  if (matches.length !== 1) {
    return { kind: 'error', text: `"${input}" passt auf keinen oder mehrere Accounts. /freepi-remove ohne Argument listet sie.` };
  }
  const gone = matches[0];
  const rest = accounts.filter((a) => a.id !== gone.id);
  const fresh = loadStore() || store;
  fresh.accounts = rest;
  if (fresh.activeAccountId === gone.id) {
    const next = rest.find((a) => !a.disabled && !a.tokenBad) || rest[0];
    fresh.activeAccountId = next ? next.id : null;
  }
  saveStore(fresh);
  // A pinned selection pointing at a removed account would block every request.
  const selected = readSelection();
  if (selected && selected === gone.id) clearSelection();
  return {
    kind: 'success',
    text: [
      `Entfernt: ${gone.id} (@${gone.handle || '?'})`,
      `Es bleiben ${rest.length} Account(s).`,
      selected === gone.id ? 'Die feste Auswahl zeigte auf ihn und wurde geloescht - Rotation laeuft wieder automatisch.' : '',
      rest.length === 0 ? 'Achtung: kein Account mehr uebrig. /freepi-add legt einen neuen an.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function readSelection() {
  try {
    return JSON.parse(fs.readFileSync(SELECTION_PATH, 'utf8')).accountId || null;
  } catch {
    return null;
  }
}

function clearSelection() {
  try {
    fs.rmSync(SELECTION_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo a pinned account so the proxy rotates by budget again. Without this the
 * only way back was deleting the file by hand.
 */
function handleAuto() {
  const store = loadStore();
  const selected = readSelection();
  if (!selected) {
    return {
      kind: 'success',
      text: 'Rotation ist schon automatisch - kein Account fest ausgewaehlt.',
    };
  }
  clearSelection();
  const accounts = (store?.accounts || []).filter((a) => !a.disabled && !a.tokenBad);
  return {
    kind: 'success',
    text: [
      `Feste Auswahl (${selected}) aufgehoben.`,
      `Der Proxy waehlt jetzt wieder selbst zwischen ${accounts.length} Account(s),`,
      'immer den mit dem meisten Kontingent.',
    ].join('\n'),
  };
}

// --------------------------------------------------------------- registration

/**
 * One-shot health check for the whole chain: store, tokens, proxy, lanes.
 * Reads only local state plus the proxy's own /usage endpoint, so it never
 * burns an upstream request.
 */
async function handleDoctor() {
  const ok = [];
  const warn = [];
  const bad = [];

  const store = loadStore();
  if (!store) {
    bad.push(['Store', `kein Store unter ${STORE_PATH} - lief der Proxy schon einmal?`]);
  } else {
    const accounts = store.accounts || [];
    const usable = accounts.filter((a) => !a.disabled && !a.tokenBad && a.token);
    if (!accounts.length) bad.push(['Accounts', 'keiner gespeichert - /freepi-add legt einen an']);
    else if (!usable.length) bad.push(['Accounts', `${accounts.length} gespeichert, aber keiner nutzbar - /freepi-add`]);
    else ok.push(['Accounts', `${usable.length} nutzbar / ${accounts.length} gespeichert`]);

    const expiring = usable.filter((a) => {
      const ts = Date.parse(a.tokenExpiresAt || '');
      return Number.isFinite(ts) && ts - Date.now() < 24 * 60 * 60 * 1000;
    });
    if (expiring.length) {
      warn.push(['Token laeuft ab', expiring.map((a) => `${a.id} (@${a.handle || '?'})`).join(', ') + ' - bei 401 /freepi-add']);
    } else if (usable.length) {
      ok.push(['Token', 'alle mindestens 24 h gueltig']);
    }

    const staleMs = store.settings?.staleMs ?? DEFAULT_STALE_MS;
    const unknown = usable.filter((a) => {
      const ts = Date.parse(a.usage?.fetchedAt || '');
      return !Number.isFinite(ts) || Date.now() - ts > staleMs;
    });
    if (unknown.length) warn.push(['Messwerte', `${unknown.length} Account(s) ohne frische Messung - der Proxy misst sie beim naechsten Request`]);
    else if (usable.length) ok.push(['Messwerte', 'frisch']);

    const lowWatermark = store.settings?.lowWatermark ?? DEFAULT_LOW_WATERMARK;
    const low = usable.filter((a) => {
      const rem = a.usage?.remainingCreditsToday;
      const allowance = a.usage?.allowanceCredits ?? DAILY_CREDITS;
      return typeof rem === 'number' && rem <= allowance * lowWatermark;
    });
    if (low.length) warn.push(['Budget', `${low.length} Account(s) unter dem Low-Watermark (${Math.round(lowWatermark * 100)}%)`]);

    const pinned = readSelection();
    if (pinned) warn.push(['Modus', `gepinnt auf ${pinned} (max 1 Request) - /freepi-auto nutzt alle Accounts`]);
    else ok.push(['Modus', `automatische Rotation zwischen ${usable.length} Account(s)`]);
  }

  try {
    const res = await fetch(PROXY_USAGE, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      bad.push(['Proxy', `antwortet ${res.status} auf ${PROXY_USAGE}`]);
    } else {
      const u = await res.json();
      const q = u.queue || {};
      ok.push(['Proxy', `laeuft auf :${new URL(PROXY_USAGE).port}, ${q.lanes ?? '?'} Lane(s), ${q.inFlight ?? 0} aktiv, ${q.waiting ?? 0} wartend`]);
      if (q.waiting > 0) warn.push(['Warteschlange', `${q.waiting} Request(s) warten - ein weiterer Account bringt direkt Durchsatz (/freepi-add)`]);
    }
  } catch {
    bad.push(['Proxy', `nicht erreichbar auf ${PROXY_USAGE} - starten mit Start-Proxy.cmd`]);
  }

  // Hours, not credits: that is the number the harness actually runs out of.
  try {
    const bres = await fetch(PROXY_BUDGET, { signal: AbortSignal.timeout(2500) });
    if (bres.ok) {
      const b = await bres.json();
      const left = typeof b.hoursLeft === 'number' ? `${b.hoursLeft.toFixed(2)} h` : '?';
      const all = typeof b.hoursAllowance === 'number' ? `${b.hoursAllowance.toFixed(2)} h` : '?';
      const line = `${left} von ${all} auf ${b.model ?? '?'} (${b.modelMultiplier ?? 1}x Rate)`;
      if (typeof b.hoursLeft === 'number' && b.hoursLeft <= 0.5) {
        bad.push(['Stunden', `${line} - fast leer, /freepi-add oder bis 00:00 UTC warten`]);
      } else if (typeof b.hoursLeft === 'number' && typeof b.usableAccounts === 'number' && b.usableAccounts < b.totalAccounts) {
        warn.push(['Stunden', `${line} - nur ${b.usableAccounts}/${b.totalAccounts} Account(s) tragen dazu bei`]);
      } else {
        ok.push(['Stunden', line]);
      }
      if (typeof b.burnRatePerHour === 'number' && b.burnRatePerHour > 0) {
        const runway = typeof b.runwayHours === 'number' && Number.isFinite(b.runwayHours) ? ` -> noch ${b.runwayHours.toFixed(2)} h` : '';
        ok.push(['Verbrauch', `${b.burnRatePerHour.toFixed(2)} h/h${runway}`]);
      }
    } else if (bres.status === 404) {
      warn.push(['Stunden', 'Proxy kennt /budget noch nicht - Proxy neu starten (Start-Proxy.cmd)']);
    }
  } catch {
    /* a dead proxy is already reported above */
  }

  const lines = [
    'free-pi doctor',
    '',
    ...ok.map(([k, v]) => `  ok  ${k.padEnd(16)} ${v}`),
    ...warn.map(([k, v]) => `  !!  ${k.padEnd(16)} ${v}`),
    ...bad.map(([k, v]) => `  XX  ${k.padEnd(16)} ${v}`),
    '',
    bad.length
      ? `${bad.length} Problem(e), ${warn.length} Hinweis(e).`
      : warn.length
        ? `Laeuft, ${warn.length} Hinweis(e).`
        : 'Alles in Ordnung.',
  ];

  return { kind: bad.length ? 'error' : 'success', text: lines.join('\n') };
}

function apply(ctx) {
  const active = new Set();

  // Handlers may be synchronous (they return a result object directly) or
  // asynchronous. Only real promises need to be tracked for shutdown.
  const track = (value) => {
    if (!value || typeof value.then !== 'function') return value;
    active.add(value);
    const retire = () => active.delete(value);
    value.then(retire, retire);
    return value;
  };

  ctx.effect(
    function* () {
      yield async () => {
        await Promise.allSettled(active);
      };

      yield ctx.commands.register({
        name: 'freepi-add',
        description: 'Add a free-pi account (opens GitHub with the login code pre-filled)',
        handler: (invocation) => track(handleAdd(ctx, invocation)),
      });

      yield ctx.commands.register({
        name: 'freepi-status',
        description: 'Show free-pi account budgets, refill times and proxy lanes',
        handler: (invocation) => track(handleStatus(invocation)),
      });

      yield ctx.commands.register({
        name: 'freepi-usage',
        description: 'Show live proxy load: lanes, in-flight requests, queue depth (/freepi-usage --json)',
        handler: (invocation) => track(handleUsage(invocation)),
      });
      yield ctx.commands.register({
        name: 'freepi-history',
        description: 'Show credits used per day (newest first) with hours (/freepi-history --json)',
        handler: (invocation) => track(handleHistory(invocation)),
      });

      yield ctx.commands.register({
        name: 'freepi-remove',
        description: 'Forget a saved free-pi account; omit the ID to list them',
        handler: (invocation) => track(handleRemove(invocation)),
      });

      yield ctx.commands.register({
        name: 'freepi-doctor',
        description: 'Check store, tokens, budgets and proxy in one go',
        handler: () => track(handleDoctor()),
      });

      yield ctx.commands.register({
        name: 'freepi-ads',
        description: 'Open the sponsor window for every account (free-pi pauses accounts without ads)',
        handler: (invocation) => track(handleAds(invocation)),
      });

      yield ctx.commands.register({
        name: 'freepi-auto',
        description: 'Undo a pinned account so the proxy rotates by remaining budget again',
        handler: () => track(handleAuto()),
      });

      const switchSpec = {
        name: 'freepi-switch',
        description: 'Choose an existing account for new requests; omit the account ID to list accounts',
        input: { hint: accountInputHint(STORE_PATH) },
        handler: invocation => {
          try {
            return switchSavedAccount(invocation.rawInput, STORE_PATH, SELECTION_PATH);
          } catch {
            return { kind: 'error', text: 'Could not read or save the account selection. Check the local proxy files.' };
          }
        },
      };
      let unregisterSwitch = ctx.commands.register(switchSpec);
      const refreshSwitch = () => {
        const hint = accountInputHint(STORE_PATH);
        if (hint === switchSpec.input.hint) return;
        unregisterSwitch();
        switchSpec.input = { hint };
        unregisterSwitch = ctx.commands.register(switchSpec);
      };
      fs.watchFile(STORE_PATH, { interval: 2000, persistent: false }, refreshSwitch);
      yield () => {
        fs.unwatchFile(STORE_PATH, refreshSwitch);
        unregisterSwitch();
      };
    },
    'command-freepi lifecycle',
  );
}

export { apply, inject, name };
