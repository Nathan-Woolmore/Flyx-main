import {normalizeCatalog,catalogFailure} from './catalog.mjs';

const sections = [
  {id:'trending-movies',kind:'movie',title:'Top 10 this week',subtitle:'Movies · TMDB weekly trending',source:'TMDB',ranked:true},
  {id:'trending-tv',kind:'tv',title:'Trending TV',subtitle:'Series · TMDB weekly trending',source:'TMDB',ranked:false},
  {id:'popular-anime',kind:'anime',title:'Popular anime',subtitle:'From the Mac anime catalogue',source:'Anime catalogue',ranked:false},
  {id:'popular-movies',kind:'movie',title:'Popular now',subtitle:'Movies · TMDB popularity',source:'TMDB',ranked:false},
  {id:'popular-manga',kind:'manga',title:'Popular manga',subtitle:'From the Mac manga catalogue',source:'WeebCentral',ranked:false},
  {id:'now-playing',kind:'movie',title:'Now playing',subtitle:'TMDB now-playing movies',source:'TMDB',ranked:false},
  {id:'top-rated-movies',kind:'movie',title:'Top rated movies',subtitle:'TMDB community ratings',source:'TMDB',ranked:false},
];

export function normalizeHomeItems(raw,kind,ranked) {
  const seen=new Set(),items=[];
  for(const [index,value] of (Array.isArray(raw)?raw:[]).slice(0,ranked?10:16).entries()) {
    try {
      const title=normalizeCatalog({data:[value]},kind).items[0];
      if(!title || (kind!=='manga'&&!/^[1-9][0-9]{0,9}$/.test(title.id)))continue;
      const id=title.kind+':'+title.id;if(seen.has(id))continue;seen.add(id);
      // Keep original provider positions if an invalid/duplicate entry is skipped.
      items.push({id,title,...(ranked?{rank:index+1}:{})});
    } catch {}
  }
  return items;
}

export function createHome(request,{now=Date.now,ttlMS=180000}={}) {
  const previous=new Map();let snapshot,pending;
  return async({refresh=false}={})=>{
    if(!refresh&&snapshot&&now()-snapshot.checkedAt<ttlMS)return{...snapshot,cached:true};
    if(pending)return pending;
    pending=(async()=>{
      // Same Mac Home lists, plus its existing anime/manga category feeds.
      // No provider extraction, media resolution or playback operations.
      const [mac,anime,manga]=await Promise.allSettled([
        request('/api/content/home'),
        request('/api/anime/jikan?'+new URLSearchParams({path:'/top/anime?limit=16&filter=bypopularity'})),
        request('/api/manga/popular?type=popular&limit=16'),
      ]);
      const rows=sections.map(def=>{
        const reply=def.kind==='anime'?anime:def.kind==='manga'?manga:mac;
        const value=reply.status==='fulfilled'?reply.value:null;
        const raw=def.source==='TMDB'?value?.sections?.find(s=>s.id===def.id):value;
        const available=def.source==='TMDB'?raw?.available===true:Array.isArray(raw?.data)&&!raw.error;
        if(!available){const saved=previous.get(def.id);return{...def,items:saved?.items??[],updatedAt:saved?.updatedAt??null,stale:!!saved,error:saved?'Could not refresh this row. Showing previously loaded titles.':'This feed is temporarily unavailable. Pull to retry.'};}
        const items=normalizeHomeItems(def.source==='TMDB'?raw.items:raw.data,def.kind,def.ranked);
        const row={...def,items,updatedAt:now(),stale:false,error:null};previous.set(def.id,row);return row;
      });
      if(!rows.some(row=>row.updatedAt!==null))throw catalogFailure('CATALOG_UNAVAILABLE');
      snapshot={sections:rows,checkedAt:now(),cached:false};return snapshot;
    })();
    try{return await pending;}finally{pending=undefined;}
  };
}
