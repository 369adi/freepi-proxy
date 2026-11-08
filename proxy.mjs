#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const FREEPI_BASE    = 'https://api.freepi.ai';
const FREEPI_VERSION = '0.6.15';   // keep in sync with upstream minimum
const PORT           = Number(process.env.FREEPI_PROXY_PORT ?? 4000);
const AD_INTERVAL_MS = 30_000;
const CREDENTIALS_PATH = path.join(os.homedir(), '.free-pi', 'agent', 'credentials.json');
const SESSION_ID = crypto.randomUUID();

async function loadJwt() {
  try {
    const p = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
    return typeof p.token === 'string' && p.token ? p.token : null;
  } catch { return null; }
}

function httpsGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchCatalog(jwt) {
  try {
    const r = await httpsGet(
      `${FREEPI_BASE}/client-version?cli_version=${FREEPI_VERSION}`,
      { authorization: `Bearer ${jwt}`, 'x-client-version': FREEPI_VERSION },
    );
    return (typeof r.body === 'object' && r.body) ? r.body : {};
  } catch { return {}; }
}

async function fetchAd(jwt) {
  try {
    return await httpsGet(`${FREEPI_BASE}/ads/next?slot=banner`, {
      authorization: `Bearer ${jwt}`,
      'x-session-id': SESSION_ID,
      'x-client-version': FREEPI_VERSION,
    });
  } catch { return null; }
}

function renderAd(ad) {
  if (!ad || typeof ad.body !== 'object' || !ad.body) return;
  const b = ad.body;
  const lines = [];
  const text = b.text ?? b.content ?? b.message ?? b.title
    ?? (b.creative ? [b.creative.headline, b.creative.body, b.creative.cta].filter(Boolean).join('\n') : null);
  const url  = b.url  ?? b.link   ?? b.click_url ?? b.href ?? null;
  const img  = b.image_url ?? b.image ?? null;
  if (text) lines.push(String(text).trim());
  if (url)  lines.push('-> ' + String(url).trim());
  if (img)  lines.push('[img] ' + String(img).trim());
  if (!lines.length) return;
  const W = 54, bar = '-'.repeat(W);
  console.log('\n+' + bar + '+');
  console.log('| ' + 'free-pi sponsor'.padEnd(W-1) + '|');
  console.log('+' + bar + '+');
  for (const line of lines)
    for (let i = 0; i < Math.max(line.length, 1); i += W)
      console.log('| ' + line.slice(i, i + W).padEnd(W-1) + '|');
  console.log('+' + bar + '+');
}

async function runAdLoop(jwt) {
  const tick = async () => { const a = await fetchAd(jwt); if (a && a.status === 200) renderAd(a); };
  await tick();
  setInterval(tick, AD_INTERVAL_MS);
}

// No model remapping: the model ID opencode sends is forwarded as-is.
function proxyCompletions(jwt, inReq, inRes) {
  const chunks = [];
  inReq.on('data', c => chunks.push(c));
  inReq.on('end', () => {
    const body = Buffer.concat(chunks);
    try { const p = JSON.parse(body); if (p.model) console.log('[proxy] -> ' + p.model); } catch {}
    const upReq = https.request({
      hostname: 'api.freepi.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: Object.assign(
        {
          'content-type': 'application/json',
          'content-length': body.length,
          'authorization': 'Bearer ' + jwt,
          'x-session-id': SESSION_ID,
          'x-client-version': FREEPI_VERSION,
        },
        inReq.headers['accept']        ? { accept: inReq.headers['accept'] } : {},
        inReq.headers['x-request-id'] ? { 'x-request-id': inReq.headers['x-request-id'] } : {},
      ),
    }, upRes => {
      const h = {
        'access-control-allow-origin': '*',
        'content-type': upRes.headers['content-type'] || 'application/json',
      };
      if (upRes.headers['cache-control'])     h['cache-control']     = upRes.headers['cache-control'];
      if (upRes.headers['transfer-encoding']) h['transfer-encoding'] = upRes.headers['transfer-encoding'];
      inRes.writeHead(upRes.statusCode, h);
      upRes.pipe(inRes);
    });
    upReq.on('error', err => {
      console.error('[proxy] upstream error: ' + err.message);
      if (!inRes.headersSent) {
        inRes.writeHead(502, { 'content-type': 'application/json' });
        inRes.end(JSON.stringify({ error: { message: 'upstream: ' + err.message, type: 'proxy_error' } }));
      }
    });
    upReq.write(body);
    upReq.end();
  });
}

function startServer(jwt, models) {
  const catalog = (Array.isArray(models) && models.length)
    ? models
    : [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }];

  const server = http.createServer(function(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-request-id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: catalog.map(function(m) {
          return { id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'free-pi', display_name: m.name };
        }),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      proxyCompletions(jwt, req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
  });

  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + PORT + ' in use. Set FREEPI_PROXY_PORT=other.');
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, '127.0.0.1', function() {
    const W = 60, sep = '='.repeat(W);
    console.log('\n' + sep);
    console.log(' free-pi proxy  ->  http://127.0.0.1:' + PORT + '/v1');
    console.log(sep);
    console.log(' opencode.json:');
    console.log('   {');
    console.log('     "provider": "openai",');
    console.log('     "openai": {');
    console.log('       "baseUrl": "http://127.0.0.1:' + PORT + '/v1",');
    console.log('       "apiKey": "freepi-proxy"');
    console.log('     }');
    console.log('   }');
    console.log(sep);
    console.log(' Models (copy an ID into the opencode "model" setting):');
    console.log(sep);
    for (const m of catalog)
      console.log('   ' + m.id.padEnd(44) + ' ' + m.name);
    console.log(sep);
    console.log(' Suggested: "model": "' + catalog[0].id + '"');
    console.log(sep + '\n');
  });
}

async function main() {
  const jwt = await loadJwt();
  if (!jwt) {
    console.error('No credentials. Run  npx free-pi-cli  once first.');
    console.error('Expected: ' + CREDENTIALS_PATH);
    process.exit(1);
  }
  const data   = await fetchCatalog(jwt);
  const models = Array.isArray(data.models) && data.models.length ? data.models : null;
  if (data.notice) console.log('[free-pi] ' + data.notice);
  startServer(jwt, models);
  runAdLoop(jwt).catch(function() {});
}

main().catch(function(err) { console.error('[proxy] Fatal:', err); process.exit(1); });
