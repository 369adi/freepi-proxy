// pick-account.mjs - tell a caller which free account to pin with
// `x-freepi-account`. Pure selection logic is exported for tests; the
// network part only runs when this file is executed directly.

import { pathToFileURL } from 'node:url';

const USAGE_URL = 'http://127.0.0.1:4000/usage';
const TIMEOUT_MS = 10000;

/** Numeric value or 0, so missing fields never crash the sort. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Compare two account ids deterministically (numeric part aware, else locale-free). */
function compareId(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const ma = /^(\D*)(\d+)$/.exec(sa);
  const mb = /^(\D*)(\d+)$/.exec(sb);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return sa < sb ? -1 : 1;
    const d = Number(ma[2]) - Number(mb[2]);
    if (d !== 0) return d < 0 ? -1 : 1;
    return 0;
  }
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * Pick the best free account.
 * Filter: `selectable === true` when any account carries the field (exact proxy
 * permission), else `usable === true`. In both cases `busy === false` is required.
 * Order: highest remaining, then highest premiumCredits, then smallest id.
 * Returns the account object or null.
 */
export function pickAccount(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(a => a && typeof a === 'object') : [];
  const hasSelectable = list.some(a => 'selectable' in a);
  const idle = list.filter(a => {
    if (a.busy === true) return false;
    return hasSelectable ? a.selectable === true : a.usable === true;
  });
  if (idle.length === 0) return null;
  idle.sort((a, b) =>
    num(b.remaining) - num(a.remaining) ||
    num(b.premiumCredits) - num(a.premiumCredits) ||
    compareId(a.id, b.id));
  return idle[0];
}

/** Count accounts that pass the same "allowed" filter as pickAccount (ignoring busy). */
export function countUsable(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(a => a && typeof a === 'object') : [];
  const hasSelectable = list.some(a => 'selectable' in a);
  return list.filter(a => (hasSelectable ? a.selectable === true : a.usable === true)).length;
}

export function countIdle(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(a => a && typeof a === 'object') : [];
  const hasSelectable = list.some(a => 'selectable' in a);
  return list.filter(a => a.busy !== true && (hasSelectable ? a.selectable === true : a.usable === true)).length;
}

function pad(s, w) {
  return String(s).padEnd(w, ' ');
}

/** ASCII table, one row per account. */
export function formatTable(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const header = ['ID', 'HANDLE', 'STATE', 'USABLE', 'BUSY', 'REMAINING'];
  const rows = list.map(a => [
    String(a.id ?? '?'),
    String(a.handle ?? '-'),
    String(a.state ?? '-'),
    a.usable === true ? 'yes' : 'no',
    a.busy === true ? 'yes' : 'no',
    String(a.remaining ?? '-'),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = r => pad(r[0], widths[0]) + '  ' + pad(r[1], widths[1]) + '  ' + pad(r[2], widths[2]) +
    '  ' + pad(r[3], widths[3]) + '  ' + pad(r[4], widths[4]) + '  ' + r[5];
  const out = [line(header), line(widths.map(w => '-'.repeat(w)))];
  for (const r of rows) out.push(line(r));
  return out.join('\n') + '\n';
}

const USAGE = [
  'Usage: node tools/pick-account.mjs [--json | --all | --help]',
  '',
  'Pick the best free free-pi account and print its account id (use it as',
  'the x-freepi-account header value).',
  '',
  '  (no option)  print only the account id, e.g. acc-2 (for shell scripts)',
  '  --json       compact JSON: {"pick":..,"handle":..,"remaining":..,"usable":..,"waiting":..}',
  '  --all        table of all accounts (ID, HANDLE, STATE, USABLE, BUSY, REMAINING)',
  '  --help       show this help',
  '',
  'Exit codes: 0 ok, 2 no free account, 1 proxy not reachable or bad response.',
].join('\n') + '\n';

function fail(msg) {
  process.stderr.write('proxy not reachable at ' + USAGE_URL + ': ' + msg + '\n');
  process.exitCode = 1;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const wantJson = argv.includes('--json');
  const wantAll = argv.includes('--all');

  let data;
  try {
    const res = await fetch(USAGE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return fail('HTTP ' + res.status);
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch (err) {
      return fail('invalid JSON (' + (err && err.message ? err.message : String(err)) + ')');
    }
  } catch (err) {
    const cause = err && err.name === 'TimeoutError' ? 'timeout after ' + TIMEOUT_MS + ' ms'
      : err && err.cause && err.cause.code ? err.cause.code
        : err && err.message ? err.message : String(err);
    return fail(cause);
  }
  if (!data || typeof data !== 'object') return fail('response is not an object');
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  if (accounts.length === 0 && !(data.accounts && Array.isArray(data.accounts))) {
    return fail('response has no accounts array');
  }

  if (wantAll) {
    process.stdout.write(formatTable(accounts));
    return;
  }

  const best = pickAccount(accounts);
  if (!best) {
    const q = data.queue && typeof data.queue === 'object' ? data.queue : {};
    const usable = countUsable(accounts);
    const idle = countIdle(accounts);
    const lanes = num(q.lanes);
    const waiting = num(q.waiting);
    process.stderr.write('no free account: ' + usable + ' usable, ' + idle + ' idle, ' +
      lanes + ' lane(s), ' + waiting + ' waiting\n');
    process.exitCode = 2;
    return;
  }

  if (wantJson) {
    const q = data.queue && typeof data.queue === 'object' ? data.queue : {};
    const obj = {
      pick: String(best.id),
      handle: best.handle ?? null,
      remaining: num(best.remaining),
      usable: countUsable(accounts),
      waiting: num(q.waiting),
    };
    process.stdout.write(JSON.stringify(obj) + '\n');
    return;
  }

  process.stdout.write(String(best.id) + '\n');
}

// Only touch the network when run directly, never on import.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch(err => fail(err && err.message ? err.message : String(err)));
}
