import {createPreparationTrace,preparationID} from './preparation-trace.mjs';
import {playbackSourceInfo} from './source-info.mjs';
// Uses the Mac extraction/VLC signing endpoint. Only the main process receives URLs.
/** @param {any} selection @param {{fetcher?:typeof fetch,order?:(sources:any[])=>any[],recovery?:(sources:any[])=>any[],requestID?:string,onTrace?:(event:Record<string,any>)=>void}} options */
export async function resolvePhoneSources(selection,{fetcher=fetch,order=s=>s,recovery=s=>s,requestID=undefined,onTrace=undefined}={}) {
 // Stay below the 25s renderer IPC and 30s iPhone media request limits.
 // Anime's exact-MAL chain includes metadata plus sub/dub provider probes.
 const trace=createPreparationTrace({requestID,emit:onTrace});trace('renderer-start',selection);
 const deadline=Date.now()+22000;
 const remaining=()=>Math.max(0,deadline-Date.now());
 const providers=selection.kind==='anime'?['animex']:['vidsrc','vidlove','multiembed','videasy'];
 const query=new URLSearchParams({format:'json',allSources:'1',tmdbId:String(selection.kind==='anime'?0:selection.contentID),mediaType:selection.kind==='movie'?'movie':'tv'});
 const correlationID=preparationID(requestID);if(correlationID)query.set('preparationID',correlationID);
 if(selection.kind==='anime')query.set('malId',String(selection.contentID));
 if(selection.kind!=='movie'){query.set('season',String(selection.season));query.set('episode',String(selection.episode));}
 const probe=async(provider,timeout)=>{
  const budget=Math.min(timeout,remaining());if(budget<=0)return{sources:[],timedOut:true};
  const signal=AbortSignal.timeout(budget);const started=Date.now();
  trace('fetch-start',{provider,budgetMS:budget});
  try{
   const q=new URLSearchParams(query);q.set('provider',provider);if(provider==='local')q.set('localOnly','1');
   const response=await fetcher('/api/stream/vlc?'+q,{credentials:'same-origin',redirect:'error',cache:'no-store',signal});
   trace('fetch-headers',{provider,status:response.status,probeMS:Date.now()-started,aborted:signal.aborted});
   const value=await response.json();
   trace('fetch-json',{provider,status:response.status,ok:response.ok&&value.ok===true,sourceCount:value.sources?.length,probeMS:Date.now()-started,aborted:signal.aborted});
   if(value.code==='PHONE_AUTH_TIMEOUT')return{sources:[],errorCode:'PHONE_AUTH_TIMEOUT',refused:true};
   return response.ok&&value.ok?{title:value.title,sources:(value.sources??[]).map(s=>({...s,provider:s.provider||provider}))}:{sources:[],refused:[401,403,451].includes(response.status)};
  }catch(error){trace('fetch-error',{provider,errorName:error?.name,probeMS:Date.now()-started,aborted:signal.aborted});return{sources:[],timedOut:signal.aborted};}
 };
 const local=await probe('local',2000);
 if(local.errorCode){trace('resolve-complete',{ok:false,sourceCount:0,errorCode:local.errorCode});throw Object.assign(new Error('Mac authentication unavailable'),{code:local.errorCode});}
 const results=await Promise.all(providers.map(async provider=>{
  let value=await probe(provider,selection.kind==='anime'?20000:12000);
  // A timed-out extraction is still running upstream. Do not duplicate it
  // with a shorter attempt that cannot finish the same dependency chain.
  if(!value.sources.length&&!value.timedOut&&!value.refused&&remaining()>0)value=await probe(provider,4000);
  return value;
 }));
 const authenticationFailure=results.find(result=>result.errorCode);
 if(authenticationFailure){trace('resolve-complete',{ok:false,sourceCount:0,errorCode:authenticationFailure.errorCode});throw Object.assign(new Error('Mac authentication unavailable'),{code:authenticationFailure.errorCode});}
 const key=source=>{try{const u=new URL(source.url);u.searchParams.delete('sig');u.searchParams.delete('exp');u.searchParams.sort();return u.href;}catch{return source.url;}};
 const groups=[local,...results];const seen=new Set();const sources=[];let rank=0;
 for(const group of groups){const available=group.sources.filter(s=>s.url&&!seen.has(key(s))&&seen.add(key(s)));const ranked=recovery(available);for(const source of (selection.kind==='anime'?order(available.filter(s=>/sub|ja|jp|japanese/i.test(s.language??''))).concat(order(available.filter(s=>!/sub|ja|jp|japanese/i.test(s.language??'')))):order(available))){sources.push({...source,sourceInfo:playbackSourceInfo(source,{identity:JSON.stringify([selection.kind,selection.contentID,selection.season??1,selection.episode??1])}),recoveryRank:rank+ranked.indexOf(source)});}rank+=available.length;}
 trace('resolve-complete',{sourceCount:sources.length,ok:sources.length>0,...(!sources.length?{errorCode:results.some(r=>r.timedOut)?'PHONE_SOURCE_TIMEOUT':'PHONE_MEDIA_UNAVAILABLE'}:{})});
 if(!sources.length)throw Object.assign(new Error('No source resolved'),{code:results.some(r=>r.timedOut)?'PHONE_SOURCE_TIMEOUT':'PHONE_MEDIA_UNAVAILABLE'});
 return{...sources[0],sources,title:groups.find(g=>g.title)?.title??'Flyx'};
}
