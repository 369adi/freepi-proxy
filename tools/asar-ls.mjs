// Lists the files inside an Electron asar archive without extracting it.
//
// The format is a repeated pickle: a 4-byte UInt32 length, then that many bytes
// of header JSON holding a directory tree, then the file contents in the same
// order. Reading the header alone is enough to find a file and to know where its
// bytes live, which is all that is needed to search a packed app.
//
//   node tools/asar-ls.mjs <archive> [substring-filter]
import fs from 'node:fs';

const archive = process.argv[2];
const filter = (process.argv[3] || '').toLowerCase();
if (!archive) {
  console.log('usage: node tools/asar-ls.mjs <archive.asar> [filter]');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
// Node's asar writer emits the header as a raw JSON blob followed by the data;
// libchromium's reader tolerates a trailing checksum, so parse the JSON by
// scanning for its true end instead of assuming a fixed layout.
const probe = Buffer.alloc(Math.min(1 << 24, fs.fstatSync(fd).size));
fs.readSync(fd, probe, 0, probe.length, 0);
const text = probe.toString('utf8');
// The directory listing is the outermost JSON object in the first bytes.
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
if (end < 0) { console.log('could not find the header boundary'); process.exit(1); }
const header = JSON.parse(text.slice(open, end));
const headerBytes = Buffer.byteLength(text.slice(0, end), 'utf8');
// File data follows the header, 8-byte aligned from the start of the file.
const dataStart = headerBytes + ((8 - (headerBytes % 8)) % 8);

const found = [];
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? prefix + '/' + name : name;
    if (entry.files) { walk(entry, full); continue; }
    found.push({ path: full, offset: Number(entry.offset || 0), size: entry.size || 0, unpacked: !!entry.unpacked });
  }
}
walk(header, '');

const matching = filter ? found.filter((f) => f.path.toLowerCase().includes(filter)) : found;
const minSize = Number(process.env.ASAR_MIN_SIZE || 0);
const limited = minSize ? matching.filter((f) => f.size >= minSize) : matching;
limited.sort((a, b) => b.size - a.size);
console.log(`archive: ${archive}`);
console.log(`entries: ${found.length}  matching: ${matching.length}  shown: ${limited.length}  data starts at ${dataStart}`);
const cap = Number(process.env.ASAR_LIMIT || 400);
for (const f of limited.slice(0, cap)) {
  console.log(`  ${f.unpacked ? 'U' : ' '} ${String(f.size).padStart(10)}  ${f.path}`);
}
if (limited.length > cap) console.log(`  ... ${limited.length - cap} more`);

// Second output line for scripting: absolute byte offset of a named file.
const pick = process.env.ASAR_PICK;
if (pick) {
  const hit = found.find((f) => f.path === pick);
  if (hit) console.log(`OFFSET ${hit.offset} SIZE ${hit.size} ABS ${dataStart + hit.offset}`);
  else console.log(`NOT FOUND ${pick}`);
}
fs.closeSync(fd);
