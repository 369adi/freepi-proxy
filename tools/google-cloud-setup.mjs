#!/usr/bin/env node
/**
 * Automatic Google Account Picker & Google Cloud / Drive Setup for freepi-proxy.
 *
 * - Scans local Chromium browsers (Brave, Edge, Chrome, Vivaldi, Chromium)
 *   plus existing gcloud auth sessions to find all logged-in Google accounts.
 * - Lets any user select which Google account to use (interactive menu, CLI
 *   flag `--account <number|email>`, or via `/freepi-cloud` in DSH).
 * - Opens the exact browser & profile where that Google account is logged in
 *   whenever OAuth login or Google Cloud Billing / Free Trial activation is needed.
 * - Automatically enables Google Drive (for Cloud Context Handoff & Memory Sync)
 *   and sets up Google Cloud Run (for 24/7 Cloud Proxy when PC is off).
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const WORKSPACE_ROOT = path.join(os.homedir(), '.dsh', 'google-workspace');
const AUTH_CONFIG_DIR = path.join(WORKSPACE_ROOT, 'auth');
const ACCOUNT_FILE = path.join(WORKSPACE_ROOT, 'account.json');
const TIERS_FILE = path.join(WORKSPACE_ROOT, 'account-tiers.json');
export const MIN_PRO_STORAGE_BYTES = 2 * 1024 ** 4; // 2 TiB (Google One / AI Pro)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------- Browser Discovery

function getBrowserDefinitions() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const home = os.homedir();

  if (process.platform === 'win32') {
    return [
      {
        name: 'Brave',
        userDataDir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
        exeCandidates: [
          path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ],
      },
      {
        name: 'Edge',
        userDataDir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
        exeCandidates: [
          path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ],
      },
      {
        name: 'Chrome',
        userDataDir: path.join(localAppData, 'Google', 'Chrome', 'User Data'),
        exeCandidates: [
          path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ],
      },
      {
        name: 'Vivaldi',
        userDataDir: path.join(localAppData, 'Vivaldi', 'User Data'),
        exeCandidates: [
          path.join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe'),
          path.join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'),
        ],
      },
    ];
  }

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return [
      {
        name: 'Brave',
        userDataDir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
        exeCandidates: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      },
      {
        name: 'Edge',
        userDataDir: path.join(appSupport, 'Microsoft Edge'),
        exeCandidates: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      },
      {
        name: 'Chrome',
        userDataDir: path.join(appSupport, 'Google', 'Chrome'),
        exeCandidates: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      },
    ];
  }

  const configDir = path.join(home, '.config');
  return [
    {
      name: 'Brave',
      userDataDir: path.join(configDir, 'BraveSoftware', 'Brave-Browser'),
      exeCandidates: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    },
    {
      name: 'Edge',
      userDataDir: path.join(configDir, 'microsoft-edge'),
      exeCandidates: ['/usr/bin/microsoft-edge'],
    },
    {
      name: 'Chrome',
      userDataDir: path.join(configDir, 'google-chrome'),
      exeCandidates: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
    },
  ];
}

function findExistingExe(candidates = []) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function querySqliteGoogleLogins(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return [];
    // Copy to temp file in case the browser currently holds a lock on the DB
    const tmpPath = path.join(
      os.tmpdir(),
      `freepi-glogin-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`,
    );
    fs.copyFileSync(dbPath, tmpPath);
    try {
      const { DatabaseSync } = process.getBuiltinModule
        ? process.getBuiltinModule('node:sqlite') || {}
        : {};
      if (!DatabaseSync) return [];
      const db = new DatabaseSync(tmpPath);
      // CAST date_last_used to TEXT because Chrome 64-bit microsecond timestamps
      // exceed JavaScript Number.MAX_SAFE_INTEGER and cause ERR_OUT_OF_RANGE in node:sqlite.
      const rows = db
        .prepare(
          "SELECT username_value, CAST(date_last_used AS TEXT) AS d FROM logins WHERE (origin_url LIKE '%google.com%' OR origin_url LIKE '%accounts.google%' OR origin_url LIKE '%myaccount.google%') AND username_value LIKE '%@%' ORDER BY date_last_used DESC",
        )
        .all();
      db.close();
      const seen = new Set();
      const list = [];
      for (const r of rows) {
        const email = String(r.username_value || '').trim().toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !seen.has(email)) {
          seen.add(email);
          list.push(email);
        }
      }
      return list;
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  } catch {
    return [];
  }
}

// --------------------------------------------------------- gcloud Discovery

export function findGcloudEnv() {
  fs.mkdirSync(AUTH_CONFIG_DIR, { recursive: true });

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const sdkCandidates = [
    path.resolve(REPO_ROOT, '..', 'dsh-google', 'tools', 'google-cloud-sdk'),
    path.join(localAppData, 'Google', 'Cloud SDK', 'google-cloud-sdk'),
    path.join(programFiles, 'Google', 'Cloud SDK', 'google-cloud-sdk'),
    path.join(programFilesX86, 'Google', 'Cloud SDK', 'google-cloud-sdk'),
    path.join(os.homedir(), 'google-cloud-sdk'),
  ];

  const pythonCandidates = [
    process.env.CLOUDSDK_PYTHON,
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
  ].filter(Boolean);

  let pythonExe = null;
  for (const py of pythonCandidates) {
    try {
      if (fs.existsSync(py)) {
        pythonExe = py;
        break;
      }
    } catch {}
  }

  for (const sdkRoot of sdkCandidates) {
    const gcloudPy = path.join(sdkRoot, 'lib', 'gcloud.py');
    const bundledPy = path.join(sdkRoot, 'platform', 'bundledpython', 'python.exe');
    const gcloudBin = path.join(
      sdkRoot,
      'bin',
      process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud',
    );
    if (fs.existsSync(bundledPy) && fs.existsSync(gcloudPy)) {
      return {
        cmd: bundledPy,
        prefixArgs: [gcloudPy],
        sdkRoot,
        env: {
          ...process.env,
          CLOUDSDK_CONFIG: AUTH_CONFIG_DIR,
          CLOUDSDK_PYTHON: bundledPy,
        },
      };
    }
    if (pythonExe && fs.existsSync(gcloudPy)) {
      return {
        cmd: pythonExe,
        prefixArgs: [gcloudPy],
        sdkRoot,
        env: {
          ...process.env,
          CLOUDSDK_CONFIG: AUTH_CONFIG_DIR,
          CLOUDSDK_PYTHON: pythonExe,
        },
      };
    }
    if (fs.existsSync(gcloudBin)) {
      return {
        cmd: gcloudBin,
        prefixArgs: [],
        sdkRoot,
        env: {
          ...process.env,
          CLOUDSDK_CONFIG: AUTH_CONFIG_DIR,
          ...(pythonExe ? { CLOUDSDK_PYTHON: pythonExe } : {}),
        },
      };
    }
  }

  return {
    cmd: process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud',
    prefixArgs: [],
    sdkRoot: null,
    env: {
      ...process.env,
      CLOUDSDK_CONFIG: AUTH_CONFIG_DIR,
      ...(pythonExe ? { CLOUDSDK_PYTHON: pythonExe } : {}),
    },
  };
}

export function runGcloud(args, { timeoutMs = 30000, inheritStdio = false } = {}) {
  const g = findGcloudEnv();
  const fullArgs = [...g.prefixArgs, ...args];
  const useShell = process.platform === 'win32' && /\.cmd$/i.test(g.cmd);
  const res = spawnSync(g.cmd, fullArgs, {
    env: g.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: inheritStdio ? 'inherit' : 'pipe',
    shell: useShell,
    windowsHide: true,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  };
}

function getGcloudAuthedAccounts() {
  const res = runGcloud(['auth', 'list', '--format=json'], { timeoutMs: 15000 });
  if (!res.ok || !res.stdout) return new Map();
  try {
    const items = JSON.parse(res.stdout);
    const map = new Map();
    for (const item of items) {
      const email = String(item.account || '').trim().toLowerCase();
      if (email) {
        map.set(email, {
          email: item.account,
          active: item.status === 'ACTIVE',
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function readSavedWorkspaceAccount(accountFile = ACCOUNT_FILE) {
  return safeReadJson(accountFile);
}

export function saveWorkspaceAccount(patch, accountFile = ACCOUNT_FILE) {
  fs.mkdirSync(path.dirname(accountFile), { recursive: true });
  const current = safeReadJson(accountFile) || {};
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(accountFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}

export function readAccountTiers(tiersFile = TIERS_FILE) {
  const data = safeReadJson(tiersFile);
  return data && typeof data === 'object' ? data : {};
}

export function saveAccountTier(entry, tiersFile = TIERS_FILE) {
  const email = String(entry?.email || '').trim();
  if (!email) return null;
  fs.mkdirSync(path.dirname(tiersFile), { recursive: true });
  const current = readAccountTiers(tiersFile);
  const key = email.toLowerCase();
  const next = {
    ...current,
    [key]: {
      email,
      isPro: Boolean(entry.isPro),
      tier: entry.isPro ? 'pro' : 'free',
      limitBytes: entry.limitBytes ?? null,
      storageLabel: entry.storageLabel || 'unknown',
      checkedAt: entry.checkedAt || new Date().toISOString(),
    },
  };
  fs.writeFileSync(tiersFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next[key];
}

export function classifyDriveQuota(about) {
  const limitRaw = about?.storageQuota?.limit;
  const limitBytes = limitRaw !== undefined && limitRaw !== null && limitRaw !== '' ? Number(limitRaw) : null;
  const valid = Number.isFinite(limitBytes) && limitBytes > 0;
  const tb = valid ? +(limitBytes / (1024 ** 4)).toFixed(2) : null;
  const gb = valid ? +(limitBytes / (1024 ** 3)).toFixed(1) : null;
  const isPro = valid && limitBytes >= MIN_PRO_STORAGE_BYTES;
  const storageLabel = tb !== null && tb >= 1 ? `${tb} TB` : gb !== null ? `${gb} GB` : 'unknown';
  return {
    isPro,
    tier: valid ? (isPro ? 'pro' : 'free') : 'unknown',
    limitBytes: valid ? limitBytes : null,
    storageLabel,
  };
}

async function fetchDriveQuotaWithGcloud(email, { timeoutMs = 15000 } = {}) {
  const tokRes = runGcloud(['auth', 'print-access-token', `--account=${email}`, '--quiet'], { timeoutMs });
  const token = tokRes.stdout.trim();
  if (!tokRes.ok || !token || /\s/.test(token)) {
    return { ok: false, error: tokRes.stderr || 'Google access token unavailable' };
  }
  const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return { ok: false, error: `Google Drive API returned HTTP ${response.status}` };
  }
  return { ok: true, about: await response.json() };
}

export async function probeAccountProStatus(
  email,
  { tiersFile = TIERS_FILE, accountFile = ACCOUNT_FILE, fetcher = fetchDriveQuotaWithGcloud, timeoutMs = 15000 } = {},
) {
  const targetEmail = String(email || '').trim();
  if (!targetEmail) return { ok: false, isPro: false, tier: 'unknown', storageLabel: 'unknown', error: 'Email required' };
  try {
    const res = await fetcher(targetEmail, { timeoutMs });
    if (!res?.ok || !res.about) {
      return { ok: false, isPro: null, tier: 'unknown', storageLabel: 'unknown', error: res?.error || 'Quota check failed' };
    }
    const classified = classifyDriveQuota(res.about);
    const verifiedEmail = String(res.about?.user?.emailAddress || targetEmail).trim();
    saveAccountTier({ email: verifiedEmail, ...classified }, tiersFile);
    const saved = readSavedWorkspaceAccount(accountFile);
    if (saved?.account && saved.account.toLowerCase() === verifiedEmail.toLowerCase()) {
      saveWorkspaceAccount(
        {
          isPro: classified.isPro,
          tier: classified.tier,
          storageLabel: classified.storageLabel,
          storageLimitBytes: classified.limitBytes,
        },
        accountFile,
      );
    }
    return { ok: true, email: verifiedEmail, ...classified };
  } catch (err) {
    return { ok: false, isPro: null, tier: 'unknown', storageLabel: 'unknown', error: err?.message || String(err) };
  }
}

/**
 * Build a minimal, password-free account store JSON for Cloud Run Secret Manager.
 * Never reads or exports secrets.json passwords.
 */
