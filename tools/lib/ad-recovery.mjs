// Wait for a real display acknowledgement; opening a window is not an impression.
export function waitForSponsorDisplay(accountId,{events,downstream,timeoutMs=45000,isBlocked=()=>true}) {
  return new Promise(resolve=>{
    let settled=false;
    const finish=result=>{
      if(settled)return;settled=true;clearTimeout(timer);
      events.removeListener('displayed',displayed);downstream.removeListener('close',closed);resolve(result);
    };
    const displayed=id=>{if(id===accountId)finish(true);};
    const closed=()=>finish(false);
    const timer=setTimeout(()=>finish(false),timeoutMs);
    events.on('displayed',displayed);downstream.once('close',closed);
    if(downstream.destroyed)finish(false);
    else if(!isBlocked(accountId))finish(true);
  });
}
