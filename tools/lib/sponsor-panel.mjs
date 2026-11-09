import crypto from 'node:crypto';
import { request } from './freepi-api.mjs';

/**
 * Sponsor panel: one visible window per account.
 *
 * free-pi is free because ads pay for it, and it gates free completions until
 * an account has *actually displayed* an ad ("403 ads_required"). Every account
 * in the pool therefore needs its own window showing a real ad - one account
 * seeing an ad does not unlock another.
 *
 * The honesty rules stay unchanged and are enforced here, not in the browser:
 *   - an impression is only forwarded after the panel reported it visible,
 *     at least one second after the ad was handed out, with the cookie and the
 *     single-use nonce of that same account,
 *   - a click token is acknowledged only once,
 *   - nothing is ever reported on behalf of an account that has no window.
 *
 * `currentAccount` returns the account a request is about; the panel is
 * account-aware so several windows can be open at the same time.
 */
export function createSponsorPanel({ currentAccount, accounts, sessionId, usage, html, apiRequest = request, pixelFetch = fetch, clock = Date.now, port = 4000, onDisplayed = null }) {
  const cookie = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  const acknowledged = new Set();
  // Per account, not global: two open windows must not overwrite each other's
  // ad, or one account would acknowledge another account's creative.
  const latest = new Map();
  const fetching = new Map();
  const lastDisplay = new Map();
  // The panel is only reachable from this machine, on the proxy's own port.
  // localhost and 127.0.0.1 are the same origin as far as the user is
  // concerned, so both are accepted (and both appear in the allowlist).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const authorized = req => {
    const origin = req.headers.origin;
    return (!origin || allowedOrigins.has(origin)) &&
      (req.headers.cookie || '').split(';').some(item => item.trim() === 'freepi_sponsor=' + cookie);
  };
  const safeUrl = value => {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
  };

  /**
   * Which account a panel request is about. `?account=<id>` selects one
   * explicitly (that is what makes several windows possible); without it we
   * fall back to the account the proxy would use next.
   */
  async function accountFor(url) {
    const wanted = url.searchParams.get('account');
    if (wanted && typeof accounts === 'function') {
      const list = await accounts();
      const hit = (list || []).find(a => a && a.id === wanted);
      if (hit) return hit;
      // An unknown account must not silently fall back to another one: that
      // would show account A's ad in account B's window.
      return null;
    }
    return currentAccount();
  }

  /** Latest ad for one account, fetched at most once concurrently. */
  async function adFor(account) {
    const cached = latest.get(account.id);
    if (cached && clock() - cached.created <= 60_000) return cached.ad;
    if (!fetching.has(account.id)) {
      const job = apiRequest('/ads/next?slot=banner', { token: account.token, headers: { 'x-session-id': sessionId } })
        .then(ad => { latest.set(account.id, { ad, created: clock() }); return ad; })
        .finally(() => { fetching.delete(account.id); });
      fetching.set(account.id, job);
    }
    return fetching.get(account.id);
  }

  async function route(req, res, url) {
    if (!url.pathname.startsWith('/sponsor')) return false;
    if (!allowedHosts.has(req.headers.host)) {
      json(res, 403, { error: 'Open this panel from the local proxy address.' }); return true;
    }
    // CORS preflight for the panel's own fetch() calls: answer before the
    // cookie check, because a preflight never carries credentials.
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) { json(res, 403, { error: 'Origin not allowed.' }); return true; }
      res.writeHead(204, {
        'access-control-allow-origin': origin || `http://127.0.0.1:${port}`,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-credentials': 'true',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
      res.end(); return true;
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

    // Which accounts still need a window - the launcher opens one per entry.
    if (req.method === 'GET' && url.pathname === '/sponsor/accounts') {
      if (typeof accounts !== 'function') { json(res, 200, { accounts: [] }); return true; }
      const list = await accounts();
      json(res, 200, {
        accounts: (list || []).filter(a => a && a.id).map(a => ({
          id: a.id,
          handle: a.handle || null,
          email: a.email || null,
          lastDisplay: lastDisplay.get(a.id) || null,
          url: `http://127.0.0.1:${port}/sponsor?account=${encodeURIComponent(a.id)}`,
        })),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/sponsor/ad') {
      const account = await accountFor(url);
      if (!account) { json(res, 404, { error: 'No such account - /sponsor/accounts lists the open windows.' }); return true; }
      if (!account.token) { json(res, 401, { error: 'The selected account needs a valid sign-in.' }); return true; }
      const ad = await adFor(account);
      if (!ad?.ad_id || !ad.click_token || !ad.creative) {
        json(res, 200, { noAd: true, account: account.handle || account.id, accountId: account.id, usage: usage() }); return true;
      }
      const nonce = crypto.randomBytes(24).toString('hex');
      for (const [key, value] of pending) if (clock() - value.created > 120_000) pending.delete(key);
      pending.set(nonce, { accountId: account.id, ad, created: clock() });
      json(res, 200, { nonce, account: account.handle || account.id, accountId: account.id, creative: {
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
      // The nonce alone decides which account this impression belongs to. It
      // is never taken from the request body, so a window cannot acknowledge
      // an impression on behalf of a different account.
      const account = record && typeof accounts === 'function'
        ? (await accounts() || []).find(a => a && a.id === record.accountId) || null
        : await currentAccount();
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
      lastDisplay.set(account.id, { at: new Date(clock()).toISOString() });
      // The proxy lifts this account's ad cooldown so it serves requests again.
      if (typeof onDisplayed === 'function') {
        try { onDisplayed(account.id); } catch {}
      }
      json(res, 200, { displayed: true, accountId: account.id }); return true;
    }

    if (req.method === 'GET' && url.pathname === '/sponsor/status') {
      const account = await accountFor(url);
      json(res, 200, {
        accountId: account?.id ?? null,
        lastDisplay: account ? lastDisplay.get(account.id) || null : null,
        display: Object.fromEntries(lastDisplay),
        usage: usage(),
      });
      return true;
    }
    json(res, 404, { error: 'Not found' }); return true;
  }
  return async (req, res, url) => {
    try { return await route(req, res, url); }
    catch (error) { if (!res.headersSent) json(res, 502, { error: error.code || 'Sponsor service temporarily unavailable' }); else res.end(); return true; }
  };
}
