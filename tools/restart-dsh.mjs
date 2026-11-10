/**
 * Restart DeepSeek Harness safely, from inside a running turn.
 *
 * The failure this prevents: killing the DSH process tree from within a tool
 * call also kills the process that is running the very turn issuing the kill.
 * The turn dies mid-answer, so the relaunch that was supposed to follow never
 * happens and the session ends with a closed window and nobody to continue it.
 *
 * The fix is to let a detached helper do the work. This script spawns that
 * helper in its own process group, prints what it is about to do and returns
 * immediately. The helper outlives the kill, relaunches the app, discovers the
 * new port and brings the GUI back up.
 *
 * How the app is identified: DSH binds a random loopback port on every start
 * and keeps no state file naming it, so the port is discovered from the
 * listening sockets owned by the app's processes rather than remembered.
 *
 * Usage:
 *   node tools/restart-dsh.mjs                  # restart in 5 seconds
 *   node tools/restart-dsh.mjs --delay 20       # give the turn time to finish
 *   node tools/restart-dsh.mjs --dry-run        # report, change nothing
 *   node tools/restart-dsh.mjs --no-open        # do not open the GUI afterwards
 *
 * @module tools/restart-dsh
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { captureTurns, resumeTurns } from './restart-continuation.mjs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** Where the detached helper reports what it did. */
const LOG_DIR = join(REPO, 'logs');
const LOG_FILE = join(LOG_DIR, 'dsh-restart.log');

/** Seconds between the caller returning and the kill, unless overridden. */
const DEFAULT_DELAY_S = 5;

/** Seconds to wait for the new instance to answer before giving up. */
const DEFAULT_TIMEOUT_S = 180;

/** Process image name of the Electron app. */
const APP_IMAGE = 'DeepSeek Harness.exe';

/** Milliseconds in one day, for the browser-session lifetime. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse command-line options.
 * @param {string[]} argv - raw arguments after the script name.
 * @returns {{delay: number, timeout: number, dryRun: boolean, open: boolean}}
 */
function parseArgs(argv) {
  const options = { delay: DEFAULT_DELAY_S, timeout: DEFAULT_TIMEOUT_S, dryRun: false, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--delay') {
      options.delay = Number(argv[i + 1]) || DEFAULT_DELAY_S;
      i += 1;
    } else if (arg === '--timeout') {
      options.timeout = Number(argv[i + 1]) || DEFAULT_TIMEOUT_S;
      i += 1;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--refresh-proxy') {
      options.refreshProxy = true;
    }
  }
  return options;
}

/**
 * Append one timestamped line to the restart log.
 * @param {string} message - what happened.
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch {
    // A failed log write must never stop a restart.
  }
}

/**
 * List the app's processes, outermost first.
 *
 * The Electron main process is the one whose parent is not itself an app
 * process; killing it with its tree takes every renderer and utility child
 * with it, which is what a restart needs.
 * @returns {Promise<Array<{pid: number, parent: number, commandLine: string}>>}
 */
async function appProcesses() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${APP_IMAGE}'" | ` +
    'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30000, windowsHide: true });
  const parsed = JSON.parse(stdout || '[]');
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((row) => row && row.ProcessId).map((row) => ({
    pid: Number(row.ProcessId),
    parent: Number(row.ParentProcessId) || 0,
    commandLine: String(row.CommandLine ?? ''),
  }));
}

/**
 * Read one process row, whoever its parent is.
 *
 * Used to prove the helper is not a descendant of the app: Win32_Process.Create
 * makes WmiPrvSE the parent, so the app's tree cannot reach it.
 * @param {number} pid - process to inspect.
 * @returns {Promise<{pid: number, parent: number, commandLine: string}|undefined>}
 */
async function processRow(pid) {
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
    'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  try {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 30000, windowsHide: true });
    const parsed = JSON.parse(stdout || '[]');
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || !row.ProcessId) return undefined;
    return {
      pid: Number(row.ProcessId),
      parent: Number(row.ParentProcessId) || 0,
      commandLine: String(row.CommandLine ?? ''),
    };
  } catch {
    return undefined;
  }
}

