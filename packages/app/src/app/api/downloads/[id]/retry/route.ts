import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { retryCollectionJob, getJob } from "@/lib/downloads/manager";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())?.isAdmin)
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  const { id } = await params;
  if (!getJob(id)) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  if (!retryCollectionJob(id))
    return NextResponse.json(
      {
        ok: false,
        error:
          "This collection cannot be retried yet. Wait for cancellation to finish, then try again.",
      },
      { status: 409 },
    );
  return NextResponse.json({ ok: true });
}
