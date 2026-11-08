#!/usr/bin/env node
// tools/stress.mjs - concurrency + rate-limit probe against the local proxy.
//
//   node tools/stress.mjs                10 parallel requests, model deepseek-v4.1-flash
//   node tools/stress.mjs --n 20         more requests
//   node tools/stress.mjs --direct       talk to api.freepi.ai, bypassing the proxy
//
// Prints a per-request status table and a summary, so we can see whether the
// proxy survives concurrent subagents or whether free-pi rate-limits us.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('--n', 10));
const MODEL = arg('--model', 'deepseek-v4.1-flash');
const DIRECT = process.argv.includes('--direct');
const PORT = Number(process.env.FREEPI_PROXY_PORT || 4000);

let BASE, TOKEN;
if (DIRECT) {
  const store = path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');
  const data = JSON.parse(fs.readFileSync(store, 'utf8'));
  const acc = data.accounts.find(a => a.id === data.activeAccountId) || data.accounts[0];
  TOKEN = acc.token;
  BASE = 'https://api.freepi.ai/v1';
} else {
  BASE = 'http://127.0.0.1:' + PORT + '/v1';
}

const headers = {
  'content-type': 'application/json',
  ...(DIRECT
    ? { authorization: 'Bearer ' + TOKEN, 'x-client-version': '0.6.15', 'x-session-id': 'stress-probe' }
    : { authorization: 'Bearer freepi-proxy' }),
};

async function one(i) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: `say OK ${i}` }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text();
    let msg = '';
    try { msg = JSON.parse(text).choices?.[0]?.message?.content ?? ''; } catch { msg = text.slice(0, 80); }
    return { i, status: r.status, ms: Date.now() - t0, note: r.ok ? msg.trim() : text.slice(0, 140) };
  } catch (e) {
    return { i, status: 0, ms: Date.now() - t0, note: e.message };
  }
}

const started = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const wall = Date.now() - started;

const ok = results.filter(r => r.status === 200);
const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

console.log(`\ntarget : ${BASE}${DIRECT ? '  (direct, no proxy)' : ''}`);
console.log(`model  : ${MODEL}`);
console.log(`requests: ${N} in parallel, wall ${wall} ms\n`);

for (const r of results.sort((a, b) => a.i - b.i)) {
  const mark = r.status === 200 ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} #${String(r.i).padStart(2)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)} ms  ${r.note.replace(/\s+/g, ' ').slice(0, 110)}`);
}

console.log('\n  status breakdown: ' + Object.entries(byStatus).map(([s, c]) => `${s}: ${c}`).join(', '));
console.log(`  success: ${ok.length}/${N}  (${Math.round(ok.length / N * 100)}%)`);
if (ok.length) {
  const ms = ok.map(r => r.ms).sort((a, b) => a - b);
  console.log(`  latency: min ${ms[0]} / median ${ms[Math.floor(ms.length / 2)]} / max ${ms[ms.length - 1]} ms`);
}
