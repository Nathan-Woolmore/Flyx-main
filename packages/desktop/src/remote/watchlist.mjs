import {CatalogRequestError} from './catalog.mjs';
const kinds=new Set(['movie','tv','anime','manga']);
export function createWatchlist(request,catalog){return async(operation,body={})=>{
 if(operation==='list'){
  const value=await request({operation:'list'});if(!Array.isArray(value.items))throw new Error('Watchlist unavailable');
  return{syncScope:typeof value.syncScope==='string'?value.syncScope:undefined,items:value.items.filter(v=>kinds.has(v.mediaType)&&v.contentId&&typeof v.title==='string').map(v=>({id:String(v.contentId),kind:v.mediaType,title:v.title,overview:'',posterURL:typeof v.posterPath==='string'?(v.posterPath.startsWith('/')?'https://image.tmdb.org/t/p/w500'+v.posterPath:/^https:\/\//.test(v.posterPath)?v.posterPath:null):null,rating:Number.isFinite(v.rating)?v.rating:null,releaseDate:v.releaseDate!=null?String(v.releaseDate):v.year!=null?String(v.year):null}))};
 }
 if(!['add','remove'].includes(operation)||!kinds.has(body.kind)||typeof body.id!=='string'||!body.id||body.id.length>300)throw new CatalogRequestError('Invalid watchlist item');
 let item;
 if(operation==='add'&&body.kind==='manga'&&/^md:[a-f0-9-]{36}$/i.test(body.id)){
  const metadata=body.item;
  if(!metadata||metadata.id!==body.id||metadata.kind!=='manga'||typeof metadata.title!=='string'||!metadata.title||metadata.title.length>500)throw new CatalogRequestError('Invalid MangaDex bookmark');
  const poster=typeof metadata.posterURL==='string'&&metadata.posterURL.startsWith('https://uploads.mangadex.org/covers/'+body.id.slice(3)+'/')?metadata.posterURL:null;
  item={id:body.id,kind:'manga',title:metadata.title,posterURL:poster,releaseDate:typeof metadata.releaseDate==='string'&&/^\d{4}(?:-\d{2}-\d{2})?$/.test(metadata.releaseDate)?metadata.releaseDate:null};
 }else item=operation==='add'?await catalog({kind:body.kind,id:body.id},true):{kind:body.kind,id:body.id};
 const value=await request({operation,item,...(body.syncScope!==undefined?{expectedScope:body.syncScope}:{}),...(body.mutationID!==undefined?{mutationID:body.mutationID}:{})});if(value.ok!==true)throw new Error('Watchlist save failed');return{ok:true};
};}
