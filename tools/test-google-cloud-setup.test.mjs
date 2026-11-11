import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  sanitizeAccountsStoreForCloud,
  parseCloudCliArgs,
  parseExtraCloudFlags,
  classifyDriveQuota,
  probeAccountProStatus,
  getAccountDiscoverySummary,
  runGoogleCloudSetup,
  buildGoogleAccountUrl,
  MIN_PRO_STORAGE_BYTES,
} from './google-cloud-setup.mjs';

test('sanitizeAccountsStoreForCloud keeps only usable credentialed accounts and strips passwords', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-cloud-san-'));
  const file = path.join(dir, 'accounts.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      activeAccountId: 'acc-disabled',
      nextAccountNumber: 5,
      settings: { lowWatermark: 0.1 },
      accounts: [
        { id: 'acc-disabled', number: 1, token: 'tok1', disabled: true },
        { id: 'acc-bad', number: 2, token: 'tok2', tokenBad: true },
        { id: 'acc-notok', number: 3, token: '' },
        {
          id: 'acc-4',
          number: 4,
          email: 'user4@example.test',
          handle: 'user4',
          token: 'tok4',
          password: 'should-never-copy-if-present',
          history: [{ date: '2026-11-01', usedCredits: 100 }],
          usage: { remainingCreditsToday: 12000, allowanceCredits: 15000 },
        },
      ],
    }),
  );

  const out = sanitizeAccountsStoreForCloud(file);
  assert.equal(out.count, 1);
  const parsed = JSON.parse(out.json);
  assert.equal(parsed.activeAccountId, 'acc-4');
  assert.equal(parsed.accounts.length, 1);
  assert.equal(parsed.accounts[0].token, 'tok4');
  assert.equal('password' in parsed.accounts[0], false);
  assert.equal('history' in parsed.accounts[0], false);
});

test('parseCloudCliArgs parses deploy alias, flags, and account selectors', () => {
  assert.deepEqual(parseCloudCliArgs(['deploy']), {
    wantsJson: false,
    wantsList: false,
    wantsDeploy: true,
    rotateKey: false,
    reauth: false,
    accountArg: null,
  });

  assert.deepEqual(parseCloudCliArgs(['status']), {
    wantsJson: false,
    wantsList: true,
    wantsDeploy: false,
    rotateKey: false,
    reauth: false,
    accountArg: null,
  });

  assert.deepEqual(parseCloudCliArgs(['--account', '2', '--deploy', '--rotate-key']), {
    wantsJson: false,
    wantsList: false,
    wantsDeploy: true,
    rotateKey: true,
    reauth: false,
    accountArg: '2',
  });

  assert.deepEqual(parseExtraCloudFlags(['list', '--all', '--refresh']), {
    showAll: true,
    allowFree: false,
    refreshTiers: true,
  });
});

test('classifyDriveQuota detects Google Pro (>= 2 TB) vs free accounts accurately', () => {
  const pro5tb = classifyDriveQuota({ storageQuota: { limit: '5497558138880' } });
  assert.equal(pro5tb.isPro, true);
  assert.equal(pro5tb.tier, 'pro');
  assert.equal(pro5tb.storageLabel, '5 TB');

  const pro2tb = classifyDriveQuota({ storageQuota: { limit: String(MIN_PRO_STORAGE_BYTES) } });
  assert.equal(pro2tb.isPro, true);
  assert.equal(pro2tb.tier, 'pro');
  assert.equal(pro2tb.storageLabel, '2 TB');

  const free15gb = classifyDriveQuota({ storageQuota: { limit: '16106127360' } });
  assert.equal(free15gb.isPro, false);
  assert.equal(free15gb.tier, 'free');
  assert.equal(free15gb.storageLabel, '15 GB');

  const basic100gb = classifyDriveQuota({ storageQuota: { limit: String(100 * 1024 ** 3) } });
  assert.equal(basic100gb.isPro, false);
  assert.equal(basic100gb.tier, 'free');
});

