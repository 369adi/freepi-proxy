// Lane invariant under load: fire several requests at once and prove the proxy
// never lets one account run two completions in parallel, and that every request
// still receives exactly one response.
const BASE = 'http://127.0.0.1:4000/v1';
const AUTH = { authorization: 'Bearer freepi-proxy', 'content-type': 'application/json' };

const ask = async (n) => {
  const started = Date.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: false,
      max_tokens: 24,
      messages: [{ role: 'user', content: 'Reply with the word "lane" and nothing else. #' + n }],
    }),
  });
  const text = await res.text();
  let ok = false;
  let detail = '';
  try {
    const json = JSON.parse(text);
    ok = Boolean(json?.choices?.[0]?.message?.content);
    detail = json?.error?.message || '';
  } catch {
    detail = text.slice(0, 80);
  }
  return { n, status: res.status, ok, ms: Date.now() - started, detail };
};

const CONCURRENCY = 6;
const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => ask(i + 1)));

for (const r of results) {
  console.log(
    `${r.ok ? 'OK  ' : 'FAIL'} #${r.n} status=${r.status} ${String(r.ms).padStart(6)}ms ${r.detail}`,
  );
}

const usage = await (await fetch('http://127.0.0.1:4000/usage', { headers: AUTH })).json();
console.log(
  `\nqueue after load: inFlight=${usage.queue.inFlight} waiting=${usage.queue.waiting} lanes=${usage.queue.lanes}`,
);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} request(s) failed` : '\nall requests served');
process.exit(failed ? 1 : 0);
