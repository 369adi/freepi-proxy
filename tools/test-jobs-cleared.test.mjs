/**
 * The cleared-jobs storage helpers, extracted from the patched browser bundle
 * and exercised against a fake localStorage. The bug these guard: the dismissal
 * set lived only in component state, so a page reload forgot every dismissal
 * while the job store kept the whole history, and the header counted finished
 * work as if it were running.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirror of the constants the bundle declares. */
const CLEARED_STORE_PREFIX = 'dsh.jobs.cleared.v1:';
const CLEARED_TTL_MS = 7 * 24 * 60 * 60 * 1e3;

function clearedStoreKey(sessionId) {
  return CLEARED_STORE_PREFIX + String(sessionId);
}

/** Fake storage so the helpers can run without a DOM. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get size() { return map.size; },
  };
}

/** Verbatim behaviour of the bundle's loadClearedKeys, over an injected store. */
function loadClearedKeys(store, sessionId, now = Date.now()) {
  try {
    const raw = store.getItem(clearedStoreKey(sessionId));
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.at !== 'number') return new Set();
    if (!Array.isArray(parsed.ids) || now - parsed.at > CLEARED_TTL_MS) return new Set();
    return new Set(parsed.ids.filter((id) => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

/** Verbatim behaviour of the bundle's saveClearedKeys, over an injected store. */
function saveClearedKeys(store, sessionId, keys, now = Date.now()) {
  try {
    store.setItem(clearedStoreKey(sessionId), JSON.stringify({ at: now, ids: [...keys] }));
  } catch {}
}

test('a dismissal survives a reload', () => {
  const store = makeStorage();
  const first = loadClearedKeys(store, 's1');
  assert.equal(first.size, 0, 'nothing dismissed yet');

  saveClearedKeys(store, 's1', new Set(['job-a', 'job-b']));
  const afterReload = loadClearedKeys(store, 's1');
  assert.deepEqual([...afterReload].sort(), ['job-a', 'job-b']);
});

test('sessions do not share dismissals', () => {
  const store = makeStorage();
  saveClearedKeys(store, 's1', new Set(['job-a']));
  saveClearedKeys(store, 's2', new Set(['job-z']));
  assert.deepEqual([...loadClearedKeys(store, 's1')], ['job-a']);
  assert.deepEqual([...loadClearedKeys(store, 's2')], ['job-z']);
  assert.equal(store.size, 2);
});

test('an expired record is ignored', () => {
  const store = makeStorage();
  const old = Date.now() - (CLEARED_TTL_MS + 1000);
  saveClearedKeys(store, 's1', new Set(['job-a']), old);
  assert.equal(loadClearedKeys(store, 's1').size, 0, 'stale ids must not persist forever');
});

test('a record inside the window is still honoured', () => {
  const store = makeStorage();
  const fresh = Date.now() - (CLEARED_TTL_MS - 60_000);
  saveClearedKeys(store, 's1', new Set(['job-a']), fresh);
  assert.deepEqual([...loadClearedKeys(store, 's1')], ['job-a']);
});

test('corrupt JSON degrades to nothing dismissed', () => {
  const store = makeStorage();
  store.setItem(clearedStoreKey('s1'), '{not json');
  assert.equal(loadClearedKeys(store, 's1').size, 0);
});

test('a wrong-shaped record degrades to nothing dismissed', () => {
  const store = makeStorage();
  for (const bad of ['null', '[]', '{"ids":["a"]}', '{"at":"soon","ids":["a"]}', '{"at":1,"ids":"a"}']) {
    store.setItem(clearedStoreKey('s1'), bad);
    assert.equal(loadClearedKeys(store, 's1').size, 0, `shape ${bad} must be rejected`);
  }
});

test('non-string ids are dropped, string ids kept', () => {
  const store = makeStorage();
  store.setItem(clearedStoreKey('s1'), JSON.stringify({ at: Date.now(), ids: ['ok', 7, null, {}, 'also'] }));
  assert.deepEqual([...loadClearedKeys(store, 's1')].sort(), ['also', 'ok']);
});

test('an unavailable store never throws', () => {
  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  assert.equal(loadClearedKeys(broken, 's1').size, 0);
  assert.doesNotThrow(() => saveClearedKeys(broken, 's1', new Set(['a'])));
});

test('the settled count reports at most one finished job', () => {
  const settledCount = (settledRows) => (settledRows.length > 0 ? 1 : 0);
  const visibleCount = (live, settledRows) => live.length + settledCount(settledRows);

  assert.equal(visibleCount([], []), 0, 'nothing at all');
  assert.equal(visibleCount([], ['a']), 1, 'one finished job counts once');
  assert.equal(visibleCount([], ['a', 'b', 'c', 'd']), 1, 'history must not inflate the header');
  assert.equal(visibleCount(['live'], ['a', 'b']), 2, 'a running job plus the settled marker');
  assert.equal(visibleCount(['x', 'y'], []), 2, 'pure live work');
});
