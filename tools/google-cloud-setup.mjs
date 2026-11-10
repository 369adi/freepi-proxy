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

export function readSavedWorkspaceAccount() {
  return safeReadJson(ACCOUNT_FILE);
}

export function saveWorkspaceAccount(patch) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  const current = safeReadJson(ACCOUNT_FILE) || {};
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Discover all Google accounts logged into Brave, Edge, Chrome, Vivaldi,
 * plus any accounts already authenticated in gcloud.
 */
export function discoverBrowserGoogleAccounts() {
  const byEmail = new Map();
  const gcloudMap = getGcloudAuthedAccounts();
  const saved = readSavedWorkspaceAccount();
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

  const list = Array.from(byEmail.values()).sort((a, b) => {
    if (a.configuredInDsh !== b.configuredInDsh) return a.configuredInDsh ? -1 : 1;
    if (a.gcloudAuthed !== b.gcloudAuthed) return a.gcloudAuthed ? -1 : 1;
    return a.email.localeCompare(b.email);
  });

  return list.map((item, idx) => ({
    index: idx + 1,
    ...item,
  }));
}

/**
 * Open a URL in the user's exact logged-in browser profile (Brave, Edge, Chrome)
 * so they don't have to log in again or switch accounts manually.
 */
export function openInAccountBrowser(url, accountObj = null) {
  try {
    if (accountObj?.browserExe && fs.existsSync(accountObj.browserExe)) {
      const args = [
        `--profile-directory=${accountObj.profileDir || 'Default'}`,
        url,
      ];
      const child = spawn(accountObj.browserExe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return { opened: true, browser: accountObj.primaryBrowser, profileDir: accountObj.profileDir };
    }

    for (const b of getBrowserDefinitions()) {
      const exe = findExistingExe(b.exeCandidates);
      if (exe) {
        const child = spawn(exe, [url], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        return { opened: true, browser: b.name, profileDir: 'Default' };
      }
    }

    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      return { opened: true, browser: 'System', profileDir: 'Default' };
    }
  } catch {}
  return { opened: false, browser: null, profileDir: null };
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

  onLog(`Oeffne Google-Anmeldung fuer ${email || 'neuen Account'} in ${browserLabel}...`);

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
    onLog(`Erstelle neues Google Cloud Projekt: ${chosenId} ...`);
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

/**
 * Enable Google Drive API and verify/create the DSH Workspace Artifacts folder.
 * Works WITHOUT a billing account!
 */
export async function setupGoogleDriveWorkspace(projectId, onLog = console.log) {
  onLog('Aktiviere Google Drive Schnittstelle fuer Cloud-Kontext & Handysynchronisation...');
  runGcloud(['services', 'enable', 'drive.googleapis.com', `--project=${projectId}`, '--quiet'], {
    timeoutMs: 45000,
  });

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
    const setupUrl = `https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(projectId)}`;
    onLog('');
    onLog('======================================================================');
    onLog('GOOGLE CLOUD RUN NOCH NICHT AKTIVIERT - BROWSER WIRD GEOEFFNET');
    onLog('======================================================================');
    onLog(`Ich oeffne jetzt automatisch deinen Browser (${accountObj?.primaryBrowser || 'Standard'})`);
    onLog(`mit dem Account ${accountObj?.email || ''}:`);
    onLog(`  ${setupUrl}`);
    onLog('');
    onLog('Bitte im geoeffneten Browserfenster einmal kurz:');
    onLog('  1. Nutzungsbedingungen akzeptieren / Rechnungskonto (Free Trial) aktivieren');
    onLog('  2. Ich erkenne das automatisch und mache hier sofort alleine weiter!');
    onLog('======================================================================');

    openInAccountBrowser(setupUrl, accountObj);

    const deadline = Date.now() + waitForBrowserMs;
    while (Date.now() < deadline) {
      await sleep(6000);
      billing = checkBilling();
      if (billing.enabled) {
        onLog('Google Cloud Rechnungskonto erkannt und automatisch verknuepft! Mache weiter...');
        break;
      }
    }
  }

  if (!billing.enabled) {
    return {
      ok: false,
      billingEnabled: false,
      message:
        'Google Drive (Cloud-Kontext & Handy-Uebergabe) ist fertig eingerichtet! Fuer 24/7 Cloud Run Server muss im geoeffneten Browser noch einmalig das Google Cloud Konto aktiviert werden.',
    };
  }

  if (!deploy) {
    return { ok: true, billingEnabled: true };
  }

  onLog('Aktiviere Cloud Run, Cloud Build und Artifact Registry...');
  runGcloud(
    [
      'services',
      'enable',
      'run.googleapis.com',
      'cloudbuild.googleapis.com',
      'artifactregistry.googleapis.com',
      `--project=${projectId}`,
      '--quiet',
    ],
    { timeoutMs: 120000 },
  );

  onLog('Starte automatisches Deployment von freepi-proxy auf Google Cloud Run (dauert ca. 1-2 Min)...');
  const deployRes = runGcloud(
    [
      'run',
      'deploy',
      'freepi-proxy',
      '--source',
      REPO_ROOT,
      `--project=${projectId}`,
      '--region=europe-west1',
      '--allow-unauthenticated',
      '--port=8080',
      '--memory=512Mi',
      '--min-instances=0',
      '--max-instances=1',
      '--quiet',
    ],
    { timeoutMs: 300000 },
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
    '--region=europe-west1',
    '--format=value(status.url)',
    '--quiet',
  ]);
  const serviceUrl = urlRes.stdout.trim();
  if (serviceUrl) {
    saveWorkspaceAccount({ projectId, cloudRunUrl: serviceUrl });
  }

  return {
    ok: true,
    billingEnabled: true,
    cloudRunUrl: serviceUrl || null,
  };
}

