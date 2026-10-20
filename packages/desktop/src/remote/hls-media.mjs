import {playbackFailure} from './playback-errors.mjs';
export function createResourceBudget({activeLimit=4,queueLimit=8,waitMS=10000}={}) {
 let active=0;const waiting=[];
 return async work=>{
  if(active<activeLimit)active++;
  else {if(waiting.length>=queueLimit)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');await new Promise((resolve,reject)=>{const entry={resolve,timer:null};entry.timer=setTimeout(()=>{const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);reject(playbackFailure('PHONE_MEDIA_UNAVAILABLE'));},waitMS);waiting.push(entry);});}
  try{return await work();}finally{const next=waiting.shift();if(next){clearTimeout(next.timer);next.resolve();}else active--;}
 };
}
// Signed proxy URLs make valid full-length playlists larger than raw CDN manifests.
// Match the existing proxy's 4 MiB cap and bound the shared variant resource index.
const PLAYLIST_LIMIT=4*1024*1024,RESOURCE_LIMIT=16384;
export function createHLSResources(root,{origin,fetcher=fetch}={}) {
 const base=new URL(origin),resources=new Map([['0',root]]),ids=new Map([[root,'0']]);
 const register=(value,parent)=>{const u=new URL(value,parent);if(u.origin!==base.origin||!['/api/stream/proxy','/api/stream/local'].includes(u.pathname)||u.username||u.password)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');const key=u.href;if(ids.has(key))return 'flyx-resource://'+ids.get(key);if(resources.size>=RESOURCE_LIMIT)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');const id=String(resources.size);ids.set(key,id);resources.set(id,key);return 'flyx-resource://'+id;};
 return async(id,range)=>{
  if(typeof id!=='string'||!resources.has(id)||range!=null&&!/^bytes=[0-9]{1,15}-[0-9]{0,15}$/.test(range))throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
  const url=resources.get(id),response=await fetcher(url,{headers:range?{Range:range}:{},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(![200,206].includes(response.status))throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
  const contentTypeHeader=(response.headers.get('content-type')??'').split(';')[0];
  const playlistType=['application/vnd.apple.mpegurl','application/x-mpegURL','application/x-mpegurl'].includes(contentTypeHeader);
  const declared=Number(response.headers.get('content-length')??0);if(declared>(playlistType?PLAYLIST_LIMIT:8388608)){await response.body?.cancel();throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');}
  const chunks=[];let size=0,playlist=playlistType||id==='0',prefix=Buffer.alloc(0);for await(const chunk of response.body){size+=chunk.length;if(prefix.length<16)prefix=Buffer.concat([prefix,Buffer.from(chunk).subarray(0,16-prefix.length)]);if(prefix.toString().trimStart().startsWith('#EXTM3U'))playlist=true;if(size>(playlist?PLAYLIST_LIMIT:8388608))throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');chunks.push(chunk);}let bytes=Buffer.concat(chunks),contentType=contentTypeHeader;
  if(bytes.subarray(0,16).toString().trimStart().startsWith('#EXTM3U')){
   if(bytes.length>PLAYLIST_LIMIT)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
   const text=bytes.toString('utf8');if(text.includes('#EXTINF')&&!text.includes('#EXT-X-ENDLIST'))throw playbackFailure('PHONE_FORMAT_UNSUPPORTED');if(/^#EXT-X-(?:SESSION-)?KEY:(?!METHOD=NONE(?:,|$))/m.test(text))throw playbackFailure('PHONE_FORMAT_UNSUPPORTED');
   const rewritten=text.split(/\r?\n/).map(line=>{if(!line.trim())return line;if(!line.startsWith('#'))return register(line.trim(),url);return line.replace(/URI="([^"]+)"/g,(_match,value)=>'URI="'+register(value,url)+'"');}).join('\n');
   if(/(?:https?|file|skd):|URI=(?!")/.test(rewritten))throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
   bytes=Buffer.from(rewritten);contentType='application/vnd.apple.mpegurl';
  }else if(id==='0'||!['video/mp2t','video/mp4','audio/aac','audio/mp4','application/octet-stream'].includes(contentType))throw playbackFailure('PHONE_FORMAT_UNSUPPORTED');
  const contentRange=response.headers.get('content-range'),parsed=/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(contentRange??'');
  if(response.status===206&&(!parsed||Number(parsed[1])>Number(parsed[2])||Number(parsed[2])>=Number(parsed[3])||bytes.length!==Number(parsed[2])-Number(parsed[1])+1))throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
  if(contentRange&&!parsed)throw playbackFailure('PHONE_MEDIA_UNAVAILABLE');
  return{bytes:bytes.toString('base64'),contentType,status:response.status,contentRange:contentRange??null};
 };
}
