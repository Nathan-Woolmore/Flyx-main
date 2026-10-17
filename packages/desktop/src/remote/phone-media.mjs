import {createHLSResources,createResourceBudget} from './hls-media.mjs';
import {randomUUID} from 'node:crypto';
import {playbackFailure} from './playback-errors.mjs';
export function createPhoneMedia(request,{origin,fetcher=fetch,now=Date.now,makeID=randomUUID}={}) {
 const sessions=new Map(),budget=createResourceBudget();
 const activate=(session,source)=>{session.current=source.id;session.url=source.url;session.format=source.format;session.resources=source.format==='mp4'?null:createHLSResources(source.url,{origin,fetcher});};
 const grant=(handle,session)=>({handle,title:session.title,position:session.position,duration:session.duration,paused:session.paused,format:session.format,mode:session.mode??(session.selection?'direct':'handoff'),currentSource:session.current,sources:session.pool.map(({id,provider,quality,language,format})=>({id,provider,quality,language,format}))});
 const makeSession=(source,selection,owner,mode,explicitStartOver=false)=>{
   const base=new URL(origin);
   const pool=(source.sources?.length?source.sources:[source]).slice(0,64).flatMap((value,index)=>{try{const u=new URL(value.url);if(!['video/mp4','application/x-mpegURL','application/vnd.apple.mpegurl'].includes(value.contentType)||u.protocol!=='http:'||!['localhost','127.0.0.1'].includes(u.hostname)||u.port!==base.port||!['/api/stream/proxy','/api/stream/local'].includes(u.pathname)||u.username||u.password)return[];return[{id:String(index),url:new URL(u.pathname+u.search,base).href,format:value.contentType==='video/mp4'?'mp4':'hls',provider:String(value.provider??'Mac').slice(0,60),quality:String(value.quality??'Auto').slice(0,40),language:String(value.language??'').slice(0,20),rank:Number.isFinite(value.recoveryRank)?value.recoveryRank:index}];}catch{return[];}});
   if(!pool.length||!source.identity)throw playbackFailure('PHONE_FORMAT_UNSUPPORTED');
   for(const [id,value]of sessions)if(value.expires<=now()||now()-value.created>=28800000)sessions.delete(id);if(sessions.size>=8)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');const handle=makeID();
   const session={explicitStartOver,owner,created:now(),expires:now()+1800000,identity:source.identity,selection,pool,failed:new Set(),failures:0,title:String(source.title??'Flyx').slice(0,200),duration:Math.max(0,source.duration??0),position:Math.max(0,source.position??0),paused:selection?false:source.paused!==false,phase:'prepared',cancelled:false,mode};
   activate(session,pool[0]);sessions.set(handle,session);return grant(handle,session);
 };
 const handleRequest=async(operation,body,owner)=>{
  if(operation==='prepare') {
   let selection;
   if(body.selection){const value=body.selection;if(!['movie','tv','anime'].includes(value.kind)||!Number.isSafeInteger(value.contentID)||value.contentID<1||Object.keys(value).some(k=>!['kind','contentID','season','episode'].includes(k))||(value.kind!=='movie'&&(!Number.isSafeInteger(value.episode)||value.episode<1||!Number.isSafeInteger(value.season)||value.season<0)))throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');selection={...value};}
   const source=await request(selection?{operation:'prepare-title',selection}:{operation:'prepare'});
   if(selection&&body.position!==undefined){if(!Number.isFinite(body.position)||body.position<0||body.position>86400)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');source.position=body.position;}
   return makeSession(source,selection,owner,selection?'direct':'handoff',!!selection&&body.position===0);
  }
  const session=sessions.get(body.handle);
  if(!session||session.owner!==owner||(session.expires<=now()||now()-session.created>=28800000))throw playbackFailure('PHONE_MEDIA_EXPIRED');
  session.expires=now()+1800000;
  if(operation==='next-source'||operation==='select-source'){
   if(!session.selection||!Number.isFinite(body.position)||body.position<0||body.position>86400||typeof body.paused!=='boolean')throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
   let next;
   if(operation==='next-source'){session.failed.add(session.current);session.failures++;if(session.failures>=5)throw playbackFailure('PHONE_SOURCES_EXHAUSTED');const current=session.pool.find(s=>s.id===session.current);next=session.pool.filter(s=>!session.failed.has(s.id)).sort((a,b)=>Number(b.provider===current.provider)-Number(a.provider===current.provider)||Number(b.language===current.language)-Number(a.language===current.language)||a.rank-b.rank)[0];}
   else{next=session.pool.find(s=>s.id===body.sourceID);session.failures=0;}
   if(!next)throw playbackFailure('PHONE_SOURCES_EXHAUSTED');
   sessions.delete(body.handle);const handle=makeID();session.position=body.position;session.paused=body.paused;session.phase='prepared';activate(session,next);sessions.set(handle,session);return grant(handle,session);
  }
  if(operation==='resource'){if(!session.resources)throw playbackFailure('PHONE_FORMAT_UNSUPPORTED');return budget(()=>session.resources(body.resourceID,body.range));}
  if(operation==='chunk') {
   if(!Number.isSafeInteger(body.offset)||body.offset<0||!Number.isSafeInteger(body.length)||body.length<1||body.length>1048576)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
   const response=await fetcher(session.url,{headers:{Range:`bytes=${body.offset}-${body.offset+body.length-1}`},redirect:'error',signal:AbortSignal.timeout(15000)});
   const range=/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(response.headers.get('content-range')??'');
   if(response.status!==206||!range||Number(range[1])!==body.offset||response.headers.get('content-type')?.split(';')[0]!=='video/mp4'||Number(range[2])-body.offset+1>body.length)throw playbackFailure('PHONE_FORMAT_UNSUPPORTED');
   const total=Number(range[3]);if(!Number.isSafeInteger(total)||total<1||total>1099511627776)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>body.length)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');chunks.push(chunk);}
   if(size!==Number(range[2])-body.offset+1)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
   return{bytes:Buffer.concat(chunks).toString('base64'),total,offset:body.offset};
  }
  if(['cancel-prepare','close'].includes(operation)){
   session.cancelled=true;sessions.delete(body.handle);
   if(!session.selection)await request({operation:'cancel',handle:body.handle,identity:session.identity,restore:operation==='cancel-prepare'&&session.phase!=='mac'});return{ok:true};
  }
  if(session.mode==='transfer'&&['phone-ready','phone-started','mac'].includes(operation))throw playbackFailure('TRANSFER_NOT_READY');
  if(operation==='phone-started'){
   if(session.phase!=='paused')throw playbackFailure('PHONE_MEDIA_EXPIRED');
   if(!session.selection)await request({operation:'phone-started',handle:body.handle,identity:session.identity});session.phase='phone';return{ok:true};
  }
  if(!['phone-ready','mac'].includes(operation)||!Number.isFinite(body.position)||body.position<0||body.position>86400||typeof body.paused!=='boolean')throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
  const result=session.selection&&operation==='phone-ready'?{ok:true,status:{state:'prepared',position:0,duration:session.duration},transfer:{position:session.position,paused:session.paused}}:await request({operation:session.selection?'select-mac':operation,selection:session.selection,handle:body.handle,identity:session.identity,position:body.position,paused:body.paused});
  if(session.cancelled){if(!session.selection)await request({operation:'cancel',handle:body.handle,identity:session.identity,restore:true});throw playbackFailure('PHONE_MEDIA_EXPIRED');}
  session.phase=operation==='phone-ready'?'paused':'mac';return result;
 };
 const owned=(owner,id)=>{const value=sessions.get(id);if(!value||value.owner!==owner||value.expires<=now()||now()-value.created>=28800000)throw playbackFailure('PHONE_MEDIA_EXPIRED');return value;};
 handleRequest.inspectForTransfer=(owner,id)=>{const value=owned(owner,id);if(value.phase!=='phone')throw playbackFailure('TRANSFER_NOT_READY');return{identity:value.identity,stamp:id,startedAt:value.created,explicitStartOver:value.explicitStartOver,selection:value.selection,url:value.url,contentType:value.format==='hls'?'application/x-mpegURL':'video/mp4',title:value.title};};
 handleRequest.prepareForTransfer=(owner,source)=>makeSession(source,source.selection,owner,'transfer');
 handleRequest.transferIsCurrent=(owner,id)=>{try{const value=owned(owner,id);return value.mode==='transfer'&&value.phase==='prepared';}catch{return false;}};
 handleRequest.activateTransfer=(owner,id)=>{const value=owned(owner,id);if(value.mode!=='transfer')throw playbackFailure('TRANSFER_NOT_READY');value.phase='phone';value.mode='direct';return{ok:true};};
 return handleRequest;
}
