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

export const BASE = process.env.FREEPI_API_BASE || 'https://api.freepi.ai';
export const VERSION = process.env.FREEPI_VERSION || '0.6.15';
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

export async function request(pathname, { method = 'GET', token, body, headers = {}, timeoutMs = 20000 } = {}) {
  const h = { 'x-client-version': VERSION, accept: 'application/json', ...headers };
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
    const code = json && typeof json.code === 'string' ? json.code : null;
    const msg = (json && typeof json.message === 'string' && json.message) || `HTTP ${res.status}`;
    throw new ApiError(res.status, code, msg, json ?? text);
  }
  return json ?? text;
}

/** Live quota/usage for one account. */
export const getMe = token => request('/me', { token });

/** Model catalog (also carries the minimum supported client version). */
export const getCatalog = token =>
  request('/client-version?cli_version=' + encodeURIComponent(VERSION), token ? { token } : {});

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
export const getAds = (token, sessionId) =>
  request('/ads/next?slot=banner', { token, headers: { 'x-session-id': sessionId } });

/** /me/consent for an already authenticated account. */
export const submitUserConsent = (token, consentVersion = CONSENT_VERSION) =>
  request('/me/consent', { method: 'POST', token, body: { consent_version: consentVersion } });

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