export function sanitizeAccountsStoreForCloud(storePath = null) {
  const target =
    storePath ||
    process.env.FREEPI_ACCOUNTS_PATH ||
    path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json');
  const raw = safeReadJson(target);
  const srcAccounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  const valid = srcAccounts
    .filter((a) => a && !a.disabled && !a.tokenBad && typeof a.token === 'string' && a.token.trim())
    .map((a, idx) => ({
      id: a.id || `acc-${idx + 1}`,
      number: Number.isFinite(a.number) ? a.number : idx + 1,
      email: a.email || null,
      handle: a.handle || null,
      userId: a.userId || null,
      token: a.token.trim(),
      createdAt: a.createdAt || new Date().toISOString(),
      disabled: false,
      tokenExpiresAt: a.tokenExpiresAt || null,
      usage: a.usage || null,
    }));
  if (!valid.length) return { count: 0, json: null };
  const activeAccountId = valid.some((a) => a.id === raw?.activeAccountId)
    ? raw.activeAccountId
    : valid[0].id;
  const maxNum = valid.reduce((m, a) => Math.max(m, Number(a.number) || 0), 0);
  const payload = {
    version: 1,
    activeAccountId,
    nextAccountNumber: Math.max(Number(raw?.nextAccountNumber) || 1, maxNum + 1),
    settings: raw?.settings && typeof raw.settings === 'object' ? raw.settings : {},
    totals: { accountsMinted: valid.length, creditsUsedTotal: 0, byDay: {} },
    accounts: valid,
  };
  return { count: valid.length, json: JSON.stringify(payload) };
}

function ensureCloudApiKey(rotate = false) {
  const saved = readSavedWorkspaceAccount();
  if (!rotate && typeof saved?.cloudApiKey === 'string' && saved.cloudApiKey.trim().length >= 24) {
    return saved.cloudApiKey.trim();
  }
  const key = 'fp_' + crypto.randomBytes(24).toString('hex');
  saveWorkspaceAccount({ cloudApiKey: key });
  return key;
}

