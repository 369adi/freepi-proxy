// Extracts one file out of an asar archive to a real path.
//
//   node tools/asar-get.mjs <archive.asar> <path-inside-archive> <output-file>
import fs from 'node:fs';

const [, , archive, inner, out] = process.argv;
if (!archive || !inner || !out) {
  console.log('usage: node tools/asar-get.mjs <archive.asar> <inner-path> <output-file>');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
const size = fs.fstatSync(fd).size;
const probe = Buffer.alloc(Math.min(1 << 24, size));
fs.readSync(fd, probe, 0, probe.length, 0);
const text = probe.toString('utf8');
const open = text.indexOf('{');
let depth = 0, end = -1, inString = false, escaped = false;
for (let i = open; i < text.length; i++) {
  const ch = text[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') inString = false;
    continue;
  }
  if (ch === '"') { inString = true; continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const header = JSON.parse(text.slice(open, end));
// The archive starts with two pickles: a UInt32 size plus that many bytes of
// padding, then the header JSON. Taking the JSON offset as the data start is
// wrong by exactly those leading pickles, which silently shifts every extracted
// file. The header size is stored in the second UInt32 of the file.
const headerSize = probe.readUInt32LE(4);
const dataStart = 8 + Math.ceil(headerSize / 4) * 4;

let node = header;
for (const part of inner.split('/')) {
  if (!node.files || !node.files[part]) {
    console.log(`not in archive: ${inner}`);
    process.exit(1);
  }
  node = node.files[part];
}
if (node.files) { console.log(`is a directory: ${inner}`); process.exit(1); }

if (node.unpacked) {
  console.log(`stored unpacked, read it directly: ${archive}.unpacked/${inner}`);
  process.exit(1);
}

const buf = Buffer.alloc(Number(node.size));
let read = 0;
const start = dataStart + Number(node.offset || 0);
while (read < buf.length) {
  const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
  if (n <= 0) break;
  read += n;
}
fs.writeFileSync(out, buf);
fs.closeSync(fd);
console.log(`wrote ${read} bytes to ${out}`);
