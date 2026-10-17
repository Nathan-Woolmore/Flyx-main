/**
 * DELETE /api/downloads/[id] — cancel a running/queued job, or remove a
 * finished one from the history.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { cancelJob, getJob, removeJobWithCache } from "@/lib/downloads/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const active =
    job.status === "queued" || job.status === "downloading" || job.status === "processing";
  if (active) {
    cancelJob(id);
  } else {
    try {
      await removeJobWithCache(id);
    } catch (error) {
      return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 409 });
    }
  }

  return NextResponse.json({ ok: true });
}
