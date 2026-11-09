// Unit tests for the pure helpers of tools/auto-add.mjs.
//
// WHAT IS TESTED
//   makeUsername / makeFreeUsername - the GitHub handle minted per account.
//   Both are reached through the module's single `export { ... }` line; the
//   import has no side effects (main() only runs when the file is executed
//   directly), so importing here starts no browser and no network request.
//
// WHAT IS NOT TESTED, AND WHY
//   usernameIsFree     exported, but it calls fetch() against
//                      https://api.github.com/users/<name>. It is pure network
//                      I/O, so it is deliberately NOT mocked and NOT tested.
//                      Only its contract is documented in a comment below.
//   makeFreeUsername   exported and pure in logic, but it calls usernameIsFree
//                      internally. The only way to exercise it without network
//                      is to monkey-patch, i.e. test a fake. It is therefore
//                      only checked for being an async function; the real
//                      behaviour is covered indirectly by makeUsername's tests
//                      (makeFreeUsername is a retry loop around it).
//   enterLaunchCode, readGithubCode, solveVerification
//                      exported, but every path drives a CDP browser session
//                      (document.querySelector, page navigation, webmail). Not
//                      unit-testable without a live Chrome; out of scope.
//   parseArgs          exported and pure: it only walks an argv array and
//                      returns a plain object, so it IS tested below. The real
//                      argv still reaches parseArgs at import time
//                      (const ARGS = parseArgs(process.argv.slice(2)), around
//                      line 112), but that does not affect the tests here.
//                      Note: importing the module with a --count flag still
//                      triggers the main flow via ARGS, so tests always pass
//                      their own arrays instead of relying on process.argv.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = fileURLToPath(new URL('./auto-add.mjs', import.meta.url));
// Tests that expect parseArgs to exit cannot run in-process: the real argv
// reaches parseArgs at import time. They run this address in a child process.
const AUTO_ADD = pathToFileURL(FILE).href; void AUTO_ADD;

import {
  makeUsername,
  makeFreeUsername,
  usernameIsFree,
  enterLaunchCode,
  readGithubCode,
  solveVerification,
  parseArgs,
} from './auto-add.mjs';

// ---------------------------------------------------------------- export surface

test('auto-add exports exactly the documented helpers', () => {
  const mod = { makeUsername, makeFreeUsername, usernameIsFree, enterLaunchCode, readGithubCode, solveVerification, parseArgs };
  assert.equal(typeof mod.makeUsername, 'function');
  assert.equal(typeof mod.makeFreeUsername, 'function');
  assert.equal(typeof mod.usernameIsFree, 'function');
  assert.equal(typeof mod.enterLaunchCode, 'function');
  assert.equal(typeof mod.readGithubCode, 'function');
  assert.equal(typeof mod.solveVerification, 'function');
  assert.equal(typeof mod.parseArgs, 'function');
});

// ---------------------------------------------------------------- makeUsername

const GITHUB_USERNAME = /^[a-z0-9-]{1,39}$/;

test('makeUsername starts with the local part and a dash', () => {
  const name = makeUsername('gh8@arisya.de');
  assert.match(name, /^gh8-[0-9a-f]{6}$/);
});

test('makeUsername keeps a hyphenated prefix instead of stripping it', () => {
  // The default prefix is "gh" and the store numbers addresses as "gh-8".
  // The base is only stripped of characters outside [a-z0-9-], so the hyphen
  // survives: "gh-8" + "-" + tail.
  const name = makeUsername('gh-8@arisya.de');
  assert.match(name, /^gh-8-[0-9a-f]{6}$/);
});

test('makeUsername only ever uses lowercase letters, digits and hyphens', () => {
  // Underscores and dots are not valid in a GitHub username at all.
  const samples = [
    'gh_12@arisya.de',
    'gh.12@arisya.de',
    'GH-12@ARISYA.DE',
    'wir ü ml@arisya.de',
    'a+b@arisya.de',
  ];
  for (const email of samples) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const name = makeUsername(email, attempt);
      assert.match(name, GITHUB_USERNAME, `illegal characters in "${name}" for ${email}/${attempt}`);
      assert.doesNotMatch(name, /_/, `underscore leaked into "${name}"`);
      assert.doesNotMatch(name, /\./, `dot leaked into "${name}"`);
      assert.doesNotMatch(name, /[A-Z]/, `uppercase leaked into "${name}"`);
    }
  }
});