/**
 * True when a port answers HTTP and speaks DSH's app shell.
 *
 * A bare TCP listener is not enough: any local service can open a port during
 * the restart window. The GUI answers its HTML shell at `/` for an
 * unauthenticated request (or a 401/302 that names the same server).
 * @param {number} port - loopback port to check.
 * @returns {Promise<boolean>} whether this looks like the DSH GUI.
 */
/**
 * True when a port answers like the DSH web GUI.
 *
 * Measured behaviour of an unauthenticated request to a fresh instance:
 * `401 text/plain` with the body
 * "dsh web authentication required; reopen the URL printed by dsh web."
 * so neither a bare status code nor a text/html content type is the right
 * signal. The body marker is what actually identifies this app, and it keeps
 * an unrelated service that opened a port during the restart window out.
 * @param {number} port - loopback port to check.
 * @returns {Promise<boolean>} whether this looks like the DSH GUI.
 */
async function looksLikeGui(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'manual',
    });
    const server = String(response.headers.get('server') ?? '');
    if (/deepseek/iu.test(server)) return true;
    const body = (await response.text()).slice(0, 4000);
    return /dsh web|deepseek harness|dsh-auth/iu.test(body);
  } catch {
    return false;
  }
}

/**
 * Find the loopback port the app serves its GUI on.
 *
 * DSH picks the port at startup and records it nowhere, so the only reliable
 * source is the listening socket owned by one of the app's processes.
 * @param {number[]} pids - candidate process ids.
 * @returns {Promise<number|undefined>} the port, when one is listening.
 */
async function guiPort(pids) {
  if (pids.length === 0) return undefined;
  const filter = pids.map((pid) => `$_.OwningProcess -eq ${pid}`).join(' -or ');
  const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ` +
    `Where-Object { ${filter} } | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 30000, windowsHide: true });
    const parsed = JSON.parse(stdout || '[]');
    const ports = (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((p) => p > 0);
    return ports[0];
  } catch {
    return undefined;
  }
}

/**
 * List every loopback port currently listening on this machine.
 *
 * Used as a fallback when the new instance's socket cannot be attributed to a
 * process id yet: any port that answers HTTP and did not exist before the
 * restart is the new GUI.
 * @returns {Promise<number[]>} listening loopback ports.
 */
async function listeningPorts() {
  const script = 'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.LocalAddress -eq "127.0.0.1" -or $_.LocalAddress -eq "0.0.0.0" -or $_.LocalAddress -eq "::" } | ' +
    'Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress';
  try {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 30000, windowsHide: true });
    const parsed = JSON.parse(stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((p) => p > 0);
  } catch {
    return [];
  }
}

/**
 * Ask whether anything answers on a URL. Any HTTP status counts as alive,
 * because an unauthenticated GUI answers 401 and that still proves it runs.
 * @param {string} url - URL to probe.
 * @returns {Promise<boolean>} whether a server answered.
 */
async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

/**
 * Split a Windows command-line tail into arguments, following the same rules
 * CommandLineToArgvW uses.
 *
 * A naive quote-or-whitespace regex breaks on `--flag="C:\a b"`, because the
 * token starts with a non-quote character and the fallback branch then eats up
 * to the next space, quotes included. Relaunching with a mangled
 * `--user-data-dir` would start the app on the wrong profile, so this has to be
 * right rather than merely plausible.
 * @param {string} tail - everything after the executable path.
 * @returns {string[]} arguments in order.
 */
