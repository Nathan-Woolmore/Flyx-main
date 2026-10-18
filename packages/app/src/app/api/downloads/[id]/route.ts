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

  const body = await _request.json().catch(() => ({}));
  const intent = body?.intent;
  if (intent !== undefined && !["cancel", "remove-history"].includes(intent))
    return NextResponse.json({ ok: false, error: "Invalid download action" }, { status: 400 });
  // A stale confirmation must never turn cancellation into removal, or vice versa.
  const current = getJob(id);
  const stillActive = current && ["queued", "downloading", "processing"].includes(current.status);
  if (!current || (intent === "cancel" && !stillActive) || (intent === "remove-history" && stillActive))
    return NextResponse.json({ ok: false, error: "Download changed. Refresh and choose the action again." }, { status: 409 });
  if (stillActive) {
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
