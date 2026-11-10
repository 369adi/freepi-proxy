import {test} from 'node:test';import assert from 'node:assert/strict';
import {apply} from '../plugin-session-routing/lib/index.js';
test('transport failures use the bounded Free-Pi recovery before generic retries',async()=>{
  const original=globalThis.fetch,handlers=new Map(),disposers=[],notices=[];
  const agent={id:'main',status:'running'},controller=new AbortController();let genericCalls=0;
  globalThis.fetch=async(_input,init)=>{notices.push(JSON.parse(init.body));return new Response('{}');};
  try{
    apply({agents:{list:()=>[agent],isOwnedBy:()=>false,currentInitiator:()=>agent},commands:{register:()=>()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const pending=handlers.get('agent/request-error')({agent,provider:'freepi',turn:1,step:1,failure:{code:'TRANSPORT',message:'Connection error.'},signal:controller.signal},async()=>{genericCalls++;return {kind:'retry'};});
    await new Promise(resolve=>setTimeout(resolve,30));controller.abort(new Error('user stopped'));
    await assert.rejects(pending,/user stopped/);assert.equal(genericCalls,0);assert.equal(notices[0].message,'Connection interrupted');
  }finally{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=original;}
});
test('sponsor recovery uses its own budget before the generic retry policy and remains cancellable',async()=>{
  const original=globalThis.fetch,handlers=new Map(),disposers=[],notices=[];
  const agent={id:'main',status:'running'},controller=new AbortController();let genericCalls=0;
  globalThis.fetch=async(_input,init)=>{notices.push(JSON.parse(init.body));return new Response('{}');};
  try{
    apply({agents:{list:()=>[agent],isOwnedBy:()=>false,currentInitiator:()=>agent},commands:{register:()=>()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const pending=handlers.get('agent/request-error')({agent,provider:'freepi',turn:1,step:1,failure:{message:'503 {"type":"ads_required"}'},signal:controller.signal},async()=>{genericCalls++;return {kind:'retry'};});
    await new Promise(resolve=>setTimeout(resolve,30));controller.abort(new Error('user stopped'));
    await assert.rejects(pending,/user stopped/);
    assert.equal(genericCalls,0);assert.equal(notices[0].message,'Waiting for sponsor display');
  }finally{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=original;}
});
test('the real Harness error hook waits, publishes a countdown, and returns retry without a user prompt',async()=>{
  const original=globalThis.fetch,handlers=new Map(),disposers=[],notices=[];
  const agent={id:'main',status:'running'};
  globalThis.fetch=async(input,init)=>{notices.push(JSON.parse(init.body));return new Response('{}');};
  try{
    apply({agents:{list:()=>[agent],isOwnedBy:()=>false,currentInitiator:()=>agent},commands:{register:()=>()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const started=Date.now();
    const result=await handlers.get('agent/request-error')({agent,provider:'freepi',turn:1,step:1,failure:{code:'PI_AI_ERROR',message:'{"code":"model_at_capacity"}'},signal:new AbortController().signal},async()=>undefined);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(result.kind,'retry');assert.ok(Date.now()-started>=14000);
    assert.equal(notices[0].message,'Model busy');assert.ok(notices[0].retryAt>started);assert.equal(notices.at(-1).message,'');
  }finally{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=original;}
});
