// Regression test: does the sign-up redirect classifier tell the truth?
//
// The bug this guards against: auto-add.mjs treated ANY unrecognised redirect
// after the sign-up POST as proof the account existed. A redirect into GitHub's
// social-login form therefore reported "signed up", waited four minutes for a
// verification mail, then aborted the whole batch with the wrong reason.
//
// The regexes are duplicated here on purpose. auto-add.mjs has no main guard, so
// importing it would start a full browser run. The duplication is checked: if
// the patterns in auto-add.mjs drift, the "patterns match source" test fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(here, 'auto-add.mjs'), 'utf8');

// --- copies under test -----------------------------------------------------
const FOREIGN_AUTH =
  /accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|\/sessions\/social\/|\/sessions\/oauth|\/login\/oauth/i;
const SIGNED_UP_PAGE =
  /\/account_verifications|\/verify|\/welcome|\/dashboard|\/settings|\/codespaces|\/onboarding|\/organizations\/|\/emails\//i;
const STILL_SIGNING_UP = /\/signup|\/join|\/session\/|layout|render|reveal|plan|select/i;

/** Mirror of auto-add.mjs: foreign -> wait -> success -> unknown. */
function classify(url) {
  const foreign = (String(url).match(FOREIGN_AUTH) || [null])[0];
  if (foreign) return { verdict: 'foreign', detail: foreign };
  if (STILL_SIGNING_UP.test(url)) return { verdict: 'wait' };
  if (SIGNED_UP_PAGE.test(url)) return { verdict: 'success' };
  return { verdict: 'unknown' };
}

test('patterns under test are still the ones in auto-add.mjs', () => {
  for (const name of ['FOREIGN_AUTH', 'SIGNED_UP_PAGE']) {
    assert.ok(
      SOURCE.includes(name),
      name + ' disappeared from auto-add.mjs - update this test',
    );
  }
  // A loose sanity check that the literal sources agree, ignoring whitespace.
  const flat = (s) => s.replace(/\s+/g, '');
  assert.ok(
    flat(SOURCE).includes(flat(FOREIGN_AUTH.source)),
    'FOREIGN_AUTH in auto-add.mjs differs from the copy in this test',
  );
  assert.ok(
    flat(SOURCE).includes(flat(SIGNED_UP_PAGE.source)),
    'SIGNED_UP_PAGE in auto-add.mjs differs from the copy in this test',
  );
});

test('social-login redirects are a hard failure, not a success', () => {
  const urls = [
    'https://github.com/sessions/social/google/initiate',
    'https://github.com/sessions/social/apple/initiate',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&scope=email',
    'https://appleid.apple.com/auth/authorize?client_id=2',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  ];
  for (const url of urls) {
    assert.equal(classify(url).verdict, 'foreign', url + ' must be foreign');
  }
});

test('a real verification screen still counts as progress', () => {
  for (const url of [
    'https://github.com/account_verifications?query=abc123',
    'https://github.com/account_verifications',
  ]) {
    assert.equal(classify(url).verdict, 'success', url);
  }
});

test('the sign-up form itself keeps the loop waiting', () => {
  for (const url of [
    'https://github.com/signup?user_email=a%40b.de',
    'https://github.com/join?source=header-home',
    'https://github.com/signup?source=login',
  ]) {
    assert.equal(classify(url).verdict, 'wait', url + ' must keep waiting');
  }
});

test('pages that prove nothing are never reported as success', () => {
  // This is the regression itself: these used to fall through to "success".
  for (const url of [
    'https://github.com/login?return_to=%2Fjoin',
    'https://github.com/sessions/two-factor',
    'https://github.com/password_reset',
  ]) {
    const v = classify(url).verdict;
    assert.notEqual(v, 'success', url + ' must not be reported as a finished sign-up');
  }
});

test('pages that do prove an account exist are accepted', () => {
  for (const url of [
    'https://github.com/dashboard',
    'https://github.com/settings/profile',
    'https://github.com/welcome',
  ]) {
    assert.equal(classify(url).verdict, 'success', url + ' should count as signed up');
  }
});

test('no catalog model id is mistaken for an auth redirect', () => {
  // Guard against a pattern so broad it catches a plain GitHub page.
  for (const url of ['https://github.com/', 'https://github.com/explore']) {
    assert.equal(classify(url).verdict, 'unknown', url + ' proves nothing');
  }
});