/**
 * Full automatic setup flow for a selected account (by number, email, or 'new').
 */
export async function runGoogleCloudSetup({
  accountSelector = null,
  deploy = true,
  reauth = false,
  onLog = console.log,
} = {}) {
  const accounts = discoverBrowserGoogleAccounts();
  let chosen = null;

  if (accountSelector && String(accountSelector).toLowerCase() !== 'new') {
    const sel = String(accountSelector).trim();
    const asNum = Number(sel);
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
      fullName: 'Neuer Account',
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
    };
  }

  // Step 1: Ensure gcloud OAuth login with Drive access
  if (!chosen.gcloudAuthed || reauth || !chosen.email) {
    const authRes = await authorizeGoogleAccount(chosen, onLog);
    if (!authRes.ok) {
      return {
        ok: false,
        error: `Google-Anmeldung fehlgeschlagen: ${authRes.error}`,
      };
    }
    chosen.email = authRes.email;
    chosen.gcloudAuthed = true;
  } else {
    onLog(`Nutze bereits verbundenen Google-Account: ${chosen.email}`);
    runGcloud(['config', 'set', 'account', chosen.email, '--quiet']);
  }

  saveWorkspaceAccount({
    account: chosen.email,
    browser: chosen.primaryBrowser || 'Browser',
    profileDir: chosen.profileDir || 'Default',
    authorizedAt: new Date().toISOString(),
  });

  // Step 2: Ensure GCP Project (if TOS not accepted yet, open Console in that browser!)
  let projRes = ensureGcpProject(chosen.email, null, onLog);
  if (!projRes.ok && projRes.needsConsoleTos) {
    const consoleUrl = 'https://console.cloud.google.com/projectcreate';
    onLog('');
    onLog('Google Cloud wird zum ersten Mal mit diesem Account genutzt.');
    onLog(`Ich oeffne jetzt ${consoleUrl} in ${chosen.primaryBrowser || 'deinem Browser'} (${chosen.email}).`);
    onLog('Bitte dort einmal den Nutzungsbedingungen zustimmen - ich warte und mache automatisch weiter...');
    openInAccountBrowser(consoleUrl, chosen);

    const tosDeadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < tosDeadline) {
      await sleep(6000);
      projRes = ensureGcpProject(chosen.email, null, onLog);
      if (projRes.ok) break;
    }
  }

  if (!projRes.ok) {
    return {
      ok: false,
      account: chosen.email,
      error: `Konnte Google Cloud Projekt nicht einrichten: ${projRes.error}`,
    };
  }

  saveWorkspaceAccount({ projectId: projRes.projectId });
  onLog(`Aktives Google Cloud Projekt: ${projRes.projectId}`);

  // Step 3: Enable Google Drive API & Workspace folder (always free, no billing required)
  const driveRes = await setupGoogleDriveWorkspace(projRes.projectId, onLog);

  // Step 4: Billing & Cloud Run deployment (if requested)
  const cloudRes = await ensureCloudBillingAndDeploy({
    accountObj: chosen,
    projectId: projRes.projectId,
    deploy,
    onLog,
  });

  return {
    ok: true,
    account: chosen.email,
    browser: chosen.primaryBrowser,
    projectId: projRes.projectId,
    driveReady: driveRes.ok,
    driveFolderId: driveRes.folderId || null,
    billingEnabled: Boolean(cloudRes.billingEnabled),
    cloudRunUrl: cloudRes.cloudRunUrl || readSavedWorkspaceAccount()?.cloudRunUrl || null,
    message: cloudRes.message || null,
  };
}