function ensureSecretWithValue(projectId, secretName, value) {
  const desc = runGcloud(['secrets', 'describe', secretName, `--project=${projectId}`, '--quiet'], {
    timeoutMs: 20000,
  });
  if (!desc.ok) {
    const createRes = runGcloud(
      ['secrets', 'create', secretName, '--replication-policy=automatic', `--project=${projectId}`, '--quiet'],
      { timeoutMs: 30000 },
    );
    if (!createRes.ok) {
      throw new Error(`Could not create secret ${secretName}: ${createRes.stderr || createRes.stdout}`);
    }
  }
  const tmpFile = path.join(
    os.tmpdir(),
    `freepi-sec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  fs.writeFileSync(tmpFile, value, { encoding: 'utf8', mode: 0o600 });
  try {
    const addRes = runGcloud(
      ['secrets', 'versions', 'add', secretName, `--data-file=${tmpFile}`, `--project=${projectId}`, '--quiet'],
      { timeoutMs: 30000 },
    );
    if (!addRes.ok) {
      throw new Error(`Could not update secret ${secretName}: ${addRes.stderr || addRes.stdout}`);
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

async function grantSecretAccessToComputeSa(projectId, secretName) {
  const projRes = runGcloud(['projects', 'describe', projectId, '--format=value(projectNumber)', '--quiet'], {
    timeoutMs: 20000,
  });
  const projectNumber = projRes.stdout.trim();
  if (!projRes.ok || !/^\d+$/.test(projectNumber)) return;
  const member = `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const bindRes = runGcloud(
      [
        'secrets',
        'add-iam-policy-binding',
        secretName,
        `--member=${member}`,
        '--role=roles/secretmanager.secretAccessor',
        `--project=${projectId}`,
        '--quiet',
      ],
      { timeoutMs: 25000 },
    );
    if (bindRes.ok) return;
    await sleep(3000);
  }
}

async function verifyCloudRunDeployment(serviceUrl, apiKey) {
  const base = serviceUrl.replace(/\/+$/, '');
  const healthRes = await fetch(`${base}/health`, { signal: AbortSignal.timeout(20000) });
  const healthOk = healthRes.ok;
  const unauthRes = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(15000) });
  const authBlocked = unauthRes.status === 401;
  const authRes = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  let modelsCount = 0;
  if (authRes.ok) {
    try {
      const data = await authRes.json();
      if (Array.isArray(data?.data)) modelsCount = data.data.length;
    } catch {}
  }
  return {
    ok: healthOk && authBlocked && authRes.ok,
    healthStatus: healthRes.status,
    unauthStatus: unauthRes.status,
    authStatus: authRes.status,
    modelsCount,
  };
}

/**
 * Discover all Google accounts logged into Brave, Edge, Chrome, Vivaldi,
 * plus any accounts already authenticated in gcloud.
 */
function discoverRawBrowserGoogleAccounts({ accountFile = ACCOUNT_FILE } = {}) {
  const byEmail = new Map();
  const gcloudMap = getGcloudAuthedAccounts();
  const saved = readSavedWorkspaceAccount(accountFile);
  const savedEmail = String(saved?.account || '').trim().toLowerCase();

  const recordAccount = ({ email, fullName, browser, browserExe, userDataDir, profileDir, profileName }) => {
    const rawEmail = String(email || '').trim();
    if (!rawEmail || !rawEmail.includes('@')) return;
    const key = rawEmail.toLowerCase();
    const existing = byEmail.get(key);
    const gcloudInfo = gcloudMap.get(key);

    if (!existing) {
      byEmail.set(key, {
        email: rawEmail,
        fullName: fullName || '',
        browsers: browser ? [browser] : [],
        primaryBrowser: browser || 'gcloud',
        browserExe: browserExe || null,
        userDataDir: userDataDir || null,
        profileDir: profileDir || 'Default',
        profileName: profileName || '',
        gcloudAuthed: Boolean(gcloudInfo),
        gcloudActive: Boolean(gcloudInfo?.active),
        configuredInDsh: key === savedEmail,
      });
    } else {
      if (browser && !existing.browsers.includes(browser)) {
        existing.browsers.push(browser);
      }
      if (!existing.fullName && fullName) existing.fullName = fullName;
      if (!existing.browserExe && browserExe) {
        existing.primaryBrowser = browser;
        existing.browserExe = browserExe;
        existing.userDataDir = userDataDir;
        existing.profileDir = profileDir || 'Default';
      }
    }
  };

  for (const b of getBrowserDefinitions()) {
    if (!fs.existsSync(b.userDataDir)) continue;
    const exe = findExistingExe(b.exeCandidates);
    const localState = safeReadJson(path.join(b.userDataDir, 'Local State'));
    const infoCache = localState?.profile?.info_cache || {};

    const profileDirs = new Set(['Default', ...Object.keys(infoCache)]);
    try {
      for (const entry of fs.readdirSync(b.userDataDir, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/i.test(entry.name))) {
          profileDirs.add(entry.name);
        }
      }
    } catch {}

    for (const profDir of profileDirs) {
      const cacheEntry = infoCache[profDir] || {};
      if (cacheEntry.user_name) {
        recordAccount({
          email: cacheEntry.user_name,
          fullName: cacheEntry.gaia_name || cacheEntry.name || '',
          browser: b.name,
          browserExe: exe,
          userDataDir: b.userDataDir,
          profileDir: profDir,
          profileName: cacheEntry.name || profDir,
        });
      }

      const prefs = safeReadJson(path.join(b.userDataDir, profDir, 'Preferences'));
      const accountInfoList = Array.isArray(prefs?.account_info) ? prefs.account_info : [];
      for (const acc of accountInfoList) {
        if (acc?.email) {
          recordAccount({
            email: acc.email,
            fullName: acc.full_name || acc.given_name || '',
            browser: b.name,
            browserExe: exe,
            userDataDir: b.userDataDir,
            profileDir: profDir,
            profileName: cacheEntry.name || profDir,
          });
        }
      }

      // Brave & privacy browsers often don't populate Chromium sync `account_info`,
      // so also check saved Google accounts in `Login Data` / `Login Data For Account`.
      for (const dbFile of ['Login Data', 'Login Data For Account']) {
        const emails = querySqliteGoogleLogins(path.join(b.userDataDir, profDir, dbFile));
        for (const email of emails) {
          recordAccount({
            email,
            fullName: '',
            browser: b.name,
            browserExe: exe,
            userDataDir: b.userDataDir,
            profileDir: profDir,
            profileName: cacheEntry.name || profDir,
          });
        }
      }
    }
  }

  for (const [, info] of gcloudMap.entries()) {
    recordAccount({
      email: info.email,
      fullName: '',
      browser: null,
      browserExe: null,
      userDataDir: null,
      profileDir: null,
      profileName: '',
    });
  }

  if (saved?.account) {
    recordAccount({
      email: saved.account,
      fullName: '',
      browser: saved.browser || null,
      browserExe: null,
      userDataDir: null,
      profileDir: saved.profileDir || 'Default',
      profileName: '',
    });
  }

  return Array.from(byEmail.values());
}

