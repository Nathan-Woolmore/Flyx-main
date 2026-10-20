import test from 'node:test';
import assert from 'node:assert/strict';
import { installRemoteBridge } from '../../packages/desktop/src/remote/electron-bridge.mjs';
import { createRendererAdapter } from '../../packages/app/src/lib/remote/renderer.mjs';
import { catalogPath } from '../../packages/desktop/src/remote/catalog.mjs';
function fixture({ready=true,timeoutMS=100}={}) {
 const handlers=new Map(), calls=[], paths=[];let seq=0, state='paused',position=0;
 const adapter=createRendererAdapter({navigate:async target=>calls.push(['navigate',target]),waitForPlayer:async()=>{if(!ready)throw new Error('fixture not ready');},player:{play:async()=>{state='playing';calls.push(['play']);},pause:()=>{state='paused';calls.push(['pause']);},seek:value=>{position=value;calls.push(['seek',value]);},snapshot:()=>({state,position,duration:300})},fetchJSON:async path=>{
  paths.push(path); const url=new URL(path,'https://fixture.invalid');
  if(url.pathname==='/api/content/details')return {data:{id:7,title:'Synthetic Movie',overview:'Fixture only'}};
  if(url.pathname==='/api/anime/jikan')return {data:[{mal_id:8,title:'Synthetic Anime'}]};
  if(url.pathname.startsWith('/api/manga/'))return {data:[{id:'synthetic-manga',title:'Synthetic Manga'}]};
  return {data:[{id:7,title:'Synthetic Movie',posterPath:'/fixture.jpg'}],nextPage:2};
 }});
 const bridge=installRemoteBridge({handleTrusted:(channel,fn)=>handlers.set(channel,fn),isMainFrame:event=>event.trusted===true,send:(_channel,request)=>queueMicrotask(async()=>{try{await handlers.get('flyx:remote-reply')({trusted:true},{requestID:request.requestID,ok:true,data:await adapter(request)});}catch{await handlers.get('flyx:remote-reply')({trusted:true},{requestID:request.requestID,ok:false});}}),makeID:()=>`fixture-${++seq}`,makeToken:()=>`SYNTHETIC-ONLY-${seq}-`.repeat(4),makeSecret:()=> 'a'.repeat(64),timeoutMS});
 const local=(channel,payload)=>handlers.get(channel)({trusted:true},payload);
 const request=(method,path,body,token)=>bridge.handle({method,path,body,headers:token?{authorization:`Bearer ${token}`}:{}});
 async function pair(){const offer=await local('flyx:remote-pair-begin');const pending=await request('POST','/remote/v1/pair/request',{secret:offer.secret,name:'Fixture iPhone'});await local('flyx:remote-approve',{id:pending.body.requestID});return (await request('POST','/remote/v1/pair/collect',{requestID:pending.body.requestID})).body.token;}
 return {bridge,handlers,calls,paths,local,request,pair};
}
test('Mac local approval is required; tokens are delivered once and never to approval UI',async()=>{
 const f=fixture();const offer=await f.local('flyx:remote-pair-begin');
 const pending=await f.request('POST','/remote/v1/pair/request',{secret:offer.secret,name:'Fixture iPhone'});
 assert.equal(pending.status,202);
 assert.equal((await f.request('POST','/remote/v1/pair/collect',{requestID:pending.body.requestID})).body.status,'awaiting-mac-approval');
 assert.equal((await f.request('GET','/remote/v1/catalog?kind=movie')).status,401);
 const approval=await f.local('flyx:remote-approve',{id:pending.body.requestID}); assert.deepEqual(approval,{ok:true});
 assert.equal(JSON.stringify(await f.local('flyx:remote-approval-state')).includes('SYNTHETIC-ONLY'),false);
 const granted=await f.request('POST','/remote/v1/pair/collect',{requestID:pending.body.requestID});assert.equal(granted.body.status,'approved');
 assert.equal((await f.request('POST','/remote/v1/pair/collect',{requestID:pending.body.requestID})).status,400);
 f.bridge.dispose();
});
test('authenticated phone catalog/search/details reach existing backend route shapes',async()=>{
 const f=fixture(),token=await f.pair();
 for(const kind of ['movie','tv','anime','manga']) {
  const response=await f.request('GET',`/remote/v1/catalog?kind=${kind}&q=space%20adventure&page=${kind==='manga'?1:2}`,undefined,token);
  assert.equal(response.status,200); assert.equal(response.body.items[0].kind,kind);
 }
 const details=await f.request('GET','/remote/v1/details?kind=movie&id=7',undefined,token);assert.equal(details.body.title,'Synthetic Movie');
 assert.equal(f.paths.length,5);assert.ok(f.paths[0].startsWith('/api/content/search?'));assert.ok(f.paths[2].startsWith('/api/anime/jikan?'));assert.ok(f.paths[3].startsWith('/api/manga/search?'));
 f.bridge.dispose();
});
test('phone Play traverses protocol → scopes → Electron → renderer → player and returns real status',async()=>{
 const f=fixture(),token=await f.pair();
 const response=await f.request('POST','/remote/v1/commands',{id:'play-1',type:'play',kind:'tv',contentID:7,season:2,episode:3},token);
 assert.equal(response.status,200);assert.equal(response.body.status.state,'playing');assert.deepEqual(f.calls,[['navigate','/watch?tmdbId=7&mediaType=tv&season=2&episode=3&remotePlayID=play-1'],['play']]);
 await f.request('POST','/remote/v1/commands',{id:'pause-1',type:'pause'},token);
 const status=await f.request('GET','/remote/v1/status',undefined,token);assert.equal(status.body.state,'paused');f.bridge.dispose();
});
test('selected player failure returns failure without reporting playing',async()=>{
 const f=fixture({ready:false}),token=await f.pair();
 const response=await f.request('POST','/remote/v1/commands',{id:'one',type:'play',kind:'movie',contentID:7},token);
 assert.equal(response.status,502);assert.equal(response.body.code,'MAC_OPERATION_FAILED');assert.equal(f.calls.some(c=>c[0]==='play'),false);f.bridge.dispose();
});
test('revocation and browser-origin requests cannot reach Mac operations',async()=>{
 const f=fixture(),token=await f.pair(),snapshot=await f.local('flyx:remote-approval-state');
 await f.local('flyx:remote-revoke',{id:snapshot.devices[0].id});
 assert.equal((await f.request('POST','/remote/v1/commands',{id:'pause',type:'pause'},token)).status,401);
 assert.equal((await f.bridge.handle({method:'GET',path:'/remote/v1/info',headers:{origin:'https://evil.invalid'}})).status,403);assert.equal(f.calls.length,0);f.bridge.dispose();
});
test('untrusted renderer cannot approve or forge completion',async()=>{
 const f=fixture();assert.throws(()=>f.handlers.get('flyx:remote-pair-begin')({trusted:false}));assert.throws(()=>f.handlers.get('flyx:remote-reply')({trusted:false},{requestID:'fixture'}));f.bridge.dispose();
});
test('catalog adapter rejects arbitrary paths and encodes hostile query strings as data',async()=>{
 assert.throws(()=>catalogPath({kind:'shell',query:''}));assert.throws(()=>catalogPath({kind:'movie',id:'https://evil.invalid'},true));
 const path=catalogPath({kind:'movie',query:'&admin=true',page:1});assert.equal(new URL(path,'http://fixture').searchParams.get('q'),'&admin=true');
});

