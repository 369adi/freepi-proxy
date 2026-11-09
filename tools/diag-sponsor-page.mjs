// Ask the live sponsor page why it is not confirming a display.
// Read-only: it evaluates the page's own state and prints the numbers.
const port = process.argv[2] || '9411';

const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
const page = list.find((t) => t.type === 'page' && String(t.url).includes('/sponsor'));
if (!page) {
  console.log('no sponsor page found on port ' + port);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function call(method, params) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
});

await new Promise((r) => ws.addEventListener('open', r));

const expression = `(() => {
  const card = document.querySelector('#ad');
  const r = card.getBoundingClientRect();
  const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return JSON.stringify({
    visibilityState: document.visibilityState,
    innerWidth, innerHeight,
    scrollY: window.scrollY,
    hasFocus: document.hasFocus(),
    rect: { width: r.width, height: r.height, top: r.top, bottom: r.bottom },
    overlap: shown,
    fits: r.top >= 0 && r.bottom <= innerHeight,
    visibleResult: (typeof visible === 'function') ? visible() : 'no visible()',
    stateText: document.querySelector('#state').textContent,
    headline: document.querySelector('#headline').textContent,
    linkHref: document.querySelector('#link').getAttribute('href'),
    current: current ? { hasNonce: !!current.nonce, noAd: !!current.noAd } : null,
    sent: sent,
    visibleSince: visibleSince,
    ratio: ratio,
    lastFetchAge: lastFetch ? Date.now() - lastFetch : null
  }, null, 1);
})()`;

const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
console.log(res.result.value ?? JSON.stringify(res.result));
ws.close();
