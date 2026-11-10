import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecoveryBudget,abortableDelay} from '../plugin-session-routing/lib/retry-policy.mjs';
const request=(failure,extra={})=>({agent:{id:'main'},provider:'freepi',turn:1,step:2,failure,...extra});
test('model_at_capacity retries the same step with increasing bounded waits',()=>{
  const budget=new RecoveryBudget(()=>1000);
  const payload=request({code:'PI_AI_ERROR',message:'409 {"code":"model_at_capacity","message":"This model is busy right now"}'});
  assert.equal(budget.next(payload).delayMs,15000);
  assert.equal(budget.next(payload).delayMs,30000);
  assert.equal(budget.next(payload).delayMs,60000);
  budget.clear('main');assert.equal(budget.next(payload).delayMs,15000);
});
test('recovery does not disguise a permanent credential or budget error',()=>{
  const budget=new RecoveryBudget();
  for(const failure of [{code:'INVALID_CREDENTIAL',message:'API key is invalid'},{message:'premium_allowance'},{message:'daily_cap'},{message:'budget spent (429)'}])assert.equal(budget.next(request(failure)),null);
  assert.equal(budget.next(request({message:'model_at_capacity'},{signal:{aborted:true}})),null);
});
test('capacity retry budget expires instead of creating an invisible infinite loop',()=>{
  let now=0;const budget=new RecoveryBudget(()=>now),payload=request({message:'model_at_capacity'});
  assert.ok(budget.next(payload));now=600001;assert.equal(budget.next(payload),null);
});
test('Stop interrupts a long retry wait immediately',async()=>{
  const controller=new AbortController();const wait=abortableDelay(60000,controller.signal);
  controller.abort(new Error('Stopped by user'));
  await assert.rejects(wait,/Stopped by user/);
});
test('old account sessions wait for the server-provided expiry rather than opening new session IDs',()=>{
  const budget=new RecoveryBudget(()=>0);
  const next=budget.next(request({message:'429 {"type":"concurrent_session","retry_after_seconds":1800}'}));
  assert.equal(next.category,'session');assert.equal(next.delayMs,1800000);
});
