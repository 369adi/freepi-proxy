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
// object. It never throws and never validates: unknown flags are silently
// dropped, every numeric flag goes through Number(...), and a flag missing its
// value consumes `undefined`. The tests below pin exactly that behaviour.

test('parseArgs returns the documented defaults for an empty argv', () => {
  assert.deepEqual(parseArgs([]), {
    count: null,       // "not given" - main() falls back to 1 (line 1745)
    dryRun: false,
    resume: false,
    status: false,
    forget: false,
    prefix: null,
    start: null,
    keepOpen: false,
    waitMin: 15,
    pauseMin: 3,
  });
});

test('parseArgs throws when argv is omitted entirely', () => {
  // Not a documented use - the only caller always passes process.argv.slice(2)
  // (line 112). But there is no `argv = []` default, so a bare call dereferences
  // undefined and throws a TypeError at the loop header (line 95).
  assert.throws(() => parseArgs(), TypeError);
});

test('parseArgs --count yields a number, not a string', () => {
  const o = parseArgs(['--count', '5']);
  assert.equal(o.count, 5);
  assert.equal(typeof o.count, 'number');
});

test('parseArgs --count converts numeric strings of any spelling', () => {
  assert.equal(parseArgs(['--count', '5.5']).count, 5.5);
  assert.equal(parseArgs(['--count', ' 7 ']).count, 7);
  assert.equal(parseArgs(['--count', '0']).count, 0);
  assert.equal(parseArgs(['--count', '-3']).count, -3);
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

test('parseArgs -h and --help set help (not part of the default object)', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  // `help` is absent from the initial object, so it is undefined by default.
  assert.equal(parseArgs([]).help, undefined);
});

test('parseArgs --prefix and --start are picked up', () => {
  const o = parseArgs(['--prefix', 'zz', '--start', '40']);
  assert.equal(o.prefix, 'zz');
  assert.equal(o.start, 40);
  assert.equal(typeof o.start, 'number');
});

test('parseArgs does NOT support --email; an email is never stored', () => {
  // GAP: there is no `--email` branch in parseArgs (lines 97-107). Addresses
  // are derived from prefix + number instead. The flag is silently ignored.
  const o = parseArgs(['--email', 'x@y.de']);
  assert.equal(o.email, undefined);
  assert.equal('email' in o, false);
  assert.deepEqual(o, parseArgs([]), '--email changes nothing');
});

test('parseArgs silently ignores unknown arguments', () => {
  // No else-branch, so an unrecognised token is skipped without an error.
  const o = parseArgs(['--bogus', 'value', 'positional', '-x']);
  assert.deepEqual(o, parseArgs([]));
  // And it does not disturb parsing of a known flag that follows.
  assert.equal(parseArgs(['--bogus', '--count', '2']).count, 2);
});

test('parseArgs with unknown argument does not throw', () => {
  assert.doesNotThrow(() => parseArgs(['--nope']));
  assert.doesNotThrow(() => parseArgs(['random']));
});

test('parseArgs --count abc yields NaN', () => {
  // BUG: no NaN validation. Number('abc') is NaN, and main() then does
  // ARGS.count || ... (line 1745); NaN is falsy, so the run silently falls
  // back to the default count instead of reporting the typo.
  const o = parseArgs(['--count', 'abc']);
  assert.ok(Number.isNaN(o.count), 'expected NaN for --count abc');
});

test('parseArgs --count with no value yields NaN', () => {
  // BUG: no NaN validation. argv[++i] runs off the end => Number(undefined)
  // => NaN, and the flag is not reported as malformed.
  assert.ok(Number.isNaN(parseArgs(['--count']).count));
});

test('parseArgs numeric flags all accept garbage as NaN', () => {
  // BUG: no NaN validation. The same hole exists for --start, --wait-min
  // and --pause-min. NaN waitMin reaches addOne() as a timeout.
  assert.ok(Number.isNaN(parseArgs(['--wait-min', 'abc']).waitMin));
  assert.ok(Number.isNaN(parseArgs(['--pause-min', 'x']).pauseMin));
  // --start falls back to the store number via `||`, so NaN is masked there.
  assert.ok(Number.isNaN(parseArgs(['--start', 'abc']).start));
});

test('parseArgs --prefix with no value stores undefined', () => {
  // BUG: no value check. The field is set to undefined, so the default object
  // no longer has prefix: null and main() falls through to settings.prefix.
  const o = parseArgs(['--prefix']);
  assert.equal(o.prefix, undefined);
  assert.equal('prefix' in o, true);
});

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

test('parseArgs leaves the input array untouched', () => {
  const argv = ['--count', '5', '--dry-run'];
  parseArgs(argv);
  assert.deepEqual(argv, ['--count', '5', '--dry-run']);
});

test('parseArgs returns a fresh object per call (no shared state)', () => {
  const a = parseArgs(['--count', '9']);
  const b = parseArgs([]);
  assert.equal(a.count, 9);
  assert.equal(b.count, null);
});
