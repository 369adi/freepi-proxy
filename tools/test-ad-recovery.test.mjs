import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {waitForSponsorDisplay} from './lib/ad-recovery.mjs';
test('opening or another account displaying an ad cannot release a paused request',async()=>{
  const events=new EventEmitter(),downstream=new EventEmitter();let resolved=false;
  const pending=waitForSponsorDisplay('a',{events,downstream,isBlocked:()=>true}).then(v=>{resolved=true;return v;});
  events.emit('opened','a');events.emit('displayed','b');await Promise.resolve();assert.equal(resolved,false);
  events.emit('displayed','a');assert.equal(await pending,true);assert.equal(events.listenerCount('displayed'),0);
});
test('disconnect cancels the wait without reporting a successful impression',async()=>{
  const events=new EventEmitter(),downstream=new EventEmitter();
  const pending=waitForSponsorDisplay('a',{events,downstream});downstream.emit('close');
  assert.equal(await pending,false);assert.equal(events.listenerCount('displayed'),0);
});
test('display timeout cannot keep a request hanging forever',async()=>{
  const events=new EventEmitter(),downstream=new EventEmitter();
  assert.equal(await waitForSponsorDisplay('a',{events,downstream,timeoutMs:10}),false);
  assert.equal(downstream.listenerCount('close'),0);
});
