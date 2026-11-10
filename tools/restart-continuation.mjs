import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sessionCookie} from './restart-dsh.mjs';
import {sessionFiles,decodeTranscript,parseEvents,lastTurn} from './read-session.mjs';

export async function rpc(port,method,args,requestId='restart-audit',fetcher=fetch) {
  const cookie=await sessionCookie(port);
  if(!cookie)throw Error('Harness API credential unavailable');
  const response=await fetcher(`http://127.0.0.1:${port}/api/${method}`,{
    method:'POST',headers:{cookie,'content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:requestId,method,payload:{args}}),
    signal:AbortSignal.timeout(20000),
  });
  const text=await response.text();
  let parsed=null;
  try{parsed=text?JSON.parse(text):null;}catch{}
  const result=parsed?.result;
  if(!response.ok || !result?.ok) {const error=new Error(result?.error?.message||('Harness API failed: '+response.status+(text?' ('+text.slice(0,80).trim()+')':'')));error.details=result?.error?.details;throw error;}
  return result.value;
}
export function readTurn(file) {
  const events=parseEvents(decodeTranscript(file).text);
  return {...lastTurn(events),seq:events.at(-1)?.seq??-1};
}
export function continuationDecision(entry,current) {
  if(current.turn!==entry.turn)return 'skip: turn already advanced';
  if(!['open','interrupted'].includes(current.state))return 'skip: turn '+current.state;
  return 'resume';
}
export async function captureTurns(port,manifestFile,{call=rpc,files=sessionFiles(),read=readTurn}={}) {
  const list=port?await call(port,'session/list',{_request:{}}):{items:[]};
  const entries=[];
  for(const item of list.items||[]) {
    if(!item.running || item.origin==='subagent' || item.parentSessionId)continue;
    const file=files.find(f=>path.basename(path.dirname(f))===item.sessionId);
    if(!file)throw Error('Cannot find active transcript: '+item.sessionId);
    const current=read(file);
    if(current.state!=='open')continue;
    const requestId='restart-'+createHash('sha256').update(item.sessionId+':'+current.turn).digest('hex').slice(0,32);
    entries.push({sessionId:item.sessionId,file,turn:current.turn,seq:current.seq,requestId,status:'pending'});
  }
  const manifest={version:1,createdAt:new Date().toISOString(),entries};
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
  return manifest;
}
export async function resumeTurns(port,manifestFile,{call=rpc,read=readTurn,log=()=>{}}={}) {
  if(!fs.existsSync(manifestFile))return [];
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  for(const entry of manifest.entries) {
    if(entry.status!=='pending')continue;
    try {
      const decision=continuationDecision(entry,read(entry.file));
      if(decision!=='resume')entry.status=decision;
      else {
        const request={sessionId:entry.sessionId,requestId:entry.requestId,mode:'queue',clientTimeZone:'Europe/Berlin',content:[{type:'text',text:
          '[Automatic restart continuation] Harness was intentionally restarted during the previous turn. Continue the existing task from the saved session and files. Do not restart Harness again for this continuation. Inspect the last tool outcomes before proceeding: an interrupted tool may already have changed external state; never repeat uncertain side effects blindly. Inspect interrupted subagents through their parent-owned controls; child sessions must not be resumed as ordinary root chats. If the task was already completed or the user stopped it, do not redo it.'}]};
        const value=await call(port,'session/prompt',{request},entry.requestId);
        if(!value?.accepted)throw Error('Continuation was not accepted');
        entry.status='accepted';entry.acceptedAt=new Date().toISOString();
      }
      delete entry.error;log(`${entry.sessionId} turn ${entry.turn}: ${entry.status}`);
    } catch(error) {
      if(error.message.includes('owned by subagent routing')){entry.status='parent-managed subagent';delete entry.error;log(`${entry.sessionId}: recovery belongs to the parent session`);}
      else {entry.error=error.message;log(`${entry.sessionId}: continuation pending: ${error.message}`);}
    }
    fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
  }
  return manifest.entries;
}
