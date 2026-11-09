// secrets.mjs - where the generated sign-up passwords live.
//
// accounts.json is rewritten by the running proxy on every usage poll, so it is
// the wrong place for a password: a concurrent write would drop it, and the file
// is the one people paste into issues. Secrets therefore live in their own file
// with 0600 permissions, keyed by account id.
//
// This is a local convenience store, not a vault. It is plaintext on purpose:
// the alternative is losing the only copy of a password for an account that
// cannot be recovered any other way. Treat the file like an SSH key.
//
// HONEST LIMIT ON WINDOWS: fs.chmod can only toggle the read-only bit there, so
// the 0600 below is a real restriction on POSIX and a no-op on Windows, where
// the file simply inherits the profile directory's ACL. Do not read the mode as
// a guarantee - the protection is that the file sits in the user's own profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const SECRETS_DIR = path.join(os.homedir(), '.free-pi', 'proxy');
export const SECRETS_PATH = path.join(SECRETS_DIR, 'secrets.json');

// Every mutation is read-modify-write, so two of them running at once both read
// the same state and the second write silently drops the first row. A unique
// temp name does not help there - the loss happens before the write. Serialise
// the whole cycle through one promise chain instead.
let writeChain = Promise.resolve();

function serialised(fn) {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive even when this link rejects, or one failure would
  // poison every later save.
  writeChain = run.then(() => {}, () => {});
  return run;
}

/** Read the secret store. A missing or unreadable file is an empty store. */
export async function loadSecrets() {
  const empty = { version: 1, accounts: {} };
  try {
    const raw = await fs.readFile(SECRETS_PATH, 'utf8');
    // Strip the BOM: PowerShell's Set-Content writes one, and JSON.parse rejects
    // it with a message that reads like the file is corrupt.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    if (!parsed.accounts || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
      parsed.accounts = {};
    }
    return parsed;
  } catch {
    return empty;
  }
}

/**
 * Write the store atomically. The temp name carries a random UUID, not the pid:
 * two saves in the same process would otherwise share one temp file and the
 * second rename would silently drop the first password.
 */
export async function saveSecrets(store) {
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  const tmp = `${SECRETS_PATH}.${crypto.randomUUID()}.tmp`;
  const body = JSON.stringify(store, null, 2) + '\n';
  try {
    // mode on open() only applies when the file is created; chmod covers the rest.
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(body, 'utf8');
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, SECRETS_PATH);
  } catch (err) {
    // Leaving a half-written temp file behind would make the next run look
    // corrupt; nothing of value is in it, so remove it and report the failure.
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  if (process.platform !== 'win32') await fs.chmod(SECRETS_PATH, 0o600).catch(() => {});
  return SECRETS_PATH;
}

/**
 * Remember the password for an account. `key` is normally the account id, but
 * during sign-up the account does not exist yet, so the email is used and later
 * re-keyed once the id is known.
 */
export async function rememberPassword(key, { email, password, handle, note, accountId } = {}) {
  if (!key) throw new Error('rememberPassword needs a key');
  if (!password) throw new Error('rememberPassword needs a password');
  return serialised(async () => {
    const store = await loadSecrets();
    store.accounts[key] = {
      email: email || null,
      handle: handle || null,
      password,
      note: note || null,
      // Set only once the account really exists in the store. Its absence is what
      // marks a row as a half-finished sign-up.
      accountId: accountId || null,
      savedAt: new Date().toISOString(),
    };
    await saveSecrets(store);
    return store.accounts[key];
  });
}

/** Look a password up by account id or by email. */
export async function findPassword(key) {
  const store = await loadSecrets();
  if (store.accounts[key]) return store.accounts[key];
  const lower = String(key || '').toLowerCase();
  for (const [k, v] of Object.entries(store.accounts)) {
    if (v && v.email && String(v.email).toLowerCase() === lower) return { ...v, key: k };
  }
  return null;
}

/**
 * Move a secret from a temporary key (email) to the final one (account id).
 *
 * Never overwrites an existing target: a blind write there would delete the
 * password of whatever account already owned the id, and that is the one value
 * in this file that cannot be recovered. If the target exists both rows are
 * kept and the newer one wins only when the old row is empty.
 */
export async function rekeySecret(from, to) {
  if (!from || !to || from === to) return null;
  return serialised(async () => {
    const store = await loadSecrets();
    const row = store.accounts[from];
    if (!row) return null;
    if (store.accounts[to]) {
      // Target taken. Keep it unless it carries no password, and leave the source
      // in place so the email lookup still finds it. Reported, not resolved
      // silently - the caller can decide.
      if (!store.accounts[to].password) {
        store.accounts[to] = { ...row, accountId: to, conflictingSource: from };
        delete store.accounts[from];
        await saveSecrets(store);
        return store.accounts[to];
      }
      return { ...store.accounts[to], conflict: true, keptFrom: from };
    }
    store.accounts[to] = { ...row, accountId: to };
    delete store.accounts[from];
    await saveSecrets(store);
    return store.accounts[to];
  });
}

/** How many passwords are on file - used by doctor to spot a half-done run. */
export async function secretCount() {
  const store = await loadSecrets();
  return Object.keys(store.accounts).length;
}
