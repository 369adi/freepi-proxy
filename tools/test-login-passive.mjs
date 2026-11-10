// Guards the sign-in passivity rules. These are the bugs that made /freepi-add
// press buttons while the person was still logging in with Google and bounce
// them back to the GitHub login screen.
import fs from 'node:fs';
import path from 'node:path';

const entry = path.join('C:\\Users\\liket\\Documents\\freepi-proxy', 'plugin', 'lib', 'index.js');
const code = fs.readFileSync(entry, 'utf8');

let failed = 0;
function check(name, ok) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) failed += 1;
}

// ---- structure: the driver is passive on sign-in pages -------------------
check('sign-in detector exists', /function isSignInPage\(url, text\)/.test(code));
check(
  'sign-in branch never clicks',
  /if \(onSignIn\) \{[\s\S]{0,700}?continue;\n\s*\}/.test(code) &&
    !/if \(onSignIn\) \{[\s\S]{0,700}?clickByLabel/.test(code),
);
check('settle grace period present', /const settleUntil = Date\.now\(\) \+ \(opts\.settleMs \?\? 4000\)/.test(code));
check('grace period skips actions', /if \(Date\.now\(\) < settleUntil\) continue;/.test(code));
check('waitForLogin no longer tied to ephemeral', /waitForLogin: true,/.test(code));

// ---- the click regexes themselves ---------------------------------------
// The device-activation page shows "Signed in as <user>" plus a bare Continue.
// That Continue must be clickable, otherwise the flow stalls while a human
// watches a button nobody presses.
const continueMatch = code.match(
  /clickByLabel\(session, '(\/\\\\bcontinue\\\\b[^']*)'/,
);
check('device-activation Continue is clicked', Boolean(continueMatch));
check(
  'Continue click is guarded by NEVER_CLICK',
  /clickByLabel\(session, '\/\\\\bcontinue\\\\b[\s\S]{0,120}?NEVER_CLICK/.test(code),
);

// The old bug: a bare ^continue matched "Continue with Google".
const bareContinue = /\^continue\|/;
check('no bare ^continue wildcard left in the driver', !bareContinue.test(code));

const authorizeMatch = code.match(
  /'\/authorize\|autorisieren\|grant access\|zugriff gewaehren\|approve access\|akzeptieren\/i'/,
);
check('authorize regex found', Boolean(authorizeMatch));
check(
  'authorize regex does not match plain Continue',
  !/\^continue/.test(authorizeMatch?.[0] || '\u0000'),
);

// The authorize button ships disabled and a page script may never enable it.
check(
  'disabled authorize button is unlocked before submit',
  /if \(b\.disabled\) \{\s*b\.disabled = false;[\s\S]{0,900}?requestSubmit\(b\)/.test(code),
);
check(
  'form.requestSubmit used for input[type=submit]',
  /requestSubmit\(b\)/.test(code),
);

// ---- behaviour of the extracted functions --------------------------------
// Re-create isSignInPage from source and exercise it against real page texts.
const fnSrc = code.match(/function isSignInPage\(url, text\) \{[\s\S]*?\n\}/)[0];
const isSignInPage = new Function('return ' + fnSrc)();

const signInCases = [
  ['https://github.com/login/oauth/authorize?x=1', '', 'github oauth login'],
  ['https://accounts.google.com/o/oauth2/auth', 'Choose an account', 'google chooser'],
  ['https://github.com/sessions/verified-device', 'two-factor', '2FA prompt'],
  ['https://github.com/login', 'Sign in with Google', 'provider button page'],
];
for (const [url, text, label] of signInCases) {
  check('passive on ' + label, isSignInPage(url, text) === true);
}

const notSignIn = [
  ['https://github.com/login/device', 'Sign in to GitHub', 'device code page'],
  ['https://github.com/login/device/success', 'Device connected', 'success page'],
  ['https://freepi.ai/', 'welcome', 'app page'],
];
for (const [url, text, label] of notSignIn) {
  check('not passive on ' + label, isSignInPage(url, text) === false);
}

console.log('\n' + (failed === 0 ? 'all checks passed' : failed + ' check(s) FAILED'));
process.exit(failed === 0 ? 0 : 1);