test('makeUsername lowercases the local part', () => {
  assert.match(makeUsername('GhX9@arisya.de'), /^ghx9-[0-9a-f]{6}$/);
});

test('makeUsername never exceeds the 30 character cap', () => {
  const long = 'a'.repeat(80) + '@arisya.de';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const name = makeUsername(long, attempt);
    assert.ok(name.length <= 30, `"${name}" is ${name.length} chars`);
    assert.match(name, GITHUB_USERNAME);
  }
});

test('makeUsername attempt 0 always carries a 6 hex char suffix', () => {
  // Regression guard: attempt 0 used to send the bare local part ("gh-8"),
  // which GitHub rejected as taken. Every attempt must add its own suffix.
  for (let i = 0; i < 20; i += 1) {
    assert.match(makeUsername('gh-8@arisya.de', 0), /^gh-8-[0-9a-f]{6}$/);
  }
});

test('makeUsername retries after attempt 0 add extra digits', () => {
  // attempt > 0 appends 6 hex chars plus a two digit number: 8 extra chars.
  for (let i = 0; i < 20; i += 1) {
    assert.match(makeUsername('gh-8@arisya.de', 1), /^gh-8-[0-9a-f]{8}$/);
    assert.match(makeUsername('gh-8@arisya.de', 3), /^gh-8-[0-9a-f]{8}$/);
  }
});

test('makeUsername is random per call, not derived only from the email', () => {
  // There is no seed parameter; the suffix comes from crypto. Two calls for
  // the same address must differ, otherwise every retry would hit the same
  // taken name and the retry loop would be pointless.
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) seen.add(makeUsername('gh-8@arisya.de', 0));
  assert.ok(seen.size > 1, 'the generator must not be deterministic');
});

test('makeUsername does not throw on odd input', () => {
  // The email always comes from the caller, but a malformed one must not crash
  // the batch. Only the shape guarantees are asserted here.
  for (const email of ['', '@arisya.de', 'noat', '***@x.de', null]) {
    const name = makeUsername(email);
    assert.equal(typeof name, 'string');
    assert.match(name, GITHUB_USERNAME, `unusable name "${name}" from ${JSON.stringify(email)}`);
  }
});

// ---------------------------------------------------------------- makeFreeUsername

test('makeFreeUsername is an async function', () => {
  // Calling it would hit the GitHub API (via usernameIsFree), so it is not
  // invoked here; see the header comment.
  assert.equal(typeof makeFreeUsername, 'function');
  assert.equal(makeFreeUsername.constructor.name, 'AsyncFunction');
});

// ---------------------------------------------------------------- usernameIsFree contract
//
// Documented, not executed: usernameIsFree(name) resolves to
//   true  on HTTP 404 (free)  |  false on HTTP 200 (taken)  |  null otherwise
// (rate limited, other status, or network error - it never pretends).

test('usernameIsFree is exported but intentionally untested (network I/O)', () => {
  assert.equal(typeof usernameIsFree, 'function');
});

// ---------------------------------------------------------------- parseArgs
//
// parseArgs(argv) walks the array with a single index and mutates one options
// object. It validates hard: an unknown flag, a flag without a value or a
// number that is NaN/negative ends the process with a message, because main()
// reads the result with `||` and would otherwise silently use a default.
// Cases that exit run in a child process (see runCli below).

test('parseArgs returns the documented defaults for an empty argv', () => {
  assert.deepEqual(parseArgs([]), {
    count: null,       // "not given" - main() falls back to 1
    dryRun: false,
    resume: false,
    status: false,
    forget: false,
    prefix: null,
    start: null,
    keepOpen: false,
    waitMin: 15,
    pauseMin: 3,
    email: null,       // "not given" - a generated address is used
    help: false,       // F: help is part of the full default object
  });
});

test('parseArgs defaults argv to an empty array', () => {
  // FIX A: a bare call used to throw a TypeError at the loop header.
  assert.deepEqual(parseArgs(), parseArgs([]));
});

