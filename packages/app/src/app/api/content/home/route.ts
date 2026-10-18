import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { loadMacHomeLists, MAC_HOME_FEEDS } from "@/lib/mac-home";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!await getSession()) return NextResponse.json({error:"Unauthorized"},{status:401});
  const lists = await loadMacHomeLists();
  return NextResponse.json({sections:MAC_HOME_FEEDS.map((feed,index)=>({
    id:feed.id, kind:feed.kind, title:feed.title, subtitle:feed.subtitle,
    source:"TMDB", ranked:feed.ranked, available:lists[index] !== null,
    items:lists[index]?.results?.slice(0,feed.ranked ? 10 : 16) ?? [],
  }))},{headers:{"Cache-Control":"private, no-store"}});
}
