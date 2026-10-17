import {CatalogRequestError} from './catalog.mjs';
const kinds=new Set(['movie','tv','anime','manga']);
export function createWatchlist(request,catalog){return async(operation,body={})=>{
 if(operation==='list'){
  const value=await request({operation:'list'});if(!Array.isArray(value.items))throw new Error('Watchlist unavailable');
  return{items:value.items.filter(v=>kinds.has(v.mediaType)&&v.contentId&&typeof v.title==='string').map(v=>({id:String(v.contentId),kind:v.mediaType,title:v.title,overview:'',posterURL:typeof v.posterPath==='string'?(v.posterPath.startsWith('/')?'https://image.tmdb.org/t/p/w500'+v.posterPath:/^https:\/\//.test(v.posterPath)?v.posterPath:null):null,rating:Number.isFinite(v.rating)?v.rating:null,releaseDate:v.releaseDate!=null?String(v.releaseDate):v.year!=null?String(v.year):null}))};
 }
 if(!['add','remove'].includes(operation)||!kinds.has(body.kind)||typeof body.id!=='string'||!body.id||body.id.length>300)throw new CatalogRequestError('Invalid watchlist item');
 const item=operation==='add'?await catalog({kind:body.kind,id:body.id},true):{kind:body.kind,id:body.id};
 const value=await request({operation,item});if(value.ok!==true)throw new Error('Watchlist save failed');return{ok:true};
};}
