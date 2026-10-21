import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackSourceInfo} from '../../packages/app/src/lib/remote/source-info.mjs';
import {publicSourceInfo} from '../../packages/desktop/src/remote/source-info.mjs';
import {createPhoneMedia} from '../../packages/desktop/src/remote/phone-media.mjs';
import {createRendererAdapter,registerRemoteCastSource} from '../../packages/app/src/lib/remote/renderer.mjs';

const selection={kind:'movie',contentID:7,season:1,episode:1};
const identity=JSON.stringify(['movie','7','1','1']);
const localURL='http://127.0.0.1:3891/api/stream/local?id=00000000-0000-4000-8000-000000000001&rev=FIXTURE&sig=PRIVATE-FIXTURE';
const localInfo=()=>playbackSourceInfo({url:localURL,provider:'local',quality:'1080p'},{identity});

test('download provenance carries exact selection and saved label without URL or measured claims',()=>{
  const value=localInfo();
  assert.equal(value.origin,'download');assert.equal(value.qualityBasis,'requested');assert.equal(value.quality,'1080p');
  assert.deepEqual(value.selection,selection);assert.equal(value.downloadID,'00000000-0000-4000-8000-000000000001');
  assert(!JSON.stringify(value).includes('PRIVATE'));assert(!('videoWidth' in value));
});
test('public provenance rejects URL-like labels and drops unapproved metadata',()=>{
  const value=publicSourceInfo({origin:'provider',provider:'https://private.invalid?sig=fixture',quality:'1080p',qualityBasis:'measured',url:localURL,videoWidth:1920,headers:{cookie:'fixture'},fallback:'local-unavailable'});
  assert.equal(value.provider,undefined);assert.equal(value.qualityBasis,'advertised');assert.equal(value.fallback,'local-unavailable');
  assert(!JSON.stringify(value).includes('private'));assert(!JSON.stringify(value).includes('cookie'));assert(!('videoWidth' in value));
});
test('phone fallback reports selected provider and retains provenance on onward transfer',async()=>{
  let serial=0;
  const sources=[{url:localURL,contentType:'video/mp4',provider:'local',quality:'1080p',sourceInfo:localInfo()},{url:'http://127.0.0.1:3891/api/stream/proxy?sig=PRIVATE-ONLINE',contentType:'video/mp4',provider:'vidsrc',quality:'720p',sourceInfo:playbackSourceInfo({provider:'vidsrc',quality:'720p'},{identity})}];
  const media=createPhoneMedia(async()=>({...sources[0],sources,identity,title:'Fixture'}),{origin:'http://127.0.0.1:3891',makeID:()=>`fixture-${++serial}`});
  const first=await media('prepare',{selection},'owner');assert.equal(first.sourceInfo.origin,'download');
  const second=await media('next-source',{handle:first.handle,position:10,paused:false},'owner');
  assert.equal(second.sourceInfo.provider,'vidsrc');assert.equal(second.sourceInfo.quality,'720p');assert.equal(second.sourceInfo.qualityBasis,'advertised');assert.equal(second.sourceInfo.fallback,'local-unavailable');assert.deepEqual(second.sourceInfo.selection,selection);
  await media('phone-ready',{handle:second.handle,position:10,paused:false},'owner');await media('phone-started',{handle:second.handle},'owner');
  assert.deepEqual(media.inspectForTransfer('owner',second.handle).sourceInfo,second.sourceInfo);assert(!JSON.stringify(second).includes('PRIVATE'));
});
test('TV status is bound to committed session and never inherits Mac browsing source or dimensions',async()=>{
  const mac={state:'paused',position:12,duration:100,videoWidth:1920,videoHeight:1080};
  let tv={isCasting:false,connectionID:1,mediaSessionID:null,deviceID:'fixture-tv',currentTime:12,playerState:'IDLE'};
  const cast={getState:async()=>({...tv}),connect:async()=>({ok:true}),load:async()=>{tv={...tv,isCasting:true,mediaSessionID:2,playerState:'PAUSED'};return{ok:true,mediaSessionID:2};},control:async command=>{if(command.type==='seek')tv.currentTime=command.value;else tv.playerState=command.type==='pause'?'PAUSED':'PLAYING';return{ok:true};}};
  const player={snapshot:()=>({...mac}),identity:()=>identity,stamp:()=> 'mac-source-A'};
  const adapter=createRendererAdapter({player,cast,resolveCastMedia:async source=>({url:source.url,contentType:source.contentType})});
  const origin={identity,selection,sourceInfo:localInfo(),url:localURL,contentType:'video/mp4',title:'Fixture',position:12,paused:true};
  await adapter({action:'transfer',payload:{method:'prepare',id:'fixture-transfer',destination:'tv',origin,receiverID:'fixture-tv'}});
  await adapter({action:'transfer',payload:{method:'activate',id:'fixture-transfer',snapshot:origin}});
  const cleanup=registerRemoteCastSource({sourceInfo:{origin:'provider',provider:'different-provider'}});
  try {
    const status=await adapter({action:'status',payload:{}});
    assert.equal(status.sourceInfo.origin,'download');assert.equal(status.title,'Fixture');assert.equal(status.videoWidth,undefined);assert.equal(status.videoHeight,undefined);
    tv.mediaSessionID=3;assert.equal((await adapter({action:'status',payload:{}})).sourceInfo,undefined);
  } finally {cleanup();}
});
