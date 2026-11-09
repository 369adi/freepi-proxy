// A UTF-8 byte-order mark in front of a JSON file is a real hazard here:
// PowerShell's Set-Content and Out-File add one, and JSON.parse() rejects it
// with "Unexpected token \uFEFF" rather than anything useful. The store is
// hand-edited and written by assorted tooling, so a BOM must be tolerated
// instead of being reported as a corrupt file.
//
// These tests pin both directions: a BOM parses, and a file that is actually
// broken still fails loudly rather than being silently replaced by defaults.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseJsonText, loadStore, mustLoadStore, saveStore, emptyStore } from './lib/store.mjs';

test('a missing store file is not an error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const store = await loadStore(path.join(dir, 'nope.json'));
  assert.equal(store.loadError, undefined, 'first run must not be reported as a failure');
  assert.deepEqual(store.accounts, []);
});

test('a corrupt store reports an error instead of looking empty', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const file = path.join(dir, 'accounts.json');
  await fs.writeFile(file, '{"version":1,"accounts":[{', 'utf8');

  const store = await loadStore(file);
  assert.ok(store.loadError instanceof Error, 'corruption must be visible on the result');
  assert.equal(store.corruptFile, file);
});

test('mustLoadStore refuses to proceed on a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const file = path.join(dir, 'accounts.json');
  await fs.writeFile(file, 'this is not json', 'utf8');

  await assert.rejects(() => mustLoadStore(file), /refusing to overwrite an unreadable account store/);
});

test('mustLoadStore accepts a missing file, so first run still works', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const store = await mustLoadStore(path.join(dir, 'absent.json'));
  assert.deepEqual(store.accounts, []);
});

test('a corrupt store is left untouched on disk, not overwritten', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const file = path.join(dir, 'accounts.json');
  const original = '{"broken": tru';
  await fs.writeFile(file, original, 'utf8');

  await assert.rejects(() => mustLoadStore(file));
  assert.equal(await fs.readFile(file, 'utf8'), original, 'the file must survive a refused load');
});

test('a BOM in front of JSON is stripped', () => {
  const withBom = '\uFEFF{"a":1}';
  assert.deepEqual(parseJsonText(withBom), { a: 1 });
});

test('JSON without a BOM still parses', () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
});

test('plain JSON.parse rejects the BOM, which is why the helper exists', () => {
  assert.throws(() => JSON.parse('\uFEFF{"a":1}'), SyntaxError);
});

test('a BOM twice is not silently accepted forever', () => {
  // Only the first mark is stripped; a second one means something is genuinely
  // wrong with the file and should not be papered over.
  assert.throws(() => parseJsonText('\uFEFF\uFEFF{"a":1}'), SyntaxError);
});

test('broken JSON still throws instead of returning defaults', () => {
  assert.throws(() => parseJsonText('{"a":'), SyntaxError);
  assert.throws(() => parseJsonText('not json at all'), SyntaxError);
});

test('non-string input does not crash the helper', () => {
  assert.throws(() => parseJsonText(null), SyntaxError);
  assert.throws(() => parseJsonText(undefined), SyntaxError);
});

test('loadStore reads a store file that PowerShell wrote with a BOM', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const file = path.join(dir, 'accounts.json');
  const store = emptyStore();
  await fs.writeFile(file, '\uFEFF' + JSON.stringify(store), 'utf8');

  const loaded = await loadStore(file);
  assert.equal(loaded.version, store.version);
  assert.ok(Array.isArray(loaded.accounts));

  // The distinction that matters: without the BOM strip this file would look
  // like a corrupt store and be replaced by empty defaults, silently losing
  // every account.
  const rawText = await fs.readFile(file, 'utf8');
  assert.throws(() => JSON.parse(rawText), SyntaxError, 'fixture must really contain a BOM');
});

test('a written store round-trips without a BOM', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freepi-bom-'));
  const file = path.join(dir, 'accounts.json');
  await saveStore(emptyStore(), file);

  const text = await fs.readFile(file, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff, 'saveStore must not write a BOM');
  assert.equal(text.charCodeAt(0), 0x7b, 'file starts with {');
});
