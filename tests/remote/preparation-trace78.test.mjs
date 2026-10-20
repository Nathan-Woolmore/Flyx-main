import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPreparationTrace,safePreparationEvent} from '../../packages/desktop/src/remote/preparation-trace.mjs';
import {installRemoteBridge} from '../../packages/desktop/src/remote/electron-bridge.mjs';
import {createPhoneMedia} from '../../packages/desktop/src/remote/phone-media.mjs';
import {createRendererAdapter} from '../../packages/app/src/lib/remote/renderer.mjs';
import {resolvePhoneSources} from '../../packages/app/src/lib/remote/source-resolution.mjs';
const selection={kind:'anime',contentID:38000,season:1,episode:1};
const origin='http://127.0.0.1:3891';
const source={url:origin+'/api/stream/proxy?sig=PRIVATE-SIGNATURE',contentType:'application/x-mpegURL',language:'sub',quality:'720p'};
test('trace strips credentials, URLs, unknown text and unbounded values; caps count and lifetime',()=>{
 const requestID=randomUUID();const events=[];let time=0;
 const trace=createPreparationTrace({requestID,emit:event=>events.push(event),now:()=>time});
 trace('fetch-headers',{cookie:'PRIVATE-COOKIE',url:source.url,owner:'PRIVATE-OWNER',title:'PRIVATE-TITLE',errorName:'PRIVATE-ERROR',errorCode:'PRIVATE-CODE',provider:'PRIVATE-PROVIDER',status:200,contentID:38000,episode:1,sourceCount:65,elapsedMS:9000000});
 assert.deepEqual(events[0],{requestID,phase:'fetch-headers',contentID:38000,episode:1,elapsedMS:0,status:200});
 assert.equal(safePreparationEvent({requestID,phase:'PRIVATE-PHASE'}),undefined);
 assert.equal(safePreparationEvent({requestID:'PRIVATE-ID',phase:'route-enter'}),undefined);
 for(let i=0;i<100;i++)trace('fetch-start');assert.equal(events.length,40);
 const other=createPreparationTrace({requestID,emit:event=>events.push(event),now:()=>time});time=90001;other('fetch-start');assert.equal(events.length,40);
 assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
});
test('trace sink failure cannot change a prepared source or its quality and identity',async()=>{
 const result=await resolvePhoneSources(selection,{requestID:randomUUID(),onTrace:()=>{throw new Error('sink unavailable');},fetcher:async path=>new URL(path,origin).searchParams.get('provider')==='local'?Response.json({ok:false},{status:404}):Response.json({ok:true,sources:[source]})});
 assert.equal(result.sources.length,1);assert.equal(result.quality,'720p');assert.equal(result.sources[0].sourceInfo.selection.contentID,38000);
});
test('direct prepare traverses real bridge and renderer with correlation, never touching desktop playback',async()=>{
 const handlers=new Map(),events=[];let desktopCalls=0;
 const adapter=createRendererAdapter({navigate:()=>desktopCalls++,waitForPlayer:()=>desktopCalls++,cast:{getState:()=>{desktopCalls++;throw new Error('must not inspect TV');}},player:{play:()=>desktopCalls++,pause:()=>desktopCalls++,snapshot:()=>{desktopCalls++;return{};}},resolvePhoneTitle:async (selected,{requestID})=>resolvePhoneSources(selected,{requestID,onTrace:event=>handlers.get('flyx:remote-trace')({trusted:true},event),fetcher:async path=>{const query=new URL(path,origin).searchParams;assert.equal(query.get('preparationID'),requestID);assert.equal(query.get('malId'),'38000');return query.get('provider')==='local'?Response.json({ok:false},{status:404}):Response.json({ok:true,sources:[source]});}})});
 const bridge=installRemoteBridge({mediaOrigin:origin,diagnostic:event=>events.push(event),handleTrusted:(name,fn)=>handlers.set(name,fn),isMainFrame:event=>event.trusted===true,send:(_channel,request)=>queueMicrotask(async()=>{try{const data=await adapter(request);handlers.get('flyx:remote-reply')({trusted:true},{requestID:request.requestID,ok:true,data});}catch(error){handlers.get('flyx:remote-reply')({trusted:true},{requestID:request.requestID,ok:false,errorCode:error.code});}})});
 try {
  const local=(name,value)=>handlers.get(name)({trusted:true},value);
  const request=(body,token)=>bridge.handle({method:'POST',path:'/remote/v1/media',body,headers:{authorization:'Bearer '+token}});
  const offer=local('flyx:remote-pair-begin');
  const pending=await bridge.handle({method:'POST',path:'/remote/v1/pair/request',body:{secret:offer.secret,name:'Synthetic trace phone'}});
  local('flyx:remote-approve',{id:pending.body.requestID});
  const paired=await bridge.handle({method:'POST',path:'/remote/v1/pair/collect',body:{requestID:pending.body.requestID}});
  const reply=await request({operation:'prepare',selection},paired.body.token);
  assert.equal(reply.status,200);assert.equal(reply.body.mode,'direct');assert.equal(reply.body.format,'hls');assert.equal(reply.body.sourceInfo.selection.contentID,38000);assert.equal(desktopCalls,0);
  const phases=events.map(event=>event.phase);for(const phase of ['media-prepare','ipc-start','renderer-start','fetch-headers','fetch-json','resolve-complete','ipc-reply','media-resolved','media-grant'])assert.ok(phases.includes(phase),phase);
  assert.equal(new Set(events.map(event=>event.requestID)).size,1);
  assert.equal(JSON.stringify(events).includes('PRIVATE-SIGNATURE'),false);
  assert.equal(JSON.stringify(reply.body).includes('preparationID'),false);
  assert.throws(()=>handlers.get('flyx:remote-trace')({trusted:false},{requestID:events[0].requestID,phase:'fetch-start'}));
  const count=events.length;local('flyx:remote-trace',{requestID:events[0].requestID,phase:'fetch-start'});assert.equal(events.length,count,'completed request cannot append renderer events');
 } finally {await bridge.dispose();}
});
test('phone resource receipt and readiness are traceable without forwarding a provider URL or controlling Mac',async()=>{
 const events=[],requests=[];
 const adapter=createRendererAdapter({resolvePhoneTitle:async()=>source});
 const media=createPhoneMedia(async payload=>{requests.push(payload);return adapter({action:'phoneMedia',payload});},{origin,diagnostic:event=>events.push(event),fetcher:async()=>new Response('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/api/stream/proxy?sig=PRIVATE-SEGMENT\n#EXT-X-ENDLIST\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}})});
 const grant=await media('prepare',{selection},'synthetic-owner');
 const resource=await media('resource',{handle:grant.handle,resourceID:'0'},'synthetic-owner');
 assert.equal(resource.status,200);assert.ok(Buffer.from(resource.bytes,'base64').toString().includes('flyx-resource://1'));
 await media('resource',{handle:grant.handle,resourceID:'0'},'synthetic-owner');
 await media('phone-ready',{handle:grant.handle,position:0,paused:false},'synthetic-owner');
 await media('phone-started',{handle:grant.handle},'synthetic-owner');
 assert.deepEqual(requests.map(value=>value.operation),['prepare-title']);
 assert.equal(events.filter(value=>value.phase==='media-first-resource').length,1);
 for(const phase of ['media-grant','media-first-resource','media-resource-ready','media-phone-ready','media-phone-started'])assert.ok(events.some(value=>value.phase===phase),phase);
 assert.equal(JSON.stringify(events).includes('PRIVATE'),false);assert.equal(JSON.stringify(events).includes(grant.handle),false);
 await media('close',{handle:grant.handle},'synthetic-owner');
 await assert.rejects(media('resource',{handle:grant.handle,resourceID:'0'},'synthetic-owner'),error=>error.code==='PHONE_MEDIA_EXPIRED');
});
test('source-resolution failure never grants media or starts desktop playback',async()=>{
 const events=[];let controlled=0;
 const adapter=createRendererAdapter({resolvePhoneTitle:async()=>{throw Object.assign(new Error('synthetic preparation timeout'),{code:'PHONE_SOURCE_TIMEOUT'});},player:{play:()=>controlled++,pause:()=>controlled++},navigate:()=>controlled++,waitForPlayer:()=>controlled++});
 const media=createPhoneMedia(payload=>adapter({action:'phoneMedia',payload}),{origin,diagnostic:event=>events.push(event)});
 await assert.rejects(media('prepare',{selection},'synthetic-owner'),error=>error.code==='PHONE_SOURCE_TIMEOUT');
 assert.equal(controlled,0);assert.equal(events.some(event=>event.phase==='media-grant'),false);
});