function splitArgs(tail) {
  const args = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (ch === '\\') {
      // Backslashes are literal unless they run into a quote.
      let count = 0;
      while (tail[i] === '\\') { count += 1; i += 1; }
      if (tail[i] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else { quoted = !quoted; i -= 1; }
      } else {
        current += '\\'.repeat(count);
        i -= 1;
      }
      started = true;
      continue;
    }
    if (ch === '"') {
      // A quote toggles quoting; doubled quotes inside a quoted run are literal.
      if (quoted && tail[i + 1] === '"') { current += '"'; i += 1; } else { quoted = !quoted; }
      started = true;
      continue;
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) { args.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/**
 * Locate the executable and the arguments the running app was started with.
 * @returns {Promise<{exe: string, args: string[]}|undefined>} launch recipe.
 */
async function launchRecipe() {
  const processes = await appProcesses();
  const appPids = new Set(processes.map(row => row.pid));
  const main = processes.find(row => !appPids.has(row.parent));
  if (main !== undefined) {
    const match = /^"([^"]+)"\s*(.*)$/u.exec(main.commandLine.trim());
    if (match !== null) {
      return { exe: match[1], args: splitArgs(match[2]) };
    }
  }
  const fallback = join(process.env.LOCALAPPDATA ?? '', 'Programs', APP_IMAGE.replace('.exe', ''), APP_IMAGE);
  if (existsSync(fallback)) return { exe: fallback, args: [] };
  return undefined;
}

/**
 * The detached half: wait, kill, relaunch, confirm, report.
 * @param {{delay: number, timeout: number, open: boolean}} options - timings.
 */
async function supervise(options) {
  log('--- restart requested ---');
  // The helper must prove it is not inside the app's process tree: that is the
  // whole point of starting it through WMI, and taskkill /T would otherwise be
  // enough to kill it again.
  const own = await processRow(process.pid);
  if (own === undefined) {
    log(`helper pid ${process.pid}: inside app tree: UNKNOWN (could not read own row)`);
  } else {
    const appPidsNow = new Set((await appProcesses()).map((row) => row.pid));
    const inside = appPidsNow.has(own.parent);
    log(`helper pid ${process.pid}, parent ${own.parent}, ` +
      `inside app tree: ${inside ? 'YES (unsafe)' : 'no'}`);
  }

  const recipe = await launchRecipe();
  if (recipe === undefined) {
    log('FATAL: cannot determine how to launch the app; nothing was stopped');
    return;
  }
  log(`launch recipe: ${recipe.exe} (${recipe.args.length} args)`);

  const before = await appProcesses();
  const beforePids = before.map((row) => row.pid);
  const oldPort = await guiPort(beforePids);
  log(`running pids: ${beforePids.join(', ') || 'none'}; gui port: ${oldPort ?? 'unknown'}`);

  log(`waiting ${options.delay}s so the calling turn can finish`);
  await new Promise((done) => { setTimeout(done, options.delay * 1000); });

  // Arm the turn watcher before the kill. It records which transcript was
  // newest, so the moment the kill cuts a turn off it can wait for the new GUI
  // and publish an authenticated continuation URL. Arming afterwards would be
  // too late: the interruption is what it has to notice.
  const handoffFile=join(LOG_DIR,`restart-handoff-${process.pid}.json`);
  const handoff=await captureTurns(oldPort,handoffFile);
  log(`captured ${handoff.entries.length} active turn(s) for continuation; ${handoffFile}`);

  // Re-read processes and ports right before the kill. The list captured above
  // is only there to name the old GUI port for the log: across a long delay
  // Windows recycles pid numbers, and a port some unrelated service opened in
  // the meantime must not be mistaken for the app's new one.
  const live = await appProcesses();
  const beforePorts = await listeningPorts();
  log(`ports before stop: ${beforePorts.length} listeners`);

  const livePids = new Set(live.map(row => row.pid));
  const main = live.find(row => !livePids.has(row.parent));
  const target = main?.pid ?? live[0]?.pid;
  if (target === undefined) {
    log('no app process to stop; continuing to launch');
  } else {
    log(`stopping app processes; shell pid ${target}`);
    try {
      // Never /T: that also kills the restart helper launched by a host tool.
      // Only the explicitly discovered app processes belong to this restart.
      for (const pid of [target, ...live.map(row => row.pid).filter(pid => pid !== target)]) {
        try {
          await run('taskkill.exe',
            ['/F', '/PID', String(pid), '/FI', `IMAGENAME eq ${APP_IMAGE}`],
            { timeout: 10000, windowsHide: true });
        } catch (error) {
          if (error.code !== 128) log(`stop pid ${pid}: ${String(error.message ?? error)}`);
        }
      }
    } catch (error) {
      if (error.code !== 128) log(`taskkill reported: ${String(error.message ?? error)}`);
    }
  }

  const gone = await until(async () => (await appProcesses()).length === 0, 30);
  if (!gone) log('warning: app processes survived the stop; relaunching anyway');
  else log('all app processes are gone');
  if(options.refreshProxy) {
    try {
      await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(REPO,'Control-Proxy.ps1'),'-Action','restart'],{windowsHide:true,timeout:65000});
      log('proxy refreshed while Harness clients were stopped');
    } catch(error) {log('proxy refresh failed; still relaunching desktop: '+error.message);}
  }

  log(`launching ${recipe.exe}`);
  const child = spawn(recipe.exe, recipe.args, {
    detached: true,
    stdio: 'ignore',
    cwd: dirname(recipe.exe),
  });
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  log(`spawned pid ${child.pid ?? 'unknown'}`);

  const candidate = await until(async () => {
    const rows = await appProcesses();
    const fresh = rows.filter((row) => !beforePids.includes(row.pid));
    return fresh.length > 0 ? fresh : false;
  }, options.timeout);

  if (candidate === false) {
    throw new Error('The new Harness instance never appeared');
  }
  log(`new instance up: pids ${candidate.map((row) => row.pid).join(', ')}`);

  const port = await until(async () => {
    const rows = await appProcesses();
    if (rows.length === 0) return false;
    // Primary: the socket belongs to one of the new app processes. The main
    // process owns the GUI listener's parent, a utility child may own the
    // socket itself, so every app pid is a candidate.
    const byPid = await guiPort(rows.map((row) => row.pid));
    if (byPid !== undefined && await looksLikeGui(byPid)) return byPid;
    // Fallback: the socket cannot be attributed yet. Only a port that is new
    // since before the restart AND answers like the GUI qualifies; anything
    // else (proxy, router, a stray service) keeps its port and is filtered out
    // by the diff, but a service that just happened to start must not win.
    const ports = await listeningPorts();
    const fresh = ports.filter((candidatePort) => !beforePorts.includes(candidatePort));
    for (const candidatePort of fresh) {
      if (await looksLikeGui(candidatePort)) return candidatePort;
    }
    return false;
  }, options.timeout);
  if (port === false) {
    throw new Error('The new Harness instance opened no listening port');
  }
  const url = `http://127.0.0.1:${port}`;
  const alive = await until(() => answers(url), 60);
  log(alive ? `gui answers at ${url}` : `warning: ${url} does not answer yet`);
  if(!alive)throw new Error('Harness did not become ready');
  // The desktop launch above opens the actual app. A URL/cookie alone cannot
  // continue a turn; submit a durable, idempotent prompt to the restored API.
  for(let attempt=0;attempt<5;attempt++) {
    const entries=await resumeTurns(port,handoffFile,{log});
    if(entries.every(entry=>entry.status!=='pending'))break;
    if(attempt===4)throw new Error('Some interrupted turns remain pending; see '+handoffFile);
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  log('--- restart complete: desktop app and continuation checked ---');
}

