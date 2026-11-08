#!/usr/bin/env node
// fetch-verify-mail.mjs — zero-dependency IMAP helper for catch-all verification mail.
//
// Why: arisya.de has a catch-all, so every random address @arisya.de is accepted
// and dropped into the webmaster mailbox. This script logs into that mailbox over
// IMAP and prints the newest GitHub verification / confirmation links, so a fresh
// address can be confirmed without opening a browser.
//
// Usage (PowerShell):
//   $env:IMAP_USER = 'webmaster@arisya.de'
//   $env:IMAP_PASS = '<postfach-passwort>'
//   node tools/fetch-verify-mail.mjs gh-42@arisya.de
//
// Without an argument it looks at UNSEEN mail instead.
// Overrides: IMAP_HOST (default imap.strato.de), IMAP_PORT (993), MAIL_LIMIT (3).

import tls from 'node:tls';

const HOST = process.env.IMAP_HOST || 'imap.strato.de';
const PORT = Number(process.env.IMAP_PORT || 993);
const USER = process.env.IMAP_USER;
const PASS = process.env.IMAP_PASS;
const TARGET = process.argv[2] || null;
const LIMIT = Number(process.env.MAIL_LIMIT || 3);

if (!USER || !PASS) {
  console.error('Set IMAP_USER and IMAP_PASS first (see header of this file).');
  process.exit(2);
}

const q = s => '"' + String(s).replace(/([\\"])/g, '\\$1') + '"';

const sock = tls.connect({ host: HOST, port: PORT, servername: HOST });
sock.setEncoding('utf8');

let buf = '';
const pending = [];

sock.on('data', d => { buf += d; pump(); });
sock.on('error', err => { while (pending.length) pending.shift().reject(err); });

function pump() {
  while (pending.length) {
    const w = pending[0];
    const m = new RegExp('\\r\\n' + w.tag + ' (OK|NO|BAD)[^\\r\\n]*\\r\\n').exec(buf);
    if (!m) return;
    const end = m.index + m[0].length;
    const text = buf.slice(0, end);
    buf = buf.slice(end);
    pending.shift();
    w.resolve({ status: m[1], text });
  }
}

let seq = 0;
function cmd(line) {
  const tag = 'A' + (++seq);
  const w = { tag };
  const p = new Promise((resolve, reject) => { w.resolve = resolve; w.reject = reject; });
  pending.push(w);
  sock.write(tag + ' ' + line + '\r\n');
  return p;
}

function greeting() {
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (buf.includes('\r\n')) { clearInterval(timer); resolve(); }
    }, 20);
  });
}

// Quoted-printable is what GitHub actually uses; decode it before matching links.
function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function githubLinks(text) {
  const found = text.match(/https:\/\/github\.com\/[^\s"'<>()\]]+/g) || [];
  const clean = [...new Set(found.map(l => l.replace(/[.,;]$/, '')))];
  const prio = clean.filter(l => /verif|confirm|activat|validate|signup/i.test(l));
  return prio.length ? prio : clean;
}

function extract(raw) {
  let direct = githubLinks(decodeQuotedPrintable(raw));
  if (direct.length) return direct;

  // Fallback: some senders use base64 parts instead.
  const out = [];
  for (const m of raw.matchAll(/[A-Za-z0-9+/=\r\n]{200,}/g)) {
    const b = m[0].replace(/\s+/g, '');
    try {
      const decoded = Buffer.from(b, 'base64').toString('utf8');
      if (decoded.includes('github.com')) out.push(...githubLinks(decoded));
    } catch { /* not base64, ignore */ }
  }
  return [...new Set(out)];
}

try {
  await greeting();
  const login = await cmd(`LOGIN ${q(USER)} ${q(PASS)}`);
  if (login.status !== 'OK') {
    console.error('LOGIN failed:\n' + login.text.trim());
    process.exit(1);
  }

  const sel = await cmd('SELECT INBOX');
  if (sel.status !== 'OK') {
    console.error('SELECT INBOX failed:\n' + sel.text.trim());
    process.exit(1);
  }

  const search = await cmd(`UID SEARCH ${TARGET ? 'TO ' + q(TARGET) : 'UNSEEN'}`);
  const uids = ((search.text.match(/^\* SEARCH([^\r\n]*)/m) || [])[1] || '')
    .trim().split(/\s+/).filter(Boolean);

  if (!uids.length) {
    console.log(TARGET ? `Keine Mail an ${TARGET} gefunden.` : 'Keine ungelesene Mail gefunden.');
  } else {
    for (const uid of uids.slice(-LIMIT).reverse()) {
      const fr = await cmd(`UID FETCH ${uid} BODY.PEEK[]`);
      const subject = ((fr.text.match(/^Subject:\s*(.*)$/m) || [])[1] || '(kein Betreff)').trim();
      console.log(`\n--- UID ${uid} | ${subject} ---`);
      const links = extract(fr.text);
      if (!links.length) console.log('(keine GitHub-Links gefunden)');
      else for (const l of links) console.log(l);
    }
  }

  await cmd('LOGOUT');
  sock.end();
} catch (err) {
  console.error('Fehler: ' + (err && err.message ? err.message : err));
  process.exit(1);
}
