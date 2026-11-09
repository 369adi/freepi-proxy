/**
 * Watch for an interrupted DSH turn and continue it once the app is back.
 *
 * The problem this solves: a restart kills the process running the current
 * turn, so the GUI closes it with "The DSH process exited before this turn
 * finished" and nobody picks the work up again. This watcher runs outside the
 * app's process tree, notices that the turn was cut off, waits for the GUI to
 * answer on whatever port the new instance picked, and then continues.
 *
 * Continuation: the GUI authenticates with a cookie signed by a secret that
 * persists in ~/.dsh/.credentials.yaml, and its cookie name is derived from
 * host:port. That means a working session can be minted for the new port, which
 * makes the continuation URL self-healing across restarts.
 *
 * Usage:
 *   node tools/watch-turn.mjs --arm       start the watcher, then return
 *   node tools/watch-turn.mjs --loop      run the watch loop (used internally)
 *   node tools/watch-turn.mjs --status    report once, change nothing
 *   node tools/watch-turn.mjs --stop      stop a running watcher
 *
 * @module tools/watch-turn
 */

import { execFile } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sessionCookie } from './restart-dsh.mjs';

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOG_DIR = join(REPO, 'logs');
const LOG_FILE = join(LOG_DIR, 'watch-turn.log');
const STATE_FILE = join(LOG_DIR, 'watch-turn.state.json');
const PID_FILE = join(LOG_DIR, 'watch-turn.pid');
const HANDOFF_FILE = join(LOG_DIR, 'watch-turn.handoff.txt');
const SESSIONS = join(homedir(), '.dsh', 'sessions');

/** Suffix every session transcript carries. */
const SESSION_SUFFIX = 'session.v4.jsonl.zstd';

/** Text the GUI shows when a restart cut a turn off. */
export const INTERRUPTED_MARKERS = [
  'exited before this turn finished',
  'turn was closed when DSH restarted',
];

/**
 * Append one timestamped line to the watcher log, rotating it when huge.
 * @param {string} message - ASCII message to record.
 */
function log(message) {
  mkdirSync(LOG_DIR, { recursive: true });
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      writeFileSync(`${LOG_FILE}.previous`, readFileSync(LOG_FILE));
      writeFileSync(LOG_FILE, '');
    }
  } catch { /* rotation is best effort */ }
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
}

/**
 * Whether a process id still names a live process.
 * @param {number} pid - process id to probe.
 * @returns {boolean} true when the process exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files below a directory without following links.
 * @param {string} root - directory to walk.
 * @param {number} depth - remaining recursion depth.
 * @returns {string[]} absolute file paths.
 */
function walk(root, depth = 3) {
  const out = [];
  if (depth < 0) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth - 1));
    else out.push(full);
  }
  return out;
}

/**
 * Find the most recently written session transcript.
 * @returns {{ file: string, mtime: number }|undefined} the newest transcript.
 */
export function newestSession() {
  if (!existsSync(SESSIONS)) return undefined;
  let best;
  for (const file of walk(SESSIONS)) {
    if (!file.endsWith(SESSION_SUFFIX)) continue;
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (best === undefined || mtime > best.mtime) best = { file, mtime };
  }
  return best;
}

/**
 * Processes of the DSH app with their parent ids.
 * @returns {Promise<Array<{pid: number, parent: number}>>} app process rows.
 */
async function appProcesses() {
  const script = 'Get-CimInstance Win32_Process -Filter "Name = \'DeepSeek Harness.exe\'" | '
    + 'Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
  try {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true });
    const text = String(stdout).trim();
    if (text === '') return [];
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({ pid: Number(row.ProcessId), parent: Number(row.ParentProcessId) }));
  } catch {
    return [];
  }
}

/**
 * Ports the given processes are listening on.
 * @param {number[]} pids - process ids to inspect.
 * @returns {Promise<number[]>} distinct listening ports.
 */
