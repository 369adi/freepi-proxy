import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionRouter} from './lib/session-router.mjs';
const accounts=[{id:'a'},{id:'b'}];
test('simultaneous mains get distinct accounts and idle makes one reusable',()=>{
  const r=new SessionRouter();const busy=new Set();
  assert.equal(r.reserve('main1',accounts,busy).accountId,'a');
  assert.equal(r.reserve('main2',accounts,busy).accountId,'b');
  assert.equal(r.reserve('main3',accounts,busy).status,'waiting');
  r.release('main1');assert.equal(r.reserve('main3',accounts,busy).accountId,'a');
});
test('main reserves a coworker for handover without interrupting its current multi-step job',()=>{
  const r=new SessionRouter();const busy=new Set();
  r.reserve('first-main',[accounts[0]],busy);
  assert.equal(r.reserveWorker('worker1','first-main',accounts,busy).accountId,'b');
  const pending=r.reserve('new-main',accounts,busy);
  assert.equal(pending.accountId,'b');assert.equal(pending.message,'Waiting for cowork to finish');
  assert.equal(r.allowed('b','first-main','worker1'),true);
  assert.equal(r.allowed('b','first-main','another-worker'),false);
  assert.equal(r.allowed('b','new-main'),false);
  assert.equal(r.reserveWorker('worker1','first-main',accounts,busy).accountId,'b');
  r.releaseWorker('worker1');
  assert.equal(r.reserve('new-main',accounts,busy).status,'main');
  assert.equal(r.allowed('b','new-main'),true);
  assert.equal(r.allowed('b','first-main','another-worker'),false);
});
test('free account preferred over a coworker, and abandoned leases expire',()=>{
  let now=0;const r=new SessionRouter(()=>now,100);
  r.reserveWorker('worker','old',accounts,new Set());
  assert.equal(r.reserve('main',accounts,new Set()).accountId,'b');
  now=80;r.touch('main');now=150;r.sweep();
  assert.equal(r.workers.size,0);assert.equal(r.owner('b'),'main');
  now=200;r.sweep();assert.equal(r.owner('b'),null);
});
test('an idle main releasing its account does not terminate a running coworker',()=>{
  const r=new SessionRouter();const a=[accounts[1]];const busy=new Set();
  r.reserve('old',[accounts[0]],busy);r.reserveWorker('worker','old',accounts,busy);r.release('old');
  assert.equal(r.reserve('new',a,busy).status,'waiting');
  assert.equal(r.allowed('b','old','worker'),true);
  r.releaseWorker('worker');assert.equal(r.reserve('new',a,busy).status,'main');
});
test('subagents never share their main account or another subagent account',()=>{
  const r=new SessionRouter(),busy=new Set();r.reserve('main',[accounts[0]],busy);
  assert.equal(r.reserveWorker('one','main',accounts,busy).accountId,'b');
  assert.equal(r.reserveWorker('two','main',accounts,busy).status,'waiting');
  assert.equal(r.reserveWorker('three','main',[accounts[0]],busy).status,'waiting');
  assert.equal(r.allowed('b','wrong-parent','one'),false);
  assert.equal(r.allowed('b','main','two'),false);
});
test('a resumed subagent keeps the same account across idle and router restart',()=>{
  let saved=[];const persistence={load:()=>saved,save:rows=>{saved=structuredClone(rows);}};
  const r=new SessionRouter(Date.now,90000,persistence),busy=new Set();r.reserve('main',[accounts[0]],busy);
  r.reserveWorker('one','main',accounts,busy);r.releaseWorker('one');
  const after=new SessionRouter(Date.now,90000,persistence);after.reserve('other-main',[accounts[1]],busy);
  assert.equal(after.reserveWorker('one','main',accounts,busy).status,'waiting');
  after.release('other-main');assert.equal(after.reserveWorker('one','main',accounts,busy).accountId,'b');
});
test('a main waiting for a release takes priority over a newly submitted cowork',()=>{
  const r=new SessionRouter();const a=[accounts[0]],busy=new Set();
  r.reserve('old-main',a,busy);
  r.reserve('waiting-main',a,busy);
  r.release('old-main');
  assert.equal(r.reserveWorker('new-worker','other-root',a,busy).status,'waiting');
  assert.equal(r.reserve('waiting-main',a,busy).accountId,'a');
});
test('legacy persisted bindings of dead sessions are purged and saved once',()=>{
  // Rows written before the `touched` fix carry no stamp and must not keep
  // their account reserved once their session shows no presence at all.
  const raw=[['w-dead',{accountId:'a',sessionId:'session-afdc0000-0000-0000-0000-000000000000'}]];
  let saved=structuredClone(raw),saves=0;
  const persistence={load:()=>saved,save:rows=>{saves++;saved=rows.map(r=>structuredClone(r));}};
  const r=new SessionRouter(Date.now,90000,persistence);
  assert.equal(r.bindings.size,1);
  r.sweep();
  assert.equal(r.bindings.size,0);
  assert.equal(saves,1);
  assert.deepEqual(saved,[]);
  r.sweep(); // no change -> no second save
  assert.equal(saves,1);
});
test('a stamped binding of a dead session survives until bindingTtl then is purged',()=>{
  let now=0,saved=[],saves=0;
  const persistence={load:()=>saved,save:rows=>{saves++;saved=rows.map(r=>structuredClone(r));}};
  const r=new SessionRouter(()=>now,90000,persistence,1000),busy=new Set();
  r.reserveWorker('w1','sess',accounts,busy);
  assert.equal(saves,1);
  assert.equal(saved.length,1);
  now=999;r.sweep();
  assert.equal(r.bindings.size,1);
  assert.equal(saved.length,1);
  now=1001;r.sweep();
  assert.equal(r.bindings.size,0);
  assert.equal(saved.length,0);
  assert.equal(saves,2);
});
test('a busy worker whose account is exclusive to its session keeps the binding',()=>{
  let now=0,saved=[],saves=0;
  const persistence={load:()=>saved,save:rows=>{saves++;saved=rows.map(r=>structuredClone(r));}};
  const r=new SessionRouter(()=>now,90000,persistence,1000),busy=new Set();
  r.reserveWorker('w1','sess',accounts,busy);
  assert.equal(r.bindings.size,1);
  now=500;r.touch('w1'); // active worker keeps its row fresh
  now=1500;r.sweep();
  assert.equal(r.bindings.size,1);
  assert.equal(saved.length,1);
});
test('a released worker still blocks another session via its binding, same session may reclaim',()=>{
  const r=new SessionRouter();const busy=new Set();
  r.reserveWorker('w9','root-a',[accounts[0]],busy);
  r.releaseWorker('w9');
  const out=r.reserveWorker('w9','root-b',[accounts[0]],busy);
  assert.equal(out.status,'unavailable');
  assert.equal(out.message,'Subagent belongs to another chat');
  assert.equal(r.reserveWorker('w9','root-a',[accounts[0]],busy).accountId,'a');
});
test('main session waiting on a busy or cowork-occupied lease switches immediately when another candidate is free',()=>{
  const three=[{id:'a'},{id:'b'},{id:'c'}];
  const r=new SessionRouter();const busy=new Set();
  r.reserve('first-main',[three[0]],busy);
  assert.equal(r.reserveWorker('worker1','first-main',[three[0],three[1]],busy).accountId,'b');
  const pending=r.reserve('new-main',[three[0],three[1]],busy);
  assert.equal(pending.accountId,'b');
  assert.equal(pending.status,'waiting');
  assert.equal(pending.message,'Waiting for cowork to finish');
  const switched=r.reserve('new-main',three,busy);
  assert.equal(switched.accountId,'c');
  assert.equal(switched.status,'main');
});
test('active main reserve reclaims an idle lease that has not been busy beyond the grace window',()=>{
  let now=0;const r=new SessionRouter(()=>now,90000);
  assert.equal(r.reserve('main1',accounts,new Set()).accountId,'a');
  assert.equal(r.reserve('main2',accounts,new Set()).accountId,'b');
  assert.equal(r.reserve('main3',accounts,new Set()).status,'waiting');
  now=15000;r.touch('main1');r.touch('main2');
  const reclaimed=r.reserve('main3',accounts,new Set(['b']));
  assert.equal(reclaimed.accountId,'a');
  assert.equal(reclaimed.status,'main');
  assert.equal(r.owner('a'),'main3');
});
test('subagent rebinds automatically when its held or bound account leaves candidates or is busy',()=>{
  let saved=[];const persistence={load:()=>saved,save:rows=>{saved=structuredClone(rows);}};
  const three=[{id:'a'},{id:'b'},{id:'c'}];
  const r=new SessionRouter(Date.now,90000,persistence),busy=new Set();
  r.reserve('main',[three[0]],busy);
  assert.equal(r.reserveWorker('w1','main',three,busy).accountId,'b');
  const rebound=r.reserveWorker('w1','main',[three[0],three[2]],busy);
  assert.equal(rebound.accountId,'c');
  assert.equal(rebound.status,'cowork');
  assert.equal(r.bindings.get('w1').accountId,'c');
  assert.equal(saved.find(([k])=>k==='w1')[1].accountId,'c');
});
test('expired waiting main entry is swept so it cannot block subagents forever',()=>{
  let now=0;const r=new SessionRouter(()=>now,100);
  const a=[accounts[0]],busy=new Set();
  r.reserve('main1',a,busy);
  assert.equal(r.reserve('main2',a,busy).status,'waiting');
  r.release('main1');
  now=150;
  assert.equal(r.reserveWorker('w1','root',a,busy).accountId,'a');
});

