// Focused test for the argv splitter used by the restart tool.
// Run: node tools/test-splitargs.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'restart-dsh.mjs'), 'utf8');
const start = source.indexOf('function splitArgs(');
const end = source.indexOf('\n}\n', start) + 3;
if (start < 0) throw new Error('splitArgs not found');
const body = source.slice(start, end);
const context = {};
vm.runInNewContext(body, context);
const splitArgs = context.splitArgs;

const cases = [
  ['--user-data-dir="C:\\path with space"', ['--user-data-dir=C:\\path with space']],
  ['--expose-internals "C:\\a b\\c.js"', ['--expose-internals', 'C:\\a b\\c.js']],
  ['--flag="C:\\x y" --other=1', ['--flag=C:\\x y', '--other=1']],
  ['--simple', ['--simple']],
  ['', []],
  ['  --a   --b  ', ['--a', '--b']],
];

let failures = 0;
for (const [input, expected] of cases) {
  const actual = splitArgs(input);
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`);
}
console.log(failures === 0 ? 'all cases passed' : `${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
