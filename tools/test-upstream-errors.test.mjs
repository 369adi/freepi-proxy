import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hourlyReset,isHourlyCeiling,upstreamCode} from './lib/upstream-errors.mjs';
test('detects Free-Pi hourly ceilings in raw and nested replies',()=>{
  assert.equal(isHourlyCeiling(Buffer.from('{"code":"hourly_ceiling","message":"hourly limit"}')),true);
  assert.equal(isHourlyCeiling('{"error":{"code":"hourly_ceiling"}}'),true);
  assert.equal(isHourlyCeiling('{"code":"premium_allowance"}'),false);
  assert.equal(isHourlyCeiling('not JSON'),false);
  assert.equal(upstreamCode('{}'),null);
  assert.deepEqual(hourlyReset('{}',{'retry-after':'0'},1000),{until:1000,source:'retry-after'});
});
