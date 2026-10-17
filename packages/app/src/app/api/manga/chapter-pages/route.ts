import {NextRequest,NextResponse} from 'next/server';
import {getMangaDetailsWithChapters,getChapterPagesById} from '@flyx/extractors/services';
import {contentRateLimiter,getClientIP} from '@/lib/utils/api-rate-limiter';
const cache=new Map<string,{expires:number;chapters:any[]}>();
export async function GET(request:NextRequest){
 const mangaID=request.nextUrl.searchParams.get('mangaID')??'',chapterID=request.nextUrl.searchParams.get('chapterID')??'';
 if(!/^[a-zA-Z0-9._-]{1,300}$/.test(mangaID)||!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(chapterID))return NextResponse.json({error:'Invalid chapter'},{status:400});
 if(!contentRateLimiter.checkLimit(getClientIP(request)).allowed)return NextResponse.json({error:'Provider busy'},{status:429});
 try{
  let entry=cache.get(mangaID);
  if(!entry||entry.expires<Date.now()){const details=await getMangaDetailsWithChapters(mangaID);if(!details)return NextResponse.json({error:'Manga unavailable'},{status:404});entry={expires:Date.now()+300000,chapters:details.chapters};if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(mangaID,entry);}
  const chapter=entry.chapters.find(c=>c.id===chapterID);if(!chapter)return NextResponse.json({error:'Chapter does not belong to this manga'},{status:404});
  const pages=await getChapterPagesById(chapterID,request.signal);
  return NextResponse.json({provider:'weebcentral',mangaID,chapterID,chapterNumber:chapter.number,language:chapter.language??'unknown',edition:chapter.edition??'unlabeled:'+chapterID,pages});
 }catch{return NextResponse.json({error:'Chapter provider unavailable. Retry.'},{status:502});}
}