/**
 * Filter & annotate discovered accounts using verified Google Drive quota (>= 2 TB = Pro).
 * Confirmed free (< 2 TB) accounts are hidden when `proOnly` is true; unverified accounts
 * remain selectable so they can be checked automatically upon sign-in.
 */
export function getAccountDiscoverySummary({
  proOnly = true,
  tiersFile = TIERS_FILE,
  accountFile = ACCOUNT_FILE,
  rawAccounts = null,
} = {}) {
  const tiers = readAccountTiers(tiersFile);
  const raw = Array.isArray(rawAccounts) ? rawAccounts : discoverRawBrowserGoogleAccounts({ accountFile });
  const enriched = raw.map((item) => {
    const key = String(item.email || '').trim().toLowerCase();
    const cached = tiers[key] || null;
    const tier = cached?.tier || 'unknown';
    const isPro = cached ? Boolean(cached.isPro) : null;
    return {
      ...item,
      tier,
      isPro,
      storageLabel: cached?.storageLabel || null,
      storageLimitBytes: cached?.limitBytes ?? null,
    };
  });

  const hiddenNonProCount = proOnly ? enriched.filter((a) => a.tier === 'free').length : 0;
  const visible = proOnly ? enriched.filter((a) => a.tier !== 'free') : enriched;

  visible.sort((a, b) => {
    if (a.configuredInDsh !== b.configuredInDsh) return a.configuredInDsh ? -1 : 1;
    const aPro = a.tier === 'pro';
    const bPro = b.tier === 'pro';
    if (aPro !== bPro) return aPro ? -1 : 1;
    if (a.gcloudAuthed !== b.gcloudAuthed) return a.gcloudAuthed ? -1 : 1;
    const aFree = a.tier === 'free';
    const bFree = b.tier === 'free';
    if (aFree !== bFree) return aFree ? 1 : -1;
    return a.email.localeCompare(b.email);
  });

  const accounts = visible.map((item, idx) => ({
    index: idx + 1,
    ...item,
  }));

  return {
    accounts,
    hiddenNonProCount,
    proCount: enriched.filter((a) => a.tier === 'pro').length,
    unverifiedCount: enriched.filter((a) => a.tier === 'unknown').length,
  };
}

export function discoverBrowserGoogleAccounts(options = {}) {
  return getAccountDiscoverySummary(options).accounts;
}

export async function refreshAuthedAccountTiers({
  force = false,
  tiersFile = TIERS_FILE,
  accountFile = ACCOUNT_FILE,
  prober = probeAccountProStatus,
} = {}) {
  const tiers = readAccountTiers(tiersFile);
  const raw = discoverRawBrowserGoogleAccounts({ accountFile });
  const saved = readSavedWorkspaceAccount(accountFile);
  const candidates = new Set(raw.filter((a) => a.gcloudAuthed).map((a) => a.email));
  if (saved?.account) candidates.add(saved.account);

  const results = [];
  for (const email of candidates) {
    const key = email.toLowerCase();
    if (!force && tiers[key] && tiers[key].tier && tiers[key].tier !== 'unknown') {
      continue;
    }
    results.push(await prober(email, { tiersFile, accountFile }));
  }
  return results;
}

/**
 * Append `authuser=<email>` (for Google Cloud / Google web URLs) or `login_hint=<email>`
 * (for OAuth URLs) so multi-account browsers never default to the wrong signed-in Google user.
 */
export function buildGoogleAccountUrl(rawUrl, email) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !cleanEmail.includes('@')) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (/\.google\.com$/i.test(parsed.hostname)) {
      if (parsed.pathname.startsWith('/o/oauth2')) {
        if (!parsed.searchParams.has('login_hint')) parsed.searchParams.set('login_hint', cleanEmail);
      } else if (!parsed.searchParams.has('authuser')) {
        parsed.searchParams.set('authuser', cleanEmail);
      }
      return parsed.toString();
    }
  } catch {}
  return rawUrl;
}

/**
 * Open a URL in the user's exact logged-in browser profile (Brave, Edge, Chrome)
 * with `authuser=<email>` so Google never switches to another logged-in account.
 */
export function openInAccountBrowser(url, accountObj = null) {
  const targetUrl = buildGoogleAccountUrl(url, accountObj?.email);
  try {
    if (accountObj?.browserExe && fs.existsSync(accountObj.browserExe)) {
      const args = [
        `--profile-directory=${accountObj.profileDir || 'Default'}`,
        targetUrl,
      ];
      const child = spawn(accountObj.browserExe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return { opened: true, browser: accountObj.primaryBrowser, profileDir: accountObj.profileDir, url: targetUrl };
    }

    const defs = getBrowserDefinitions();
    const preferred = accountObj?.primaryBrowser
      ? defs.filter((b) => b.name.toLowerCase() === accountObj.primaryBrowser.toLowerCase())
      : [];
    for (const b of [...preferred, ...defs]) {
      const exe = findExistingExe(b.exeCandidates);
      if (exe) {
        const args = [
          ...(accountObj?.profileDir ? [`--profile-directory=${accountObj.profileDir}`] : []),
          targetUrl,
        ];
        const child = spawn(exe, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        return { opened: true, browser: b.name, profileDir: accountObj?.profileDir || 'Default', url: targetUrl };
      }
    }

    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' }).unref();
      return { opened: true, browser: 'System', profileDir: 'Default', url: targetUrl };
    }
  } catch {}
  return { opened: false, browser: null, profileDir: null, url: targetUrl };
}

/**
 * Run `gcloud auth login` and open the OAuth URL directly in the selected
 * browser + profile where the chosen Google account is already signed in.
 */
export async function authorizeGoogleAccount(accountObj, onLog = console.log) {
  const email = accountObj?.email || '';
  const browserLabel = accountObj?.primaryBrowser && accountObj.primaryBrowser !== 'gcloud'
    ? `${accountObj.primaryBrowser} (${accountObj.profileDir || 'Default'})`
    : 'Browser';

  onLog(`Opening Google sign-in for ${email || 'new account'} in ${browserLabel}...`);

  const g = findGcloudEnv();
  const loginArgs = [
    ...g.prefixArgs,
    'auth',
    'login',
    ...(email ? [email] : []),
    '--enable-gdrive-access',
    '--brief',
    '--quiet',
  ];

  // If we know the exact browser executable and profile directory, pass it via
  // BROWSER env or intercept the URL so gcloud opens the right browser.
  const customEnv = { ...g.env };
  const useShell = process.platform === 'win32' && /\.cmd$/i.test(g.cmd);

  return new Promise((resolve) => {
    const child = spawn(g.cmd, loginArgs, {
      env: customEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });

    let combined = '';
    let urlOpenedInCustomBrowser = false;

    const handleChunk = (chunk) => {
      const text = chunk.toString('utf8');
      combined += text;
      const match = combined.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/);
      if (match && !urlOpenedInCustomBrowser && accountObj?.browserExe) {
        urlOpenedInCustomBrowser = true;
        openInAccountBrowser(match[0], accountObj);
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('close', (code) => {
      if (code === 0) {
        const activeRes = runGcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)', '--quiet']);
        const activeEmail = activeRes.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || email;
        resolve({ ok: true, email: activeEmail });
      } else {
        resolve({ ok: false, error: combined.trim() || `Exit code ${code}` });
      }
    });
  });
}

/**
 * Ensure a Google Cloud project exists and is selected.
 */
export function ensureGcpProject(email, preferredProjectId = null, onLog = console.log) {
  const currentProj = runGcloud(['config', 'get-value', 'project', '--quiet']);
  const currentId = currentProj.stdout.trim();

  const listRes = runGcloud(['projects', 'list', '--format=json', '--quiet'], { timeoutMs: 25000 });
  let projects = [];
  if (listRes.ok && listRes.stdout) {
    try {
      projects = JSON.parse(listRes.stdout).filter((p) => p.lifecycleState === 'ACTIVE');
    } catch {}
  }

  let chosenId = null;
  if (preferredProjectId && projects.some((p) => p.projectId === preferredProjectId)) {
    chosenId = preferredProjectId;
  } else if (currentId && currentId !== '(unset)' && projects.some((p) => p.projectId === currentId)) {
    chosenId = currentId;
  } else {
    const freepiProj = projects.find((p) => /freepi|dsh/i.test(p.projectId));
    if (freepiProj) {
      chosenId = freepiProj.projectId;
    } else if (projects.length > 0) {
      chosenId = projects[0].projectId;
    }
  }

  if (!chosenId) {
    const prefix = String(email || 'user')
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10) || 'user';
    const suffix = Math.floor(1000 + Math.random() * 9000);
    chosenId = `freepi-${prefix}-${suffix}`;
    onLog(`Creating new Google Cloud project: ${chosenId} ...`);
    const createRes = runGcloud(['projects', 'create', chosenId, '--name=FreePi Cloud', '--quiet'], {
      timeoutMs: 45000,
    });
    if (!createRes.ok) {
      // If Terms of Service have never been accepted on Google Cloud Console yet:
      return {
        ok: false,
        needsConsoleTos: true,
        projectId: chosenId,
        error: createRes.stderr || createRes.stdout,
      };
    }
  }

  runGcloud(['config', 'set', 'project', chosenId, '--quiet']);
  return { ok: true, projectId: chosenId, projectsCount: projects.length };
}

