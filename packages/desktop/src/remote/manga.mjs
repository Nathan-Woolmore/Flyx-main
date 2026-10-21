import {randomUUID} from 'node:crypto';
import {catalogFailure,CatalogRequestError} from './catalog.mjs';
export function createManga(request,{now=Date.now,makeID=randomUUID}={}){
 const sessions=new Map();
 return async(operation,body,owner)=>{
  if(operation==='chapter'){
   if(!/^[a-zA-Z0-9._-]{1,300}$/.test(body.mangaID??'')||!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(body.chapterID??''))throw new CatalogRequestError('Invalid chapter');
   const value=await request({operation:'chapter',mangaID:body.mangaID,chapterID:body.chapterID});
   if(!Array.isArray(value.pages)||!value.pages.length||value.pages.length>1000||value.chapterID!==body.chapterID||value.mangaID!==body.mangaID)throw catalogFailure('MANGA_UNAVAILABLE');
   for(const page of value.pages){const url=new URL(page.imageUrl);if(url.protocol!=='https:'||url.username||url.password||url.href.length>4096)throw catalogFailure('MANGA_UNAVAILABLE');}
   const handle=makeID();if(sessions.size>=32)sessions.delete(sessions.keys().next().value);sessions.set(handle,{owner,expires:now()+900000,pages:value.pages});
   return{handle,pageCount:value.pages.length,provider:'weebcentral',mangaID:body.mangaID,chapterID:body.chapterID,chapterNumber:value.chapterNumber,language:String(value.language??'unknown'),edition:String(value.edition??'unlabeled:'+body.chapterID)};
  }
  if(operation!=='image')throw new CatalogRequestError('Invalid reader operation');
  const session=sessions.get(body.handle);if(!session||session.owner!==owner||session.expires<now())throw catalogFailure('MANGA_EXPIRED');
  const page=Number(body.page);if(!Number.isSafeInteger(page)||page<1||page>session.pages.length)throw new CatalogRequestError('Invalid page');
  const item=session.pages[page-1];const value=await request({operation:'image',url:item.imageUrl,referer:item.referer});
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(value.mimeType)||typeof value.base64!=='string'||value.base64.length>12_000_000)throw catalogFailure('MANGA_UNAVAILABLE');
  const bytes=Buffer.from(value.base64,'base64');if(!bytes.length||bytes.length>8_388_608)throw catalogFailure('MANGA_UNAVAILABLE');
  return{bytes,contentType:value.mimeType};
 };
}
