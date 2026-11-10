// freepi-api.mjs — minimal zero-dependency client for the free-pi API.
//
// Every call mirrors what free-pi-cli 0.6.15 itself does, so the rotator never
// invents behaviour the real client does not have:
//   GET  /me                      -> live usage (credits + USD cap + refill_at)
//   GET  /client-version          -> model catalog
//   POST /auth/github/device      -> {session_id, user_code, verification_uri_complete}
//   POST /auth/consent            -> {session_id, consent_version}
//   POST /auth/token              -> {status:"pending"} | {token} | 403 consent_required
//   GET  /ads/next?slot=banner    -> sponsor banner

import {getClientVersion,requiredVersion,upgradeClient,syncClientVersionFromCatalog} from './client-runtime.mjs';
export const BASE = process.env.FREEPI_API_BASE || 'https://api.freepi.ai';
export const VERSION = getClientVersion();
export const CONSENT_VERSION = '4';

export class ApiError extends Error {
  constructor(status, code, message, raw) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

export async function request(pathname, { method = 'GET', token, body, headers = {}, timeoutMs = 20000, upgradeRetried=false } = {}) {
  const h = { accept: 'application/json', ...headers, 'x-client-version': getClientVersion() };
  if (token) h.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = String(Buffer.byteLength(payload));
  }

  const res = await fetch(BASE + pathname, {
    method,
    headers: h,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

  if (!res.ok) {
    if(res.status===426&&(json?.code==='upgrade_required'||json?.error?.code==='upgrade_required')&&!upgradeRetried){
      await upgradeClient(requiredVersion(json));
      return request(pathname,{method,token,body,headers,timeoutMs,upgradeRetried:true});
    }
    const code = json && typeof json.code === 'string' ? json.code : null;
    const msg = (json && typeof json.message === 'string' && json.message) || `HTTP ${res.status}`;
    throw new ApiError(res.status, code, msg, json ?? text);
  }
  return json ?? text;
}

/** Live quota/usage for one account. */
export const getMe = token => request('/me', { token });

/** Model catalog (also carries the minimum supported client version). */
export const getCatalog = async token => {
  const res = await request('/client-version?cli_version=' + encodeURIComponent(getClientVersion()), token ? { token } : {});
  syncClientVersionFromCatalog(res);
  return res;
};

/** Start the headless GitHub device flow. */
export const deviceStart = () => request('/auth/github/device', { method: 'POST', body: {} });

/** Accept the first-run consent for a device session (required once per session). */
export const deviceConsent = sessionId =>
  request('/auth/consent', {
    method: 'POST',
    body: { session_id: sessionId, consent_version: CONSENT_VERSION },
  });

/** Poll a device session. Resolves {status:'pending'} or {token}. Throws ApiError on 403. */
export const devicePoll = (sessionId, { timezone, locale } = {}) =>
  request('/auth/token', {
    method: 'POST',
    body: {
      session_id: sessionId,
      timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      locale: locale || 'en',
    },
  });

/** Sponsor banner for the active account. */
export const getAds = (token, sessionId, slot = 'banner') =>
  request('/ads/next?slot=' + encodeURIComponent(slot), { token, headers: { 'x-session-id': sessionId } });

/**
 * Direct sponsor confirmation from official free-pi-cli (vendor/free-pi-cli/src/vendor/pi-ads/api.ts):
 * 1. GET /ads/next?slot=banner (or inline)
 * 2. If Gravity imp_url on https://*.trygravity.(ai|com), fire GET imp_url
 * 3. POST /ads/impression with { ad_id, click_token, imp_fired }
 */
export async function confirmAdDirect(token, sessionId, slot = 'banner') {
  if (!token || !sessionId) return { confirmed: false };
  const ad = await getAds(token, sessionId, slot);
  if (!ad || typeof ad !== 'object' || !ad.ad_id || !ad.click_token) {
    return { confirmed: false, ad: ad || null };
  }
  let impFired = false;
  if (ad.source === 'gravity' && typeof ad.imp_url === 'string' && ad.imp_url) {
    try {
      const parsed = new URL(ad.imp_url);
      if (parsed.protocol === 'https:' && /^([a-z0-9-]+\.)?trygravity\.(ai|com)$/i.test(parsed.hostname)) {
        const impRes = await fetch(ad.imp_url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        });
        impFired = impRes.ok;
      }
    } catch { /* ignore imp_url errors */ }
  }
  await request('/ads/impression', {
    method: 'POST',
    token,
    headers: { 'x-session-id': sessionId },
    body: {
      ad_id: ad.ad_id,
      click_token: ad.click_token,
      ...(impFired ? { imp_fired: true } : {}),
    },
    timeoutMs: 5000,
  });
  return { confirmed: true, ad, impFired };
}

/** /me/consent for an already authenticated account. */
export const submitUserConsent = (token, consentVersion = CONSENT_VERSION) =>
  request('/me/consent', { method: 'POST', token, body: { consent_version: consentVersion } });

/** Release any stuck upstream CLI session lease on this account (POST /session/reset). */
export const resetUpstreamSession = token =>
  request('/session/reset', { method: 'POST', token, body: {}, timeoutMs: 5000 });

/** Decode a free-pi JWT payload without verifying it (exp/sub only). */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const pad = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** True when the token is expired (with a safety margin). */
export function tokenExpired(token, now = Date.now(), marginMs = 60000) {
  const claims = decodeJwt(token);
  if (!claims || typeof claims.exp !== 'number') return false; // unparseable: let the API decide
  return claims.exp * 1000 <= now + marginMs;
}
