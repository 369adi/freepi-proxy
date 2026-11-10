// test-sponsor-accounts.test.mjs - one sponsor window per account.
//
// free-pi gates free completions per account ("403 ads_required") until that
// account has really displayed an ad. A single global panel would mean only the
// active account ever gets unlocked, and every other account keeps failing -
// which a harness then reports as "API key is invalid". These tests pin down
// that each account gets its own ad, its own nonce and its own confirmation,
// and that one account can never acknowledge another one's impression.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSponsorPanel } from './lib/sponsor-panel.mjs';

const AD = {
  ad_id: 'ad', click_token: 'click', source: 'own',
  creative: { headline: 'Sponsor', body: 'A real visible advertisement', cta: 'Read more' },
  click_url: 'https://example.com',
};

async function fixture(t, { accountList } = {}) {
  let now = 100_000;
  const accounts = accountList || [
    { id: 'acc-1', token: 'TOKEN_ONE', handle: 'one' },
    { id: 'acc-2', token: 'TOKEN_TWO', handle: 'two' },
  ];
  const calls = [];
  const displayed = [];
  const panel = createSponsorPanel({
    currentAccount: async () => accounts[0],
    accounts: async () => accounts,
    sessionId: 'test-session',
    html: '<html>Visible sponsor</html>',
    usage: () => ({}),
    clock: () => now,
    onDisplayed: id => displayed.push(id),
    apiRequest: async (route, options) => {
      calls.push({ route, options });
      // Distinguishable creatives so a mix-up between accounts is visible.
      return route.startsWith('/ads/next')
        ? { ...AD, click_token: 'click-' + (options?.token || 'none') }
        : {};
    },
  });
  const server = http.createServer(async (req, res) => {
    if (!await panel(req, res, new URL(req.url, 'http://127.0.0.1:4000'))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  let cookie = '';
  async function request(route, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: route,
        method: payload ? 'POST' : 'GET',
        headers: { host: '127.0.0.1:4000', cookie, ...(payload ? { 'content-type': 'application/json' } : {}) },
      }, res => {
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        let text = '';
        res.on('data', chunk => text += chunk);
        res.on('end', () => {
          let data; try { data = JSON.parse(text); } catch { data = text; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  await request('/sponsor');
  return { request, calls, displayed, advance: ms => now += ms, accounts };
}

test('every account is listed with its own window URL', async t => {
  const f = await fixture(t);
  const { status, data } = await f.request('/sponsor/accounts');

  assert.equal(status, 200);
  assert.equal(data.accounts.length, 2);
  assert.deepEqual(data.accounts.map(a => a.id), ['acc-1', 'acc-2']);
  assert.match(data.accounts[1].url, /\/sponsor\?account=acc-2$/);
  assert.doesNotMatch(JSON.stringify(data), /TOKEN_ONE|TOKEN_TWO/);
});

test('duplicate pages close only their own account and stale windows become reopenable', async t => {
  const f=await fixture(t);
  assert.equal((await f.request('/sponsor/window?account=acc-1',{id:'first',register:true})).data.close,false);
  await f.request('/sponsor/window?account=acc-2',{id:'other',register:true});
  await f.request('/sponsor/window?account=acc-1',{id:'second',register:true});
  assert.equal((await f.request('/sponsor/window?account=acc-1',{id:'first'})).data.close,true);
  assert.equal((await f.request('/sponsor/window?account=acc-2',{id:'other'})).data.close,false);
  const live=(await f.request('/sponsor/windows')).data;
  assert.equal(live.accounts['acc-1'],true);
  assert.equal(live.duplicates,1);
  // Stale windows only drop out after the panel's window heartbeat TTL (90 s).
  f.advance(90_001);
  assert.deepEqual((await f.request('/sponsor/windows')).data.accounts,{});
});

test('each account receives its own ad and nonce', async t => {
  const f = await fixture(t);
  const one = await f.request('/sponsor/ad?account=acc-1');
  const two = await f.request('/sponsor/ad?account=acc-2');

  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(one.data.accountId, 'acc-1');
  assert.equal(two.data.accountId, 'acc-2');
  assert.notEqual(one.data.nonce, two.data.nonce, 'nonces must not be shared between accounts');

  // each account fetched with its own token - never the other one's
  const tokens = f.calls.filter(c => c.route.startsWith('/ads/next')).map(c => c.options.token);
  assert.deepEqual(tokens.sort(), ['TOKEN_ONE', 'TOKEN_TWO']);
});

test('an unknown account does not silently borrow the active one', async t => {
  const f = await fixture(t);
  const { status } = await f.request('/sponsor/ad?account=ghost');
  assert.equal(status, 404, 'a wrong id must fail loudly, not show another account ad');
});

test('confirming an ad only unblocks the account that displayed it', async t => {
  const f = await fixture(t);
  const one = await f.request('/sponsor/ad?account=acc-1');
  const two = await f.request('/sponsor/ad?account=acc-2');
  f.advance(1500);

  const first = await f.request('/sponsor/impression', { nonce: one.data.nonce, visible: true });
  assert.equal(first.status, 200);
  assert.equal(first.data.accountId, 'acc-1');
  assert.deepEqual(f.displayed, ['acc-1'], 'only acc-1 may leave its ad cooldown yet');

  // the other account's nonce is still unanswered
  const second = await f.request('/sponsor/impression', { nonce: two.data.nonce, visible: true });
  assert.equal(second.status, 200);
  assert.equal(second.data.accountId, 'acc-2');
  assert.deepEqual(f.displayed, ['acc-1', 'acc-2']);
});

test('an impression cannot be confirmed on behalf of another account', async t => {
  const f = await fixture(t);
  const one = await f.request('/sponsor/ad?account=acc-1');
  f.advance(1500);

  // acc-2 has never displayed anything: its id in the body must not help,
  // because the nonce alone decides which account the impression belongs to.
  await f.request('/sponsor/ad?account=acc-2');
  const forged = await f.request('/sponsor/impression', {
    nonce: one.data.nonce, visible: true, accountId: 'acc-2',
  });

  assert.equal(forged.status, 200);
  assert.equal(forged.data.accountId, 'acc-1', 'the nonce owner gets the confirmation');
  assert.deepEqual(f.displayed, ['acc-1']);
});

test('the same ad is not acknowledged twice', async t => {
  const f = await fixture(t);
  const one = await f.request('/sponsor/ad?account=acc-1');
  f.advance(1500);
  await f.request('/sponsor/impression', { nonce: one.data.nonce, visible: true });

  // a second window for the same account gets a fresh nonce but the same click
  // token, so upstream must not be told twice
  const again = await f.request('/sponsor/ad?account=acc-1');
  f.advance(1500);
  await f.request('/sponsor/impression', { nonce: again.data.nonce, visible: true });

  const impressions = f.calls.filter(c => c.route === '/ads/impression');
  assert.equal(impressions.length, 1, 'one ad, one impression');
});
