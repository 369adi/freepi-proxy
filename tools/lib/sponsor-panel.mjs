import crypto from 'node:crypto';
import { request } from './freepi-api.mjs';

export function createSponsorPanel({ currentAccount, sessionId, usage, html, apiRequest = request, pixelFetch = fetch, clock = Date.now }) {
  const cookie = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  const acknowledged = new Set();
  let latest = null;
  let fetching = null;
  let lastDisplay = null;
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const authorized = req => {
    const origin = req.headers.origin;
    return (!origin || origin === 'http://127.0.0.1:4000') &&
      (req.headers.cookie || '').split(';').some(item => item.trim() === 'freepi_sponsor=' + cookie);
  };
  const safeUrl = value => {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
  };
  async function route(req, res, url) {
    if (!url.pathname.startsWith('/sponsor')) return false;
    if (!['127.0.0.1:4000', 'localhost:4000'].includes(req.headers.host)) {
      json(res, 403, { error: 'Open this panel from the local proxy address.' }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/sponsor') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'set-cookie': `freepi_sponsor=${cookie}; HttpOnly; SameSite=Strict; Path=/sponsor`,
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      });
      res.end(html); return true;
    }
    if (!authorized(req)) { json(res, 403, { error: 'Open the local sponsor window first.' }); return true; }
    if (req.method === 'GET' && url.pathname === '/sponsor/ad') {
      const account = await currentAccount();
      if (!account?.token) { json(res, 401, { error: 'The selected account needs a valid sign-in.' }); return true; }
      if (!latest || latest.accountId !== account.id || clock() - latest.created > 60_000) {
        if (!fetching) fetching = apiRequest('/ads/next?slot=banner', { token: account.token, headers: { 'x-session-id': sessionId } })
          .then(ad => {
            latest = { accountId: account.id, ad, created: clock() };
          }).finally(() => { fetching = null; });
        await fetching;
      }
      if (latest.accountId !== account.id) { json(res, 409, { error: 'Account changed; refreshing sponsor.' }); return true; }
      const ad = latest.ad;
      if (!ad?.ad_id || !ad.click_token || !ad.creative) { json(res, 200, { noAd: true, account: account.handle || account.id, usage: usage() }); return true; }
      const nonce = crypto.randomBytes(24).toString('hex');
      for (const [key, value] of pending) if (clock() - value.created > 120_000) pending.delete(key);
      pending.set(nonce, { accountId: account.id, ad, created: clock() });
      json(res, 200, { nonce, account: account.handle || account.id, creative: {
        headline: String(ad.creative.headline || ''), body: String(ad.creative.body || ''), cta: String(ad.creative.cta || 'Learn more'),
      }, url: safeUrl(ad.click_url), usage: usage() });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/sponsor/impression') {
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 4096) { json(res, 413, { error: 'Request too large' }); return true; } }
      let body;
      try { body = JSON.parse(text); } catch { json(res, 400, { error: 'Invalid request' }); return true; }
      const record = pending.get(body.nonce);
      const account = await currentAccount();
      if (!record || record.accountId !== account?.id || body.visible !== true || clock() - record.created < 1000 || clock() - record.created > 120_000) {
        json(res, 409, { error: 'The sponsor must be displayed in the visible window before confirmation.' }); return true;
      }
      pending.delete(body.nonce);
      if (!acknowledged.has(record.ad.click_token)) {
        let pixelSent = false;
        const pixel = safeUrl(record.ad.imp_url);
        if (record.ad.source === 'gravity' && pixel && /(^|\.)trygravity\.(ai|com)$/.test(new URL(pixel).hostname)) {
          try { const response = await pixelFetch(pixel, { signal: AbortSignal.timeout(3000), redirect: 'error' }); pixelSent = response.ok; } catch {}
        }
        await apiRequest('/ads/impression', { method: 'POST', token: account.token,
          headers: { 'x-session-id': sessionId }, body: { ad_id: record.ad.ad_id, click_token: record.ad.click_token, ...(pixelSent ? { imp_fired: true } : {}) } });
        acknowledged.add(record.ad.click_token);
        if (acknowledged.size > 500) acknowledged.delete(acknowledged.values().next().value);
      }
      lastDisplay = { accountId: account.id, at: new Date(clock()).toISOString() };
      json(res, 200, { displayed: true }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/sponsor/status') {
      json(res, 200, { lastDisplay, usage: usage() }); return true;
    }
    json(res, 404, { error: 'Not found' }); return true;
  }
  return async (req, res, url) => {
    try { return await route(req, res, url); }
    catch (error) { if (!res.headersSent) json(res, 502, { error: error.code || 'Sponsor service temporarily unavailable' }); else res.end(); return true; }
  };
}
