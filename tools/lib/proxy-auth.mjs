// proxy-auth.mjs — host/port resolution and constant-time API key auth.
//
// Keeps local usage (127.0.0.1) friction-free while ensuring any public bind
// (such as Google Cloud Run on 0.0.0.0:$PORT) fails closed unless
// FREEPI_PROXY_API_KEY is configured and matched on every non-health request.

import crypto from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** True when `host` only listens on the local loopback interface. */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

/** Parse one or more comma-separated API keys from an env string. */
export function parseApiKeys(raw) {
  return String(raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Extract a client API key from `Authorization: Bearer <key>` or `x-api-key`.
 * Returns null when neither header provides a non-empty token.
 */
export function extractRequestApiKey(headers = {}) {
  const auth = headers.authorization ?? headers.Authorization;
  if (typeof auth === 'string') {
    const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
    if (match && match[1] && match[1].trim()) return match[1].trim();
  }
  const xApiKey = headers['x-api-key'] ?? headers['X-Api-Key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }
  return null;
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();

/** Constant-time check against all configured keys (compares SHA-256 digests). */
export function verifyApiKey(candidate, allowedKeys = []) {
  if (typeof candidate !== 'string' || !candidate || !Array.isArray(allowedKeys) || !allowedKeys.length) {
    return false;
  }
  const candDigest = sha256(candidate);
  let matched = false;
  for (const key of allowedKeys) {
    if (!key) continue;
    const keyDigest = sha256(key);
    if (crypto.timingSafeEqual(candDigest, keyDigest)) matched = true;
  }
  return matched;
}

/**
 * Resolve bind host, port, and auth policy from environment variables.
 * Cloud Run sets K_SERVICE and injects PORT; local runs stay on 127.0.0.1:4000.
 */
export function resolveBindConfig(env = process.env) {
  const isCloudRun = Boolean(env.K_SERVICE);
  const rawPort = isCloudRun
    ? (env.PORT ?? env.FREEPI_PROXY_PORT ?? 8080)
    : (env.FREEPI_PROXY_PORT ?? env.PORT ?? 4000);
  const port = Number(rawPort);
  const host = String(env.FREEPI_PROXY_HOST || (isCloudRun ? '0.0.0.0' : '127.0.0.1')).trim();
  const apiKeys = parseApiKeys(env.FREEPI_PROXY_API_KEY);
  const allowUnauthenticated = env.FREEPI_ALLOW_UNAUTHENTICATED === '1';
  const isPublic = !isLoopbackHost(host);
  const authRequired = !allowUnauthenticated && (apiKeys.length > 0 || isPublic);
  const misconfiguredPublic = isPublic && apiKeys.length === 0 && !allowUnauthenticated;

  return {
    isCloudRun,
    host,
    port: Number.isFinite(port) && port > 0 ? port : (isCloudRun ? 8080 : 4000),
    isPublic,
    apiKeys,
    allowUnauthenticated,
    authRequired,
    misconfiguredPublic,
  };
}
