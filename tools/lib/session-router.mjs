// Ephemeral turn leases. A busy coworker may finish, but cannot be re-claimed
// after a main has reserved its account. Idle roots release their lease.
export class SessionRouter {
  constructor(clock = Date.now, ttl = 90000, persistence={}, bindingTtl = 6*60*60*1000) {
    this.clock = clock; this.ttl = ttl; this.bindingTtl = bindingTtl;
    this.leases = new Map(); this.waiting = new Map(); this.workers=new Map();this.workerWaiters=new Map();
    this.persistence=persistence;
    this.bindings=new Map(persistence.load?.()||[]);
  }
  sweep() {
    for (const [id, lease] of this.leases) if (this.clock() - lease.touched > this.ttl) this.release(id);
    for (const [id, w] of this.waiting) if (!this.leases.has(id) && this.clock() - (w.touched ?? 0) > this.ttl) this.waiting.delete(id);
    for (const [id, w] of this.workers) if (this.clock() - w.touched > this.ttl) this.workers.delete(id);
    // Persisted bindings (exclusive account->subagent assignments) survive
    // restarts, but dead sessions must not keep their account reserved.
    // Contact = the binding's own stamp (set on (re)bind) or live state of its
    // session (lease) / worker (reserved or waiting). Legacy rows carry no
    // stamp and are treated as already expired.
    let changed=false;
    for (const [worker,b] of this.bindings) {
      // Live = any current presence of the binding's session or worker
      // (reserved lease, active worker, or a waiting worker).
      const live=Math.max(this.leases.get(b.sessionId)?.touched??0,this.workers.get(worker)?.touched??0,this.workerWaiters.get(worker)?.touched??0);
      // Legacy rows (no `touched` stamp, written before this fix) are purged
      // only when their session shows no presence at all. Stamped rows expire
      // once neither the live state nor their stamp has been seen for bindingTtl.
      const stale=Number.isFinite(b.touched) ? this.clock()-Math.max(live,b.touched)>this.bindingTtl : live===0;
      if (stale) { this.bindings.delete(worker); changed=true; }
    }
    if (changed) { try { this.persistence.save?.([...this.bindings]); } catch { /* in-memory rows are already deleted; only the file may still hold them until the next restart purges again */ } }
  }
  release(session) { this.leases.delete(session); this.waiting.delete(session); this.notices?.delete(session); }
  notice(session,message,retryAt){this.notices??=new Map();if(!message)this.notices.delete(session);else this.notices.set(session,{message:String(message).slice(0,120),retryAt:Number(retryAt)||this.clock()});}
  touch(session) { const lease=this.leases.get(session)||this.workers.get(session)||this.workerWaiters.get(session)||this.waiting.get(session); if(lease) lease.touched=this.clock(); }
  owner(account) { this.sweep(); for(const [id,l] of this.leases) if(l.accountId===account) return id; return null; }
  workerAt(account) { return [...this.workers.values()].find(w=>w.accountId===account); }
  allowed(account, session, worker) {
    this.sweep();
    const held=this.workerAt(account);
    if(held) return held.workerId===worker && held.sessionId===session;
    if(worker)return false;
    const owner=this.owner(account);
    if(owner)return owner===session;
    // A waiting main has priority over assigning a new cowork job.
    return ![...this.waiting.values()].some(row=>!row.accountId);
  }
  releaseWorker(worker) {this.workers.delete(worker);this.workerWaiters.delete(worker);}
  // Switch one live reservation while keeping it exclusive. Failure leaves the
  // original reservation and persisted worker binding untouched.
  moveReservation(session, worker, from, candidates, busy) {
    this.sweep();
    const held = worker ? this.workers.get(worker) : this.leases.get(session);
    if (!held || held.accountId !== from || (worker && held.sessionId !== session)) return null;
    const target = candidates.find(a => a.id !== from && !busy.has(a.id) && !this.owner(a.id) && !this.workerAt(a.id));
    if (!target) return null;
    if (worker) {
      const binding = this.bindings.get(worker);
      if (!binding || binding.sessionId !== session || binding.accountId !== from) return null;
      const replacement = {...binding,accountId:target.id,touched:this.clock()};
      this.bindings.set(worker,replacement);
      try { this.persistence.save?.([...this.bindings]); }
      catch { this.bindings.set(worker,binding); return null; }
    }
    held.accountId=target.id; held.touched=this.clock();
    const waiting=this.waiting.get(session);
    if(!worker && waiting) waiting.accountId=target.id;
    return target.id;
  }
  reserveWorker(worker,session,candidates,busy) {
    this.sweep();
    if(!candidates.length)return {status:'unavailable',message:'No account is eligible for this model. Check sign-in, advertising and model access.'};
    const held=this.workers.get(worker);
    if(held) {
      if(held.sessionId!==session)return {status:'unavailable',message:'Subagent belongs to another chat'};
      if(candidates.some(a=>a.id===held.accountId) && !busy.has(held.accountId)) {
        this.workerWaiters.delete(worker);held.touched=this.clock();return {accountId:held.accountId,status:'cowork'};
      }
      this.workers.delete(worker);
    }
    const binding=this.bindings.get(worker);
    if(binding && binding.sessionId!==session)return {status:'unavailable',message:'Subagent belongs to another chat'};
    const validBinding=binding && candidates.some(a=>a.id===binding.accountId) && !busy.has(binding.accountId) ? binding : null;
    const available=candidates.filter(a=>(!validBinding||validBinding.accountId===a.id)&&!this.owner(a.id)&&!this.workerAt(a.id)&&this.allowed(a.id,session)&&!busy.has(a.id));
    const chosen=available[0];
    if(!chosen){this.workerWaiters.set(worker,{workerId:worker,parentSessionId:session,accountId:validBinding?.accountId||null,status:'waiting',touched:this.clock()});return {accountId:null,status:'waiting',message:'Waiting for an available cowork account'};}
    this.workerWaiters.delete(worker);
    if(!binding || binding.accountId!==chosen.id){
      this.bindings.set(worker,{accountId:chosen.id,sessionId:session,touched:this.clock()});
      try{this.persistence.save?.([...this.bindings]);}catch{if(binding)this.bindings.set(worker,binding);else this.bindings.delete(worker);return {status:'unavailable',message:'Could not persist the exclusive subagent account assignment'};}
    }
    this.workers.set(worker,{workerId:worker,sessionId:session,accountId:chosen.id,touched:this.clock()});
    return {accountId:chosen.id,status:'cowork'};
  }
  workerSnapshot(){return [...this.workers.values()].map(({workerId,sessionId,accountId})=>({workerId,chatId:workerId,parentSessionId:sessionId,accountId,role:'cowork'}));}
  waitingWorkerSnapshot(){for(const[id,w]of this.workerWaiters)if(this.clock()-w.touched>this.ttl)this.workerWaiters.delete(id);return [...this.workerWaiters.values()].map(({touched,...w})=>w);}
  reserve(session, candidates, busy) {
    this.sweep();
    if(!candidates.length) {this.release(session);return {status:'unavailable',message:'No account is eligible for this model. Check sign-in and model access.'};}
    let lease=this.leases.get(session);
    if(lease && !candidates.some(a=>a.id===lease.accountId)) { this.release(session); lease=null; }
    if(lease && (busy.has(lease.accountId)||this.workerAt(lease.accountId))) {
      const free=candidates.find(a=>!this.owner(a.id)&&!busy.has(a.id)&&!this.workerAt(a.id));
      if(free) lease.accountId=free.id;
    }
    if(!lease) {
      const available=candidates.filter(a=>!this.owner(a.id));
      let chosen=available.find(a=>!busy.has(a.id)&&!this.workerAt(a.id)) || available[0];
      if(!chosen) {
        const idle=candidates.find(a=>{
          if(busy.has(a.id)||this.workerAt(a.id)) return false;
          const owner=this.owner(a.id);
          const ownerLease=owner?this.leases.get(owner):null;
          return ownerLease && this.clock()-(ownerLease.reservedAt??ownerLease.touched??0)>2000;
        });
        if(idle) {
          const prevOwner=this.owner(idle.id);
          if(prevOwner) this.release(prevOwner);
          chosen=idle;
        }
      }
      if(!chosen) {
        const result={sessionId:session,accountId:null,status:'waiting',message:'Waiting for a main account to become idle'};
        this.waiting.set(session,{...result,touched:this.clock()}); return result;
      }
      lease={accountId:chosen.id,touched:this.clock(),reservedAt:this.clock()}; this.leases.set(session,lease);
    }
    lease.touched=this.clock();
    lease.reservedAt=this.clock();
    const waiting=busy.has(lease.accountId)||!!this.workerAt(lease.accountId);
    const result={sessionId:session,accountId:lease.accountId,status:waiting?'waiting':'main',message:waiting?'Waiting for cowork to finish':'Main account: '+lease.accountId};
    this.waiting.set(session,{...result,touched:this.clock()}); return result;
  }
  snapshot(busy) {
    this.sweep();
    return [...this.waiting.values()].map(({touched,...row})=>row.accountId ? {...row,status:(busy.has(row.accountId)||this.workerAt(row.accountId))&&row.status==='waiting'?'waiting':'main',message:(busy.has(row.accountId)||this.workerAt(row.accountId))&&row.status==='waiting'?'Waiting for cowork to finish':'Main account: '+row.accountId} : row).map(row=>{
      const notice=this.notices?.get(row.sessionId);
      const waiting=this.waitingWorkerSnapshot().filter(w=>w.parentSessionId===row.sessionId).length;
      return notice?{...row,message:`${row.accountId||'Free-Pi'} · ${notice.message} · retry in ${Math.max(0,Math.ceil((notice.retryAt-this.clock())/1000))}s`}:waiting?{...row,message:`${row.message} · ${waiting} subagent(s) waiting for a free account`}:row;
    });
  }
}
