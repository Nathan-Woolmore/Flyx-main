import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { getJob, listJobs, relinkCompletedDownload } from "@/lib/downloads/manager";
import { getDownloadDir } from "@/lib/downloads/types";
import { LocalRelinkError, previewLocalRelink } from "@/lib/downloads/local-relink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  json(
    {
      ok: false,
      error:
        error instanceof LocalRelinkError
          ? error.message
          : "Could not check this saved file. Try again.",
    },
    error instanceof LocalRelinkError ? error.status : 500,
  );

export async function GET(request: NextRequest, { params }: Context) {
  const session = await getSession();
  if (!session?.isAdmin)
    return json({ ok: false, error: "Administrator access required" }, session ? 403 : 401);
  const { id } = await params;
  try {
    const preview = await previewLocalRelink(
      getJob(id) ?? undefined,
      listJobs(),
      getDownloadDir(),
      request.nextUrl.searchParams.get("filename") ?? undefined,
    );
    return json({ ok: true, preview });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  const session = await getSession();
  if (!session?.isAdmin)
    return json({ ok: false, error: "Administrator access required" }, session ? 403 : 401);
  let body: { confirmed?: unknown; proof?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (body?.confirmed !== true)
    return json(
      { ok: false, error: "Confirm that this file is the named movie or episode first." },
      400,
    );
  const { id } = await params;
  try {
    const job = await relinkCompletedDownload(id, body.proof);
    return json({ ok: true, job });
  } catch (error) {
    return failure(error);
  }
}
