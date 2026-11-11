import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL('../../', import.meta.url));
const prefix = path.join(root, 'runtime', 'freepi-cli');
const vendorPkg = path.join(root, 'vendor', 'free-pi-cli', 'package.json');
const runtimePkg = path.join(prefix, 'node_modules', 'free-pi-cli', 'package.json');
const stateFile = path.join(prefix, 'update-state.json');
const logFile = path.join(root, 'logs', 'client-update.log');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
let cachedVersion = null;
let updating = null;

function compareSemver(a, b) {
  if (!SEMVER_RE.test(String(a || '')) || !SEMVER_RE.test(String(b || ''))) return 0;
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function readVersionFromDisk() {
  for (const candidate of [runtimePkg, vendorPkg]) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const v = data?.version;
      if (SEMVER_RE.test(v)) return v;
    } catch {}
  }
  throw new Error('No installed official free-pi-cli package found');
}

export function getClientVersion() {
  if (!cachedVersion) cachedVersion = readVersionFromDisk();
  return cachedVersion;
}

export function syncClientVersionFromCatalog(catalogData) {
  if (!catalogData || typeof catalogData !== 'object') return getClientVersion();
  const current = getClientVersion();
  let next = current;
  for (const cand of [catalogData.latest, catalogData.min]) {
    if (SEMVER_RE.test(String(cand || '')) && compareSemver(cand, next) > 0) {
      next = String(cand);
    }
  }
  if (next !== current) upgradeClient(next).catch(error => log('Client update failed: ' + error.message));
  return current;
}

export function requiredVersion(error) {
  return error?.minimum_version || error?.min_version || error?.required_version ||
    /(?:minimum|required)[^0-9]{0,20}(\d+\.\d+\.\d+)/i.exec(error?.message || error?.error?.message || '')?.[1] || null;
}

export function runtimeStatus() {
  return { version: getClientVersion(), updating: !!updating, restartPending: false };
}

function log(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + message + '\n');
  } catch {}
}

export function upgradeClient(minimum) {
  if (updating) return updating;
  const operation = (async () => {
    let next = getClientVersion();
    if (SEMVER_RE.test(String(minimum || '')) && compareSemver(minimum, next) > 0) {
      next = String(minimum);
    }
    try {
      const base = process.env.FREEPI_API_BASE || 'https://api.freepi.ai';
      const res = await fetch(base + '/client-version', { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        for (const cand of [data?.latest, data?.min]) {
          if (SEMVER_RE.test(String(cand || '')) && compareSemver(cand, next) > 0) {
            next = String(cand);
          }
        }
      }
    } catch {}
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('npm CLI not found next to Node.js; cannot install official free-pi-cli');
    fs.mkdirSync(prefix, { recursive: true });
    log('Installing official free-pi-cli@latest; installed version ' + getClientVersion());
    await execFileAsync(process.execPath, [npmCli, 'install', '--prefix', prefix, '--save-exact', '--no-audit', '--no-fund', 'free-pi-cli@latest'], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const installed = JSON.parse(fs.readFileSync(runtimePkg, 'utf8')).version;
    if (!SEMVER_RE.test(installed) || compareSemver(installed, next) < 0) {
      throw new Error('Installed CLI ' + installed + ' does not satisfy required version ' + next);
    }
    cachedVersion = installed;
    try {
      fs.mkdirSync(prefix, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ checkedAt: Date.now(), version: installed }, null, 2));
    } catch {}
    log('Official CLI installed and verified: ' + installed);
    return { version: installed, restartPending: false };
  })();
  updating = operation;
  operation.finally(() => { if (updating === operation) updating = null; }).catch(() => {});
  return operation;
}
