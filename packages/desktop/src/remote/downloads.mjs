const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function downloadRequest(operation,body={}) {
 if(operation==='list')return {path:'/api/downloads',method:'GET'};
 if(['remove','retry'].includes(operation)) {if(!uuid(body.id))throw new Error('Invalid job');return{path:`/api/downloads/${body.id}${operation==='retry'?'/retry':''}`,method:operation==='retry'?'POST':'DELETE'};}
 if(operation!=='queue')throw new Error('Unsupported download operation');
 const item=body.item;
 if(!item||item.kind!=='video'||!['movie','tv'].includes(item.mediaType)||!Number.isSafeInteger(item.tmdbId)||item.tmdbId<0||item.tmdbId===0&&(!Number.isSafeInteger(item.malId)||item.malId<=0))throw new Error('Invalid download');
 if(item.mediaType==='tv'&&(!Number.isSafeInteger(item.season)||item.season<0||!Number.isSafeInteger(item.episode)||item.episode<=0))throw new Error('Episode selection required');
 if(Object.keys(item).some(k=>!['kind','tmdbId','malId','mediaType','season','episode','title','quality'].includes(k)))throw new Error('Unexpected download field');
 if(item.quality!=null&&!['480p','720p','1080p','2160p'].includes(item.quality))throw new Error('Unsupported quality');
 if(item.title!=null&&(typeof item.title!=='string'||item.title.length>300))throw new Error('Invalid title');
 return{path:'/api/downloads',method:'POST',body:{items:[item]}};
}
export function publicJobs(body) {
 if(!body.ok||!Array.isArray(body.jobs))throw new Error('Downloads unavailable');
 return{jobs:body.jobs.map(j=>({id:j.id,label:j.label,status:j.status,progress:Number.isFinite(j.progress)?Math.min(100,Math.max(0,j.progress)):0,bytes:j.bytes??0,canRetry:j.kind==='manga'&&!!j.collection&&['error','cancelled'].includes(j.status),error:j.error?'Download failed. See Flyx on Mac for details.':null}))};
}
export function createDownloads(request){return async(operation,body)=>{const spec=downloadRequest(operation,body);const response=await request(spec);if(!response.ok)throw new Error('Download operation failed');return operation==='list'?publicJobs(response):{ok:true};};}
