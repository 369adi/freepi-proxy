import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import { createSponsorPanel } from './lib/sponsor-panel.mjs';
import { emptyStore, recordUsage } from './lib/store.mjs';
import { describe } from './lib/policy.mjs';

async function fixture(t) {
  let now = 100_000, account = { id: 'one', token: 'TEST_AUTH_SECRET', handle: 'Example' };
  const calls = [];
  const panel = createSponsorPanel({ currentAccount: async () => account, sessionId: 'test-session', html: '<html>Visible sponsor</html>', usage: () => ({}), clock: () => now,
    apiRequest: async (route, options) => { calls.push({ route, options }); return route.startsWith('/ads/next') ? { ad_id: 'ad', click_token: 'click', source: 'own', creative: { headline: 'Sponsor', body: 'A real visible advertisement', cta: 'Read more' }, click_url: 'https://example.com' } : {}; } });
  const server = http.createServer(async (req, res) => { if (!await panel(req, res, new URL(req.url, 'http://127.0.0.1:4000'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let cookie = '';
  async function request(route, body, origin) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: payload ? 'POST' : 'GET', headers: { host: '127.0.0.1:4000', cookie, ...(origin ? { origin } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } }, res => {
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, data }); });
      });
      req.on('error', reject); req.end(payload);
    });
  }
  await request('/sponsor');
  return { request, calls, advance: ms => now += ms, change: () => account = { id: 'two', token: 'TEST_OTHER_SECRET' } };
}

test('fetching an ad does not send an impression or expose credentials', async t => {
  const f = await fixture(t), response = await f.request('/sponsor/ad');
  assert.equal(response.status, 200);
  assert.equal(f.calls.filter(c => c.route === '/ads/impression').length, 0);
  assert.doesNotMatch(JSON.stringify(response.data), /TEST_AUTH_SECRET|click_token/);
});
test('hidden, premature, foreign-origin and replayed confirmations are rejected', async t => {
  const f = await fixture(t), { data } = await f.request('/sponsor/ad');
  assert.equal((await f.request('/sponsor/impression', { nonce: data.nonce, visible: true })).status, 409);
  f.advance(1500);
  assert.equal((await f.request('/sponsor/impression', { nonce: data.nonce, visible: false })).status, 409);
  assert.equal((await f.request('/sponsor/impression', { nonce: data.nonce, visible: true }, 'https://other.example')).status, 403);
  assert.equal((await f.request('/sponsor/impression', { nonce: data.nonce, visible: true })).status, 200);
  assert.equal((await f.request('/sponsor/impression', { nonce: data.nonce, visible: true })).status, 409);
  assert.equal(f.calls.filter(c => c.route === '/ads/impression').length, 1);
});
test('a displayed ad cannot confirm an impression for a different account', async t => {
  const f = await fixture(t), { data } = await f.request('/sponsor/ad'); f.advance(1500); f.change();
  assert.equal((await f.request('/sponsor/impression', { nonce: data.nonce, visible: true })).status, 409);
  assert.equal(f.calls.filter(c => c.route === '/ads/impression').length, 0);
});
test('browser visibility gate rejects a hidden, clipped or off-screen sponsor', () => {
  const html = fs.readFileSync(new URL('./sponsor.html', import.meta.url), 'utf8');
  const gate = html.match(/function visible\(\)\{[\s\S]*?\n\}/)[0];
  let rect = { width: 600, height: 150, top: 30, bottom: 180 };
  const context = { document: { visibilityState: 'visible' }, ratio: 1, innerHeight: 600, window: { scrollY: 0 }, card: { getBoundingClientRect: () => rect }, duplicateWindow: false };
  vm.createContext(context); vm.runInContext(gate, context);
  assert.equal(context.visible(), true);
  context.document.visibilityState = 'hidden'; assert.equal(context.visible(), false);
  context.document.visibilityState = 'visible';
  // A card taller than the window is accepted only while it starts at the top;
  // a card pushed below the fold or scrolled away must never confirm anything.
  rect = { width: 600, height: 900, top: 0, bottom: 900 }; context.window.scrollY = 0;
  assert.equal(context.visible(), true);
  rect = { width: 600, height: 900, top: -700, bottom: 200 }; context.window.scrollY = 700;
  assert.equal(context.visible(), false);
  rect = { width: 600, height: 150, top: 620, bottom: 770 }; context.window.scrollY = 0;
  assert.equal(context.visible(), false);
  // Too small to be readable, or almost entirely cut off, is not a display.
  rect = { width: 150, height: 400, top: 10, bottom: 410 };
  assert.equal(context.visible(), false);
  rect = { width: 600, height: 400, top: 500, bottom: 900 };
  assert.equal(context.visible(), false);
  // The intersection ratio no longer gates on its own; geometry does.
  rect = { width: 600, height: 150, top: 30, bottom: 180 }; context.ratio = .4;
  assert.equal(context.visible(), true);
});
test('premium balances and consumption are tracked separately without double counting components', () => {
  const store = emptyStore(), account = { id: 'example', history: [] }, now = Date.now();
  const me = { allowance_credits: 15000, remaining_credits_today: 10000, premium_credits: 1000, premium_bought_credits: 600, premium_gifted_credits: 400, refill_at: new Date(now + 86400000).toISOString() };
  recordUsage(store, account, me, now);
  recordUsage(store, account, { ...me, premium_credits: 800, premium_bought_credits: 500, premium_gifted_credits: 300 }, now + 1000);
  const summary = describe(account);
  assert.equal(summary.premiumCredits, 800);
  assert.equal(summary.premiumBoughtCredits, 500);
  assert.equal(summary.premiumGiftedCredits, 300);
  assert.equal(store.totals.premiumCreditsUsedTotal, 200);
  assert.equal(store.totals.creditsUsedTotal, 0);
  recordUsage(store, account, { ...me, premium_credits: 1500 }, now + 2000);
  assert.equal(store.totals.premiumCreditsUsedTotal, 200);
});
