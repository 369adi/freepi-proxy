window.__ModuleLoader__.load({id:'freepi-session-routing',factory:require=>{
  const React=require('react');
  function AccountStatus({sessionId}) {
    const [label,setLabel]=React.useState('');
    React.useEffect(()=>{
      let alive=true;
      const refresh=async()=>{
        try{
          const response=await fetch('http://127.0.0.1:4000/session-routing',{signal:AbortSignal.timeout(2500)});
          if(!response.ok)throw Error('Proxy unavailable');
          const data=await response.json();
          const row=data.sessions?.find(s=>s.sessionId===sessionId);
          const pool=data.accounts?` (${data.accounts.available}/${data.accounts.total} acc)`:'';
          if(alive)setLabel((row?.message||'Account released · idle')+pool);
        }catch{if(alive)setLabel('Free-Pi proxy offline');}
      };
      refresh();const timer=setInterval(refresh,1500);
      return()=>{alive=false;clearInterval(timer);};
    },[sessionId]);
    return React.createElement('span',{title:label,style:{fontSize:'12px',color:label.startsWith('Waiting')?'#f0b65d':'#a6bbd5',padding:'0 6px'},'data-freepi-session':sessionId},label);
  }
  return {inject:['slots'],apply(ctx){ctx.slots.inject('conversation.session.header.actions',()=>ctx.slots.register({name:'conversation.session.header.actions',id:'freepi-session-account',order:15},AccountStatus));}};
}});