test('TV details fetch selected season from existing Mac TMDB proxy',async()=>{
 const {createCatalog}=await import('../../packages/desktop/src/remote/catalog.mjs');const paths=[];
 const catalog=createCatalog(async path=>{paths.push(path);if(path.startsWith('/api/content/details'))return{data:{id:7,name:'Synthetic TV',seasons:[{season_number:1},{season_number:2}]}};assert.equal(new URL(path,'http://fixture').pathname,'/api/content/season');assert.equal(new URL(path,'http://fixture').searchParams.get('season'),'2');return{episodes:[{episode_number:3,name:'Synthetic Episode'}]};});
 const details=await catalog({kind:'tv',id:'7',season:2},true);assert.deepEqual(details.seasons[1].episodes,[{number:3,title:'Synthetic Episode'}]);assert.equal(paths.length,2);
});
test('renderer timeout reports failure and never claims playback',async()=>{
 const handlers=new Map();let seq=0;
 const bridge=installRemoteBridge({handleTrusted:(c,f)=>handlers.set(c,f),isMainFrame:()=>true,send:()=>{},timeoutMS:5,makeID:()=>`timeout-${++seq}`,makeToken:()=> 'SYNTHETIC-ONLY-'.repeat(4),makeSecret:()=> 'a'.repeat(64)});
 const offer=handlers.get('flyx:remote-pair-begin')({});const pending=await bridge.handle({method:'POST',path:'/remote/v1/pair/request',body:{secret:offer.secret,name:'Fixture'}});
 handlers.get('flyx:remote-approve')({},{id:pending.body.requestID});
 const grant=await bridge.handle({method:'POST',path:'/remote/v1/pair/collect',body:{requestID:pending.body.requestID}});
 const result=await bridge.handle({method:'POST',path:'/remote/v1/commands',headers:{authorization:`Bearer ${grant.body.token}`},body:{id:'timeout-command',type:'pause'}});
 assert.equal(result.status,502);assert.equal(result.body.code,'MAC_RENDERER_TIMEOUT');assert.equal(result.body.status,undefined);bridge.dispose();
});

