export class RecoveryBudget {
  constructor(clock=Date.now){this.clock=clock;this.attempts=new Map();}
  clear(agentId){for(const key of this.attempts.keys())if(key.startsWith(agentId+':'))this.attempts.delete(key);}
  next({agent,turn,step,provider,failure,signal}) {
    if(provider!=='freepi'||signal?.aborted||failure?.code==='ABORTED')return null;
    const text=JSON.stringify(failure||{}).toLowerCase();
    const category=/model_at_capacity|model_busy|model is busy|model.*at capacity/.test(text)?'capacity':
      /upgrade_required|client_update_failed/.test(text)?'upgrade':
      /concurrent_session|too many parallel sessions|already at.*session limit/.test(text)?'session':
      /ads_required/.test(text)?'ads':
      /connection error|socket hang up|econnreset|etimedout|econnrefused|queue_timeout|temporarily unavailable|upstream responded 402|http 50[234]|bad gateway|gateway timeout|stream stalled|no response content|fetch failed|terminated/.test(text)?'connection':null;
    if(!category)return null;
    const key=agent.id+':'+turn+':'+step;
    const state=this.attempts.get(key)||{start:this.clock(),count:0};
    const maxTime=category==='session'?35*60*1000:category==='capacity'?10*60*1000:category==='ads'?5*60*1000:2*60*1000;
    const maxAttempts=category==='session'?35:category==='capacity'?15:6;
    const base=category==='session'?60000:category==='capacity'?15000:category==='upgrade'?5000:category==='ads'?5000:1000;
    const reportedWait=Number(/retry_after_seconds[^0-9]{0,16}([0-9]+)/.exec(text)?.[1])||0;
    const delayMs=category==='session'?Math.max(60000,reportedWait*1000):Math.min(60000,base*2**state.count);
    if(state.count>=maxAttempts||this.clock()-state.start+delayMs>maxTime)return null;
    state.count++;this.attempts.set(key,state);
    return {category,delayMs,attempt:state.count};
  }
}
export function abortableDelay(ms,signal){return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason);return;}
  const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(finish,ms);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason);};
  signal?.addEventListener('abort',abort,{once:true});
});}
