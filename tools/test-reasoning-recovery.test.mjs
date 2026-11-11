import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../plugin-session-routing/lib/index.js';
const message=(blocks)=>({turn:7,message:{source:{provider:'freepi',replayState:{response:{stopReason:'stop'}}},content:blocks}});
test('reasoning-only recovery continues once only with active credit guard',async()=>{
  const old=globalThis.fetch,handlers=new Map(),disposers=[],injected=[],session={};
  let guarded=false;
  globalThis.fetch=async()=>new Response(JSON.stringify({creditGuard:guarded?'free-unlimited-visible-v1':undefined}));
  const agent={id:'a',session,status:'running',inject:m=>injected.push(m)};
  try{
    apply({agents:{list:()=>[agent],isOwnedBy:()=>false},commands:{register:()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const onEvent=handlers.get('session/event'),stopping=handlers.get('agent/turn-stopping');
    onEvent(session,{type:'assistant/message',data:message([{type:'reasoning',text:'thinking'}])});
    await stopping({agent,turn:7});assert.equal(injected.length,0);
    guarded=true;await stopping({agent,turn:7});assert.equal(injected.length,1);
    await stopping({agent,turn:7});assert.equal(injected.length,1);
    onEvent(session,{type:'assistant/message',data:{...message([{type:'reasoning',text:'thinking'},{type:'text',text:'done'}]),turn:8}});
    await stopping({agent,turn:8});assert.equal(injected.length,1);
    onEvent(session,{type:'assistant/message',data:{...message([{type:'reasoning',text:'thinking'},{type:'tool-call',id:'x'}]),turn:9}});
    await stopping({agent,turn:9});assert.equal(injected.length,1);
  }finally{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=old;}
});

test('reasoning-only recovery handles whitespace text blocks, repeated stops in same turn, and transient /health errors',async()=>{
  const old=globalThis.fetch,handlers=new Map(),disposers=[],injected=[],session={};
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)throw new Error('transient');
    return new Response(JSON.stringify({creditGuard:'disabled-by-user'}));
  };
  const agent={id:'b',session,status:'running',inject:m=>injected.push(m)};
  try{
    apply({agents:{list:()=>[agent],isOwnedBy:()=>false},commands:{register:()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const onEvent=handlers.get('session/event'),stopping=handlers.get('agent/turn-stopping');
    onEvent(session,{type:'assistant/message',data:message([{type:'reasoning',text:'step 1'},{type:'text',text:'   '}])});
    await stopping({agent,turn:7});assert.equal(injected.length,1);
    onEvent(session,{type:'assistant/message',data:message([{type:'reasoning',text:'step 2'}])});
    await stopping({agent,turn:7});assert.equal(injected.length,2);
  }finally{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=old;}
});

test('length limit auto-continuation works for both freepi and llama-local',async()=>{
  const old=globalThis.fetch,handlers=new Map(),disposers=[],injected=[],session={};
  globalThis.fetch=async()=>new Response(JSON.stringify({creditGuard:'disabled-by-user'}));
  const agent={id:'c',session,status:'running',inject:m=>injected.push(m)};
  try{
    apply({agents:{list:()=>[agent],isOwnedBy:()=>false},commands:{register:()=>{}},effect:f=>disposers.push(f()),on:(name,fn)=>handlers.set(name,fn)});
    const onEvent=handlers.get('session/event'),stopping=handlers.get('agent/turn-stopping');
    // 1) freepi length limit with partial visible text
    onEvent(session,{type:'assistant/message',data:{turn:1,message:{source:{provider:'freepi',replayState:{response:{stopReason:'length'}}},content:[{type:'text',text:'part 1'}]}}});
    await stopping({agent,turn:1});
    assert.equal(injected.length,1);
    assert.match(injected[0].content[0].text,/without repeating what you already wrote/);

    // 2) llama-local length limit with reasoning only
    onEvent(session,{type:'assistant/message',data:{turn:2,message:{source:{provider:'llama-local',replayState:{response:{stopReason:'length'}}},content:[{type:'reasoning',text:'thinking step'}]}}});
    await stopping({agent,turn:2});
    assert.equal(injected.length,2);
    assert.match(injected[1].content[0].text,/Conclude your thinking concisely/);
  }finally{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=old;}
});
