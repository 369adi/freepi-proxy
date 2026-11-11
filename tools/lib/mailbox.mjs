// mailbox.mjs — zero-dependency IMAP reader for a catch-all mailbox.
//
// Why this exists: a catch-all domain accepts every address of the form
// anything@example.com and drops the mail into one mailbox. That is what makes
// unattended account creation possible at all -- the signup form can use a
// fresh address and the verification mail is still reachable.
//
// What it does NOT do: it never guesses credentials and never touches mail
// other than the ones addressed to the target. Read-only by contract:
// BODY.PEEK[] is used everywhere so nothing gets marked as seen.
//
// Config (environment):
//   IMAP_USER / IMAP_PASS  mailbox login                (required)
//   IMAP_HOST              default imap.strato.de
//   IMAP_PORT              default 993
// Or a credentials file, so the password does not have to be retyped:
//   %USERPROFILE%\.free-pi\mail.json  ->  {"user":"...","pass":"..."}
// Override that path with FREEPI_MAIL_CONFIG.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export const MAIL_CONFIG_PATH =
  process.env.FREEPI_MAIL_CONFIG || path.join(os.homedir(), '.free-pi', 'mail.json');

// Links we are willing to follow. Kept narrow on purpose: the account flow only
// ever needs GitHub's own verification/confirmation pages.
const LINK_RE = /https:\/\/github\.com\/[^\s"'<>()\]]+/g;
const PRIORITY_RE = /verif|confirm|activat|validate|signup|email-verification/i;

const q = (s) => '"' + String(s).replace(/([\\"])/g, '\\$1') + '"';

/** Resolve credentials from env or the config file. Throws a helpful error. */
export function readConfig(overrides = {}) {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(MAIL_CONFIG_PATH, 'utf8')) || {};
  } catch {
    fromFile = {};
  }
  const cfg = {
    user: overrides.user || process.env.IMAP_USER || fromFile.user || null,
    pass: overrides.pass || process.env.IMAP_PASS || fromFile.pass || null,
    host: overrides.host || process.env.IMAP_HOST || fromFile.host || 'imap.strato.de',
    port: Number(overrides.port || process.env.IMAP_PORT || fromFile.port || 993),
  };
  if (!cfg.user || !cfg.pass) {
    throw Object.assign(
      new Error(
        'no mailbox credentials: set IMAP_USER/IMAP_PASS or write ' +
          MAIL_CONFIG_PATH +
          ' with {"user":"...","pass":"..."}',
      ),
      { code: 'no_mail_credentials' },
    );
  }
  return cfg;
}

// ---------------------------------------------------------------- IMAP client

class ImapConnection {
  constructor(cfg, timeoutMs = 30000) {
    this.cfg = cfg;
    this.buf = '';
    this.pending = [];
    this.seq = 0;
    this.deadline = Date.now() + timeoutMs;
    this.sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => {
      this.buf += d;
      this.pump();
    });
    this.sock.on('error', (err) => {
      while (this.pending.length) this.pending.shift().reject(err);
    });
  }

  pump() {
    while (this.pending.length) {
      const w = this.pending[0];
      const m = new RegExp('\\r\\n' + w.tag + ' (OK|NO|BAD)[^\\r\\n]*\\r\\n').exec(this.buf);
      if (!m) return;
      const end = m.index + m[0].length;
      const text = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      this.pending.shift();
      w.resolve({ status: m[1], text });
    }
  }

  /** Wait for the server greeting (an untagged line ending in CRLF). */
  async greeting() {
    const until = Date.now() + 10000;
    while (!this.buf.includes('\r\n')) {
      if (Date.now() > until) throw new Error('imap: no greeting');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  cmd(line, timeoutMs = 20000) {
    const tag = 'A' + ++this.seq;
    const w = { tag };
    const p = new Promise((resolve, reject) => {
      w.resolve = resolve;
      w.reject = reject;
    });
    this.pending.push(w);
    this.sock.write(tag + ' ' + line + '\r\n');
    // A stalled server must never hang the whole bulk run.
    const timer = setTimeout(() => {
      const idx = this.pending.indexOf(w);
      if (idx !== -1) this.pending.splice(idx, 1);
      resolve({ status: 'TIMEOUT', text: '' });
    }, timeoutMs);
    return p.finally(() => clearTimeout(timer));
  }

  async login() {
    await this.greeting();
    const r = await this.cmd(`LOGIN ${q(this.cfg.user)} ${q(this.cfg.pass)}`);
    if (r.status !== 'OK') throw new Error('imap: LOGIN failed (' + r.status + ')');
  }

  async select(folder = 'INBOX') {
    const r = await this.cmd('SELECT ' + q(folder));
    if (r.status !== 'OK') throw new Error('imap: SELECT failed (' + r.status + ')');
  }

  async uidsFor(target) {
    const r = await this.cmd(target ? `UID SEARCH TO ${q(target)}` : 'UID SEARCH UNSEEN');
    return ((r.text.match(/^\* SEARCH([^\r\n]*)/m) || [])[1] || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  async body(uid) {
    const r = await this.cmd(`UID FETCH ${uid} BODY.PEEK[]`, 30000);
    return r.text;
  }

  close() {
    try {
      this.sock.end();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------- decoding

/** Quoted-printable, the encoding GitHub actually uses for these mails. */
export function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** GitHubs verification links, best candidate first. */
export function githubLinks(text) {
  const found = text.match(LINK_RE) || [];
  const clean = [...new Set(found.map((l) => l.replace(/[.,;]$/, '')))];
  const prio = clean.filter((l) => PRIORITY_RE.test(l));
  return prio.length ? prio : clean;
}

/** Pull links out of a raw message, trying quoted-printable and base64 parts. */
export function extractLinks(raw) {
  const direct = githubLinks(decodeQuotedPrintable(raw));
  if (direct.length) return direct;

  const out = [];
  for (const m of raw.matchAll(/[A-Za-z0-9+/=\r\n]{200,}/g)) {
    const b = m[0].replace(/\s+/g, '');
    try {
      const decoded = Buffer.from(b, 'base64').toString('utf8');
      if (decoded.includes('github.com')) out.push(...githubLinks(decoded));
    } catch {
      /* not base64, skip */
    }
  }
  return [...new Set(out)];
}

/** UIDs a message was addressed to, so a catch-all mailbox can be filtered. */
export function recipientsOf(raw) {
  const out = new Set();
  for (const m of raw.matchAll(/^(?:To|Delivered-To|X-Original-To):\s*(.+)$/gim)) {
    for (const addr of m[1].match(/[^\s,<>"']+@[^\s,<>"']+/g) || []) {
      out.add(addr.replace(/[.;]$/, '').toLowerCase());
    }
  }
  return [...out];
}

export function subjectOf(raw) {
  const encoded = (raw.match(/^Subject:\s*(.*)$/m) || [])[1] || '';
  // Unfold RFC 2047 the cheap way: these subjects are plain ASCII in practice.
  return encoded.replace(/=\?[^?]+\?[BbQq]\?([^?]*)\?=/g, (_, s) => s).trim() || '(no subject)';
}

// ---------------------------------------------------------------- public API

/**
 * Read the newest matching messages for `target`.
 * Returns [{uid, subject, links}] newest first. Never marks mail as read.
 */
export async function fetchMessages(target, { limit = 3, cfg } = {}) {
  const conf = cfg || readConfig();
  const conn = new ImapConnection(conf);
  try {
    await conn.login();
    await conn.select('INBOX');
    const uids = await conn.uidsFor(target);
    const out = [];
    for (const uid of uids.slice(-limit).reverse()) {
      const raw = await conn.body(uid);
      out.push({ uid, subject: subjectOf(raw), links: extractLinks(raw), raw });
    }
    return out;
  } finally {
    conn.close();
  }
}

/**
 * Poll until a message for `target` arrives that was not seen before.
 *
 * `sinceUid` lets a caller ignore older mail that belongs to a previous
 * account; when omitted the newest matching mail is returned immediately.
 * Returns {uid, subject, links} or null on timeout. It never throws for a
 * missing mail -- only for a broken mailbox.
 */
export async function waitForMessage(
  target,
  { sinceUid = null, timeoutMs = 180000, intervalMs = 6000, limit = 5, cfg, onPoll } = {},
) {
  const conf = cfg || readConfig();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const conn = new ImapConnection(conf);
    try {
      await conn.login();
      await conn.select('INBOX');
      const uids = await conn.uidsFor(target);
      const fresh = uids.filter((u) => sinceUid === null || Number(u) > Number(sinceUid));
      if (fresh.length) {
        const uid = fresh[fresh.length - 1];
        const raw = await conn.body(uid);
        const links = extractLinks(raw);
        if (links.length) {
          return { uid, subject: subjectOf(raw), links, attempt };
        }
        // Mail is there but carries no link yet (e.g. a "new sign-in" notice).
        // Keep waiting: the verification mail may still be in flight.
      }
      if (onPoll) onPoll({ attempt, count: uids.length, fresh: fresh.length });
    } catch (err) {
      // A transient IMAP hiccup must not abort a long bulk run.
      if (onPoll) onPoll({ attempt, error: err.message });
    } finally {
      conn.close();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** Highest UID currently in the mailbox (0 when empty), used as a watermark. */
export async function latestUid(target, { cfg } = {}) {
  const conf = cfg || readConfig();
  const conn = new ImapConnection(conf);
  try {
    await conn.login();
    await conn.select('INBOX');
    const uids = await conn.uidsFor(target);
    return uids.length ? Number(uids[uids.length - 1]) : 0;
  } finally {
    conn.close();
  }
}
