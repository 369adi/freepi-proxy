// webmail.mjs — read a mailbox through a logged-in browser session.
//
// WHY NOT IMAP
// The user has no IMAP password stored anywhere; what they do have is a live
// STRATO Webmail login in a browser. Rather than ask for a secret, this drives
// a browser profile that stays logged in and reads the message list out of the
// DOM. One human login, then it is fully automatic for every account.
//
// The profile lives at ~/.free-pi/mail-profile and is separate from the
// per-account signup profiles, so signing in once serves all of them.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PROFILE_DIR =
  process.env.FREEPI_MAIL_PROFILE || path.join(os.homedir(), '.free-pi', 'mail-profile');

export const WEBMAIL_URL = process.env.FREEPI_WEBMAIL_URL || 'https://webmail.strato.de/';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const findBrowser = () => CHROME_CANDIDATES.find((c) => {
  try {
    return c && fs.existsSync(c);
  } catch {
    return false;
  }
}) || null;

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/** "https://webmail.strato.de/" -> "webmail.strato.de", for matching tabs. */
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- CDP

export class Session {
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
      const t = setTimeout(() => rej(new Error('cdp timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        res();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(t);
        rej(new Error('cdp error'));
      });
    });
    await this.send('Page.enable');
    return this;
  }

  send(method, params = {}, timeoutMs = 25000) {
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

export async function target(port, want = null) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    const pages = l.filter((t) => t.type === 'page' && t.url && t.url !== 'about:blank');
    if (want) {
      const hit = pages.find((t) => String(t.url).startsWith(want) || String(t.url).includes(want));
      if (hit) return hit;
    }
    // Prefer a real page over about:blank; the launcher often leaves a blank
    // first tab behind, and reading that one reports an empty screen.
    return pages[0] || l.find((t) => t.type === 'page') || null;
  } catch {
    return null;
  }
}

/**
 * Start a browser that keeps its cookies between runs. Returns a handle with
 * `cdp`, `port`, and `kill()`.
 */
export async function openBrowser({ port = null, url = WEBMAIL_URL, profileDir = PROFILE_DIR, headless = false } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('no Chrome or Edge found');
  const p = port || (await freePort());
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${p}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
  ];
  if (headless) args.push('--headless=new');
  args.push(url);

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  let page = null;
  for (let i = 0; i < 80; i += 1) {
    page = await target(p, headless ? null : hostOf(url));
    if (page && page.url && page.url !== 'about:blank') break;
    await sleep(300);
  }
  if (!page) throw new Error('browser never exposed CDP');
  const cdp = await new Session(page.webSocketDebuggerUrl).open();
  return {
    cdp,
    port: p,
    kill() {
      cdp.close();
      try {
        child.kill();
      } catch {
        /* gone */
      }
    },
  };
}

// ---------------------------------------------------------------- reading

/** Compact, provider-agnostic snapshot of whatever is on screen. */
export const SNAPSHOT = `(() => {
  const vis = el => !!el && el.offsetParent !== null;
  const rows = [];
  // Generic list-row sweep: anything that looks like a message line.
  const cands = document.querySelectorAll('tr, li, div[role=row], a[href], [class*="mail" i], [class*="message" i], [class*="item" i]');
  for (const el of cands) {
    if (!vis(el)) continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 400) continue;
    if (!/@/.test(t) && !/github/i.test(t)) continue;
    rows.push(t);
    if (rows.length >= 60) break;
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000),
    rows,
    inputs: Array.from(document.querySelectorAll('input')).filter(vis).map(i => ({
      name: i.name || null, type: i.type, placeholder: i.placeholder || null,
    })),
  };
})()`;

/**
 * Is the webmail logged in right now? Heuristic but conservative: a login form
 * on screen means no, a message list means yes.
 */
export async function isLoggedIn(cdp) {
  const s = await cdp.eval(SNAPSHOT);
  if (!s || s.__error) return false;
  const text = String(s.text || '');
  const hasPassword = (s.inputs || []).some((i) => i.type === 'password');
  const looksLikeInbox = /posteingang|inbox|nachrichten|messages/i.test(text) && !hasPassword;
  return looksLikeInbox && !/anmelden|sign in|login|passwort/i.test(text.slice(0, 400));
}

/**
 * Wait until the person logs in, then return. Polls the page rather than
 * asking for credentials.
 */
export async function waitForLogin(cdp, { timeoutMs = 600000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const s = await cdp.eval(SNAPSHOT);
    if (s && !s.__error) {
      const where = String(s.url || '');
      const note = (await isLoggedIn(cdp)) ? 'logged in' : 'waiting for login';
      if (note !== last) {
        if (onTick) onTick(note + '  ' + where.slice(0, 70));
        last = note;
      }
      if (note === 'logged in') return { ok: true, url: where };
    }
    await sleep(3000);
  }
  return { ok: false };
}

/**
 * Find mail addressed to `to` and return any GitHub links inside those rows.
 * The webmail is left on the inbox; nothing is marked read deliberately beyond
 * whatever opening a message does.
 */
export async function findGithubLinks(cdp, { to, timeoutMs = 180000, intervalMs = 6000, onPoll } = {}) {
  const deadline = Date.now() + timeoutMs;
  const local = String(to || '').split('@')[0].toLowerCase();
  while (Date.now() < deadline) {
    const s = await cdp.eval(SNAPSHOT);
    if (s && !s.__error) {
      const hit = (s.rows || []).find((r) => {
        const low = r.toLowerCase();
        return low.includes(local) && /github|verif|bestätig|confirm/i.test(r);
      });
      if (onPoll) onPoll(hit ? 'found a candidate row' : 'no mail yet');
      if (hit) return { ok: true, row: hit, rows: s.rows };
    }
    await sleep(intervalMs);
  }
  return { ok: false };
}

export { sleep, findBrowser };
