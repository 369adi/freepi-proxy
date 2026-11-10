import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindRequestLifecycle } from './lib/request-lifecycle.mjs';

function setup(timeout = 1000) {
  const upstream = new EventEmitter(), downstream = new EventEmitter();
  let releases = 0;
  upstream.setTimeout = (_ms, callback) => { upstream.idle = callback; };
  upstream.destroy = error => { upstream.destroyed = true; if (error) upstream.emit('error', error); upstream.emit('close'); };
  downstream.destroy = () => { downstream.destroyed = true; downstream.emit('close'); };
  bindRequestLifecycle(upstream, downstream, () => releases++, timeout);
  return { upstream, downstream, releases: () => releases };
}

test('SSE keepalives without actual model content cannot occupy a lane forever', async () => {
  const {upstream,downstream,releases}=setup(20),response=new EventEmitter();
  response.headers={'content-type':'text/event-stream'};upstream.emit('response',response);
  const timer=setInterval(()=>response.emit('data',Buffer.from(': keepalive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')),3);
  try{await new Promise(resolve=>setTimeout(resolve,45));assert.equal(upstream.destroyed,true);assert.equal(downstream.destroyed,true);assert.equal(releases(),1);}
  finally{clearInterval(timer);}
});
test('real reasoning and tool output keep a live model stream running', async () => {
  const {upstream,releases}=setup(25),response=new EventEmitter();
  response.headers={'content-type':'text/event-stream'};upstream.emit('response',response);
  const timer=setInterval(()=>response.emit('data',Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"working"}}]}\n\n')),4);
  try{await new Promise(resolve=>setTimeout(resolve,60));assert.equal(upstream.destroyed,undefined);response.emit('end');assert.equal(releases(),1);}
  finally{clearInterval(timer);}
});

test('client disconnect before response headers cancels upstream and releases exactly once', () => {
  const { upstream, downstream, releases } = setup();
  downstream.destroy();
  upstream.emit('error', new Error('late socket error'));
  assert.equal(upstream.destroyed, true);
  assert.equal(releases(), 1);
});

test('missing headers release the request instead of occupying the slot forever', async () => {
  const { upstream, releases } = setup(10);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(upstream.destroyed, true);
  assert.equal(releases(), 1);
});

test('normal response completion releases without canceling the request', () => {
  const { upstream, downstream, releases } = setup();
  const response = new EventEmitter();
  upstream.emit('response', response);
  response.emit('end');
  downstream.writableEnded = true;
  downstream.emit('close');
  assert.equal(releases(), 1);
  assert.equal(upstream.destroyed, undefined);
});

test('an idle or aborted upstream cannot leave the downstream hanging', () => {
  const { upstream, downstream, releases } = setup();
  const response = new EventEmitter();
  upstream.emit('response', response);
  response.emit('aborted');
  assert.equal(releases(), 1);
  assert.equal(downstream.destroyed, true);
});
