import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { guiPort } from './watch-turn.mjs';
import { rpc } from './restart-continuation.mjs';
import { sessionFiles, decodeTranscript, parseEvents } from './read-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logs = path.join(root, 'logs');
const stateFile = path.join(logs, 'auto-continue-state.json');
fs.mkdirSync(logs, { recursive: true });
const sinceFile = path.join(logs, 'auto-continue-since.txt');
let watchSince;
try { watchSince = Number(fs.readFileSync(sinceFile, 'utf8')); } catch {}
if (!Number.isFinite(watchSince) || watchSince <= 0) {
  watchSince = Date.now() - 600_000;
  fs.writeFileSync(sinceFile, String(watchSince));
}
function log(message) {
  fs.appendFileSync(path.join(logs, 'auto-continue.log'), `${new Date().toISOString()} ${message}\n`);
}
let accepted = {};
try { accepted = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}

export function limitedTurn(events) {
  const index = events.findLastIndex(e => e.type === 'turn/end');
  const end = events[index];
  if (end?.data?.reason?.kind !== 'max-tokens') return null;
  if (events.slice(index + 1).some(e => ['turn/start', 'user/message', 'agent/inbox/spliced'].includes(e.type))) return null;
  return { turn: end.data.turn, seq: end.seq };
}
function readLimit(file) {
  const decoded = decodeTranscript(file);
  // A partially written frame could hide a newer user message or turn.
  if (decoded.skipped) return null;
  return limitedTurn(parseEvents(decoded.text));
}
async function scan() {
  const port = await guiPort();
  if (!port) return;
  const list = await rpc(port, 'session/list', { _request: {} });
  const files = new Map(sessionFiles().map(file => [path.basename(path.dirname(file)), file]));
  for (const item of list.items || []) {
    if (item.running || item.origin === 'subagent' || item.parentSessionId || !Number.isFinite(item.updatedAt) || item.updatedAt < watchSince) continue;
    const file = files.get(item.sessionId);
    if (!file) continue;
    const limit = readLimit(file);
    if (!limit) continue;
    const requestId = 'limit-' + createHash('sha256').update(`${item.sessionId}:${limit.turn}:${limit.seq}`).digest('hex').slice(0, 32);
    if (accepted[requestId]) continue;
    const fresh = await rpc(port, 'session/list', { _request: {} });
    const current = fresh.items?.find(v => v.sessionId === item.sessionId);
    const check = readLimit(file);
    if (!current || current.running || !check || check.seq !== limit.seq) continue;
    const request = {
      sessionId: item.sessionId, requestId, mode: 'queue', clientTimeZone: 'Europe/Berlin',
      content: [{ type: 'text', text: 'continue' }],
    };
    const result = await rpc(port, 'session/prompt', { request }, requestId);
    if (!result?.accepted) throw Error('Continuation was not accepted');
    accepted[requestId] = { sessionId: item.sessionId, turn: limit.turn, at: new Date().toISOString() };
    const entries = Object.entries(accepted).slice(-500);
    accepted = Object.fromEntries(entries);
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(accepted, null, 2));
    fs.renameSync(stateFile + '.tmp', stateFile);
    log(`Accepted continue for ${item.sessionId} after turn ${limit.turn}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  log('Watcher started; polling max-tokens endings every 10 seconds.');
  do {
    try { await scan(); } catch (error) { log(`Check failed: ${error.message}`); }
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  } while (true);
}
