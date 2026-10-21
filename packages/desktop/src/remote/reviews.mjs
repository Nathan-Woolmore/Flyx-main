import {CatalogRequestError,catalogFailure} from './catalog.mjs';
export function reviewsPath({kind,id,page=1}){
 if(!['movie','tv'].includes(kind)||!/^[1-9][0-9]{0,9}$/.test(String(id))||!Number.isSafeInteger(page)||page<1||page>500)throw new CatalogRequestError('Invalid reviews request');
 return '/api/content/reviews?'+new URLSearchParams({mediaType:kind,id:String(id),page:String(page)});
}
export function normalizeReviews(body,page){
 const data=body?.data;if(body?.success!==true||!data||!Array.isArray(data.results)||data.page!==page)throw catalogFailure('CATALOG_UNAVAILABLE');
 const seen=new Set(),items=[];
 for(const value of data.results.slice(0,20)){
  if(!value||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.id)||seen.has(value.id)||typeof value.content!=='string'||!value.content.trim())continue;
  seen.add(value.id);
  const text=value.content.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,50000);
  if(!text)continue;
  const author=[value.author_details?.name,value.author_details?.username,value.author].find(v=>typeof v==='string'&&v.trim());
  const rating=value.author_details?.rating,date=typeof value.created_at==='string'?Date.parse(value.created_at):NaN;
  items.push({id:value.id,author:author?author.trim().slice(0,120):'TMDB member',text,rating:typeof rating==='number'&&Number.isFinite(rating)&&rating>=0&&rating<=10?rating:null,createdAt:Number.isFinite(date)?new Date(date).toISOString():null,url:'https://www.themoviedb.org/review/'+encodeURIComponent(value.id)});
 }
 return{items,order:'tmdb',page,nextPage:Number.isSafeInteger(data.total_pages)&&data.total_pages>page&&page<500?page+1:null,total:Number.isSafeInteger(data.total_results)&&data.total_results>=0?data.total_results:null};
}
export function createReviews(request){return async query=>{const page=query.page??1;return normalizeReviews(await request(reviewsPath(query)),page);};}
