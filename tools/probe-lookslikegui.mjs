// Direct probe: why does looksLikeGui reject the real port?
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'restart-dsh.mjs'), 'utf8');
const start = source.indexOf('async function looksLikeGui(');
const open = source.indexOf('{', start);
let depth = 0;
let end = -1;
for (let i = open; i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const body = source.slice(start, end);
console.log('--- extracted body ---');
console.log(body);
console.log('--- does it contain dsh web? ---', body.includes('dsh web'));

const context = { AbortSignal };
vm.runInNewContext(body + '\nthis.__f = looksLikeGui;', context);
const fn = context.__f;
const port = Number(process.argv[2] ?? 60443);
console.log('--- direct result ---', await fn(port));
