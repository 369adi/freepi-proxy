import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
const prefix=path.join(root,'runtime','freepi-cli');
const lockFile=path.join(prefix,'update.lock');
const stateFile=path.join(prefix,'update-state.json');
const logFile=path.join(root,'logs','client-update.log');
let updating, restartPending=false, restartDeadline=0;
export function getClientVersion(){
  try{const version=JSON.parse(fs.readFileSync(path.join(prefix,'node_modules','free-pi-cli','package.json'),'utf8')).version;if(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))return version;}catch{}
  return '0.6.15';
}
export function requiredVersion(error){
  return error?.minimum_version||error?.min_version||error?.required_version||
    /(?:minimum|required)[^0-9]{0,20}(\d+\.\d+\.\d+)/i.exec(error?.message||error?.error?.message||'')?.[1]||null;
}
export function runtimeStatus(){if(restartPending&&Date.now()>restartDeadline)restartPending=false;return {version:getClientVersion(),updating:!!updating,restartPending};}
function log(message){fs.mkdirSync(path.dirname(logFile),{recursive:true});fs.appendFileSync(logFile,new Date().toISOString()+' '+message+'\n');}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function run(node,args,timeoutMs){return new Promise((resolve,reject)=>{
  const child=spawn(node,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>{child.kill();reject(Error('Client update command timed out'));},timeoutMs);
  const collect=data=>{output=(output+data).slice(-10000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(output);else{log(output);reject(Error('Client update command failed with exit '+code));}});
});}
export function upgradeClient(minimum,{restart=true}={}){
  if(updating)return updating;
  const operation=(async()=>{
    fs.mkdirSync(prefix,{recursive:true});
    let held=false;
    const deadline=Date.now()+180000;
    while(!held){
      try{const fd=fs.openSync(lockFile,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));fs.closeSync(fd);held=true;}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        try{const owner=JSON.parse(fs.readFileSync(lockFile,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<=0||!alive(owner.pid)||Date.now()-owner.at>300000){fs.unlinkSync(lockFile);continue;}}
        catch(readError){if(readError.code==='ENOENT')continue;try{if(Date.now()-fs.statSync(lockFile).mtimeMs>5000){fs.unlinkSync(lockFile);continue;}}catch{}}
        if(Date.now()>deadline)throw Error('Another CLI update did not finish in time');
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
    try{
      const node=path.basename(process.execPath).toLowerCase()==='node.exe'?process.execPath:path.join(process.env.ProgramFiles||'C:/Program Files','nodejs','node.exe');
      const npm=path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js');
      let previous;try{previous=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
      if(!previous||Date.now()-previous.checkedAt>60000||previous.version!==getClientVersion()){
        log('Installing official free-pi-cli@latest; previous version '+getClientVersion());
        await run(node,[npm,'install','--prefix',prefix,'--no-audit','--no-fund','--save-exact','free-pi-cli@latest'],150000);
        previous={checkedAt:Date.now(),version:getClientVersion()};
        fs.writeFileSync(stateFile,JSON.stringify(previous,null,2));
      }
      const installed=getClientVersion();
      if(minimum){const a=installed.split('.').map(Number),b=minimum.split('.').map(Number);let comparison=0;for(let i=0;i<3;i++){if(a[i]!==b[i]){comparison=a[i]>b[i]?1:-1;break;}}if(comparison<0)throw Error('Official latest CLI '+installed+' is below required '+minimum);}
      log('Official CLI ready: '+installed);
      if(restart && (!previous.restartAt||Date.now()-previous.restartAt>120000)){
        restartPending=true;restartDeadline=Date.now()+90000;
        try{
          const output=await run(node,[path.join(root,'tools','restart-dsh.mjs'),'--delay','3','--no-open','--refresh-proxy'],30000);
          log(output.trim());previous.restartAt=Date.now();fs.writeFileSync(stateFile,JSON.stringify(previous,null,2));
        }catch(error){restartPending=false;throw error;}
      }
      return {version:installed,restartPending};
    }finally{try{if(JSON.parse(fs.readFileSync(lockFile,'utf8')).pid===process.pid)fs.unlinkSync(lockFile);}catch{}}
  })();
  updating=operation;operation.finally(()=>{if(updating===operation)updating=null;}).catch(()=>{});return operation;
}
