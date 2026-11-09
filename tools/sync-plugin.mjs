/**
 * Copy the plugin sources from this repo into the DSH plugin directory.
 *
 * The repo is the source of truth (it is the thing on GitHub); DSH loads the
 * copy under ~/.dsh/plugins. Run this after editing plugin/ and restart DSH.
 *
 *   node tools/sync-plugin.mjs           repo -> DSH
 *   node tools/sync-plugin.mjs --check   only report differences, change nothing
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '..', 'plugin');
const to = path.join(os.homedir(), '.dsh', 'plugins', 'freepi-accounts');
const checkOnly = process.argv.includes('--check');

const FILES = [
  'package.json',
  'lib/index.js',
  'lib/manual-selection.js',
  'test/manual-selection.test.mjs',
  'test/lifecycle.test.mjs',
];

if (!fs.existsSync(from)) {
  console.error('plugin/ not found next to tools/ - run this from the repo.');
  process.exit(1);
}

let changed = 0;
let missing = 0;
for (const rel of FILES) {
  const src = path.join(from, rel);
  const dst = path.join(to, rel);
  if (!fs.existsSync(src)) {
    console.log(`skip   ${rel} (not in repo)`);
    continue;
  }
  const body = fs.readFileSync(src);
  const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(body);
  if (same) {
    console.log(`same   ${rel}`);
    continue;
  }
  if (checkOnly) {
    console.log(`${fs.existsSync(dst) ? 'differs' : 'missing'} ${rel}`);
    missing += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, body);
  console.log(`copied ${rel}`);
  changed += 1;
}

if (checkOnly) {
  console.log(missing ? `\n${missing} file(s) out of sync.` : '\nplugin is in sync.');
  process.exit(missing ? 1 : 0);
}
console.log(
  changed
    ? `\n${changed} file(s) updated in ${to}\nRestart DSH so the new plugin code is loaded.`
    : `\nNothing to do - ${to} is already up to date.`,
);
