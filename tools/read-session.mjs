/**
 * Read a DSH session transcript and tell whether a turn was cut off.
 *
 * The transcripts are zstd-compressed JSONL, and the compression is the trap:
 * a session file is a chain of many small frames, so decompressing the whole
 * buffer in one call returns only the first frame, which is roughly the session
 * header and nothing else. Every frame has to be cut out at its magic bytes and
 * decompressed on its own before the newline-separated records appear.
 *
 * The second trap is matching on text. The word "interrupted" appears in
 * ordinary assistant and tool output, so searching for it reports failures that
 * never happened. A turn that a restart closed is only ever recognised by its
 * structure: a turn/end record whose reason kind is "interrupted".
 *
 * Usage:
 *   node tools/read-session.mjs [file]
 *
 * @module tools/read-session
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS = join(homedir(), '.dsh', 'sessions');

/** Suffix every session transcript carries. */
export const SESSION_SUFFIX = 'session.v4.jsonl.zstd';

/** First bytes of a zstd frame. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Find every session transcript below a directory.
 * @param {string} [root] - directory to search, defaults to the DSH sessions.
 * @returns {string[]} absolute file paths.
 */
export function sessionFiles(root = SESSIONS) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === SESSION_SUFFIX) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The most recently written session transcript.
 * @param {string} [root] - directory to search.
 * @returns {{file: string, mtime: number}|undefined} newest file and its mtime.
 */
export function newestSession(root = SESSIONS) {
  let best;
  for (const file of sessionFiles(root)) {
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (best === undefined || mtime > best.mtime) best = { file, mtime };
  }
  return best;
}

/**
 * Decompress a multi-frame zstd file.
 *
 * Frames are located by their magic bytes and decoded one at a time. A frame
 * that fails to decode is skipped rather than thrown on: the transcripts are
 * written live, so the last frame of a file is regularly half written.
 *
 * @param {string} file - transcript to decode.
 * @returns {{text: string, frames: number, skipped: number}} decoded content and counts.
 */
export function decodeTranscript(file) {
  const buffer = readFileSync(file);
  const offsets = [];
  let at = 0;
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    offsets.push(at);
    at += ZSTD_MAGIC.length;
  }

  if (offsets.length === 0) {
    return { text: '', frames: 0, skipped: 0 };
  }

  const parts = [];
  let skipped = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      // A half-written tail frame is normal for a live transcript.
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start)));
      } catch {
        skipped += 1;
      }
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, skipped };
}

/**
 * Parse transcript text into record objects.
 * @param {string} text - decoded newline separated records.
 * @returns {object[]} parsed events, unparseable lines dropped.
 */
export function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch { /* a torn record is not an event */ }
  }
  return events;
}

/**
 * Every turn/end record with its reason.
 *
 * The reason shapes differ and that is the point: a user abort nests its cause
 * as reason.reason.kind, while a restart interruption is flat. Reading only
 * reason.reason would silently miss every interruption.
 *
 * @param {object[]} events - parsed transcript events.
 * @returns {object[]} turn ends as {seq, time, turn, kind}.
 */
export function turnEnds(events) {
  const ends = [];
  for (const event of events) {
    if (event?.type !== 'turn/end') continue;
    const reason = event.data?.reason ?? {};
    ends.push({
      seq: event.seq,
      time: event.time,
      turn: event.data?.turn,
      kind: reason.kind ?? 'unknown',
    });
  }
  return ends;
}

/**
 * The turns a restart cut off.
 * @param {object[]} events - parsed transcript events.
 * @returns {object[]} interrupted turn ends.
 */
export function interruptedTurns(events) {
  return turnEnds(events).filter((end) => end.kind === 'interrupted');
}

/**
 * What the last turn in the transcript is doing.
 *
 * A turn that started without an end is reported as open: either it is still
 * running, or the process vanished and nothing ever closed it.
 *
 * @param {object[]} events - parsed transcript events.
 * @returns {{turn: number|undefined, state: string}} turn number and state.
 */
export function lastTurn(events) {
  const ends = turnEnds(events);
  let startedTurn;
  for (const event of events) {
    if (event?.type === 'turn/start') startedTurn = event.data?.turn ?? startedTurn;
  }
  const last = ends.at(-1);
  if (last !== undefined && (startedTurn === undefined || last.turn >= startedTurn)) {
    const state = last.kind === 'interrupted' ? 'interrupted'
      : last.kind === 'aborted' ? 'aborted'
        : last.kind === 'error' ? 'error'
          : 'completed';
    return { turn: last.turn, state };
  }
  return { turn: startedTurn, state: startedTurn === undefined ? 'empty' : 'open' };
}

/**
 * Whether this file is the entry point rather than an imported module.
 * @returns {boolean} true only for a direct invocation.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  const requested = process.argv[2];
  const target = requested !== undefined
    ? resolve(requested)
    : newestSession()?.file;

  if (target === undefined || !existsSync(target)) {
    console.error('no session transcript found');
    process.exitCode = 2;
  } else {
    const decoded = decodeTranscript(target);
    const events = parseEvents(decoded.text);
    const ends = turnEnds(events);
    const interrupted = interruptedTurns(events);
    const last = lastTurn(events);

    console.log(`file: ${target}`);
    console.log(`frames: ${decoded.frames} skipped: ${decoded.skipped}`);
    console.log(`events: ${events.length}`);
    console.log(`turn ends: ${ends.length}`);
    for (const end of ends) {
      console.log(`  turn ${end.turn} seq ${end.seq}: ${end.kind}`);
    }
    console.log(`interrupted turns: ${interrupted.length}`);
    for (const end of interrupted) {
      console.log(`  turn ${end.turn} at ${new Date(end.time ?? 0).toISOString()}`);
    }
    console.log(`last turn: ${last.turn ?? '?'} state: ${last.state}`);
    console.log(`verdict: ${last.state === 'interrupted' ? 'TURN WAS CUT OFF' : 'no interruption pending'}`);
  }
}
