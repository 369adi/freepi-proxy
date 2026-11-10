import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionRouter} from './lib/session-router.mjs';
import {apply} from '../plugin-session-routing/lib/index.js';
test('Harness fetches preserve root ownership and wait for the complete cowork turn before handover',async()=>{
  const original=globalThis.fetch;
  const router=new SessionRouter(),accounts=[{id:'a'},{id:'b'}],busy=new Set();
  const main1={id:'main1',status:'running'},main2={id:'main2',status:'running'},worker={id:'worker',status:'running'};
  let current=main1;const handlers=new Map(),disposers=[],sent=[];
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith('/session-routing')){
      const d=JSON.parse(init.body);let result={ok:true};
      if(d.action==='reserve')result=router.reserve(d.sessionId,accounts,busy);
      if(d.action==='cowork')result=router.reserveWorker(d.workerId,d.sessionId,accounts,busy);
      if(d.action==='release')router.release(d.sessionId);
      if(d.action==='release-worker')router.releaseWorker(d.sessionId);
      return new Response(JSON.stringify(result));
    }
    sent.push({session:new Headers(init.headers).get('x-freepi-session'),account:new Headers(init.headers).get('x-freepi-account'),worker:new Headers(init.headers).get('x-freepi-worker')});
    return new Response('{}');
  };
  try{
    apply({agents:{list:()=>[main1,main2,worker],isOwnedBy:(id,parent)=>id==='worker'&&parent===main1,currentInitiator:()=>current},
      commands:{register:()=>()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const ask=()=>globalThis.fetch('http://127.0.0.1:4000/v1/chat/completions',{body:JSON.stringify({model:'particle'}),method:'POST'});
    await ask();
    await handlers.get('agent/created')({agent:worker});
    assert.equal(router.workers.get('worker').accountId,'b');
    assert.equal(sent.length,1,'child allocation happens before its first model call');
    current=worker;await ask();
    assert.deepEqual(sent[0],{session:'main1',account:'a',worker:null});
    assert.deepEqual(sent[1],{session:'main1',account:'b',worker:'worker'});
    current=main2;const waiting=ask();
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(sent.length,2);
    assert.equal(router.snapshot(busy).find(s=>s.sessionId==='main2').message,'Waiting for cowork to finish');
    current=worker;await ask();assert.equal(sent[2].account,'b');
    handlers.get('agent/status')({agent:worker,status:'idle'});
    await waiting;
    assert.deepEqual(sent[3],{session:'main2',account:'b',worker:null});
    handlers.get('agent/status')({agent:main2,status:'idle'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(router.owner('b'),null);
  } finally {for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=original;}
});

test('Aborted waiting request releases its pending reservation and /freepi-session reports account pool',async()=>{
  const original=globalThis.fetch;
  const router=new SessionRouter(),accounts=[{id:'a'}],busy=new Set(['a']);
  const main1={id:'main1',status:'running'},main2={id:'main2',status:'running'};
  let current=main1,cmdHandler=null;const handlers=new Map(),disposers=[];
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith('/session-routing')){
      if(!init?.method||init.method==='GET'){
        return new Response(JSON.stringify({
          accounts:{total:6,available:6,busy:0},
          sessions:router.snapshot(busy),
          workers:router.workerSnapshot(),
          waitingWorkers:router.waitingWorkerSnapshot(),
        }));
      }
      const d=JSON.parse(init.body);let result={ok:true};
      if(d.action==='reserve')result=router.reserve(d.sessionId,accounts,busy);
      if(d.action==='release')router.release(d.sessionId);
      return new Response(JSON.stringify(result));
    }
    return new Response('{}');
  };
  try{
    apply({agents:{list:()=>[main1,main2],isOwnedBy:()=>false,currentInitiator:()=>current},
      commands:{register:def=>{if(def.name==='freepi-session')cmdHandler=def.handler;return()=>{};}},
      effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    router.reserve('main1',accounts,new Set());
    current=main2;
    const ac=new AbortController();
    const pending=globalThis.fetch('http://127.0.0.1:4000/v1/chat/completions',{body:JSON.stringify({model:'particle'}),method:'POST',signal:ac.signal});
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(router.waiting.has('main2'),true);
    ac.abort(new Error('user cancelled'));
    await assert.rejects(pending,/user cancelled/);
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(router.waiting.has('main2'),false);
    const out=await cmdHandler({});
    assert.match(out.text,/6\/6/);
  } finally {for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=original;}
});
