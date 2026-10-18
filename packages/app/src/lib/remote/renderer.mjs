const catalogPaths = new Set(['/api/content/reviews','/api/content/home','/api/content/search','/api/content/details','/api/content/season','/api/anime/jikan','/api/manga/popular','/api/manga/search','/api/manga/details','/api/tmdb']);
export function watchTarget(command) {
  const query=new URLSearchParams({[command.kind === 'anime' ? 'malId' : 'tmdbId']:String(command.contentID),mediaType:command.kind === 'movie' ? 'movie' : 'tv'});
  if(command.kind !== 'movie') {query.set('season',String(command.season ?? 1));query.set('episode',String(command.episode));}
  if(command.seconds===0)query.set("remoteStartOver","1");
  if(command.id)query.set("remotePlayID",command.id);
  return `/watch?${query}`;
}
let castSource;
export function registerRemoteCastSource(source){castSource=source;return()=>{if(castSource===source)castSource=undefined;};}
export function currentRemoteCastSource(){if(!castSource)throw new Error('Open a title on Mac first');return castSource;}
import {createRendererTransfers} from './renderer-transfers.mjs';
import {applyRemoteAudio} from './audio.mjs';
export function createRendererAdapter({navigate,player,fetchJSON,waitForPlayer,cast,downloads,watchlist,manga,resolvePhoneTitle,resolveCastMedia,progress}) {
  const transfers=new Map(),cancelled=new Set();
  const destinationTransfers=createRendererTransfers({player,cast,currentSource:currentRemoteCastSource,navigate,waitForPlayer,resolveCastMedia});
  return async ({action,payload}) => {
    if(action==='progress'){if(!progress)throw new Error('Progress unavailable');return progress(payload);}
    if(action==='transfer')return destinationTransfers(payload);
    if(action==='sources'){
      const state=cast?await cast.getState():null;if(state?.isCasting)throw new Error('Mac source selection unavailable while TV is active');
      const source=currentRemoteCastSource();
      if(payload.operation==='list')return{stamp:player.stamp(),items:source.describe?.()??[]};
      if(payload.operation!=='select'||player.stamp()!==payload.stamp||!source.select)throw new Error('Source inventory expired');
      const before=player.snapshot(),oldStamp=player.stamp();
      const selected=source.select(payload.key);if(selected===source.sourceKey)return{ok:true,status:before};const end=Date.now()+15000;
      while(Date.now()<end){const current=currentRemoteCastSource();if(current.sourceKey===selected&&player.stamp()!==oldStamp&&['paused','playing'].includes(player.snapshot().state)){
        await player.seekAndWait(before.position);if(currentRemoteCastSource().sourceKey!==selected)throw new Error('Source changed during selection');
        if(before.state==='playing')await player.play();else player.pause();const status=player.snapshot();
        if(Math.abs(status.position-before.position)>1||status.state!==before.state)throw new Error('Source did not confirm playback');return{ok:true,status};
      }await new Promise(r=>setTimeout(r,50));}throw new Error('Mac source did not become ready');
    }
    if(action === 'catalog') {
      const url=new URL(payload.path,'http://flyx.local');
      if(url.origin !== 'http://flyx.local' || !catalogPaths.has(url.pathname)) throw new Error('Unsupported catalog path');
      if(url.pathname === '/api/tmdb' && !/^\/tv\/[1-9][0-9]{0,9}\/season\/[0-9]{1,4}$/.test(url.searchParams.get('path') ?? '')) throw new Error('Unsupported season path');
      return fetchJSON(url.pathname+url.search);
    }
    if(action === 'manga'){if(!manga)throw new Error('Reader unavailable');return manga(payload);}
    if(action === 'watchlist'){if(!watchlist)throw new Error('Watchlist unavailable');return watchlist(payload);}
    if(action === 'downloads') return downloads(payload);
    const snapshot=async()=>{
      const state=cast?await cast.getState():null;
      if(state?.isCasting){
        // Use the confirmed TV session, never the Mac's current browsing source.
        const active=await destinationTransfers({method:'snapshot',origin:'tv'}).catch(()=>null);
        return {...player.snapshot(),title:active?.title,sourceInfo:active?.sourceInfo,videoWidth:undefined,videoHeight:undefined,state:state.playerState?.toLowerCase()??'idle',position:state.currentTime??0,duration:state.duration??0,output:'tv',outputName:state.deviceName??'TV',volume:state.volume,isMuted:state.isMuted};
      }
      let sourceInfo;try{sourceInfo=currentRemoteCastSource().sourceInfo;}catch{}
      return {...player.snapshot(),sourceInfo};
    };
    if(action === 'status') {const value=await snapshot();return{...value,phonePlayback:value.output!=='tv'&&['video/mp4','application/x-mpegURL'].includes(castSource?.contentType)};}
    if(action==='phoneMedia') {
      if(payload.operation==='prepare-title'){if(!resolvePhoneTitle)throw Object.assign(new Error('Resolver unavailable'),{code:'PHONE_MEDIA_UNAVAILABLE'});const media=await resolvePhoneTitle(payload.selection);return{...media,identity:JSON.stringify([payload.selection.kind,String(payload.selection.contentID),String(payload.selection.season??1),String(payload.selection.episode??1)]),position:0,duration:0,paused:false};}
      const state=cast?await cast.getState():null;if(state?.isCasting&&payload.operation!=='cancel')throw Object.assign(new Error('TV output active'),{code:'PHONE_MEDIA_UNAVAILABLE'});
      if(payload.operation==='select-mac'){await navigate(watchTarget(payload.selection));await waitForPlayer(payload.selection);player.seek(payload.position);if(payload.paused)player.pause();else await player.play();return{ok:true,status:player.snapshot()};}
      if(payload.operation==='prepare'){const source=currentRemoteCastSource();if(!source.preparePhone||!['video/mp4','application/x-mpegURL'].includes(source.contentType))throw Object.assign(new Error('Unsupported format'),{code:'PHONE_FORMAT_UNSUPPORTED'});const media=await source.preparePhone();const status=player.snapshot();return{...media,identity:player.identity(),position:status.position,duration:status.duration,paused:status.state!=='playing'};}
      if(payload.operation==='cancel'){
        cancelled.add(payload.handle);if(cancelled.size>128)cancelled.delete(cancelled.values().next().value);
        const previous=transfers.get(payload.handle);transfers.delete(payload.handle);
        if(!state?.isCasting&&payload.restore&&previous&&!previous.paused&&player.identity()===payload.identity&&player.snapshot().state==='paused')await player.play();
        return{ok:true,status:player.snapshot()};
      }
      if(player.identity()!==payload.identity)throw Object.assign(new Error('Title changed'),{code:'PHONE_TITLE_CHANGED'});
      if(cancelled.has(payload.handle))throw Object.assign(new Error('Transfer cancelled'),{code:'PHONE_MEDIA_EXPIRED'});
      if(payload.operation==='phone-ready'){const before=player.snapshot();const transfer={position:before.position,paused:before.state!=='playing'};transfers.set(payload.handle,transfer);if(transfers.size>128)transfers.delete(transfers.keys().next().value);player.pause();return{ok:true,status:player.snapshot(),transfer};}
      if(payload.operation==='phone-started'){if(player.snapshot().state!=='paused')throw Object.assign(new Error('Mac playback changed'),{code:'PHONE_TITLE_CHANGED'});return{ok:true,status:player.snapshot()};}
      player.seek(payload.position);if(payload.paused)player.pause();else await player.play();return{ok:true,status:await snapshot()};
    }
    if(action !== 'command') throw new Error('Unsupported operation');
    if(payload.type.startsWith('cast.')) {
      if(!cast)throw new Error('Native Cast unavailable');
      if(payload.type==='cast.discover'){const result=await cast.discover();if(!result.ok)throw new Error('Discovery failed');return{ok:true,devices:(result.devices??[]).map(d=>({id:d.id,name:d.name}))};}
      if(payload.type==='cast.disconnect')return cast.disconnect();
      if(payload.type==='cast.connect'){
        const source=currentRemoteCastSource();const media=await source.prepare();
        const connected=await cast.connect({id:payload.receiverID});if(!connected.ok)throw new Error('Cast connection failed');
        const loaded=await cast.load(media);if(!loaded.ok){await cast.disconnect();throw new Error('Cast load failed');}
        source.pause();return{ok:true,castState:await cast.getState()};
      }
      throw new Error('Unsupported Cast command');
    }
    const casting=cast?await cast.getState():null;
    if(['volume','mute'].includes(payload.type))return applyRemoteAudio(payload,{output:casting?.isCasting?'tv':'mac',player,cast,snapshot});
    if(casting?.isCasting && ['resume','pause','seek','stop'].includes(payload.type)){
      const result=payload.type==='stop'?await cast.disconnect():await cast.control({type:payload.type==='resume'?'play':payload.type,value:payload.seconds});
      if(!result.ok)throw new Error('Cast control failed');return{ok:true,status:await snapshot()};
    }
    if(payload.type === 'play') {
      if(casting?.isConnected){const result=await cast.disconnect();if(!result.ok)throw new Error('Could not switch playback to Mac');}
      const target=watchTarget(payload); await navigate(target); await waitForPlayer(payload);
      if(payload.seconds!==undefined)await player.seekAndWait(payload.seconds);
      await player.play();
      const state=player.snapshot();
      if(state.state !== 'playing') throw new Error('Mac did not start playback');
      return {ok:true,status:state};
    }
    if(payload.type === 'resume') await player.play();
    else if(payload.type === 'pause') player.pause();
    else if(payload.type === 'stop') {player.pause();player.seek(0);}
    else if(payload.type === 'seek') player.seek(payload.seconds);
    else throw new Error('Unsupported player command');
    return {ok:true,status:player.snapshot()};
  };
}
