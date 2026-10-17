import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { listJobs } from "@/lib/downloads/manager";
import { getDownloadDir } from "@/lib/downloads/types";
import { findLocalDownloadSources } from "@/lib/downloads/local-files";
import { parseLocalIdentity } from "@/lib/downloads/local-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin)
    return NextResponse.json(
      { success: false, message: "Local downloads require host administrator access" },
      { status: session ? 403 : 401 },
    );
  let identity;
  try {
    identity = parseLocalIdentity(request.nextUrl.searchParams);
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid movie or episode identity" },
      { status: 400 },
    );
  }
  const sources = await findLocalDownloadSources(listJobs(), getDownloadDir(), identity);
  return NextResponse.json(
    {
      success: true,
      provider: "local",
      sources,
      message: sources.length ? undefined : "No matching completed local download is available",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
