// The model catalog is read once at startup. Without a refresh, a model that
// free-pi launches later is rejected with 404 ("does not exist") until the proxy
// is restarted - a wrong answer, not just a stale one. These tests pin the
// rules that make the refresh safe to run unattended:
//
//   - a failed fetch must not shrink the set (a network blip would start
//     rejecting ids that worked a second ago)
//   - an empty answer must not clear the set
//   - a good answer replaces it, so new ids become usable
//
// The logic is reproduced here rather than imported because proxy.mjs starts a
// server at import time. Keep this in step with startCatalogRefresh().

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * One refresh step, extracted from proxy.mjs startCatalogRefresh().
 * Returns the set that should now be in force.
 */
function applyRefresh(current, fresh) {
  const list = fresh && (Array.isArray(fresh.models) ? fresh.models : (Array.isArray(fresh.data) ? fresh.data : null));
  if (!list || !list.length) return current;
  const next = new Set();
  for (const m of list) {
    if (m && m.id) next.add(String(m.id));
  }
  if (!next.size) return current;
  return next;
}

const base = () => new Set(['particle', 'deepseek-v4-flash']);

test('a new model in the catalog is accepted after refresh', () => {
  const now = applyRefresh(base(), {
    models: [{ id: 'particle' }, { id: 'deepseek-v4-flash' }, { id: 'brand-new-model' }],
  });
  assert.ok(now.has('brand-new-model'), 'newly launched model must become known');
  assert.ok(now.has('particle'), 'existing ids must survive a refresh');
});

test('an empty catalog answer keeps the previous set', () => {
  const now = applyRefresh(base(), { models: [] });
  assert.deepEqual([...now].sort(), ['deepseek-v4-flash', 'particle']);
});

test('a missing catalog answer keeps the previous set', () => {
  for (const answer of [{}, null, undefined, { models: null }]) {
    const now = applyRefresh(base(), answer);
    assert.ok(now.has('particle'), 'a failed refresh must not drop ids: ' + JSON.stringify(answer));
  }
});

test('entries without an id are ignored rather than added as undefined', () => {
  const now = applyRefresh(base(), { models: [{ id: 'particle' }, {}, null, { id: '' }] });
  assert.ok(now.has('particle'));
  assert.equal(now.size, 1, 'junk entries must not become known ids');
  assert.ok(!now.has('undefined'));
});

test('a catalog using the data field is read too', () => {
  const now = applyRefresh(base(), { data: [{ id: 'from-data-field' }] });
  assert.ok(now.has('from-data-field'));
});

test('refresh replaces rather than merges, so a withdrawn model stops being accepted', () => {
  const now = applyRefresh(base(), { models: [{ id: 'particle' }] });
  assert.ok(now.has('particle'));
  assert.ok(!now.has('deepseek-v4-flash'), 'a model free-pi no longer lists must not pass validation');
});