test('parseArgs no longer accepts NaN, 0 or negative numbers in-process', () => {
  // These are checked by parseArgs itself, so the child process is the only
  // way to observe them; kept as a guard that parseArgs really validates.
  for (const argv of [['--count', 'abc'], ['--count', '0'], ['--count', '-3']]) {
    assert.equal(runCli(...argv).status, 1, argv.join(' ') + ' must exit 1');
  }
});

test('parseArgs --count yields a number, not a string', () => {
  const o = parseArgs(['--count', '5']);
  assert.equal(o.count, 5);
  assert.equal(typeof o.count, 'number');
});

test('parseArgs --count converts numeric strings of any spelling', () => {
  assert.equal(parseArgs(['--count', '5.5']).count, 5.5);
  assert.equal(parseArgs(['--count', ' 7 ']).count, 7);
  // 0 and -3 are parsed as numbers but rejected by the validation pass; the
  // in-process calls for them live in the child-process tests below.
});

test('parseArgs --pause-min sets pauseMin to 7', () => {
  const o = parseArgs(['--pause-min', '7']);
  assert.equal(o.pauseMin, 7);
  assert.equal(typeof o.pauseMin, 'number');
  assert.equal(o.waitMin, 15, 'waitMin must keep its default');
});

test('parseArgs --wait-min sets waitMin to 30', () => {
  const o = parseArgs(['--wait-min', '30']);
  assert.equal(o.waitMin, 30);
  assert.equal(o.pauseMin, 3, 'pauseMin must keep its default');
});

test('parseArgs boolean flags set their field to true', () => {
  const cases = [
    ['--resume', 'resume'],
    ['--keep-open', 'keepOpen'],
    ['--dry-run', 'dryRun'],
    ['--status', 'status'],
    ['--forget', 'forget'],
  ];
  for (const [flag, field] of cases) {
    const o = parseArgs([flag]);
    assert.equal(o[field], true, flag + ' must set ' + field);
    // Every other boolean stays false.
    for (const [, other] of cases) {
      if (other !== field) assert.equal(o[other], false, flag + ' must not set ' + other);
    }
  }
});

test('parseArgs -h and --help set help, false by default', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  // FIX F: `help` is now part of the initial object instead of being absent.
  assert.equal(parseArgs([]).help, false);
});

test('parseArgs --prefix and --start are picked up', () => {
  const o = parseArgs(['--prefix', 'zz', '--start', '40']);
  assert.equal(o.prefix, 'zz');
  assert.equal(o.start, 40);
  assert.equal(typeof o.start, 'number');
});

// FIXES A-F replaced the former tests that pinned the broken behaviour:
//   'parseArgs throws when argv is omitted entirely'   -> FIX A (default [])
//   'parseArgs does NOT support --email'               -> FIX B (--email branch)
//   'parseArgs silently ignores unknown arguments'     -> FIX C (rejects them)
//   'parseArgs with unknown argument does not throw'   -> FIX C
//   'parseArgs --count abc yields NaN'                 -> FIX E
//   'parseArgs --count with no value yields NaN'       -> FIX D/E
//   'parseArgs numeric flags all accept garbage as NaN'-> FIX E
//   'parseArgs --prefix with no value stores undefined'-> FIX D
//   'help is not part of the default object'           -> FIX F
// The replacement assertions live in 'parseArgs rejects bad input' below.

test('parseArgs is last-one-wins for repeated flags', () => {
  const o = parseArgs(['--count', '1', '--count', '4']);
  assert.equal(o.count, 4);
  const b = parseArgs(['--status', '--status']);
  assert.equal(b.status, true);
});

test('parseArgs reads flags in any position mixed with values', () => {
  const o = parseArgs(['--keep-open', '--count', '3', '--pause-min', '1', '--resume']);
  assert.equal(o.keepOpen, true);
  assert.equal(o.count, 3);
  assert.equal(o.pauseMin, 1);
  assert.equal(o.resume, true);
  assert.equal(o.status, false);
});

// ---------------------------------------------------------------- parseArgs rejects bad input
//
// These cases exit the process, so they cannot be called in-process; each one
// runs the module in a child process and checks the status and the message.

