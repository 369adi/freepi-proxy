// Set the image input declaration from measured capability.
// Only models that tools/probe-vision-strong.mjs proved can see get "- image".
// Everything else is left as text-only, because offering an attachment to a
// model that cannot read it is exactly the bug we are fixing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PATCH = process.env.CORDIS_PATCH_PATH || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const VALIDATOR = fileURLToPath(new URL('./validate-vision.py', import.meta.url));

// Measured: answered "left half blue, right half yellow" for a 64x64 split image.
const VISION = new Set([
  'particle',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'deepseek-v4-flash',
  'deepseek-v4.1-flash-abliterated',
  'gemma-4-uncensored',
  'gpt-6.1-terra',
  'gpt-6.1-terra-flex',
  'qwen3.5-35b-darkbloom',
]);

const lines = fs.readFileSync(PATCH, 'utf8').split('\n');
const out = [];
const applied = [];
let currentModel = null;
let inModelsList = false;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];

  if (line === '        models:') {
    inModelsList = true;
    out.push(line);
    continue;
  }
  // Any other 6-space key ends the provider block.
  if (/^      \S/.test(line)) {
    inModelsList = false;
    currentModel = null;
    out.push(line);
    continue;
  }

  const idm = /^ {10}- id: (\S+)$/.exec(line);
  if (inModelsList && idm) {
    currentModel = idm[1];
    out.push(line);
    continue;
  }

  if (currentModel && line === '            input:') {
    out.push(line);
    // Consume the existing "- text" / "- image" entries.
    let j = i + 1;
    const entries = [];
    while (j < lines.length && /^ {14}- \S+$/.test(lines[j])) {
      entries.push(lines[j].slice(16).trim());
      j += 1;
    }
    const want = VISION.has(currentModel) ? ['text', 'image'] : ['text'];
    const changed = want.length !== entries.length || want.some((w, k) => w !== entries[k]);
    if (changed) {
      applied.push(currentModel + ' -> [' + want.join(', ') + ']');
    }
    for (const w of want) out.push('              - ' + w);
    i = j - 1;
    continue;
  }

  out.push(line);
}

if (applied.length) {
  const backup = PATCH + '.bak-vision2-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  fs.copyFileSync(PATCH, backup);
  fs.writeFileSync(PATCH, out.join('\n'), 'utf8');
  console.log('backup: ' + backup);
  console.log('changes (' + applied.length + '):');
  for (const a of applied) console.log('  ' + a);
} else {
  console.log('no changes needed');
}

try {
  const res = execFileSync('python', [VALIDATOR], {
    encoding: 'utf8',
  });
  console.log(res);
} catch (err) {
  console.error('validation failed:\n' + (err.stdout || '') + (err.stderr || ''));
  process.exit(1);
}
