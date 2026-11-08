#!/usr/bin/env node
// stop.mjs — stop a running free-pi proxy without needing WMIC/PowerShell.
import { execSync } from 'node:child_process';

const MATCH = /proxy\.mjs/i;
let killed = 0;

try {
  // tasklist gives PID + image name; we then filter by command line via
  // PowerShell's CIM (works on systems without wmic) when available.
  const out = execSync(
    'powershell -NoProfile -Command ' +
    '"Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ' +
    'Where-Object { $_.CommandLine -match \'proxy\\.mjs\' } | ' +
    'ForEach-Object { $_.ProcessId }"',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const pids = out.split(/\s+/).map(s => s.trim()).filter(Boolean);
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    if (Number(pid) === process.pid) continue;
    try {
      execSync('taskkill /pid ' + pid + ' /f', { stdio: 'ignore' });
      console.log('  stopped PID ' + pid);
      killed++;
    } catch {
      console.log('  could not stop PID ' + pid);
    }
  }
} catch {
  /* no powershell — nothing to do */
}

console.log(killed ? '  proxy stopped.' : '  no running proxy found.');
process.exit(0);