export function formatCloudStatusAndAccounts() {
  const accounts = discoverBrowserGoogleAccounts();
  const saved = readSavedWorkspaceAccount();
  const lines = [
    'Google Cloud & Drive Auto-Setup (/freepi-cloud)',
    '',
  ];

  if (saved?.account) {
    lines.push(`Aktuell verbunden: ${saved.account}`);
    if (saved.projectId) lines.push(`Cloud-Projekt:     ${saved.projectId}`);
    if (saved.cloudRunUrl) lines.push(`24/7 Cloud-URL:    ${saved.cloudRunUrl}`);
    lines.push('');
  } else {
    lines.push('Aktuell ist noch kein Google-Account fest eingerichtet.');
    lines.push('');
  }

  if (accounts.length === 0) {
    lines.push('Keine eingeloggten Google-Accounts in Brave/Edge/Chrome gefunden.');
    lines.push('Starte mit: /freepi-cloud new');
    return lines.join('\n');
  }

  lines.push('Gefundene Google-Accounts aus deinen Browsern (Brave / Edge / Chrome):');
  for (const a of accounts) {
    const browsers = a.browsers.length ? a.browsers.join(', ') : 'gcloud';
    const flags = [
      a.configuredInDsh ? 'AKTIV' : null,
      a.gcloudAuthed ? 'verbunden' : 'Klick im Browser noetig',
    ]
      .filter(Boolean)
      .join(', ');
    const namePart = a.fullName ? ` (${a.fullName})` : '';
    lines.push(`  [${a.index}] ${a.email}${namePart}  —  ${browsers} [${flags}]`);
  }

  lines.push('');
  lines.push('So richtest du Google Drive + Google Cloud automatisch ein:');
  lines.push('  /freepi-cloud 1          (nimmt Account Nr. 1 und richtet alles automatisch ein)');
  lines.push('  /freepi-cloud 2          (nimmt Account Nr. 2)');
  lines.push('  /freepi-cloud new        (neuen Google-Account im Browser anmelden)');
  lines.push('  /freepi-cloud 1 --drive  (richtet nur Google Drive Cloud-Kontext ohne Cloud Run ein)');

  return lines.join('\n');
}

// --------------------------------------------------------- CLI Entrypoint

async function main() {
  const args = process.argv.slice(2);
  const wantsJson = args.includes('--json');
  const wantsList = args.includes('--list');
  const driveOnly = args.includes('--drive') || args.includes('--no-deploy');
  const reauth = args.includes('--reauth');

  let accountArg = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--account' && args[i + 1]) {
      accountArg = args[i + 1];
      i += 1;
    } else if (!args[i].startsWith('--') && !accountArg) {
      accountArg = args[i];
    }
  }

  if (wantsList) {
    const accounts = discoverBrowserGoogleAccounts();
    if (wantsJson) {
      console.log(JSON.stringify({ saved: readSavedWorkspaceAccount(), accounts }, null, 2));
    } else {
      console.log(formatCloudStatusAndAccounts());
    }
    return;
  }

  if (!accountArg && process.stdin.isTTY && !wantsJson) {
    console.log('');
    console.log(formatCloudStatusAndAccounts());
    console.log('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    accountArg = await new Promise((resolve) => {
      rl.question('Welchen Google-Account moechtest du nutzen? (Nummer, E-Mail oder "new"): ', (ans) => {
        rl.close();
        resolve(ans.trim() || '1');
      });
    });
  }

  if (!accountArg) {
    if (wantsJson) {
      console.log(JSON.stringify({ ok: false, needsSelection: true, accounts: discoverBrowserGoogleAccounts() }, null, 2));
    } else {
      console.log(formatCloudStatusAndAccounts());
    }
    return;
  }

  const logs = [];
  const logger = wantsJson ? (msg) => logs.push(msg) : console.log;
  const result = await runGoogleCloudSetup({
    accountSelector: accountArg,
    deploy: !driveOnly,
    reauth,
    onLog: logger,
  });

  if (wantsJson) {
    console.log(JSON.stringify({ ...result, logs }, null, 2));
  } else {
    console.log('');
    if (result.ok) {
      console.log('======================================================================');
      console.log('FERTIG EINGERICHTET!');
      console.log(`  Google-Account:   ${result.account}`);
      console.log(`  Cloud-Projekt:    ${result.projectId}`);
      console.log(`  Google Drive Sync: ${result.driveReady ? 'Aktiv (Kontext & Handy-Handoff bereit)' : 'Bereit'}`);
      if (result.cloudRunUrl) {
        console.log(`  24/7 Cloud-URL:   ${result.cloudRunUrl}`);
      } else if (result.message) {
        console.log(`  Hinweis:          ${result.message}`);
      }
      console.log('======================================================================');
    } else {
      console.error(`Fehler: ${result.error || 'Unbekannter Fehler'}`);
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
