// Read the free-allowance switch the way the proxy sees it: on a real
// completion. One tiny request per account, pinned, and we only look at
// usage.visibleAllowance in the answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storePath = path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const base = process.env.FREEPI_API_BASE || 'https://api.freepi.ai';

for (const account of store.accounts) {
  const sid = 'meas-' + Math.random().toString(36).slice(2, 18);
  try {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + account.token,
        'x-client-version': '0.6.15',
        'x-session-id': sid,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-ai/deepseek-v41-flash-1017',
        messages: [{ role: 'user', content: 'Reply with just: ok' }],
        max_tokens: 5,
        stream: false,
      }),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) {
      console.log(account.id + ': HTTP ' + r.status + ' ' + text.slice(0, 160));
      continue;
    }
    const usage = data.usage || {};
    console.log(JSON.stringify({
      id: account.id,
      visibleAllowance: usage.visibleAllowance ?? null,
      costCredits: usage.cost_credits ?? usage.credits ?? null,
      remainingToday: usage.remaining_credits_today ?? null,
    }));
  } catch (err) {
    console.log(account.id + ': ' + err.message);
  }
}