test('Cast uses only discovered ID plus Mac prepared media and pauses only after load acknowledgement',async()=>{
 const {registerRemoteCastSource}=await import('../../packages/app/src/lib/remote/renderer.mjs');const calls=[];
 const unregister=registerRemoteCastSource({prepare:async()=>({url:'http://synthetic.local/signed-fixture',title:'Fixture',contentType:'video/mp4'}),pause:()=>calls.push('pause')});
 const cast={discover:async()=>({ok:true,devices:[{id:'fixture-tv',name:'Fixture TV',address:'PRIVATE-MAC-ONLY'}]}),getState:async()=>({isConnected:true,isCasting:true,deviceName:'Fixture TV'}),connect:async value=>(calls.push(value),{ok:true}),load:async media=>(calls.push(media),{ok:true}),disconnect:async()=>({ok:true})};
 const adapter=createRendererAdapter({cast});const devices=await adapter({action:'command',payload:{type:'cast.discover'}});assert.equal(JSON.stringify(devices).includes('PRIVATE-MAC-ONLY'),false);
 const result=await adapter({action:'command',payload:{type:'cast.connect',receiverID:'fixture-tv'}});assert.equal(result.castState.isCasting,true);assert.deepEqual(calls[0],{id:'fixture-tv'});assert.equal(calls.at(-1),'pause');unregister();
});
test('download adapter constrains writes and returns no local paths, URLs, cache plans or raw errors',async()=>{
 const {createDownloads,downloadRequest}=await import('../../packages/desktop/src/remote/downloads.mjs');
 const downloads=createDownloads(async()=>({ok:true,jobs:[{id:'11111111-1111-4111-8111-111111111111',label:'Fixture',status:'error',progress:0,filepath:'/private/user/secret',error:'secret upstream URL',collectionPlan:{secret:'no'},kind:'manga',collection:{language:'en'}}]}));
 const list=await downloads('list');const serialized=JSON.stringify(list);assert.equal(serialized.includes('/private'),false);assert.equal(serialized.includes('upstream'),false);assert.equal(list.jobs[0].canRetry,true);
 assert.throws(()=>downloadRequest('queue',{item:{kind:'video',tmdbId:7,mediaType:'movie',url:'http://evil.invalid'}}));assert.throws(()=>downloadRequest('remove',{id:'../../file'}));
 assert.deepEqual(downloadRequest('queue',{item:{kind:'video',tmdbId:7,mediaType:'movie'}}).body,{items:[{kind:'video',tmdbId:7,mediaType:'movie'}]});
});

test('download protocol denies default pairings and requires explicit local download approval',async()=>{
 const {RemoteCore}=await import('../../packages/desktop/src/remote/remote-core.mjs');const {createRemoteHandler}=await import('../../packages/desktop/src/remote/protocol.mjs');let seq=0,calls=0;
 const core=new RemoteCore({makeID:()=>`scope-${++seq}`,makeToken:()=>`SYNTHETIC-SCOPE-${seq}-`.repeat(4),dispatch:async()=>({ok:true})});
 const handler=createRemoteHandler({core,downloads:async()=>{calls++;return{jobs:[]};}});
 core.openPairing('a'.repeat(64));const limited=core.approve({secret:'a'.repeat(64),name:'Limited'});
 assert.equal((await handler({method:'GET',path:'/remote/v1/downloads',headers:{authorization:`Bearer ${limited.token}`}})).status,401);assert.equal(calls,0);
 core.openPairing('b'.repeat(64));const approved=core.approve({secret:'b'.repeat(64),name:'Approved',scopes:['catalog.read','playback.control','downloads.read','downloads.write']});
 assert.equal((await handler({method:'GET',path:'/remote/v1/downloads',headers:{authorization:`Bearer ${approved.token}`}})).status,200);assert.equal(calls,1);
 core.revoke(approved.deviceID);assert.equal((await handler({method:'GET',path:'/remote/v1/downloads',headers:{authorization:`Bearer ${approved.token}`}})).status,401);
});
test('Cast load failure never pauses local player or reports success',async()=>{
 const {registerRemoteCastSource}=await import('../../packages/app/src/lib/remote/renderer.mjs');let pauses=0,disconnects=0;
 const remove=registerRemoteCastSource({prepare:async()=>({url:'fixture-only'}),pause:()=>pauses++});
 const adapter=createRendererAdapter({cast:{connect:async()=>({ok:true}),load:async()=>({ok:false}),disconnect:async()=>{disconnects++;return{ok:true};}}});
 await assert.rejects(adapter({action:'command',payload:{type:'cast.connect',receiverID:'fixture'}}));assert.equal(pauses,0);assert.equal(disconnects,1);remove();
});
test('remote playback status and controls follow active native Cast state',async()=>{
 let paused=false;const controls=[];
 const adapter=createRendererAdapter({player:{snapshot:()=>({state:'idle',position:0,duration:0})},cast:{getState:async()=>({isCasting:true,playerState:paused?'PAUSED':'PLAYING',currentTime:44,duration:120}),control:async command=>{controls.push(command);paused=true;return{ok:true};}}});
 assert.equal((await adapter({action:'status',payload:{}})).state,'playing');
 const result=await adapter({action:'command',payload:{type:'pause'}});assert.equal(result.status.state,'paused');assert.equal(controls[0].type,'pause');
});
