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
