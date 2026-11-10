import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureTurns,resumeTurns,continuationDecision} from './restart-continuation.mjs';
test('only the exact interrupted/open turn can resume; completed, stopped and newer turns cannot',()=>{
  const entry={turn:3};
  for(const state of ['open','interrupted'])assert.equal(continuationDecision(entry,{turn:3,state}),'resume');
  for(const state of ['completed','aborted','error'])assert.match(continuationDecision(entry,{turn:3,state}),/^skip/);
  assert.match(continuationDecision(entry,{turn:4,state:'open'}),/^skip/);
});
test('capture includes only live running sessions and a repeated continuation cannot submit twice',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-restart-')),manifest=path.join(dir,'handoff.json');
  const file=path.join(dir,'live','session.v4.jsonl.zstd');
  const result=await captureTurns(123,manifest,{files:[file],read:()=>({turn:2,state:'open',seq:14}),call:async()=>({items:[{sessionId:'live',running:true},{sessionId:'idle',running:false},{sessionId:'child',running:true,origin:'subagent'}]})});
  assert.equal(result.entries.length,1);
  let submitted=0;
  const options={read:()=>({turn:2,state:'interrupted'}),call:async(port,method,args,id)=>{
    assert.equal(method,'session/prompt');assert.equal(args.request.requestId,id);assert.equal(args.request.mode,'queue');submitted++;return {accepted:true};
  }};
  await resumeTurns(456,manifest,options);await resumeTurns(456,manifest,options);assert.equal(submitted,1);
});
test('a failed HTTP acknowledgement retains the identical request ID for safe server-side deduplication',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-retry-')),manifest=path.join(dir,'handoff.json');
  fs.writeFileSync(manifest,JSON.stringify({entries:[{sessionId:'live',file:'fixture',turn:2,requestId:'stable',status:'pending'}]}));
  const ids=[];let first=true;
  const opts={read:()=>({turn:2,state:'interrupted'}),call:async(p,m,a,id)=>{ids.push(id);if(first){first=false;throw Error('lost acknowledgement');}return {accepted:true};}};
  await resumeTurns(456,manifest,opts);await resumeTurns(456,manifest,opts);
  assert.deepEqual(ids,['stable','stable']);
});
