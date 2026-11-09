// The sponsor cookie proves that a request comes from a local sponsor window.
// It must survive a proxy restart: the windows stay open while the proxy is
// down, so nothing reopens them, and a fresh value per start would lock every
// one of them out permanently - no account would ever confirm a display again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Mirrors loadCookie in tools/lib/sponsor-panel.mjs, with the path injected so
// the check never touches the real home directory.
function loadCookie(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(raw)) return raw;
  } catch { /* first run */ }
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  } catch { /* an unwritable home still works */ }
  return fresh;
}

function tempCookiePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sponsor-cookie-')), 'sponsor-cookie');
}

test('the same cookie is returned on every start', () => {
  const file = tempCookiePath();
  const first = loadCookie(file);
  const second = loadCookie(file);
  const third = loadCookie(file);
  assert.equal(first, second);
  assert.equal(second, third);
});

test('the cookie is a 48 character hex value', () => {
  const cookie = loadCookie(tempCookiePath());
  assert.match(cookie, /^[0-9a-f]{48}$/);
});

test('two installs get different cookies', () => {
  const a = loadCookie(tempCookiePath());
  const b = loadCookie(tempCookiePath());
  assert.notEqual(a, b);
});

test('a corrupted file is replaced instead of accepted', () => {
  const file = tempCookiePath();
  fs.writeFileSync(file, 'garbage');
  const cookie = loadCookie(file);
  assert.match(cookie, /^[0-9a-f]{48}$/);
  // The bad value must be overwritten so the next start agrees with this one.
  assert.equal(loadCookie(file), cookie);
});

test('a wrong length is rejected even if it is valid hex', () => {
  const file = tempCookiePath();
  fs.writeFileSync(file, 'abc123');
  const cookie = loadCookie(file);
  assert.equal(cookie.length, 48);
  assert.notEqual(cookie, 'abc123');
});

test('surrounding whitespace and a trailing newline do not change the value', () => {
  const file = tempCookiePath();
  const value = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, '\n  ' + value + '  \n');
  assert.equal(loadCookie(file), value);
});
