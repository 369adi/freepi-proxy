// Mint a valid DSH browser-session cookie for the current port.
//
// The web GUI signs its session cookie with a secret persisted in
// ~/.dsh/.credentials.yaml under client-connection/browser-session. Because the
// cookie name is derived from the request authority (host:port) and the cookie
// value is an HMAC over a small JSON payload, a valid session can be produced
// locally for whatever port the app happens to bind after a restart. That is
// what makes automatic continuation possible without reading process memory.
//
//   node tools/dsh-cookie.mjs <port>            print the Cookie header value
//   node tools/dsh-cookie.mjs <port> --verify   also prove the server accepts it
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COOKIE_PREFIX = 'dsh-auth-';
const DAY_MS = 1440 * 60 * 1000;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Read the persisted signing secret; never print it. */
function loadSecret(home) {
  const file = join(home, '.dsh', '.credentials.yaml');
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  // Only the browser-session block carries this secret; locate it by its key,
  // then take the first `secret:` line after it.
  const start = lines.findIndex((line) => line.includes('client-connection/browser-session'));
  if (start < 0) throw new Error('no client-connection/browser-session record in the credential store');
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{2}[A-Za-z0-9_-]+\//u.test(lines[i])) break; // next record
    const m = /^\s*secret:\s*(\S+)\s*$/u.exec(lines[i]);
    if (m) {
      const secret = Buffer.from(String(m[1]).replaceAll('-', '+').replaceAll('_', '/'), 'base64');
      if (secret.byteLength !== 32) throw new Error(`signing secret is ${secret.byteLength} bytes, expected 32`);
      return secret;
    }
  }
  throw new Error('browser-session record has no secret');
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest();
}

const port = Number(process.argv[2]);
if (!Number.isFinite(port)) {
  console.log('usage: node tools/dsh-cookie.mjs <port> [--verify]');
  process.exit(2);
}

const authority = `127.0.0.1:${port}`;
const secret = loadSecret(homedir());
const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest());
const issuedAt = Date.now();
const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * DAY_MS };
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const value = `v1.${body}.${b64url(sign(secret, body))}`;
const cookie = `${name}=${value}`;

if (!process.argv.includes('--verify')) {
  console.log(cookie);
  process.exit(0);
}

// Verify against the live server: an authenticated index request must not be 401.
const response = await fetch(`http://127.0.0.1:${port}/`, {
  headers: { cookie },
  redirect: 'manual',
  signal: AbortSignal.timeout(4000),
});
console.log(`cookie name: ${name}`);
console.log(`status with cookie: ${response.status} ${response.statusText}`);
if (response.status === 401) {
  const text = await response.text();
  console.log(`REJECTED: ${JSON.stringify(text.slice(0, 160))}`);
  process.exit(1);
}
console.log('ACCEPTED: the server did not answer 401');
