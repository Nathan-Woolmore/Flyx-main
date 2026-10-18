const fail=code=>Object.assign(new Error(code),{code});
const selectionFrom=source=>{if(source.selection)return source.selection;try{const[kind,id,season,episode]=JSON.parse(source.identity);return{kind,contentID:Number(id),season:Number(season),episode:Number(episode)};}catch{throw fail('TRANSFER_UNSUPPORTED');}};
export function createRendererTransfers({player,cast,currentSource,navigate,waitForPlayer,resolveCastMedia,delay=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,prepareTimeoutMS=10000}){
 const stages=new Map(),stops=new Map();let activeTV;
 const macIdentity=()=>{try{return player.identity();}catch{return'';}};
 const stamp=()=>player.stamp?.()??macIdentity();
 const tvStamp=s=>`${s.connectionID??''}:${s.mediaSessionID??''}:${s.deviceID??''}`;
 const snapshot=async origin=>{
  if(origin==='mac'){const value=player.snapshot(),source=currentSource(),identity=macIdentity(),nativeStamp=stamp();if(!['playing','paused'].includes(value.state))throw fail('TRANSFER_UNSUPPORTED');const media=await source.preparePhone();if(identity!==macIdentity()||nativeStamp!==stamp())throw fail('TRANSFER_ORIGIN_CHANGED');return{...media,identity,stamp:nativeStamp,selection:selectionFrom({identity}),position:value.position,duration:value.duration,paused:value.state!=='playing',output:'mac'};}
  const state=await cast.getState();if(!activeTV||(!state.isCasting&&!(state.playerState==='IDLE'&&state.idleReason==='FINISHED'))||tvStamp(state)!==activeTV.stamp)throw fail('TRANSFER_ORIGIN_CHANGED');return{...activeTV.source,identity:activeTV.source.identity,stamp:activeTV.stamp,startedAt:activeTV.startedAt,position:state.currentTime,duration:state.duration??activeTV.source.duration??0,ended:state.playerState==='IDLE'&&state.idleReason==='FINISHED',paused:state.playerState!=='PLAYING',output:'tv'};
 };
 const isCurrent=async stage=>{
  if(!stage||stages.get(stage.id)!==stage)return false;
  if(stage.destination==='mac')return macIdentity()===stage.source.identity&&player.transferID?.()===stage.id&&stamp()===stage.nativeStamp;
  const state=await cast.getState();return state.connectionID===stage.connectionID&&(stage.mediaSessionID==null||state.mediaSessionID===stage.mediaSessionID);
 };
 const ensure=async stage=>{if(!await isCurrent(stage))throw fail('TRANSFER_DESTINATION_CHANGED');};
 const apply=async(stage,value)=>{
  await ensure(stage);
  if(stage.destination==='mac'){await(player.seekAndWait?.(value.position)??player.seek(value.position));await ensure(stage);if(value.paused)player.pause();else await player.play();await ensure(stage);const state=player.snapshot();if(Math.abs(state.position-value.position)>1||state.state!==(value.paused?'paused':'playing'))throw fail('TRANSFER_DESTINATION_UNCONFIRMED');stage.activated=true;return{...value,output:'mac',position:state.position,paused:state.state!=='playing'};}
  for(const command of [{type:'seek',value:value.position},{type:value.paused?'pause':'play'}]){await ensure(stage);const ack=await cast.control(command);if(!ack.ok)throw fail('TRANSFER_DESTINATION_UNCONFIRMED');}
  const end=now()+4000;while(now()<end){await ensure(stage);const state=await cast.getState();if(Math.abs(state.currentTime-value.position)<=1&&state.playerState===(value.paused?'PAUSED':'PLAYING')){stage.activated=true;activeTV={source:stage.source,stamp:tvStamp(state),startedAt:stage.createdAt};return{...value,output:'tv',position:state.currentTime,paused:state.playerState==='PAUSED'};}await delay(50);}throw fail('TRANSFER_DESTINATION_UNCONFIRMED');
 };
 return async spec=>{
  if(spec.method==='snapshot')return snapshot(spec.origin);
  if(spec.method==='prepare'){
   const stage={createdAt:now(),id:spec.id,destination:spec.destination,source:spec.origin};stages.set(spec.id,stage);
   if(spec.destination==='mac'){
    const state=player.snapshot();if(state.state==='playing'&&macIdentity()!==spec.origin.identity)throw fail('TRANSFER_DESTINATION_BUSY');
    if(macIdentity()===spec.origin.identity&&player.isReady?.()===true){player.markTransfer?.(spec.id);player.pause();stage.nativeStamp=stamp();return{ticket:spec.id,reusedNativePlayer:true};}
    const selection=selectionFrom(spec.origin);const query=new URLSearchParams({[selection.kind==='anime'?'malId':'tmdbId']:String(selection.contentID),mediaType:selection.kind==='movie'?'movie':'tv',season:String(selection.season??1),episode:String(selection.episode??1),remotePrepare:'1',remoteTransfer:spec.id});
    await navigate('/watch?'+query);await waitForPlayer({...selection,transferID:spec.id});if(macIdentity()!==spec.origin.identity||player.transferID?.()!==spec.id)throw fail('TRANSFER_DESTINATION_CHANGED');player.markTransfer?.(spec.id);player.pause();stage.nativeStamp=stamp();
   }else{
    if(!cast)throw fail('TRANSFER_UNSUPPORTED');const state=await cast.getState();if(state.isCasting)throw fail('TRANSFER_DESTINATION_BUSY');const media=await resolveCastMedia(spec.origin);const connected=await cast.connect({id:spec.receiverID});if(!connected.ok)throw fail(connected.errorCode??'CAST_CONNECT_FAILED');stage.connectionID=(await cast.getState()).connectionID;
    const loaded=await cast.load({...media,startTime:spec.origin.position,autoplay:false});if(!loaded.ok)throw fail(loaded.errorCode??'CAST_LOAD_FAILED');stage.mediaSessionID=loaded.mediaSessionID??(await cast.getState()).mediaSessionID;
    // LOAD acknowledgement may precede BUFFERING -> PAUSED. Keep the origin
    // untouched until the exact receiver/media session confirms paused readiness.
    const deadline=now()+prepareTimeoutMS;let ready=false;
    while(now()<deadline){await ensure(stage);const state=await cast.getState();
     if(state.mediaSessionID!=null&&state.playerState==='PAUSED'){ready=true;break;}
     if(state.playerState==='PLAYING'){const ack=await cast.control({type:'pause'});if(!ack.ok)throw fail('CAST_REQUEST_REJECTED');}
     if(state.lastError||state.playerState==='IDLE'&&['ERROR','CANCELLED','INTERRUPTED'].includes(state.idleReason))throw fail('CAST_LOAD_FAILED');
     await delay(50);
    }
    if(!ready)throw fail('CAST_READY_TIMEOUT');
   }
   return{ticket:spec.id};
  }
  const stage=stages.get(spec.id);
  if(spec.method==='isCurrent')return isCurrent(stage);
  if(spec.method==='activate')return apply(stage,spec.snapshot);
  if(spec.method==='stopOrigin'){
   const before=await snapshot(spec.origin.output);if(before.identity!==spec.origin.identity||before.stamp!==spec.origin.stamp)throw fail('TRANSFER_ORIGIN_CHANGED');stops.set(spec.id,before);
   if(before.output==='mac')player.pause();else{const ack=await cast.control({type:'pause'});if(!ack.ok)throw fail('TRANSFER_ORIGIN_CHANGED');}
   const after=await snapshot(before.output);if(after.stamp!==before.stamp)throw fail('TRANSFER_ORIGIN_CHANGED');return{snapshot:{...before,position:after.position}};
  }
  if(spec.method==='restoreOrigin'){
   const before=stops.get(spec.id);if(!before)return;const current=await snapshot(before.output).catch(()=>null);if(current?.stamp!==before.stamp||!current.paused||Math.abs(current.position-before.position)>1)return;
   if(!before.paused){if(before.output==='mac')await player.play();else{const ack=await cast.control({type:'play'});if(!ack.ok)throw fail('TRANSFER_ROLLBACK_UNCONFIRMED');}}stops.delete(spec.id);return;
  }
  if(spec.method==='completeOrigin'){const current=await snapshot('tv').catch(()=>null);if(current?.stamp===spec.origin.stamp)await cast.disconnect();return;}
  if(spec.method==='cleanup'){
   if(!await isCurrent(stage)){stages.delete(spec.id);return;}
   if(stage.destination==='mac')player.pause();else await cast.disconnect();stages.delete(spec.id);return;
  }
  throw fail('TRANSFER_INVALID');
 };
}