test('probeAccountProStatus caches tiers, filters free accounts in proOnly mode, and rejects non-Pro setup without overwriting Pro account', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-pro-tier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tiersFile = path.join(dir, 'account-tiers.json');
  const accountFile = path.join(dir, 'account.json');

  await fs.writeFile(
    accountFile,
    JSON.stringify({
      account: 'pro1@example.test',
      projectId: 'proj-pro',
      isPro: true,
      tier: 'pro',
      storageLabel: '5 TB',
    }),
  );

  const probePro = await probeAccountProStatus('pro1@example.test', {
    tiersFile,
    accountFile,
    fetcher: async (email) => ({
      ok: true,
      about: { user: { emailAddress: email }, storageQuota: { limit: '5497558138880' } },
    }),
  });
  assert.equal(probePro.ok, true);
  assert.equal(probePro.isPro, true);
  assert.equal(probePro.storageLabel, '5 TB');

  const rawAccounts = [
    { email: 'pro1@example.test', fullName: '', browsers: ['Brave'], primaryBrowser: 'Brave', gcloudAuthed: true, configuredInDsh: true },
    { email: 'free1@example.test', fullName: '', browsers: ['Brave'], primaryBrowser: 'Brave', gcloudAuthed: false, configuredInDsh: false },
    { email: 'unknown@example.test', fullName: '', browsers: ['Edge'], primaryBrowser: 'Edge', gcloudAuthed: false, configuredInDsh: false },
  ];

  let revokedEmail = null;
  let restoredAccount = null;
  const rejectRes = await runGoogleCloudSetup({
    accountSelector: 'free1@example.test',
    tiersFile,
    accountFile,
    rawAccounts,
    authorizeFn: async (acc) => ({ ok: true, email: acc.email }),
    ensureProjectFn: () => ({ ok: true, projectId: 'proj-free' }),
    enableDriveFn: () => ({ ok: true }),
    prober: (email, opts) =>
      probeAccountProStatus(email, {
        ...opts,
        fetcher: async (e) => ({
          ok: true,
          about: { user: { emailAddress: e }, storageQuota: { limit: '16106127360' } },
        }),
      }),
    revokeGcloudAccountFn: (e) => { revokedEmail = e; },
    setGcloudAccountFn: (e) => { restoredAccount = e; },
    setGcloudProjectFn: () => {},
    onLog: () => {},
  });

  assert.equal(rejectRes.ok, false);
  assert.equal(rejectRes.notPro, true);
  assert.equal(revokedEmail, 'free1@example.test');
  assert.equal(restoredAccount, 'pro1@example.test');

  // Previous saved Pro account must remain untouched!
  const savedAfterReject = JSON.parse(await fs.readFile(accountFile, 'utf8'));
  assert.equal(savedAfterReject.account, 'pro1@example.test');
  assert.equal(savedAfterReject.projectId, 'proj-pro');

  // Now free1@example.test is remembered as free and automatically hidden in proOnly mode!
  const proOnlyList = getAccountDiscoverySummary({ proOnly: true, tiersFile, accountFile, rawAccounts });
  assert.equal(proOnlyList.hiddenNonProCount, 1);
  assert.deepEqual(proOnlyList.accounts.map((a) => a.email), ['pro1@example.test', 'unknown@example.test']);
  assert.equal(proOnlyList.accounts[0].tier, 'pro');
  assert.equal(proOnlyList.accounts[0].storageLabel, '5 TB');

  // With proOnly=false (--all), all accounts are visible
  const allList = getAccountDiscoverySummary({ proOnly: false, tiersFile, accountFile, rawAccounts });
  assert.equal(allList.hiddenNonProCount, 0);
  assert.equal(allList.accounts.length, 3);
});

test('buildGoogleAccountUrl binds exact Google account (authuser / login_hint) for multi-account browsers', () => {
  const billingUrl = buildGoogleAccountUrl(
    'https://console.cloud.google.com/billing/linkedaccount?project=demo-proj',
    'pro.user@example.test',
  );
  assert.equal(
    billingUrl,
    'https://console.cloud.google.com/billing/linkedaccount?project=demo-proj&authuser=pro.user%40example.test',
  );

  const tosUrl = buildGoogleAccountUrl('https://console.cloud.google.com/projectcreate', 'pro.user@example.test');
  assert.equal(tosUrl, 'https://console.cloud.google.com/projectcreate?authuser=pro.user%40example.test');

  const oauthUrl = buildGoogleAccountUrl('https://accounts.google.com/o/oauth2/auth?client_id=123', 'pro.user@example.test');
  assert.equal(oauthUrl, 'https://accounts.google.com/o/oauth2/auth?client_id=123&login_hint=pro.user%40example.test');
});
