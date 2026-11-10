import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hourlyReset} from './lib/upstream-errors.mjs';
test('uses provider reset timestamps and durations, estimating only if absent',()=>{
 const now=Date.parse('2026-11-10T14:00:00Z');
 assert.deepEqual(hourlyReset('{"clears_at":"2026-11-10T14:10:00Z"}',{},now),{until:now+600000,source:'clears_at'});
 assert.deepEqual(hourlyReset('{"retry_after_seconds":90}',{},now),{until:now+90000,source:'retry_after_seconds'});
 assert.deepEqual(hourlyReset('{}',{'retry-after':'45'},now),{until:now+45000,source:'retry-after'});
 assert.deepEqual(hourlyReset('{}',{'retry-after':'Tue, 10 Nov 2026 14:05:00 GMT'},now),{until:now+300000,source:'retry-after'});
 assert.deepEqual(hourlyReset('{}',{},now),{until:now+3600000,source:'estimated'});
});
