import {normalizeCatalog,catalogFailure,catalogPath,CatalogRequestError} from './catalog.mjs';

const animePath=path=>'/api/anime/jikan?'+new URLSearchParams({path});
const mangaPath=type=>'/api/manga/popular?'+new URLSearchParams({type,limit:'16'});
const base = [
  {id:'trending-movies',kind:'movie',title:'Top 10 this week',subtitle:'Movies · Trending this week',source:'TMDB',ranked:true},
  {id:'trending-tv',kind:'tv',title:'Trending TV',subtitle:'Series · Trending this week',source:'TMDB',ranked:false},
  {id:'popular-anime',kind:'anime',title:'Popular anime',subtitle:'Fan favorites',source:'Anime catalogue',ranked:false,path:animePath('/top/anime?limit=16&filter=bypopularity')},
  {id:'popular-movies',kind:'movie',title:'Popular now',subtitle:'Movies everyone is watching',source:'TMDB',ranked:false},
  {id:'popular-manga',kind:'manga',title:'Popular manga',subtitle:'Fan-favorite manga',source:'WeebCentral',ranked:false,path:mangaPath('popular')},
  {id:'now-playing',kind:'movie',title:'Now playing',subtitle:'In cinemas now',source:'TMDB',ranked:false},
  {id:'top-rated-movies',kind:'movie',title:'Top rated movies',subtitle:'Community favorites',source:'TMDB',ranked:false},
];
const byID=id=>base.find(row=>row.id===id);
const anime=(id,title,subtitle,path,ranked=false)=>({id,kind:'anime',title,subtitle,source:'Anime catalogue',ranked,path:animePath(path)});
const manga=(id,title,subtitle,type)=>({id,kind:'manga',title,subtitle,source:'WeebCentral',ranked:false,path:mangaPath(type)});
export function homeSectionDefinitions(category='all') {
  if(category==='all')return base;
  if(category==='movie')return base.filter(row=>row.kind==='movie');
  if(category==='tv')return[
    {...byID('trending-tv'),title:'Top 10 series this week',ranked:true},
    {id:'popular-tv',kind:'tv',title:'Popular series',subtitle:'Discover your next series',source:'TMDB',ranked:false},
    {id:'top-rated-tv',kind:'tv',title:'Top rated series',subtitle:'Community favorites',source:'TMDB',ranked:false,path:catalogPath({kind:'tv',sort:'rating',minVotes:10})},
  ];
  if(category==='anime')return[
    {...byID('popular-anime'),title:'Top 10 popular anime',ranked:true},
    anime('airing-anime','Currently airing','Fresh episodes this season','/seasons/now?limit=16'),
    anime('top-rated-anime','Top rated anime','Community favorites','/top/anime?limit=16'),
    anime('upcoming-anime','Upcoming anime','Coming next season','/seasons/upcoming?limit=14'),
    anime('anime-movies','Anime movies','Feature-length stories','/top/anime?limit=14&type=movie'),
  ];
  if(category==='manga')return[
    byID('popular-manga'),
    manga('latest-manga','Latest updates','Recently updated chapters','latest'),
    manga('action-manga','Action & adventure','Epic battles and heroes','action'),
    manga('romance-manga','Romance & drama','Love stories and drama','romance'),
    manga('fantasy-manga','Fantasy & isekai','Other worlds and magic','fantasy'),
  ];
  throw new CatalogRequestError('Invalid Home category');
}

export function normalizeHomeItems(raw,kind,ranked) {
  const seen=new Set(),items=[];
  for(const [index,value] of (Array.isArray(raw)?raw:[]).slice(0,ranked?10:16).entries()) {
    try {
      const title=normalizeCatalog({data:[value]},kind).items[0];
      if(!title || (kind!=='manga'&&!/^[1-9][0-9]{0,9}$/.test(title.id)))continue;
      const id=title.kind+':'+title.id;if(seen.has(id))continue;seen.add(id);
      items.push({id,title,...(ranked?{rank:index+1}:{})});
    } catch {}
  }
  return items;
}

export function createHome(request,{now=Date.now,ttlMS=180000}={}) {
  const states=new Map();
  return async({refresh=false,category='all'}={})=>{
    const definitions=homeSectionDefinitions(category);
    let state=states.get(category);
    if(!state){state={previous:new Map()};states.set(category,state);}
    if(!refresh&&state.snapshot&&now()-state.snapshot.checkedAt<ttlMS)return{...state.snapshot,cached:true};
    if(state.pending)return state.pending;
    state.pending=(async()=>{
      const macPath=category==='tv'?'/api/content/home?category=tv':'/api/content/home';
      const paths=[...new Set(definitions.map(def=>def.path??macPath))];
      const outcomes=await Promise.allSettled(paths.map(path=>request(path)));
      const replies=new Map(paths.map((path,index)=>[path,outcomes[index]]));
      const rows=definitions.map(def=>{
        const {path,...publicDef}=def;
        const reply=replies.get(path??macPath);
        const value=reply.status==='fulfilled'?reply.value:null;
        const raw=path?value:value?.sections?.find(s=>s.id===def.id);
        const available=path?Array.isArray(raw?.data)&&!raw.error:raw?.available===true;
        if(!available){const saved=state.previous.get(def.id);return{...publicDef,items:saved?.items??[],updatedAt:saved?.updatedAt??null,stale:!!saved,error:saved?'Could not refresh this row. Showing previously loaded titles.':'This feed is temporarily unavailable. Pull to retry.'};}
        const items=normalizeHomeItems(path?raw.data:raw.items,def.kind,def.ranked);
        const row={...publicDef,items,updatedAt:now(),stale:false,error:null};state.previous.set(def.id,row);return row;
      });
      if(!rows.some(row=>row.updatedAt!==null))throw catalogFailure('CATALOG_UNAVAILABLE');
      state.snapshot={sections:rows,checkedAt:now(),cached:false};return state.snapshot;
    })();
    try{return await state.pending;}finally{state.pending=undefined;}
  };
}
