// Transport cleanup independent of provider, credentials, or scheduling policy.
export function bindRequestLifecycle(upstream, downstream, release, timeoutMs = 240_000) {
  let released = false;
  let progressTimer, responseStream, progressListener;
  const finish = () => {
    if (released) return;
    released = true;
    clearTimeout(headerTimer);
    clearTimeout(progressTimer);
    if(responseStream&&progressListener)responseStream.removeListener('data',progressListener);
    downstream.removeListener('close', cancel);
    release();
  };
  const cancel = () => {
    if (!downstream.writableEnded) upstream.destroy();
    finish();
  };
  const headerTimer = setTimeout(() => {
    upstream.destroy(new Error('Upstream did not send response headers within ' + timeoutMs + ' ms'));
    finish();
  }, timeoutMs);
  headerTimer.unref?.();
  downstream.once('close', cancel);
  upstream.once('error', finish);
  upstream.once('close', finish);
  upstream.once('response', response => {
    clearTimeout(headerTimer);
    responseStream=response;
    let pending='';
    const armProgress=()=>{
      if(released)return;
      clearTimeout(progressTimer);
      progressTimer=setTimeout(()=>{
        if(released)return;
        upstream.destroy(new Error('Model stream stalled: no response content for '+timeoutMs+' ms'));
        if(!downstream.writableEnded)downstream.destroy();
        finish();
      },timeoutMs);
      progressTimer.unref?.();
    };
    const eventStream=String(response.headers?.['content-type']||'').includes('text/event-stream');
    progressListener=chunk=>{
      if(!eventStream){armProgress();return;}
      pending=(pending+chunk.toString()).replaceAll('\r\n','\n');
      let boundary;
      while((boundary=pending.indexOf('\n\n'))>=0){
        const event=pending.slice(0,boundary);pending=pending.slice(boundary+2);
        const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        try {
          const payload=JSON.parse(data);
          const meaningful=(payload.choices||[]).some(choice=>{
            const delta=choice.delta||choice.message||{};
            const hasReasoningDetails=Array.isArray(delta.reasoning_details)&&delta.reasoning_details.some(item=>
              typeof item==='string'?item.length>0:Boolean(item&&(item.text||item.summary||item.data)));
            return [choice.text,delta.content,delta.reasoning_content,delta.reasoning,delta.reasoning_text].some(value=>typeof value==='string'&&value.length>0)||
              hasReasoningDetails||
              (delta.tool_calls||[]).some(call=>call.function?.arguments||call.function?.name);
          });
          if(meaningful)armProgress();
        }catch{}
      }
      if(pending.length>131072)pending=pending.slice(-131072);
    };
    response.on('data',progressListener);
    armProgress();
    response.once('end', finish);
    response.once('aborted', () => { finish(); downstream.destroy(); });
    response.once('error', error => { finish(); downstream.destroy(error); });
  });
  upstream.setTimeout(timeoutMs, () => {
    upstream.destroy(new Error('Upstream stream was inactive for ' + timeoutMs + ' ms'));
    finish();
  });
  if (downstream.destroyed) cancel();
  return finish;
}
