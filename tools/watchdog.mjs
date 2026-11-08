#!/usr/bin/env node
// watchdog.mjs - keep the free-pi proxy alive in the background.
//
//   node tools/watchdog.mjs            start & supervise (Ctrl+C stops both)
//   node tools/watchdog.mjs --install  autostart at logon
//   node tools/watchdog.mjs --remove   remove autostart
//
// The watchdog restarts the proxy if it exits or if the port stops answering.
// All proxy output is appended to ~/.free-pi/proxy/proxy.log so a crash leaves
// evidence behind.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROXY = path.join(ROOT, 'proxy.mjs');
const LOG_DIR = path.join(os.homedir(), '.free-pi', 'proxy');
const LOG = path.join(LOG_DIR, 'proxy.log');
const CRASH_LOG = path.join(LOG_DIR, 'crashes.log');
const PORT = Number(process.env.FREEPI_PROXY_PORT || 4000);

fs.mkdirSync(LOG_DIR, { recursive: true });

const stamp = () => new Date().toISOString();

function note(msg) {
  const line = '[' + stamp() + '] ' + msg + '\n';
  process.stdout.write(line);
  try { fs.appendFileSync(CRASH_LOG, line); } catch { /* ignore */ }
}

async function alive() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/v1/models', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- supervision

async function supervise() {
  if (await alive()) note('proxy already listening on :' + PORT + ' - watching it');

  let child = null;
  let failures = 0;

  const startChild = () => {
    if (child) return;
    note('starting proxy (port ' + PORT + '), log -> ' + LOG);
    const out = fs.createWriteStream(LOG, { flags: 'a' });
    out.write('\n===== ' + stamp() + ' start =====\n');
    child = spawn(process.execPath, [PROXY], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FREEPI_PROXY_PORT: String(PORT) },
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('exit', (code, signal) => {
      note('proxy exited code=' + code + ' signal=' + signal);
      child = null;
      if (code === 0) { note('clean exit - not restarting'); process.exit(0); }
    });
  };

  const ensure = async () => {
    if (child) return;
    if (await alive()) return;
    startChild();
  };

  await ensure();

  setInterval(async () => {
    if (!child) { await ensure(); return; }
    if (!(await alive())) {
      failures++;
      if (failures >= 3) {
        note('proxy unresponsive ' + failures + 'x - restarting');
        try { child.kill(); } catch { /* ignore */ }
        child = null;
        failures = 0;
        await ensure();
      }
    } else failures = 0;
  }, 20_000);

  process.on('SIGINT', () => {
    note('watchdog stopped (SIGINT)');
    try { child?.kill(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// ---------------------------------------------------------------- autostart

// COM (WScript.Shell) and schtasks are frequently blocked in restricted shells.
// A Startup-folder entry needs neither: a .vbs file that launches the watchdog
// hidden is enough, and VBScript ships with every Windows.

const STARTUP = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);
const VBS = path.join(STARTUP, 'free-pi Proxy.vbs');

function install() {
  fs.mkdirSync(STARTUP, { recursive: true });
  const shim = path.join(ROOT, 'Watchdog.cmd');
  const vbs = [
    "' free-pi proxy watchdog - starts the proxy hidden and keeps it alive.",
    "' created by tools/watchdog.mjs --install, remove with --remove",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + ROOT + '"',
    'sh.Run """' + shim + '""", 0, False',
    '',
  ].join('\r\n');
  fs.writeFileSync(VBS, vbs);
  console.log('\n  Registered: the proxy starts automatically at logon.');
  console.log('  Entry: ' + VBS);
  console.log('  Remove it with:  node tools\\watchdog.mjs --remove');
  console.log('  Start it now with: cscript //nologo "' + VBS + '"');
}

function remove() {
  let removed = false;
  for (const f of [VBS, path.join(STARTUP, 'free-pi Proxy.lnk')]) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('  removed ' + f); removed = true; }
  }
  console.log(removed ? '  Autostart removed.' : '  No autostart entry found.');
}

// ---------------------------------------------------------------- main

const arg = process.argv[2];
if (arg === '--install') install();
else if (arg === '--remove') remove();
else supervise().catch(e => { note('watchdog failed: ' + e.message); process.exit(1); });
