// Stronger vision probe: a 64x64 image split into left=blue, right=yellow.
// A model that truly sees says "blue and yellow" / two colours; one that merely
// accepts the part without looking answers generically or not at all.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { request } from './lib/freepi-api.mjs';

/** Minimal PNG encoder: 64x64, left half blue, right half yellow. */
function buildPng(size = 64) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const left = x < size / 2;
      raw[p++] = left ? 0 : 255;        // R
      raw[p++] = left ? 0 : 220;        // G
      raw[p++] = left ? 255 : 0;        // B
    }
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = buildPng().toString('base64');
const store = JSON.parse(
  readFileSync(path.join(os.homedir(), '.free-pi', 'proxy', 'accounts.json'), 'utf8'),
);
const accounts = store.accounts.filter((a) => a.token && !a.disabled);
const only = process.argv.slice(2);
const catalog = await request('/client-version?cli_version=0.6.15', { token: accounts[0].token });
const ids = (catalog.models || [])
  .filter((m) => !m.unavailable)
  .map((m) => m.id)
  .filter((id) => !only.length || only.includes(id));

const verdicts = [];
for (const id of ids) {
  let verdict = 'error';
  let detail = '';
  for (const account of accounts) {
    try {
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        token: account.token,
        body: {
          model: id,
          stream: false,
          max_tokens: 40,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Describe the colours in this image, left half then right half. Answer in under 15 words.',
                },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } },
              ],
            },
          ],
        },
      });
      const text = String(res?.choices?.[0]?.message?.content ?? '');
      const hitsBlue = /blue|blau/i.test(text);
      const hitsYellow = /yellow|gelb/i.test(text);
      verdict = hitsBlue && hitsYellow ? 'VISION' : (hitsBlue || hitsYellow ? 'partial' : 'text-only');
      detail = text.replace(/\s+/g, ' ').slice(0, 70);
      break;
    } catch (err) {
      detail = `${err.status || ''} ${err.code || ''}`.trim() || String(err.message).slice(0, 60);
      if (/concurrent|429/i.test(detail)) continue;
      verdict = /image|vision|modality/i.test(String(err.raw || err.message)) ? 'no-image' : 'error';
      break;
    }
  }
  verdicts.push({ id, verdict, detail });
  console.log(`${verdict.padEnd(10)} ${id.padEnd(34)} ${detail}`);
  await new Promise((r) => setTimeout(r, 900));
}

const vision = verdicts.filter((v) => v.verdict === 'VISION').map((v) => v.id);
console.log('\nTRUE VISION (' + vision.length + '): ' + vision.join(', '));
const partial = verdicts.filter((v) => v.verdict === 'partial').map((v) => v.id);
if (partial.length) console.log('PARTIAL: ' + partial.join(', '));
