#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FREEPI_BASE = 'https://api.freepi.ai';
const ACCOUNTS_STORE_PATH = process.env.FREEPI_ACCOUNTS_PATH ||
  path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

function req(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(FREEPI_BASE + path);
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'x-client-version': '0.6.16',
        ...(opts.headers || {}),
      },
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, body: b }); }
      });
    });
    r.on('error', reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main Flow: GitHub Device Flow & Auto-Authorization via Chrome/Edge CDP
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n============================================================');
  console.log(' free-pi: Add Account with GitHub Auto-Authorization');
  console.log('============================================================\n');

  // 1. Start free-pi device flow (/auth/github/device)
  console.log('[1/4] Requesting device code from free-pi...');
  const startRes = await req('/auth/github/device', { method: 'POST', body: {} });
  if (startRes.status !== 200 || !startRes.body?.user_code) {
    console.error('Failed to get device code:', startRes.body);
    process.exit(1);
  }

  const { user_code, session_id, verification_uri, verification_uri_complete } = startRes.body;
  const targetUrl = verification_uri_complete || `${verification_uri}?user_code=${encodeURIComponent(user_code)}`;

  console.log(`[2/4] Device Code: ${user_code}`);
  console.log(`      Verification URL: ${targetUrl}`);

  // Copy code to clipboard on Windows
  try {
    execSync(`powershell.exe -NoProfile -Command "Set-Clipboard -Value '${user_code}'"`);
    console.log('      (Code copied to clipboard)');
  } catch {}

  const browserExe = findBrowser();
  const cdpPort = 9466;
  const tempProfile = path.join(os.tmpdir(), `freepi-add-${Date.now()}`);

  let browserProc = null;
  if (browserExe) {
    console.log(`[3/4] Launching browser (${path.basename(browserExe)}) for authorization...`);
    browserProc = spawn(browserExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      targetUrl,
    ], { detached: true, stdio: 'ignore' });
    browserProc.unref();

    // Drive browser via CDP to auto-type and click Authorize
    driveCdpAutoAuthorize(cdpPort, user_code).catch(() => {});
  } else {
    console.log(`[3/4] Please open the URL in your browser to confirm.`);
  }

  // 2. Poll for free-pi token
  console.log('[4/4] Waiting for GitHub authorization approval...');
  const startTime = Date.now();
  let token = null;

  while (Date.now() - startTime < 300_000) {
    await sleep(2500);

    // Consent call to ensure token endpoint is unblocked
    try {
      await req('/auth/consent', {
        method: 'POST',
        body: { session_id, consent_version: '4' },
      });
    } catch {}

    const pollRes = await req('/auth/token', {
      method: 'POST',
      body: { session_id },
    });

    if (pollRes.status === 200 && pollRes.body?.token) {
      token = pollRes.body.token;
      break;
    }
  }

  if (!token) {
    console.error('\nAuthorization timed out or was cancelled.');
    process.exit(1);
  }

  // 3. Measure account details via /me
  console.log('\nToken received! Fetching account details...');
  const meRes = await req('/me', {
    headers: { authorization: `Bearer ${token}` },
  });

  const me = meRes.body || {};
  const handle = me.handle || 'unknown';
  const userId = me.user_id || crypto.randomUUID();

  // 4. Save to accounts.json
  await saveAccount({ token, handle, userId, me });

  console.log('\n============================================================');
  console.log(` Successfully added account: ${handle} (ID: ${userId.slice(0, 8)})`);
  console.log(` Daily Credits: ${me.remaining_credits_today ?? 20000} / ${me.allowance_credits ?? 20000}`);
  console.log('============================================================\n');

  // Cleanup temp profile
  try {
    await fs.rm(tempProfile, { recursive: true, force: true });
  } catch {}

  process.exit(0);
}

// ---------------------------------------------------------------------------
// CDP Auto-Authorize Script
// ---------------------------------------------------------------------------
async function driveCdpAutoAuthorize(port, userCode) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(1500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const tabs = await res.json();
      const page = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!page) continue;

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise(r => ws.addEventListener('open', r));

      // Script to auto-type userCode into device boxes and click Authorize
      const expr = `(() => {
        // If device code input fields exist, enter code
        var inputs = document.querySelectorAll('input[name="user_code"], input#user_code, input.js-verification-code-input');
        if (inputs.length === 1 && !inputs[0].value) {
          inputs[0].value = '${userCode}';
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Look for and click Continue button
        var buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        for (var b of buttons) {
          var label = (b.innerText || b.value || '').trim();
          if (/^continue$/i.test(label) && !b.disabled) {
            b.click();
            return 'continue_clicked';
          }
        }

        // Look for and click Authorize button (enable if disabled by script)
        for (var b of buttons) {
          var label = (b.innerText || b.value || '').trim();
          if (/^authorize|authorize free-pi/i.test(label)) {
            b.disabled = false;
            b.removeAttribute('disabled');
            b.click();
            return 'authorized';
          }
        }
        return 'waiting';
      })()`;

      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true },
      }));

      ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Store Helper
// ---------------------------------------------------------------------------
async function saveAccount({ token, handle, userId, me }) {
  let store = { version: 1, activeAccountId: null, accounts: [] };
  try {
    const raw = await fs.readFile(ACCOUNTS_STORE_PATH, 'utf8');
    store = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {}

  if (!Array.isArray(store.accounts)) store.accounts = [];

  const nextNum = store.accounts.length + 1;
  const id = `acc-${nextNum}`;

  const existing = store.accounts.find(a => a.userId === userId || a.handle === handle);
  if (existing) {
    existing.token = token;
    existing.tokenBad = false;
    existing.disabled = false;
    existing.usage = {
      allowanceCredits: me.allowance_credits ?? 20000,
      remainingCreditsToday: me.remaining_credits_today ?? 20000,
      refillAt: me.refill_at ?? null,
      visibleAllowance: me.visible_allowance ?? true,
      fetchedAt: new Date().toISOString(),
    };
    store.activeAccountId = existing.id;
  } else {
    store.accounts.push({
      id,
      number: nextNum,
      handle,
      userId,
      token,
      disabled: false,
      tokenBad: false,
      createdAt: new Date().toISOString(),
      usage: {
        allowanceCredits: me.allowance_credits ?? 20000,
        remainingCreditsToday: me.remaining_credits_today ?? 20000,
        refillAt: me.refill_at ?? null,
        visibleAllowance: me.visible_allowance ?? true,
        fetchedAt: new Date().toISOString(),
      },
    });
    store.activeAccountId = id;
  }

  await fs.mkdir(path.dirname(ACCOUNTS_STORE_PATH), { recursive: true });
  await fs.writeFile(ACCOUNTS_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

main().catch(console.error);
