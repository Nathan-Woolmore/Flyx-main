import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { loadMacHomeLists, MAC_HOME_FEEDS, MAC_TV_HOME_FEEDS } from "@/lib/mac-home";

export const dynamic = "force-dynamic";

export async function GET(request:NextRequest) {
  if (!await getSession()) return NextResponse.json({error:"Unauthorized"},{status:401});
  const category=request.nextUrl.searchParams.get("category");
  if(category && category!=="tv")return NextResponse.json({error:"Invalid Home category"},{status:400});
  const feeds=category==="tv" ? MAC_TV_HOME_FEEDS:MAC_HOME_FEEDS;
  const lists = await loadMacHomeLists(feeds);
  return NextResponse.json({sections:feeds.map((feed,index)=>({
    id:feed.id, kind:feed.kind, title:feed.title, subtitle:feed.subtitle,
    source:"TMDB", ranked:feed.ranked, available:lists[index] !== null,
    items:lists[index]?.results?.slice(0,feed.ranked ? 10 : 16) ?? [],
  }))},{headers:{"Cache-Control":"private, no-store"}});
}
