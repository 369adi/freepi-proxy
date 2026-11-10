/**
 * The guard that watches the guard.
 *
 * Everything on this machine can fail quietly: the proxy loses all usable
 * accounts and answers 503, DSH disappears or comes back on another port, a
 * turn gets cut off by a restart. Nothing reports that by itself, so this
 * process polls the surfaces that know better and records an alert the moment
 * one of them turns bad.
 *
 * It is meant to run detached (see start-guard.ps1) so a taskkill on the app
 * tree cannot take it down. It only ever reads: it never starts, stops or
 * repairs anything on its own, because an automatic repair that guesses wrong
 * is worse than a clear alert.
 *
 * Usage:
 *   node tools/guard.mjs            one pass, prints what it found
 *   node tools/guard.mjs --loop     keep watching, interval from GUARD_INTERVAL
 *
 * @module tools/guard
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, summary } from './alert.mjs';
import { guiPort } from './watch-turn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOG_DIR = join(REPO, 'logs');
const PID_FILE = join(LOG_DIR, 'guard.pid');
const STATE_FILE = join(LOG_DIR, 'guard.state.json');

/** The proxy this repository runs. */
export const PROXY_URL = 'http://127.0.0.1:4000';

/** Seconds between passes in loop mode. */
const DEFAULT_INTERVAL = 20;

/**
 * Ask the proxy whether it still has a usable path to the models.
 *
 * Reaching the models route is not enough: the proxy happily lists models while
 * every account behind it is exhausted, which is exactly the failure that makes
 * requests fail with the process looking healthy. So the account picture from
 * /usage decides, and the models route only proves the server is answering.
 *
 * @returns {Promise<{ok: boolean, detail: object}>} what was found.
 */
async function checkProxy() {
  let usage;
  try {
    const response = await fetch(`${PROXY_URL}/usage`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      return { ok: false, detail: { reason: 'usage route answered', status: response.status } };
    }
    usage = await response.json();
  } catch (error) {
    return { ok: false, detail: { reason: 'proxy unreachable', error: String(error.message ?? error) } };
  }

  const budget = usage?.budget ?? {};
  const usable = Number(budget.usableAccounts ?? 0);
  const total = Number(budget.totalAccounts ?? 0);
  const action = usage?.nextAction?.action;
  const waiting = Number(usage?.queue?.waiting ?? 0);
  const failed = Object.values(usage?.served ?? {})
    .reduce((sum, lane) => sum + Number(lane?.failed ?? 0), 0);

  const detail = {
    models: undefined,
    usableAccounts: usable,
    totalAccounts: total,
    nextAction: action ?? null,
    waiting,
    failed,
  };

  // No usable account, or the proxy asking to mint/wait, means requests cannot
  // make progress even though the server is up.
  if (total > 0 && usable === 0) {
    return { ok: false, detail: { ...detail, reason: 'no usable account' } };
  }
  if (action === 'mint' || action === 'wait') {
    return { ok: false, detail: { ...detail, reason: `next action is ${action}` } };
  }

  // The models route is the surface the clients actually use; if it cannot list
  // anything the proxy is useless no matter what the account book says.
  try {
    const response = await fetch(`${PROXY_URL}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    const models = response.ok ? await response.json() : undefined;
    detail.models = Array.isArray(models?.data) ? models.data.length : 0;
  } catch (error) {
    return { ok: false, detail: { ...detail, reason: 'models route unreachable', error: String(error.message ?? error) } };
  }

  return { ok: true, detail };
}

/**
 * Ask whether the DSH GUI is up and on which port.
 * @returns {Promise<{ok: boolean, detail: object}>} what was found.
 */
async function checkDsh() {
  let port;
  try {
    port = await guiPort();
  } catch (error) {
    return { ok: false, detail: { reason: 'port probe failed', error: String(error.message ?? error) } };
  }
  if (port === undefined) {
    return { ok: false, detail: { reason: 'no GUI answered' } };
  }
  return { ok: true, detail: { port } };
}

/**
 * Run one pass over every surface and record what changed.
 *
 * Alerts are edge triggered: a surface that stays broken records one alert
 * when it breaks, not one every twenty seconds, so the log stays readable and
 * a real new failure is easy to spot.
 *
 * @returns {Promise<object>} the pass result, also used to print in one-shot mode.
 */
export async function pass() {
  mkdirSync(LOG_DIR, { recursive: true });
  const previous = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : {};

  const proxy = await checkProxy();
  const dsh = await checkDsh();

  const state = {
    at: new Date().toISOString(),
    proxy,
    dsh,
    previous: { proxy: previous.proxy?.ok, dsh: previous.dsh?.ok },
  };

  if (proxy.ok !== previous.proxy?.ok) {
    if (proxy.ok) {
      record('info', 'proxy', 'proxy is serving models again', proxy.detail);
    } else {
      record('critical', 'proxy', 'proxy cannot serve models', proxy.detail);
    }
  }
  if (dsh.ok !== previous.dsh?.ok) {
    if (dsh.ok) {
      record('info', 'dsh', `DSH gui is reachable on port ${dsh.detail.port}`, dsh.detail);
    } else {
      record('warn', 'dsh', 'DSH gui is not reachable', dsh.detail);
    }
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

/**
 * Whether this file is the entry point rather than an imported module.
 * @returns {boolean} true only for a direct invocation.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);

  if (argv.includes('--loop')) {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid));
    const interval = Number(process.env.GUARD_INTERVAL ?? DEFAULT_INTERVAL) * 1000;
    record('info', 'guard', `guard loop started (pid ${process.pid})`);
    // A fixed deadline keeps a forgotten loop from running forever.
    const deadline = Date.now() + Number(process.env.GUARD_HOURS ?? 12) * 3600 * 1000;
    while (Date.now() < deadline) {
      try {
        const state = await pass();
        console.log(`${state.at} proxy=${state.proxy.ok} dsh=${state.dsh.ok}`);
      } catch (error) {
        record('error', 'guard', 'guard pass threw', { error: String(error.message ?? error) });
      }
      await new Promise((done) => { setTimeout(done, interval); });
    }
    writeFileSync(PID_FILE, '0');
    record('info', 'guard', 'guard loop reached its deadline and stopped');
  } else {
    const state = await pass();
    console.log(JSON.stringify(state, null, 2));
    const overall = summary();
    console.log(overall.ok ? 'everything looks fine' : `open alerts: ${overall.actionable.length}`);
    process.exitCode = overall.ok ? 0 : 1;
  }
}
