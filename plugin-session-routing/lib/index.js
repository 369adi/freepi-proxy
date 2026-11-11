// Only deployment-owned local Free-Pi fetches receive routing headers.
import {RecoveryBudget,abortableDelay} from './retry-policy.mjs';
export const inject = ['agents', 'commands'];
const fetchSlot=Symbol.for('freepi.session-routing.fetch');
export function rootAgent(agents, agent) {
  const seen=new Set();
  while(agent && !seen.has(agent.id)) {
    seen.add(agent.id);
    const parent=agents.list().find(other=>agents.isOwnedBy(agent.id,other));
    if(!parent) return agent;
    agent=parent;
  }
  return agent;
}
export function apply(ctx) {
  // Cordis can mount the replacement before disposing the previous scope.
  // Keep one dispatcher, including for SDKs that cache their fetch function.
  let slot=globalThis[fetchSlot];
  if(!slot || (!slot.owner && globalThis.fetch!==slot.dispatch)) {
    slot={original:globalThis.fetch,owner:null,handler:null};
    slot.dispatch=(...args)=>(slot.handler||slot.original)(...args);
    globalThis[fetchSlot]=slot;
  }
  const original=slot.original;
  const owner={};
  const base=(process.env.FREEPI_PROXY_URL||'http://127.0.0.1:4000').replace(/\/$/,'');
  const endpoint=base+'/session-routing';
  const authHeaders=()=>process.env.FREEPI_PROXY_API_KEY?{authorization:'Bearer '+process.env.FREEPI_PROXY_API_KEY}:{};
  const chains=new Map();
  const activeWorkers=new Set();
  const recovery=new RecoveryBudget();
  // Track only the final assistant message of each step; never restart a turn
  // that produced visible text or tool calls, or one explicitly stopped by user.
  const finalMessages=new WeakMap(), continuedTurns=new WeakMap(), lastActivity=new WeakMap();
  const IDLE_RELEASE_MS=Number(process.env.FREEPI_IDLE_RELEASE_MS || 30*60*1000);
  const activityKey=(obj)=>obj?.session??obj;
  const noteActivity=(obj)=>{const k=activityKey(obj);if(k)lastActivity.set(k,Date.now());};
  ctx.on('session/event',(session,event)=>{
    if(event.type==='assistant/message'){finalMessages.set(session,event.data);noteActivity(session);}
    else if(event.type==='turn/start'){finalMessages.delete(session);continuedTurns.delete(session);noteActivity(session);}
    else if(event.type==='user/message')noteActivity(session);
  });
  ctx.on('agent/turn-stopping',async({agent,turn,signal})=>{
    const result=finalMessages.get(agent.session), message=result?.message;
    const content=message?.content;
    const provider=message?.source?.provider;
    if(result?.turn!==turn || !['freepi','llama-local'].includes(provider) || signal?.aborted)return;
    const stopReason=message?.source?.replayState?.response?.stopReason ?? message?.stopReason;
    const isReasoningOnly=stopReason==='stop' && Array.isArray(content) &&
      content.some(block=>block.type==='reasoning' && block.text?.trim()) &&
      !content.some(block=>block.type==='tool-call' || (block.type==='text' && block.text?.trim()));
    const isLengthLimit=stopReason==='length' || stopReason==='max_tokens' || stopReason==='max-tokens';
    if(!isReasoningOnly && !isLengthLimit)return;
    const msgId=message?.id || null;
    const prev=continuedTurns.get(agent.session) || {turn:-1,count:0,lastMsgId:null,lastResult:null};
    const count=prev.turn===turn ? prev.count : 0;
    if(prev.lastResult===result || (msgId && prev.lastMsgId===msgId) || count>=10)return;
    // Local GPU llama-server has no credit limit; Free-Pi requires active credit guard advertisement.
    let guardOk=provider==='llama-local';
    if(provider==='freepi'){
      for(let attempt=0;attempt<2 && !signal?.aborted;attempt++){
        try{
          const response=await original(base+'/health',{headers:authHeaders(),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000)});
          if(response.ok){
            const body=await response.json();
            if(['free-unlimited-visible-v1','disabled-by-user'].includes(body?.creditGuard))guardOk=true;
            break;
          }
          if(response.status<500)break;
        }catch{}
        if(attempt===0 && !signal?.aborted)await new Promise(r=>setTimeout(r,200));
      }
    }
    if(!guardOk || signal?.aborted)return;
    continuedTurns.set(agent.session,{turn,count:count+1,lastMsgId:msgId,lastResult:result});
    const hasVisibleOutput=Array.isArray(content) && content.some(b=>b.type==='tool-call' || (b.type==='text' && b.text?.trim()));
    const promptText=isLengthLimit
      ? (hasVisibleOutput
          ? 'Your previous response hit the output token limit mid-generation. Continue seamlessly from the exact point where you stopped without repeating what you already wrote.'
          : 'Your previous thought reached the output token limit before producing an answer or tool call. Conclude your thinking concisely and provide your visible answer or tool call now.')
      : 'The previous model response contained reasoning only and ended without an answer or tool call. Continue the current task from the existing context. Do not repeat side effects unless verified.';
    agent.inject({id:crypto.randomUUID(),role:'user',source:{kind:'freepi-recovery',reason:isLengthLimit?'max-tokens':'reasoning-only'},content:[{type:'text',text:promptText}]});
  });
  function control(data,signal) {
    const key=data.workerId||data.sessionId;
    const pending=(chains.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const timeout=AbortSignal.timeout(4000);
      const response=await original(endpoint,{method:'POST',headers:{'content-type':'application/json','x-freepi-control':'session-routing',...authHeaders()},body:JSON.stringify(data),signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if(!response.ok) throw Error('Free-Pi session routing returned '+response.status);
      return response.json();
    });
    chains.set(key,pending);
    pending.finally(()=>{if(chains.get(key)===pending)chains.delete(key);}).catch(()=>{});
    return pending;
  }
  const pause=signal=>new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(done,1000);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason);};
    signal?.addEventListener('abort',abort,{once:true});
  });
  const wrapped=async(input,init)=>{
    const address=typeof input==='string'||input instanceof URL?String(input):input.url;
    if(address!==base+'/v1/chat/completions')return original(input,init);
    const agent=ctx.agents.currentInitiator();
    if(!agent)return original(input,init);
    if(agent.session?.id && agent.session.id!==agent.id)throw Error('Subagent/chat identity mismatch');
    const root=rootAgent(ctx.agents,agent);
    noteActivity(agent);
    if(root!==agent)noteActivity(root);
    const cowork=agent!==root;
    let model, parsedBody;
    try{parsedBody=JSON.parse(typeof init?.body==='string'?init.body:await input.clone().text());model=parsedBody?.model;}catch{}
    if(cowork && (!model || model==='particle')) {
      model='deepseek-v4.1-flash';
      if(parsedBody && typeof init?.body==='string') {
        parsedBody.model='deepseek-v4.1-flash';
        init={...init,body:JSON.stringify(parsedBody)};
      }
    }
    const signal=init?.signal || input?.signal;
    const data={action:cowork?'cowork':'reserve',sessionId:root.id,model,...(cowork?{workerId:agent.id}:{})};
    if(cowork)activeWorkers.add(agent.id);
    let allocation;
    try {
      do {
        signal?.throwIfAborted();
        allocation=await control(data,signal);
        if(allocation.status==='unavailable')throw Error(allocation.message);
        if(allocation.accountId && allocation.status!=='waiting')break;
        await pause(signal);
      } while(true);
    } catch(error) {
      if(!allocation?.accountId || allocation.status==='waiting') {
        if(cowork) activeWorkers.delete(agent.id);
        control({action:cowork?'release-worker':'release',sessionId:cowork?agent.id:root.id}).catch(()=>{});
      }
      throw error;
    }
    const headers=new Headers(init?.headers || (input instanceof Request?input.headers:undefined));
    headers.set('x-freepi-session',root.id);
    headers.set('x-freepi-account',allocation.accountId);
    headers.set('x-freepi-chat',agent.id);
    if(cowork)headers.set('x-freepi-worker',agent.id);
    return original(input,{...init,headers});
  };
  ctx.effect(()=>{
    slot.owner=owner;
    slot.handler=wrapped;
    globalThis.fetch=slot.dispatch;
    const KEEPALIVE_MS=Number(process.env.FREEPI_KEEPALIVE_MS || 15000);
    const timer=setInterval(()=>{
      const now=Date.now();
      for(const agent of ctx.agents.list()) {
        if(agent.status!=='running')continue;
        const isWorker=activeWorkers.has(agent.id);
        if(!isWorker && rootAgent(ctx.agents,agent)!==agent)continue;
        const key=activityKey(agent);
        const last=lastActivity.get(key);
        if(last===undefined){lastActivity.set(key,now);}
        else if(now-last>=IDLE_RELEASE_MS){
          release(agent);
          continue;
        }
        control({action:'touch',sessionId:agent.id}).catch(()=>{});
      }
    },KEEPALIVE_MS);
    timer.unref?.();
    return ()=>{
      clearInterval(timer);
      if(slot.owner!==owner)return;
      slot.owner=null;
      slot.handler=null;
      if(globalThis.fetch===slot.dispatch)globalThis.fetch=original;
    };
  });
  function release(agent) {
    recovery.clear(agent.id);
    if(activeWorkers.delete(agent.id)) control({action:'release-worker',sessionId:agent.id}).catch(()=>{});
    if(rootAgent(ctx.agents,agent)===agent)control({action:'release',sessionId:agent.id}).catch(()=>{});
  }
  ctx.on('agent/status',({agent,status})=>{if(status==='idle')release(agent);});
  ctx.on('agent/disposed',({agent})=>release(agent));
  ctx.on('agent/created',async({agent})=>{
    const root=rootAgent(ctx.agents,agent);
    if(!root||root===agent)return;
    if(agent.session?.id&&agent.session.id!==agent.id)throw Error('Subagent/chat identity mismatch');
    activeWorkers.add(agent.id);
    const rawModel=agent.session?.requestHeader?.()?.config?.model;
    const model=(!rawModel||rawModel==='particle')?'deepseek-v4.1-flash':rawModel;
    // Reserve as soon as the child is created; the first model fetch keeps
    // polling if the pool is full. No sign-in or manual activation is required.
    const allocation=await control({action:'cowork',sessionId:root.id,workerId:agent.id,model}).catch(()=>null);
    if(!allocation || allocation.status==='unavailable') activeWorkers.delete(agent.id);
  });
  ctx.on('agent/request-error',async(payload,next)=>{
    // Sponsor waits and transport failures use the longer, cancellable
    // Free-Pi recovery budget before the generic five-attempt policy.
    const failureText=JSON.stringify(payload.failure||{});
    const managedRecovery=payload.provider==='freepi' && /ads_required|hourly_ceiling|hourly limit|rolling_cap|queue_wait|account_busy|account_unusable|upstream responded 402|connection error|socket hang up|econnreset|etimedout|timed out|idle timeout|econnrefused|fetch failed/i.test(failureText);
    const prior=managedRecovery?undefined:await next();
    if(prior?.kind==='retry')return prior;
    const retry=recovery.next(payload);
    if(!retry)return managedRecovery?await next():prior;
    const root=rootAgent(ctx.agents,payload.agent);
    const message=retry.category==='capacity'?'Model busy':retry.category==='upgrade'?'Updating official CLI and restarting proxy':retry.category==='session'?'Waiting for account session slot':retry.category==='ads'?'Waiting for sponsor display':/upstream responded 402/i.test(failureText)?'Free-Pi backend unavailable (502 / upstream 402)':'Connection interrupted';
    await control({action:'notice',sessionId:root.id,message,retryAt:Date.now()+retry.delayMs}).catch(()=>{});
    try{await abortableDelay(retry.delayMs,payload.signal);return {kind:'retry'};}
    finally{control({action:'notice',sessionId:root.id,message:''}).catch(()=>{});}
  });
  ctx.commands.register({name:'freepi-session',description:'Show main account reservations and cowork handovers',handler:async invocation=>{
    try {
      const response=await original(endpoint,{headers:authHeaders(),signal:AbortSignal.timeout(3000)});
      const data=await response.json();
      const pool=data.accounts?[`Accounts available: ${data.accounts.available}/${data.accounts.total} (busy: ${data.accounts.busy||0})`]:[];
      const lines=[...pool,...(data.sessions||[]).map(s=>`${s.sessionId}: ${s.message}`),...(data.workers||[]).map(w=>`Subagent/chat ${w.chatId} -> ${w.accountId} (exclusive; parent ${w.parentSessionId})`),...(data.waitingWorkers||[]).map(w=>`Subagent/chat ${w.workerId}: waiting for a free account`)];
      return {kind:'success',text:lines.length?lines.join('\n'):'All accounts released; an exclusive account is assigned when a chat starts working.'};
    }catch(error){return {kind:'error',text:error.message};}
  }});
}
