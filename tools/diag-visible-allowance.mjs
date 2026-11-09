// Ask free-pi directly what the free-allowance switch says for every account.
// This is the ground truth the proxy cannot fake: usage.visibleAllowance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storePath = path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const base = process.env.FREEPI_API_BASE || 'https://api.freepi.ai';

for (const account of store.accounts) {
  const sid = 'diag-' + Math.random().toString(36).slice(2, 18);
  try {
    const r = await fetch(base + '/me', {
      headers: {
        authorization: 'Bearer ' + account.token,
        'x-client-version': '0.6.15',
        'x-session-id': sid,
      },
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) {
      console.log(account.id + ': HTTP ' + r.status + ' ' + text.slice(0, 120));
      continue;
    }
    const usage = data.usage || {};
    console.log(JSON.stringify({
      id: account.id,
      handle: account.handle,
      visibleAllowance: usage.visibleAllowance ?? null,
      remaining: data.remaining_credits_today ?? null,
      allowance: data.allowance_credits ?? null,
      premium: data.premium_credits ?? null,
      refillAt: data.refill_at ?? null,
    }));
  } catch (err) {
    console.log(account.id + ': ' + err.message);
  }
}
