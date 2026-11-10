import {test} from 'node:test';import assert from 'node:assert/strict';
import {upstreamSessionId} from './lib/upstream-session.mjs';
test('account session ID survives process restarts and separates accounts',()=>{
  const a={id:'acc-1',userId:'user1'},b={id:'acc-2',userId:'user2'};
  const first=upstreamSessionId(a,'C:/install');
  assert.equal(first,upstreamSessionId({...a},'c:\\install'));
  assert.notEqual(first,upstreamSessionId(b,'C:/install'));
  assert.match(first,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