/**
 * Mint a browser-session cookie the restarted GUI will accept.
 *
 * The web client authenticates with a signed cookie. Its name is derived from
 * the request authority (host:port) and its value is an HMAC-SHA256 over a
 * small JSON payload, keyed by a secret that the app persists in
 * `~/.dsh/.credentials.yaml`. Reading that secret lets a restart produce a
 * session for the new port instead of leaving the user at the 401 page.
 * @param {number} port - loopback port of the new instance.
 * @returns {Promise<string|undefined>} `name=value`, or undefined when the
 *   credential store has no browser-session secret.
 */
export async function sessionCookie(port) {
  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml');
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/u);
    const start = lines.findIndex((line) => line.includes('client-connection/browser-session'));
    if (start < 0) return undefined;
    let secret;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s{2}[A-Za-z0-9_-]+\//u.test(lines[i])) break;
      const match = /^\s*secret:\s*(\S+)\s*$/u.exec(lines[i]);
      if (match === null) continue;
      secret = Buffer.from(String(match[1]).replaceAll('-', '+').replaceAll('_', '/'), 'base64');
      break;
    }
    if (secret === undefined || secret.byteLength !== 32) return undefined;
    const authority = `127.0.0.1:${port}`;
    const name = `dsh-auth-${base64Url(createHash('sha256').update(authority).digest())}`;
    const issuedAt = Date.now();
    const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * DAY_MS };
    const body = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signature = createHmac('sha256', secret).update(body).digest();
    return `${name}=v1.${body}.${base64Url(signature)}`;
  } catch {
    return undefined;
  }
}

