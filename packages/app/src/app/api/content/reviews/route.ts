import {NextRequest,NextResponse} from 'next/server';
import {tmdbApi} from '@/lib/utils/tmdb-api';
import {contentRateLimiter,getClientIP} from '@/lib/utils/api-rate-limiter';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 const q=request.nextUrl.searchParams,kind=q.get('mediaType'),id=q.get('id')??'',page=Number(q.get('page')??1);
 if([...q.keys()].some(k=>!['mediaType','id','page'].includes(k))||!['movie','tv'].includes(kind??'')||!/^[1-9][0-9]{0,9}$/.test(id)||!Number.isSafeInteger(page)||page<1||page>500)return NextResponse.json({error:'Invalid reviews request'},{status:400});
 if(!contentRateLimiter.checkLimit(getClientIP(request)).allowed)return NextResponse.json({error:'Reviews temporarily unavailable'},{status:429});
 try{const data=await tmdbApi.getReviews(id,kind as 'movie'|'tv',page);return NextResponse.json({success:true,data},{headers:{'Cache-Control':'public, s-maxage=3600'}});}
 catch{return NextResponse.json({error:'Reviews temporarily unavailable'},{status:502});}
}
