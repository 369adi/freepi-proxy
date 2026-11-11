import fs from 'node:fs';
import path from 'node:path';

export function accountInputHint(storePath) {
  try {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const choices = (store.accounts || [])
      .filter(a => a.token && !a.disabled && !a.tokenBad)
      .map(a => `${a.id} (${a.handle || a.email || 'unnamed'})`);
    return choices.length ? choices.join(' | ') : 'No available accounts — /freepi-add';
  } catch {
    return 'Account list unavailable — /freepi-status';
  }
}

export function accountList(store, selectedId) {
  const accounts = store?.accounts || [];
  if (!accounts.length) return 'No saved accounts. Sign in to an account first.';
  return ['Saved accounts:', ...accounts.map(a =>
    `${a.id === selectedId ? '* ' : '  '}${a.id}  ${a.handle || a.email || '(unnamed)'}${a.disabled ? ' [disabled]' : ''}`),
    '',
    selectedId
      ? '* Pinned: only this account serves new requests.'
      : 'No account pinned — the proxy rotates by remaining budget.',
    'Use /freepi-switch <account-id or email>, or /freepi-auto to rotate again.',
    'Running requests keep their current account.'].join('\n');
}

export function switchSavedAccount(rawInput, storePath, selectionPath) {
  const input = String(rawInput || '').replace(/^\/?freepi-switch\b\s*/i, '').trim();
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  let selected;
  try { selected = JSON.parse(fs.readFileSync(selectionPath, 'utf8')).accountId; } catch {}
  if (!input) return { kind: 'success', text: accountList(store, selected) };
  const accounts = store.accounts || [];
  const exactId = accounts.filter(a => a.id === input);
  const matches = exactId.length ? exactId : accounts.filter(a => a.email?.toLowerCase() === input.toLowerCase());
  if (matches.length !== 1) return { kind: 'error', text: 'Account not found or ambiguous. Run /freepi-switch to list saved account IDs.' };
  const account = matches[0];
  if (account.disabled || !account.token || account.tokenBad) return { kind: 'error', text: 'This account is disabled or needs a new sign-in. Your selection was not changed.' };
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  const temporary = selectionPath + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ accountId: account.id }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, selectionPath);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch {}
    throw err;
  }
  return { kind: 'success', text: `Selected ${account.handle || account.email || account.id} (${account.id}).\nNew requests use only this account; running requests finish on their previous account.\nThis account's authentication, advertising requirements and usage limits still apply.\nUndo with /freepi-auto.` };
}