export function enableGoogleDriveApi(projectId, onLog = console.log) {
  onLog('Enabling Google Drive API...');
  return runGcloud(['services', 'enable', 'drive.googleapis.com', `--project=${projectId}`, '--quiet'], {
    timeoutMs: 45000,
  });
}

/**
 * Enable Google Drive API and verify/create the DSH Workspace Artifacts folder.
 * Works WITHOUT a billing account!
 */
export async function setupGoogleDriveWorkspace(projectId, onLog = console.log) {
  onLog('Configuring Google Drive workspace folder and memory sync...');
  enableGoogleDriveApi(projectId, () => {});

  const dshGoogleModulePath = path.resolve(REPO_ROOT, '..', 'dsh-google', 'google.mjs');
  if (fs.existsSync(dshGoogleModulePath)) {
    try {
      const modUrl = new URL(`file:///${dshGoogleModulePath.replace(/\\/g, '/')}`).href;
      const gMod = await import(modUrl);
      if (typeof gMod.ensureArtifactsFolder === 'function') {
        const folder = await gMod.ensureArtifactsFolder();
        if (typeof gMod.syncMemoryNotes === 'function') {
          await gMod.syncMemoryNotes({ direction: 'both' });
        }
        return { ok: true, folderId: folder?.id || null };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, folderId: null };
}

/**
 * Check if billing is enabled on `projectId`. If not, try to link an existing
 * open billing account, or open the browser to the exact Google Cloud Billing /
 * Free Trial page and wait until the user activates it.
 */
export async function ensureCloudBillingAndDeploy({
  accountObj,
  projectId,
  deploy = false,
  rotateKey = false,
  waitForBrowserMs = 8 * 60 * 1000,
  onLog = console.log,
}) {
  const checkBilling = () => {
    const desc = runGcloud(['beta', 'billing', 'projects', 'describe', projectId, '--format=json', '--quiet']);
    if (desc.ok && desc.stdout) {
      try {
        const info = JSON.parse(desc.stdout);
        if (info.billingEnabled) return { enabled: true, billingAccountName: info.billingAccountName };
      } catch {}
    }
    const list = runGcloud(['beta', 'billing', 'accounts', 'list', '--filter=open=true', '--format=json', '--quiet']);
    if (list.ok && list.stdout) {
      try {
        const accounts = JSON.parse(list.stdout);
        if (Array.isArray(accounts) && accounts.length > 0) {
          const acctId = String(accounts[0].name || '').replace(/^billingAccounts\//, '');
          if (acctId) {
            const link = runGcloud([
              'beta',
              'billing',
              'projects',
              'link',
              projectId,
              `--billing-account=${acctId}`,
              '--quiet',
            ]);
            if (link.ok) {
              return { enabled: true, billingAccountName: accounts[0].name, autoLinked: true };
            }
          }
        }
      } catch {}
    }
    return { enabled: false };
  };

  let billing = checkBilling();
  if (!billing.enabled && deploy) {
    const setupUrl = buildGoogleAccountUrl(
      `https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(projectId)}`,
      accountObj?.email,
    );
    onLog('');
    onLog('======================================================================');
    onLog('GOOGLE CLOUD RUN NOT ENABLED YET - OPENING BROWSER');
    onLog('======================================================================');
    onLog(`Opening your browser (${accountObj?.primaryBrowser || 'Default'})`);
    onLog(`with account ${accountObj?.email || ''}:`);
    onLog(`  ${setupUrl}`);
    onLog('');
    onLog('In the opened browser tab, please briefly:');
    onLog('  1. Accept Terms of Service / enable billing (or Free Trial)');
    onLog('  2. Setup will detect it automatically and continue!');
    onLog('======================================================================');

    openInAccountBrowser(setupUrl, accountObj);

    const deadline = Date.now() + waitForBrowserMs;
    while (Date.now() < deadline) {
      await sleep(6000);
      billing = checkBilling();
      if (billing.enabled) {
        onLog('Google Cloud billing account detected and linked automatically! Continuing...');
        break;
      }
    }
  }

  if (!billing.enabled) {
    return {
      ok: false,
      billingEnabled: false,
      message:
        'Google Drive is ready! To deploy the 24/7 Cloud Run server, enable a billing account in the opened browser tab.',
    };
  }

  if (!deploy) {
    return { ok: true, billingEnabled: true };
  }

  const sanitized = sanitizeAccountsStoreForCloud();
  if (!sanitized.count || !sanitized.json) {
    return {
      ok: false,
      billingEnabled: true,
      error: 'No valid local Free-Pi accounts found. Run /freepi-add first.',
    };
  }

  onLog('Enabling Cloud Run, Cloud Build, Artifact Registry, and Secret Manager...');
  const apiRes = runGcloud(
    [
      'services',
      'enable',
      'run.googleapis.com',
      'cloudbuild.googleapis.com',
      'artifactregistry.googleapis.com',
      'secretmanager.googleapis.com',
      `--project=${projectId}`,
      '--quiet',
    ],
    { timeoutMs: 120000 },
  );
  if (!apiRes.ok) {
    return {
      ok: false,
      billingEnabled: true,
      error: `Failed to enable Google Cloud services: ${apiRes.stderr || apiRes.stdout}`,
    };
  }

  const apiKey = ensureCloudApiKey(rotateKey);
  onLog(`Uploading ${sanitized.count} Free-Pi account(s) and API key securely to Secret Manager...`);
  try {
    ensureSecretWithValue(projectId, 'freepi-accounts', sanitized.json);
    ensureSecretWithValue(projectId, 'freepi-proxy-api-key', apiKey);
    await grantSecretAccessToComputeSa(projectId, 'freepi-accounts');
    await grantSecretAccessToComputeSa(projectId, 'freepi-proxy-api-key');
  } catch (err) {
    return {
      ok: false,
      billingEnabled: true,
      error: err.message,
    };
  }

  const cloudRegion = process.env.FREEPI_CLOUD_REGION || 'us-central1';
  onLog(`Deploying freepi-proxy to Google Cloud Run (${cloudRegion}, Always-Free eligible, ~1-2 min)...`);
  const deployRes = runGcloud(
    [
      'run',
      'deploy',
      'freepi-proxy',
      '--source',
      REPO_ROOT,
      `--project=${projectId}`,
      `--region=${cloudRegion}`,
      '--allow-unauthenticated',
      '--port=8080',
      '--memory=512Mi',
      '--min-instances=0',
      '--max-instances=1',
      '--timeout=300',
      '--set-env-vars=FREEPI_ACCOUNTS_PATH=/tmp/freepi/accounts.json,FREEPI_ACCOUNTS_SEED_PATH=/secrets/accounts.json,FREEPI_STATE_DIR=/tmp/freepi,FREEPI_AUTO_SPONSOR=0',
      '--set-secrets=/secrets/accounts.json=freepi-accounts:latest,FREEPI_PROXY_API_KEY=freepi-proxy-api-key:latest',
      '--quiet',
    ],
    { timeoutMs: 360000 },
  );

  if (!deployRes.ok) {
    return {
      ok: false,
      billingEnabled: true,
      error: deployRes.stderr || deployRes.stdout,
    };
  }

  const urlRes = runGcloud([
    'run',
    'services',
    'describe',
    'freepi-proxy',
    `--project=${projectId}`,
    `--region=${cloudRegion}`,
    '--format=value(status.url)',
    '--quiet',
  ]);
  const serviceUrl = urlRes.stdout.trim();
  let verify = null;
  if (serviceUrl) {
    saveWorkspaceAccount({ projectId, cloudRunUrl: serviceUrl, cloudAccountsCount: sanitized.count });
    onLog('Verifying live endpoint and API key protection...');
    try {
      verify = await verifyCloudRunDeployment(serviceUrl, apiKey);
    } catch (err) {
      verify = { ok: false, error: err?.message || String(err) };
    }
  }

  return {
    ok: true,
    billingEnabled: true,
    cloudRunUrl: serviceUrl || null,
    cloudApiKey: apiKey,
    cloudAccountsCount: sanitized.count,
    verified: verify,
  };
}

/**
 * Full automatic setup flow for a selected account (by number, email, or 'new').
 * Verifies Google Pro (>= 2 TB Drive storage) before saving as the active account.
 */
export async function runGoogleCloudSetup({
  accountSelector = null,
  deploy = false,
  rotateKey = false,
  reauth = false,
  allowFree = false,
  includeAll = false,
  tiersFile = TIERS_FILE,
  accountFile = ACCOUNT_FILE,
  rawAccounts = null,
  prober = probeAccountProStatus,
  authorizeFn = authorizeGoogleAccount,
  ensureProjectFn = ensureGcpProject,
  enableDriveFn = enableGoogleDriveApi,
  setupDriveFn = setupGoogleDriveWorkspace,
  deployFn = ensureCloudBillingAndDeploy,
  setGcloudAccountFn = (email) => runGcloud(['config', 'set', 'account', email, '--quiet']),
  setGcloudProjectFn = (projectId) => runGcloud(['config', 'set', 'project', projectId, '--quiet']),
  revokeGcloudAccountFn = (email) => runGcloud(['auth', 'revoke', email, '--quiet'], { timeoutMs: 15000 }),
  onLog = console.log,
} = {}) {
  const proOnly = !includeAll && !allowFree;
  const discovery = getAccountDiscoverySummary({ proOnly, tiersFile, accountFile, rawAccounts });
  const accounts = discovery.accounts;
  const savedBefore = readSavedWorkspaceAccount(accountFile);
  let chosen = null;

  if (accountSelector && String(accountSelector).toLowerCase() !== 'new') {
    const sel = String(accountSelector).trim();
    const asNum = /^\d+$/.test(sel) ? Number(sel) : NaN;
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= accounts.length) {
      chosen = accounts[asNum - 1];
    } else {
      chosen =
        accounts.find((a) => a.email.toLowerCase() === sel.toLowerCase()) ||
        accounts.find((a) => a.email.toLowerCase().startsWith(sel.toLowerCase()));
      if (!chosen && sel.includes('@')) {
        chosen = {
          email: sel,
          fullName: '',
          primaryBrowser: 'Browser',
          browsers: [],
          browserExe: null,
          profileDir: 'Default',
          gcloudAuthed: false,
        };
      }
    }
  } else if (String(accountSelector).toLowerCase() === 'new') {
    chosen = {
      email: '',
      fullName: 'New Account',
      primaryBrowser: 'Browser',
      browsers: [],
      browserExe: null,
      profileDir: 'Default',
      gcloudAuthed: false,
    };
  }

  if (!chosen) {
    return {
      ok: false,
      needsSelection: true,
      accounts,
      hiddenNonProCount: discovery.hiddenNonProCount,
    };
  }

  // Reject already-cached non-Pro accounts immediately unless --allow-free is set
  const cachedTiers = readAccountTiers(tiersFile);
  const preKey = chosen.email ? chosen.email.toLowerCase() : '';
  if (!allowFree && preKey && cachedTiers[preKey]?.tier === 'free' && !reauth) {
    return {
      ok: false,
      notPro: true,
      account: chosen.email,
      tier: 'free',
      storageLabel: cachedTiers[preKey].storageLabel || '< 2 TB',
      error: `Account ${chosen.email} is not a Google Pro account (${cachedTiers[preKey].storageLabel || '< 2 TB'}; requires >= 2 TB). Pass --allow-free to override.`,
    };
  }

  // Step 1: Ensure gcloud OAuth login with Drive access
  if (!chosen.gcloudAuthed || reauth || !chosen.email) {
    const authRes = await authorizeFn(chosen, onLog);
    if (!authRes.ok) {
      return {
        ok: false,
        error: `Google sign-in failed: ${authRes.error}`,
      };
    }
    chosen.email = authRes.email;
    chosen.gcloudAuthed = true;
  } else {
    onLog(`Using already authenticated Google account: ${chosen.email}`);
    setGcloudAccountFn(chosen.email);
  }

  // Step 2: Ensure GCP Project (if TOS not accepted yet, open Console in that browser!)
  const preferredProject =
    savedBefore?.account && savedBefore.account.toLowerCase() === chosen.email.toLowerCase()
      ? savedBefore.projectId || null
      : null;
  let projRes = ensureProjectFn(chosen.email, preferredProject, onLog);
  if (!projRes.ok && projRes.needsConsoleTos) {
    const consoleUrl = buildGoogleAccountUrl('https://console.cloud.google.com/projectcreate', chosen.email);
    onLog('');
    onLog('First-time Google Cloud use detected for this account.');
    onLog(`Opening ${consoleUrl} in ${chosen.primaryBrowser || 'your browser'} (${chosen.email}).`);
    onLog('Please accept Terms of Service there - waiting to continue automatically...');
    openInAccountBrowser(consoleUrl, chosen);

    const tosDeadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < tosDeadline) {
      await sleep(6000);
      projRes = ensureProjectFn(chosen.email, preferredProject, onLog);
      if (projRes.ok) break;
    }
  }

  if (!projRes.ok) {
    if (savedBefore?.account && savedBefore.account.toLowerCase() !== chosen.email.toLowerCase()) {
      setGcloudAccountFn(savedBefore.account);
      if (savedBefore.projectId) setGcloudProjectFn(savedBefore.projectId);
    }
    return {
      ok: false,
      account: chosen.email,
      error: `Could not set up Google Cloud project: ${projRes.error}`,
    };
  }

  // Step 3: Enable Drive API and verify Google Pro tier (>= 2 TB) BEFORE overwriting active account.json
  enableDriveFn(projRes.projectId, onLog);
  onLog(`Checking Google Pro plan (>= 2 TB Drive storage) for ${chosen.email}...`);
  let proCheck = await prober(chosen.email, { tiersFile, accountFile });
  if (!proCheck.ok) {
    await sleep(2000);
    proCheck = await prober(chosen.email, { tiersFile, accountFile });
  }

  if (!allowFree) {
    if (proCheck.ok && !proCheck.isPro) {
      onLog(`Account ${chosen.email} has ${proCheck.storageLabel} storage (< 2 TB) -> NOT a Google Pro account.`);
      revokeGcloudAccountFn(chosen.email);
      if (savedBefore?.account && savedBefore.account.toLowerCase() !== chosen.email.toLowerCase()) {
        setGcloudAccountFn(savedBefore.account);
        if (savedBefore.projectId) setGcloudProjectFn(savedBefore.projectId);
      }
      return {
        ok: false,
        notPro: true,
        account: chosen.email,
        tier: proCheck.tier,
        storageLabel: proCheck.storageLabel,
        error: `Account ${chosen.email} is not a Google Pro account (${proCheck.storageLabel} < 2 TB). Excluded from Pro list; previous setup kept.`,
      };
    }
    if (!proCheck.ok) {
      if (savedBefore?.account && savedBefore.account.toLowerCase() !== chosen.email.toLowerCase()) {
        setGcloudAccountFn(savedBefore.account);
        if (savedBefore.projectId) setGcloudProjectFn(savedBefore.projectId);
      }
      return {
        ok: false,
        account: chosen.email,
        error: `Could not verify Google Pro status for ${chosen.email}: ${proCheck.error}`,
      };
    }
    onLog(`Verified Google Pro account: ${chosen.email} (${proCheck.storageLabel}).`);
  }

  saveWorkspaceAccount(
    {
      account: chosen.email,
      browser: chosen.primaryBrowser || 'Browser',
      profileDir: chosen.profileDir || 'Default',
      projectId: projRes.projectId,
      authorizedAt: new Date().toISOString(),
      isPro: proCheck.ok ? proCheck.isPro : null,
      tier: proCheck.ok ? proCheck.tier : 'unknown',
      storageLabel: proCheck.ok ? proCheck.storageLabel : null,
      storageLimitBytes: proCheck.ok ? proCheck.limitBytes : null,
    },
    accountFile,
  );
  onLog(`Active Google Cloud project: ${projRes.projectId}`);

  // Step 4: Initialize Google Drive Workspace artifacts folder & memory sync
  const driveRes = await setupDriveFn(projRes.projectId, onLog);

  // Step 5: Billing & Cloud Run deployment (only when explicitly requested with --deploy)
  const cloudRes = deploy
    ? await deployFn({
        accountObj: chosen,
        projectId: projRes.projectId,
        deploy,
        rotateKey,
        onLog,
      })
    : { ok: true, billingEnabled: false, message: null };

  if (deploy && !cloudRes.ok && cloudRes.error) {
    return {
      ok: false,
      account: chosen.email,
      projectId: projRes.projectId,
      isPro: proCheck.ok ? proCheck.isPro : null,
      tier: proCheck.ok ? proCheck.tier : 'unknown',
      storageLabel: proCheck.ok ? proCheck.storageLabel : null,
      driveReady: driveRes.ok,
      billingEnabled: Boolean(cloudRes.billingEnabled),
      error: cloudRes.error,
    };
  }

  const savedAfter = readSavedWorkspaceAccount(accountFile);
  return {
    ok: true,
    account: chosen.email,
    browser: chosen.primaryBrowser,
    projectId: projRes.projectId,
    isPro: proCheck.ok ? proCheck.isPro : savedAfter?.isPro ?? null,
    tier: proCheck.ok ? proCheck.tier : savedAfter?.tier ?? 'unknown',
    storageLabel: proCheck.ok ? proCheck.storageLabel : savedAfter?.storageLabel ?? null,
    driveReady: driveRes.ok,
    driveFolderId: driveRes.folderId || null,
    billingEnabled: Boolean(cloudRes.billingEnabled),
    cloudRunUrl: cloudRes.cloudRunUrl || savedAfter?.cloudRunUrl || null,
    cloudApiKey: cloudRes.cloudApiKey || null,
    cloudAccountsCount: cloudRes.cloudAccountsCount || savedAfter?.cloudAccountsCount || null,
    verified: cloudRes.verified || null,
    message: cloudRes.message || null,
  };
}

export function formatCloudStatusAndAccounts({ includeAll = false, tiersFile = TIERS_FILE, accountFile = ACCOUNT_FILE } = {}) {
  const { accounts, hiddenNonProCount } = getAccountDiscoverySummary({ proOnly: !includeAll, tiersFile, accountFile });
  const saved = readSavedWorkspaceAccount(accountFile);
  const lines = [
    'Google Pro Cloud & Drive Auto-Setup (/freepi-cloud)',
    '',
  ];

  if (saved?.account) {
    const tierNote = saved.storageLabel
      ? ` (${saved.isPro ? 'PRO' : 'Free'} ${saved.storageLabel})`
      : '';
    lines.push(`Connected account: ${saved.account}${tierNote}`);
    if (saved.projectId) lines.push(`Cloud project:     ${saved.projectId}`);
    if (saved.cloudRunUrl) lines.push(`24/7 Cloud URL:    ${saved.cloudRunUrl}`);
    if (saved.cloudApiKey) lines.push('API key:           saved in ~/.dsh/google-workspace/account.json');
    lines.push('');
  } else {
    lines.push('No Google Pro account configured yet.');
    lines.push('');
  }

  if (accounts.length === 0) {
    lines.push('No eligible Google accounts found in Brave/Edge/Chrome.');
    if (hiddenNonProCount > 0) {
      lines.push(`Hidden non-Pro accounts (< 2 TB): ${hiddenNonProCount} (run "/freepi-cloud list --all" to view all).`);
    }
    lines.push('Sign in a Pro account with: /freepi-cloud new');
    return lines.join('\n');
  }

  lines.push(includeAll
    ? 'Google accounts from browsers (Brave / Edge / Chrome) [all]:'
    : 'Google accounts from browsers (Pro-only mode, >= 2 TB verified on connect):');
  for (const a of accounts) {
    const browsers = a.browsers.length ? a.browsers.join(', ') : 'gcloud';
    const tierTag = a.tier === 'pro'
      ? `PRO ${a.storageLabel || '>= 2 TB'}`
      : a.tier === 'free'
        ? `NOT PRO (${a.storageLabel || '< 2 TB'})`
        : 'unverified - checked on connect';
    const flags = [
      a.configuredInDsh ? 'ACTIVE' : null,
      tierTag,
      a.gcloudAuthed ? 'authed' : 'browser sign-in required',
    ]
      .filter(Boolean)
      .join(', ');
    const namePart = a.fullName ? ` (${a.fullName})` : '';
    lines.push(`  [${a.index}] ${a.email}${namePart}  --  ${browsers} [${flags}]`);
  }

  if (hiddenNonProCount > 0) {
    lines.push('');
    lines.push(`Hidden confirmed non-Pro account(s) (< 2 TB): ${hiddenNonProCount} (use "/freepi-cloud list --all" to inspect).`);
  }

  lines.push('');
  lines.push('Connect Google Drive (verifies Pro >= 2 TB automatically):');
  lines.push('  /freepi-cloud 1          (connects account #1 and verifies Pro quota)');
  lines.push('  /freepi-cloud 2          (connects account #2)');
  lines.push('  /freepi-cloud new        (sign in a new Google Pro account in browser)');
  lines.push('  /freepi-cloud deploy     (deploy 24/7 Cloud Run server; requires billing)');

  return lines.join('\n');
}

export function parseCloudCliArgs(args = []) {
  const wantsJson = args.includes('--json');
  let wantsList = args.includes('--list');
  let wantsDeploy = args.includes('--deploy');
  const rotateKey = args.includes('--rotate-key');
  const reauth = args.includes('--reauth');

  let accountArg = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--account' && args[i + 1]) {
      accountArg = args[i + 1];
      i += 1;
    } else if (!arg.startsWith('--')) {
      const lower = arg.toLowerCase();
      if (lower === 'deploy') wantsDeploy = true;
      else if (lower === 'status' || lower === 'list') wantsList = true;
      else if (!accountArg) accountArg = arg;
    }
  }

  return { wantsJson, wantsList, wantsDeploy, rotateKey, reauth, accountArg };
}