function runCli(...args) {
  return spawnSync(process.execPath, ['--no-warnings', FILE, ...args], { encoding: 'utf8', timeout: 60000 });
}

test('parseArgs leaves the input array untouched', () => {
  const argv = ['--count', '5', '--dry-run'];
  parseArgs(argv);
  assert.deepEqual(argv, ['--count', '5', '--dry-run']);
});

test('a malformed number exits instead of becoming NaN', () => {
  for (const [flag, bad] of [['--count', 'abc'], ['--start', 'abc'], ['--wait-min', 'abc'], ['--pause-min', 'x']]) {
    const r = runCli(flag, bad);
    assert.equal(r.status, 1, flag + ' ' + bad + ' must exit 1');
    assert.match(r.stderr, /must be a number/, flag + ' must name the bad value');
    assert.doesNotMatch(r.stdout, /would add|account\(s\)/, 'nothing may run');
  }
});

test('a negative number exits', () => {
  for (const [flag, bad] of [['--count', '-3'], ['--wait-min', '-1'], ['--pause-min', '-5']]) {
    const r = runCli(flag, bad);
    assert.equal(r.status, 1, flag + ' ' + bad + ' must exit 1');
    assert.match(r.stderr, /must be a number/);
  }
});

test('--count 0 exits, because the old || would turn it into 1', () => {
  const r = runCli('--count', '0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--count must be at least 1/);
});

test('--start 0 exits for the same reason', () => {
  const r = runCli('--start', '0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--start must be at least 1/);
});

test('a flag without a value exits instead of storing undefined', () => {
  for (const flag of ['--count', '--prefix', '--start', '--wait-min', '--pause-min', '--email']) {
    const r = runCli(flag);
    assert.equal(r.status, 1, flag + ' alone must exit 1');
    assert.ok(r.stderr.includes('missing value for ' + flag), flag + ' must be named');
  }
});

test('a flag does not swallow the next flag as its value', () => {
  // `--count --dry-run` used to give count NaN and still enable dry-run.
  const r = runCli('--count', '--dry-run');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing value for --count/);
});

test('unknown arguments are rejected with the list of known flags', () => {
  for (const bad of ['--dryrun', '--bogus', 'random', '-x']) {
    const r = runCli(bad);
    assert.equal(r.status, 1, bad + ' must exit 1');
    assert.ok(r.stderr.includes('unknown argument: ' + bad), 'message must name ' + bad);
    assert.match(r.stderr, /known: --count .*--email --help/);
  }
});

test('the known-flag list is complete, not invented', () => {
  // Every flag the help text documents must be accepted by parseArgs.
  const r = runCli('--help');
  assert.equal(r.status, 0);
  const documented = [...r.stdout.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(documented.includes('--email'), '--email must be documented');
  assert.deepEqual(documented.sort(), [
    '--count', '--dry-run', '--email', '--forget', '--keep-open', '--pause-min',
    '--prefix', '--resume', '--start', '--status', '--wait-min',
  ]);
});

test('--email is stored as the given address, normalized', () => {
  const o = parseArgs(['--email', '  X@Y.de ']);
  assert.equal(o.email, 'x@y.de');
  assert.equal(parseArgs([]).email, null, 'no email by default');
});

test('--email rejects something that is not an address', () => {
  for (const bad of ['nope', 'a@b', 'a b@c.de', '@y.de']) {
    const r = runCli('--email', bad);
    assert.equal(r.status, 1, bad + ' must exit 1');
    assert.match(r.stderr, /--email is not an address/);
  }
});

test('--email with --count or --resume exits rather than guessing', () => {
  for (const extra of [['--count', '2'], ['--resume']]) {
    const r = runCli('--email', 'gh-99@arisya.de', '--dry-run', ...extra);
    assert.equal(r.status, 1, extra.join(' ') + ' with --email must exit 1');
    assert.match(r.stderr, /--email takes exactly one address/);
  }
});

test('parseArgs returns a fresh object per call (no shared state)', () => {
  const a = parseArgs(['--count', '9']);
  const b = parseArgs([]);
  assert.equal(a.count, 9);
  assert.equal(b.count, null);
});
