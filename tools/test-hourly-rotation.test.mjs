import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionRouter} from './lib/session-router.mjs';
const accounts=[{id:'a'},{id:'b'},{id:'c'}],busy=new Set();
test('main moves to a free account without changing another session',()=>{
 const r=new SessionRouter();r.reserve('main',accounts,busy);r.reserve('other',[accounts[1]],busy);
 assert.equal(r.moveReservation('main',undefined,'a',accounts,busy),'c');
 assert.equal(r.owner('a'),null);assert.equal(r.owner('b'),'other');assert.equal(r.owner('c'),'main');
});
test('worker move persists its new exclusive account and avoids busy lanes',()=>{
 let saved=[];const r=new SessionRouter(Date.now,90000,{load:()=>saved,save:rows=>saved=structuredClone(rows)});
 r.reserve('main',[accounts[0]],busy);r.reserveWorker('worker','main',accounts,busy);
 assert.equal(r.moveReservation('main','worker','b',accounts,busy),'c');
 assert.equal(r.allowed('c','main','worker'),true);assert.equal(saved[0][1].accountId,'c');
 assert.equal(r.allowed('c','other'),false);
});
test('no free account or persistence failure leaves worker binding unchanged',()=>{
 let fail=false;const r=new SessionRouter(Date.now,90000,{load:()=>[],save:()=>{if(fail)throw Error('write');}});
 r.reserve('main',[accounts[0]],busy);r.reserveWorker('w','main',accounts,busy);
 assert.equal(r.moveReservation('main','w','b',accounts,new Set(['c'])),null);
 fail=true;assert.equal(r.moveReservation('main','w','b',accounts,busy),null);
 assert.equal(r.allowed('b','main','w'),true);assert.equal(r.bindings.get('w').accountId,'b');
});