export function parseExtraCloudFlags(args = []) {
  return {
    showAll: args.includes('--all'),
    allowFree: args.includes('--allow-free'),
    refreshTiers: args.includes('--refresh'),
  };
}

// --------------------------------------------------------- CLI Entrypoint

async function main() {
  const argv = process.argv.slice(2);
  const {
    wantsJson,
    wantsList,
    wantsDeploy,
    rotateKey,
    reauth,
    accountArg: parsedAccountArg,
  } = parseCloudCliArgs(argv);
  const { showAll, allowFree, refreshTiers } = parseExtraCloudFlags(argv);
  let accountArg = parsedAccountArg;

  if (wantsList || refreshTiers) {
    await refreshAuthedAccountTiers({ force: refreshTiers }).catch(() => {});
  }

  if (wantsList) {
    const summary = getAccountDiscoverySummary({ proOnly: !showAll });
    if (wantsJson) {
      const saved = readSavedWorkspaceAccount();
      const safeSaved = saved
        ? { ...saved, ...(saved.cloudApiKey ? { cloudApiKey: '[saved]' } : {}) }
        : null;
      console.log(JSON.stringify({ saved: safeSaved, ...summary }, null, 2));
    } else {
      console.log(formatCloudStatusAndAccounts({ includeAll: showAll }));
    }
    return;
  }

  if (!accountArg && wantsDeploy) {
    const saved = readSavedWorkspaceAccount();
    if (saved?.account) accountArg = saved.account;
  }

  if (!accountArg && process.stdin.isTTY && !wantsJson) {
    await refreshAuthedAccountTiers().catch(() => {});
    console.log('');
    console.log(formatCloudStatusAndAccounts({ includeAll: showAll }));
    console.log('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    accountArg = await new Promise((resolve) => {
      rl.question('Select Google Pro account (number, email, or "new"): ', (ans) => {
        rl.close();
        resolve(ans.trim() || '1');
      });
    });
  }

  if (!accountArg) {
    if (wantsJson) {
      console.log(JSON.stringify({ ok: false, needsSelection: true, ...getAccountDiscoverySummary({ proOnly: !showAll }) }, null, 2));
    } else {
      console.log(formatCloudStatusAndAccounts({ includeAll: showAll }));
    }
    return;
  }

  const logs = [];
  const logger = wantsJson ? (msg) => logs.push(msg) : console.log;
  const result = await runGoogleCloudSetup({
    accountSelector: accountArg,
    deploy: wantsDeploy,
    rotateKey,
    reauth,
    allowFree,
    includeAll: showAll,
    onLog: logger,
  });

  if (wantsJson) {
    const safeResult = {
      ...result,
      ...(result.cloudApiKey ? { cloudApiKey: '[saved]' } : {}),
    };
    console.log(JSON.stringify({ ...safeResult, logs }, null, 2));
  } else {
    console.log('');
    if (result.ok) {
      console.log('======================================================================');
      console.log('SETUP COMPLETE!');
      console.log(`  Google Account:    ${result.account}${result.storageLabel ? ` (${result.isPro ? 'PRO' : 'Free'} ${result.storageLabel})` : ''}`);
      console.log(`  Cloud Project:     ${result.projectId}`);
      console.log(`  Google Drive Sync: ${result.driveReady ? 'Active (context & handoffs ready)' : 'Ready'}`);
      if (result.cloudRunUrl) {
        console.log(`  24/7 Cloud URL:    ${result.cloudRunUrl}/v1`);
        if (result.cloudApiKey) {
          console.log(`  API Key:           ${result.cloudApiKey}`);
        }
        if (result.cloudAccountsCount) {
          console.log(`  Cloud Accounts:    ${result.cloudAccountsCount} active`);
        }
        if (result.verified) {
          console.log(
            `  Security Check:    ${result.verified.ok ? 'OK (401 unauth, 200 with key)' : `Health ${result.verified.healthStatus}, unauth ${result.verified.unauthStatus}, auth ${result.verified.authStatus}`}`,
          );
        }
      } else if (result.message) {
        console.log(`  Note:              ${result.message}`);
      }
      console.log('======================================================================');
    } else {
      console.error(`Error: ${result.error || 'Unknown error'}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
