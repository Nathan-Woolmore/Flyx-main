// Uses the Mac extraction/VLC signing endpoint. Only the main process receives URLs.
export async function resolvePhoneSources(selection,{fetcher=fetch,order=s=>s,recovery=s=>s}={}) {
 const providers=selection.kind==='anime'?['animex']:['vidsrc','vidlove','multiembed','videasy'];
 const query=new URLSearchParams({format:'json',allSources:'1',tmdbId:String(selection.kind==='anime'?0:selection.contentID),mediaType:selection.kind==='movie'?'movie':'tv'});
 if(selection.kind==='anime')query.set('malId',String(selection.contentID));
 if(selection.kind!=='movie'){query.set('season',String(selection.season));query.set('episode',String(selection.episode));}
 const probe=async(provider,timeout)=>{try{const q=new URLSearchParams(query);q.set('provider',provider);if(provider==='local')q.set('localOnly','1');const response=await fetcher('/api/stream/vlc?'+q,{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeout)});const value=await response.json();return response.ok&&value.ok?{title:value.title,sources:(value.sources??[]).map(s=>({...s,provider:s.provider||provider}))}:{sources:[]};}catch{return{sources:[]};}};
 const local=await probe('local',2000);
 // Await every bounded provider probe before declaring exhaustion; retry a resolver once.
 const results=await Promise.all(providers.map(async provider=>{let value=await probe(provider,12000);if(!value.sources.length)value=await probe(provider,4000);return value;}));
 const key=source=>{try{const u=new URL(source.url);u.searchParams.delete('sig');u.searchParams.delete('exp');u.searchParams.sort();return u.href;}catch{return source.url;}};
 const groups=[local,...results];const seen=new Set();const sources=[];let rank=0;
 for(const group of groups){const available=group.sources.filter(s=>s.url&&!seen.has(key(s))&&seen.add(key(s)));const ranked=recovery(available);for(const source of (selection.kind==='anime'?order(available.filter(s=>/sub|ja|jp|japanese/i.test(s.language??''))).concat(order(available.filter(s=>!/sub|ja|jp|japanese/i.test(s.language??'')))):order(available))){sources.push({...source,recoveryRank:rank+ranked.indexOf(source)});}rank+=available.length;}
 if(!sources.length)throw Object.assign(new Error('No source resolved'),{code:'PHONE_MEDIA_UNAVAILABLE'});
 return{...sources[0],sources,title:groups.find(g=>g.title)?.title??'Flyx'};
}
