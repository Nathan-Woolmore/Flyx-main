const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function downloadRequest(operation,body={}) {
 if(operation==='trash'){if(!uuid(body.id)||typeof body.revision!=='string'||!/^[a-f0-9]{64}$/.test(body.revision))throw new Error('Invalid download confirmation');return{path:`/api/downloads/${body.id}`,method:'POST',body:{intent:'trash',revision:body.revision}};}
 if(operation==='list')return {path:'/api/downloads',method:'GET'};
 if(['remove','retry','cancel','removeHistory'].includes(operation)) {if(!uuid(body.id))throw new Error('Invalid job');return{path:`/api/downloads/${body.id}${operation==='retry'?'/retry':''}`,method:operation==='retry'?'POST':'DELETE',...(['cancel','removeHistory'].includes(operation)?{body:{intent:operation==='cancel'?'cancel':'remove-history'}}:{})};}
 if(operation!=='queue')throw new Error('Unsupported download operation');
 const item=body.item;
 if(!item||item.kind!=='video'||!['movie','tv'].includes(item.mediaType)||!Number.isSafeInteger(item.tmdbId)||item.tmdbId<0||item.tmdbId===0&&(!Number.isSafeInteger(item.malId)||item.malId<=0))throw new Error('Invalid download');
 if(item.mediaType==='tv'&&(!Number.isSafeInteger(item.season)||item.season<0||!Number.isSafeInteger(item.episode)||item.episode<=0))throw new Error('Episode selection required');
 if(Object.keys(item).some(k=>!['kind','tmdbId','malId','mediaType','season','episode','title','quality'].includes(k)))throw new Error('Unexpected download field');
 if(item.quality!=null&&!['480p','720p','1080p','2160p'].includes(item.quality))throw new Error('Unsupported quality');
 if(item.title!=null&&(typeof item.title!=='string'||item.title.length>300))throw new Error('Invalid title');
 return{path:'/api/downloads',method:'POST',body:{items:[item]}};
}
const integer=(v,min=1)=>Number.isSafeInteger(v)&&v>=min;
export function downloadSelection(j) {
 if(j.kind!=='video'||!['movie','tv'].includes(j.mediaType))return null;
 const anime=integer(j.malId),id=anime?j.malId:j.tmdbId;
 if(!integer(id)||anime&&j.mediaType!=='tv'||j.mediaType==='tv'&&(!integer(j.season,0)||!integer(j.episode)))return null;
 return {kind:anime?'anime':j.mediaType,contentID:id,...(j.mediaType==='tv'?{season:j.season,episode:j.episode}:{})};
}
export function publicJobs(body) {
 if(!body.ok||!Array.isArray(body.jobs))throw new Error('Downloads unavailable');
 return{jobs:body.jobs.map(j=>({id:j.id,canTrash:j.canTrash===true,fileRevision:typeof j.fileRevision==='string'&&/^[a-f0-9]{64}$/.test(j.fileRevision)?j.fileRevision:null,label:String(j.label??'Download').slice(0,300),kind:j.kind,status:j.status,progress:Number.isFinite(j.progress)?Math.min(100,Math.max(0,j.progress)):0,bytes:Number.isFinite(j.bytes)?Math.max(0,j.bytes):0,totalBytes:Number.isFinite(j.totalBytes)&&j.totalBytes>0?j.totalBytes:null,quality:typeof j.quality==='string'?j.quality.slice(0,30):null,selection:downloadSelection(j),localPlaybackAvailable:j.status==='done'&&j.localPlaybackAvailable===true,canRetry:j.kind==='manga'&&!!j.collection&&['error','cancelled'].includes(j.status),removalClearsCache:!!j.collection,createdAt:Number.isFinite(j.createdAt)?j.createdAt:null,error:j.error?'Download failed. Retry from this title or see Flyx for details.':null}))};
}
export function createDownloads(request,catalog,{metadataBudgetMs=250}={}) {
 const cache=new Map();let inFlight=0;
 const bounded=promise=>new Promise(resolve=>{
  const timer=setTimeout(()=>resolve(null),metadataBudgetMs);
  promise.then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);resolve(null);});
 });
 return async(operation,body)=>{
  const spec=downloadRequest(operation,body);const response=await request(spec);
  if(!response.ok)throw Object.assign(new Error('Download operation failed'),{code:response.code});
  if(operation!=='list')return{ok:true};
  const result=publicJobs(response),pending=[];
  if(catalog)for(const job of result.jobs){
   if(!job.selection)continue;
   const {kind,contentID}=job.selection,key=kind+':'+contentID;
   let entry=cache.get(key);
   if((!entry||entry.expires<Date.now())&&inFlight<4){
    if(cache.size>=500)cache.delete(cache.keys().next().value);
    inFlight++;
    const promise=Promise.resolve().then(()=>catalog({kind,id:String(contentID)},true)).then(value=>{
     if(String(value.id)!==String(contentID)||value.kind!==kind)return null;
     return{id:value.id,kind:value.kind,title:value.title,overview:value.overview??'',posterURL:value.posterURL??null,rating:value.rating??null,releaseDate:value.releaseDate??null};
    }).catch(()=>null).finally(()=>{inFlight--;});
    entry={expires:Date.now()+300000,promise};cache.set(key,entry);
   }
   if(entry)pending.push(bounded(entry.promise).then(title=>{if(title)job.title=title;}));
  }
  // Fixed frames paint immediately; slow poster metadata warms for later polls.
  await Promise.all(pending);return result;
 };
}
