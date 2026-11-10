/**
 * Live alerts for the things that go wrong on this machine.
 *
 * The point of this module is that a failure never stays silent. When a
 * subagent dies, the proxy loses its accounts, or DSH is restarted out from
 * under a turn, a line lands in a file the operator can watch, and an HTTP
 * listener answers with the current state so anyone can ask rather than poll
 * log files.
 *
 * Two halves, deliberately separate:
 *   - record() appends an event. It never throws, so it cannot break a caller.
 *   - serve() answers on a loopback port with the recent events, which keeps the
 *     notification surface machine readable instead of screen-only.
 *
 * Usage:
 *   node tools/alert.mjs --serve     start the listener
 *   node tools/alert.mjs --tail      print the recent events
 *   node tools/alert.mjs --emit TEXT record one event
 *
 * @module tools/alert
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOG_DIR = join(REPO, 'logs');
const ALERT_FILE = join(LOG_DIR, 'alerts.jsonl');
const PID_FILE = join(LOG_DIR, 'alert-server.pid');

/** Default port of the alert listener. */
export const ALERT_PORT = 4599;

/** How many events a status answer returns. */
const RECENT_LIMIT = 50;

/** Severities that mean someone has to act. */
export const ACTIONABLE = new Set(['error', 'critical']);

/**
 * Record one alert event.
 * Never throws: a broken alert channel must not take the caller down with it.
 * @param {'info'|'warn'|'error'|'critical'} severity - how bad it is.
 * @param {string} source - where it happened, e.g. "subagent" or "proxy".
 * @param {string} message - what happened, ASCII.
 * @param {object} [detail] - optional extra fields.
 * @returns {object|undefined} the stored event.
 */
export function record(severity, source, message, detail) {
  const event = {
    at: new Date().toISOString(),
    epoch: Date.now(),
    severity,
    source,
    message: String(message),
    ...(detail === undefined ? {} : { detail }),
  };
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(ALERT_FILE) && statSync(ALERT_FILE).size > 4 * 1024 * 1024) {
      writeFileSync(`${ALERT_FILE}.previous`, readFileSync(ALERT_FILE));
      writeFileSync(ALERT_FILE, '');
    }
    appendFileSync(ALERT_FILE, `${JSON.stringify(event)}\n`);
  } catch { /* an unwritable log must not fail the caller */ }
  return event;
}

/**
 * Read the recorded events.
 * @param {number} [limit] - how many of the newest to return.
 * @returns {object[]} events, oldest first.
 */
export function recent(limit = RECENT_LIMIT) {
  if (!existsSync(ALERT_FILE)) return [];
  const lines = readFileSync(ALERT_FILE, 'utf8').split(/\r?\n/u).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch { /* a torn line at the end is not worth failing over */ }
  }
  return events.slice(-limit);
}

/**
 * A compact summary of what needs attention right now.
 * @param {number} [windowMs] - how far back to look.
 * @returns {{ok: boolean, actionable: object[], counts: object}} summary.
 */
export function summary(windowMs = 30 * 60 * 1000) {
  const since = Date.now() - windowMs;
  const events = recent(500).filter((event) => event.epoch >= since);
  const counts = { info: 0, warn: 0, error: 0, critical: 0 };
  for (const event of events) {
    if (counts[event.severity] !== undefined) counts[event.severity] += 1;
  }
  const actionable = events.filter((event) => ACTIONABLE.has(event.severity));
  return { ok: actionable.length === 0, actionable, counts };
}

/**
 * Start the HTTP listener that reports alerts.
 * @param {number} port - loopback port to bind.
 * @returns {Promise<import('node:http').Server>} the listening server.
 */
export function serve(port = ALERT_PORT) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      const text = JSON.stringify(body, null, 2);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      });
      response.end(text);
    };

    if (url.pathname === '/health' || url.pathname === '/') {
      const state = summary();
      send(state.ok ? 200 : 503, state);
      return;
    }
    if (url.pathname === '/alerts') {
      send(200, { events: recent(Number(url.searchParams.get('limit')) || RECENT_LIMIT) });
      return;
    }
    send(404, { error: 'unknown path', paths: ['/', '/health', '/alerts'] });
  });

  server.listen(port, '127.0.0.1', () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid));
    record('info', 'alert', `alert listener up on ${port}`);
    console.log(`alert listener on http://127.0.0.1:${port}/health`);
  });
  return new Promise((ready) => { server.on('listening', () => { ready(server); }); });
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
  if (argv.includes('--serve')) {
    await serve(Number(process.env.ALERT_PORT ?? ALERT_PORT));
  } else if (argv.includes('--tail')) {
    for (const event of recent(Number(process.env.ALERT_LIMIT ?? 20))) {
      console.log(`${event.at} ${event.severity.padEnd(8)} ${event.source.padEnd(10)} ${event.message}`);
    }
  } else if (argv.includes('--emit')) {
    const message = argv[argv.indexOf('--emit') + 1];
    if (message === undefined) {
      console.error('usage: --emit "message"');
      process.exitCode = 2;
    } else {
      record('info', 'cli', message);
      console.log(`recorded: ${message}`);
    }
  } else {
    console.log('usage: node tools/alert.mjs --serve | --tail | --emit TEXT');
    process.exitCode = 2;
  }
}
