// Measure what a single call actually costs, per model.
// Reads the account's daily counter before and after, so the answer comes from
// free-pi's own numbers instead of from a model name that merely says "Free".
const BASE = 'http://127.0.0.1:4000';
const AUTH = { authorization: 'Bearer freepi-proxy', 'content-type': 'application/json' };

const credits = async () => {
  const r = await fetch(BASE + '/usage', { headers: AUTH });
  const j = await r.json();
  const acc = j.accounts.find((a) => a.id === 'acc-1');
  return acc.dailyCreditsLeft;
};

const ask = (model) =>
  fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 30,
      messages: [{ role: 'user', content: 'Say "ok".' }],
    }),
  }).then(async (r) => {
    const j = await r.json();
    return j?.choices?.[0]?.message?.content ? 'served' : `error ${r.status}`;
  });

const models = process.argv.slice(2);
for (const model of models) {
  const before = await credits();
  const outcome = await ask(model);
  await new Promise((r) => setTimeout(r, 2500));   // let the meter settle
  const after = await credits();
  console.log(
    `${model.padEnd(32)} ${outcome.padEnd(8)} costs ${String(before - after).padStart(4)} credits  (${before} -> ${after})`,
  );
}
