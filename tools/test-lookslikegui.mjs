// Verify that looksLikeGui() accepts the real GUI and rejects look-alikes.
// Run: node tools/test-lookslikegui.mjs <realPort>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'restart-dsh.mjs'), 'utf8');
// Extract the whole async function by brace matching; a naive indexOf('\n}\n')
// stops at the first inner block and silently tests stale code.
function extract(name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is unbalanced`);
}
// The sandbox needs the same globals the real module uses; without AbortSignal
// the extracted function throws inside its own catch and reports false, which
// would look like a code defect but is only a harness gap.
const context = { AbortSignal, fetch, setTimeout };
vm.runInNewContext(extract('looksLikeGui') + '\nthis.__looksLikeGui = looksLikeGui;', context);
const looksLikeGui = context.__looksLikeGui;

const realPort = Number(process.argv[2]);
const targets = [
  [realPort, 'real GUI', true],
  [4000, 'free-pi proxy (not HTML)', false],
  [4201, 'stray service 4201', false],
  [4202, 'stray service 4202', false],
];

let failures = 0;
for (const [port, label, expected] of targets) {
  if (!Number.isFinite(port)) continue;
  const actual = await looksLikeGui(port);
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} port ${port} (${label}): ${actual} (expected ${expected})`);
}

// Raw diagnosis of the real port, so a mismatch can be understood.
if (Number.isFinite(realPort)) {
  try {
    const r = await fetch(`http://127.0.0.1:${realPort}/`, { redirect: 'manual' });
    const text = (await r.text()).slice(0, 300);
    console.log(`\nreal port ${realPort}: status=${r.status} ` +
      `type=${r.headers.get('content-type')} server=${r.headers.get('server')}`);
    console.log(`body head: ${JSON.stringify(text)}`);
  } catch (error) {
    console.log(`real port probe failed: ${error.message}`);
  }
}
console.log(failures === 0 ? '\nlooksLikeGui behaves as required' : `\n${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