/**
 * Encode bytes as unpadded base64url, the alphabet the GUI uses for cookie names.
 * @param {Buffer} buffer - bytes to encode.
 * @returns {string} the encoded text.
 */
export function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Poll a condition until it yields a truthy value or the deadline passes.
 * @param {() => Promise<any>} condition - the probe.
 * @param {number} timeoutS - maximum seconds to wait.
 * @returns {Promise<any>} the first truthy result, or false.
 */
async function until(condition, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => { setTimeout(done, 750); });
  }
}

const argv = process.argv.slice(2);

/**
 * Whether this file is the entry point rather than an imported module.
 * Tests import sessionCookie; without this guard the import would run the
 * restart itself.
 * @returns {boolean} true only for a direct invocation.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (!invokedDirectly()) {
  // Imported for its helpers: define them and change nothing.
} else if (argv.includes('--supervise')) {
  const options = parseArgs(argv);
  options.open = !argv.includes('--no-open');
  try {
    await supervise(options);
  } catch (error) {
    log(`FATAL: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  }
} else {
  const options = parseArgs(argv);
  const recipe = await launchRecipe().catch(() => undefined);
  const currentPids = await appProcesses().catch(() => []);
  const currentPort = await guiPort(currentPids.map((row) => row.pid)).catch(() => undefined);

  console.log(`App       : ${recipe?.exe ?? 'NOT FOUND'}`);
  console.log(`Processes : ${currentPids.map((row) => row.pid).join(', ') || 'none'}`);
  console.log(`GUI URL   : ${currentPort === undefined ? 'unknown' : `http://127.0.0.1:${currentPort}`}`);
  console.log(`Delay     : ${options.delay}s`);
  console.log(`Log       : ${LOG_FILE}`);

  if (recipe === undefined) {
    console.error('\nRefusing to continue: the app executable could not be identified.');
    process.exitCode = 1;
  } else if (options.dryRun) {
    console.log('\n--dry-run: nothing was stopped or started.');
  } else {
    const helperArgs = [fileURLToPath(import.meta.url), '--supervise',
      '--delay', String(options.delay), '--timeout', String(options.timeout)];
    if (!options.open) helperArgs.push('--no-open');
    if (options.refreshProxy) helperArgs.push('--refresh-proxy');

    // The helper must not be a descendant of the app. `detached` only gives a
    // child its own console on Windows; it stays in the app's process tree, so
    // killing that tree also killed the helper and nothing relaunched the app.
    // Win32_Process.Create starts the helper from the WMI service instead, which
    // makes it a root process the app's tree cannot reach.
    const command = [process.execPath, ...helperArgs]
      .map((part) => `"${part}"`).join(' ');
    const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
    const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
      `-Arguments @{ CommandLine = ${psLiteral(command)}; CurrentDirectory = ${psLiteral(REPO)} }; ` +
      `"$($r.ProcessId)|$($r.ReturnValue)"`;

    let helperPid = 'unknown';
    try {
      const { stdout } = await run('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 30000, windowsHide: true });
      const [pid, code] = String(stdout).trim().split('|');
      if (Number(code) !== 0) throw new Error(`Win32_Process.Create returned ${code}`);
      helperPid = pid;
    } catch (error) {
      console.error(`\nCould not start the restart helper: ${String(error.message ?? error)}`);
      console.error('Nothing was stopped. The app is still running.');
      process.exitCode = 1;
      throw error;
    }

    console.log(`\nHelper started outside the app tree (pid ${helperPid}).`);
    console.log(`The app restarts in ${options.delay}s; this turn can finish first.`);
  }
}
