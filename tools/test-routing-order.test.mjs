import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareRoutingAccounts} from './lib/routing-order.mjs';
import {SessionRouter} from './lib/session-router.mjs';
const account=(id,total,left,lastUsedAt)=>({id,usage:{allowanceCredits:total,remainingCreditsToday:left},lastUsedAt});
test('new sessions and parallel subagents choose the least-used free account',()=>{
  const candidates=[account('a',15000,750,'2026-11-10T10:00:00Z'),account('b',6000,6000,'2026-11-10T12:00:00Z'),account('c',15000,14000,'2026-11-10T11:00:00Z')].sort(compareRoutingAccounts);
  const router=new SessionRouter(),busy=new Set();
  assert.equal(router.reserve('main',candidates,busy).accountId,'b');
  assert.equal(router.reserveWorker('child','main',candidates,busy).accountId,'c');
  assert.equal(router.reserve('other',candidates,busy).accountId,'a');
});
test('equal usage rotates oldest first and unknown usage goes last',()=>{
  const candidates=[account('unknown',null,null,null),account('new',6000,6000,'2026-11-10T12:00:00Z'),account('old',15000,15000,'2026-11-10T11:00:00Z')].sort(compareRoutingAccounts);
  assert.deepEqual(candidates.map(a=>a.id),['old','new','unknown']);
});
