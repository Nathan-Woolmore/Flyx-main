import {it,expect} from 'vitest';
import http from 'node:http';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {createProgressBridge} from '../../packages/app/src/lib/remote/progress-bridge.mjs';import {createRendererAdapter,registerRemoteCastSource} from '../../packages/app/src/lib/remote/renderer.mjs';
import {createRemoteProgress} from '../../packages/desktop/src/remote/progress.mjs';import {createPhoneMedia} from '../../packages/desktop/src/remote/phone-media.mjs';import {RemoteCore} from '../../packages/desktop/src/remote/remote-core.mjs';import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';
import {createTransferRuntime} from '../../packages/desktop/src/remote/transfer-runtime.mjs';
import {readProgress,writeProgress,upsertEntry,isProgressFinished} from '../../packages/app/src/lib/watch-progress';
it('native iOS progress fixture uses production protocol/core/media/progress/canonical storage',async()=>{
 const file='/tmp/flyx-native-switching40-history.json';if(!fs.existsSync(file))fs.writeFileSync(file,'{}');
 const storage={getItem:(key:string)=>JSON.parse(fs.readFileSync(file,'utf8'))[key]??null,setItem:(key:string,value:string)=>{const map=JSON.parse(fs.readFileSync(file,'utf8'));map[key]=value;fs.writeFileSync(file,JSON.stringify(map));}};
 const read=()=>readProgress(storage);const write=(input:any)=>{const next=upsertEntry(read(),input);if(!next)return null;writeProgress(storage,next);return next[0]};
 let mode='normal',tag='',stamp='native-synthetic';let serial=0,state={state:'paused',position:33.25,duration:120};const identity=JSON.stringify(['movie','1','1','1']);const commands:any[]=[];const events:any[]=[];
 const source={identity,title:'Synthetic silent progress clip',url:'http://127.0.0.1:3891/api/stream/proxy?synthetic=1',contentType:'video/mp4',position:33.25,duration:120,paused:true};
 const remove=registerRemoteCastSource({contentType:'video/mp4',preparePhone:async()=>{if(mode==='slow')await new Promise(r=>setTimeout(r,1800));return {...source,position:state.position,paused:state.state!=='playing'}}});
 const player={isReady:()=>!['failed-mac','slow-mac'].includes(mode),stamp:()=>stamp,transferID:()=>tag,markTransfer:(id:string)=>tag=id,identity:()=>identity,snapshot:()=>({...state}),seek:(p:number)=>state.position=p,seekAndWait:async(p:number)=>state.position=p,pause:()=>{state.state='paused'},play:async()=>{state.state='playing'}};
 const adapter=createRendererAdapter({navigate:async(url:string)=>{if(mode==='slow-mac')await new Promise(r=>setTimeout(r,1800));if(mode==='failed-mac')throw new Error('SYNTHETIC_SOURCE_FAILURE');tag=new URL(url,'http://fixture').searchParams.get('remoteTransfer')??'';stamp=tag;},waitForPlayer:async()=>{},player,cast:{getState:async()=>({isCasting:false})},resolvePhoneTitle:async()=>({...source,position:0})} as any);
 let handler:any,transfers:any;
 const restart=()=>{
  const bridge=createProgressBridge({read,write,scope:()=> 'SYNTHETIC-ACCOUNT-ONLY',finished:isProgressFinished,begin:()=>({progressSessionID:'canonical-fixture-'+ ++serial,progressSessionStartedAt:Math.max(Date.now(),...read().map(e=>(e.progressSessionStartedAt??0)+1))})});
  const media=createPhoneMedia((payload:any)=>adapter({action:'phoneMedia',payload}),{origin:'http://127.0.0.1:3891'} as any);
  transfers=createTransferRuntime((payload:any)=>adapter({action:'transfer',payload}),media);
  const progress=createRemoteProgress((spec:any)=>bridge(spec),media);
  const core=new RemoteCore({now:Date.now,dispatch:async(c:any)=>{commands.push(c);return adapter({action:'command',payload:c})}} as any);
  core.approveDigest({id:'native-fixture-phone40',name:'Synthetic fixture',digest:createHash('sha256').update('SYNTHETIC-UI-ONLY').digest('hex')},['catalog.read','playback.control']);
  handler=createRemoteHandler({core,phoneMedia:media,progress,transfers,status:async()=>({...state,output:'mac',phonePlayback:true})} as any);
 };restart();let close:()=>void=()=>{};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');try{
  let result:any;
  if(req.url==='/fixture/probe')result={entries:read(),commands,events,state};
  else if(req.url==='/fixture/mode'){mode=body.mode??'normal';result={ok:true};}
  else if(req.url==='/remote/v1/fixture-mode'){mode=body.mode??'normal';result={ok:true};}
  else if(req.url==='/fixture/reset'){writeProgress(storage,[]);state={state:'paused',position:33.25,duration:120};commands.length=0;events.length=0;restart();result={ok:true};}
  else if(req.url==='/fixture/restart'){restart();result={ok:true};}
  else if(req.url==='/fixture/newer'||req.url==='/remote/v1/fixture-newer'){write({contentId:'1',contentType:'movie',currentTime:70,duration:120,progressSessionID:'newer-Mac-fixture',progressSessionStartedAt:Date.now()+100,progressSequence:1,completionEvidence:'position'});result={ok:true};}
  else if(req.url==='/fixture/stop'){result={ok:true};setTimeout(close,50);}
  else{const response=await handler({method:req.method,path:req.url,headers:req.headers,body});if(mode==='lost-confirm'&&body.operation==='confirm'){mode='normal';res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'SYNTHETIC_LOST_CONFIRM'}));return;}if(mode==='failed-phone'&&body.operation==='prepare'&&response.body?.destinationData)response.body.destinationData.format='unsupported';res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify(response.body));events.push({path:req.url,operation:body.operation,position:body.position,seconds:body.seconds,status:response.status});return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}});
 await new Promise<void>(resolve=>server.listen(47140,'127.0.0.1',resolve));console.log('Synthetic production switching server40 ready');
 await new Promise<void>(resolve=>{close=()=>server.close(()=>resolve());});remove();expect(read().every(e=>e.contentId==='1')).toBe(true);
},600000);