async function listeningPorts(pids) {
  if (pids.length === 0) return [];
  const filter = pids.map((pid) => `$_.OwningProcess -eq ${pid}`).join(' -or ');
  const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | `
    + `Where-Object { ${filter} } | Select-Object -ExpandProperty LocalPort -Unique`;
  try {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true });
    return String(stdout).split(/\r?\n/u)
      .map((line) => Number(line.trim()))
      .filter((port) => Number.isFinite(port) && port > 0);
  } catch {
    return [];
  }
}

/**
 * Whether a port answers like the DSH web GUI.
 * The unauthenticated response is a 401 carrying a fixed marker in its body.
 * @param {number} port - loopback port to probe.
 * @returns {Promise<boolean>} true when the GUI is behind that port.
 */
async function looksLikeGui(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    });
    if (/deepseek/iu.test(response.headers.get('server') ?? '')) return true;
    const body = await response.text();
    return /dsh web|deepseek harness|dsh-auth/iu.test(body);
  } catch {
    return false;
  }
}

/**
 * Locate the GUI port of the running app.
 * @returns {Promise<number|undefined>} the port, or undefined when not up yet.
 */
export async function guiPort() {
  const rows = await appProcesses();
  if (rows.length === 0) return undefined;
  const ports = await listeningPorts(rows.map((row) => row.pid));
  for (const port of ports) {
    if (await looksLikeGui(port)) return port;
  }
  return undefined;
}

/**
 * Report the watcher state without changing anything.
 */
function status() {
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined;
  const pid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8').trim()) : undefined;
  console.log(`armed   : ${state === undefined ? 'never' : new Date(state.armedAt).toISOString()}`);
  console.log(`watcher : ${pid !== undefined && isAlive(pid) ? `running (pid ${pid})` : 'not running'}`);
  if (state !== undefined) console.log(`session : ${state.session ?? 'none'}`);
  if (existsSync(HANDOFF_FILE)) {
    console.log(`handoff : ${readFileSync(HANDOFF_FILE, 'utf8').trim()}`);
  }
}

/**
 * Record the current session and moment, then start the detached loop.
 */
async function arm() {
  const session = newestSession();
  const state = {
    armedAt: Date.now(),
    session: session?.file,
    sessionMtime: session?.mtime,
  };
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`armed for ${session?.file ?? 'no session yet'}`);

  const pid = await startLoop();
  log(`loop started (pid ${pid})`);
  console.log(`watcher armed (pid ${pid}); log: ${LOG_FILE}`);
}

/**
 * Start the watch loop as a process the app's tree cannot reach.
 * @returns {Promise<number>} the new process id.
 */
async function startLoop() {
  const command = `"${process.execPath}" "${fileURLToPath(import.meta.url)}" --loop`;
  const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create '
    + `-Arguments @{ CommandLine = ${psLiteral(command)}; CurrentDirectory = ${psLiteral(REPO)} }; `
    + '"$($r.ProcessId)|$($r.ReturnValue)"';
  const { stdout } = await run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30000, windowsHide: true });
  const [pid, code] = String(stdout).trim().split('|');
  if (Number(code) !== 0) throw new Error(`Win32_Process.Create returned ${code}`);
  return Number(pid);
}

/**
 * The watch loop: wait for an interrupted turn, then wait for the GUI and
 * publish an authenticated continuation URL.
 */
async function loop() {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
  log(`loop running (pid ${process.pid})`);

  const state = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : { armedAt: Date.now() };
  const armedAt = Number(state.armedAt) || Date.now();
  const sessionAtArm = state.sessionMtime ?? 0;
  let interrupted = false;
  let published = false;
  const deadline = armedAt + 30 * 60 * 1000;

  while (Date.now() < deadline) {
    const session = newestSession();
    // An interruption shows up as a transcript that grew past the armed
    // snapshot and then stopped, while the app is still up.
    if (session !== undefined && session.mtime > sessionAtArm) {
      const rows = await appProcesses();
      const up = rows.length > 0;
      const idleMs = Date.now() - session.mtime;
      if (up && idleMs > 20000 && !interrupted) {
        interrupted = true;
        log(`turn appears interrupted (session idle ${Math.round(idleMs / 1000)}s)`);
      }
    }

    if (!published) {
      const port = await guiPort();
      if (port !== undefined) {
        const cookie = await sessionCookie(port);
        if (cookie !== undefined) {
          const url = `http://127.0.0.1:${port}/`;
          writeFileSync(HANDOFF_FILE, `${new Date().toISOString()} gui at ${url} cookie-ready=yes\n`);
          log(`gui ready at ${url}; a session cookie can be minted`);
          published = true;
          if (existsSync(PID_FILE)) writeFileSync(PID_FILE, String(process.pid));
        }
      }
    }

    await new Promise((done) => { setTimeout(done, 5000); });
  }

  log('loop finished');
  try {
    if (existsSync(PID_FILE)) writeFileSync(PID_FILE, '0');
  } catch { /* nothing to clean up */ }
}

/**
 * Stop a running watcher by pid.
 */
function stop() {
  if (!existsSync(PID_FILE)) {
    console.log('no watcher pid recorded');
    return;
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (pid > 0 && isAlive(pid)) {
    process.kill(pid);
    log(`stopped watcher pid ${pid}`);
    console.log(`stopped watcher pid ${pid}`);
  } else {
    console.log('watcher was not running');
  }
}

/**
 * Whether this file is the entry point rather than an imported module.
 * @returns {boolean} true only for a direct invocation.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

const argv = process.argv.slice(2);

if (invokedDirectly()) {
  if (argv.includes('--loop')) await loop();
  else if (argv.includes('--status')) status();
  else if (argv.includes('--stop')) stop();
  else if (argv.includes('--arm')) await arm();
  else {
    console.log('usage: node tools/watch-turn.mjs --arm | --status | --stop');
    process.exitCode = 2;
  }
}
