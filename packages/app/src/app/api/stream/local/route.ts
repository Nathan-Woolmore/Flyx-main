import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { getSession } from "@/lib/auth/get-session";
import { listJobs } from "@/lib/downloads/manager";
import { getDownloadDir } from "@/lib/downloads/types";
import { byteRange, openLocalDownload } from "@/lib/downloads/local-files";
import { localStreamQuery } from "@/lib/downloads/local-identity";
import { hasValidSignature } from "@/lib/security/proxy-sign";
import { applySignedCors, PROXY_SECURITY_HEADERS, signedPreflight } from "@/lib/media-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serve(request: NextRequest, head = false) {
  const signed = hasValidSignature(request.url);
  const session = signed ? null : await getSession();
  const via = signed ? "signature" : "session";
  const error = (status: number) =>
    applySignedCors(
      new NextResponse(
        head
          ? null
          : JSON.stringify({
              error:
                status === 401
                  ? "Unauthorized"
                  : status === 403
                    ? "Forbidden"
                    : "Local download unavailable",
            }),
        {
          status,
          headers: {
            ...PROXY_SECURITY_HEADERS,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      ),
      signed ? "signature" : null,
    );
  if (!signed && !session?.isAdmin) return error(session ? 403 : 401);
  const query = localStreamQuery(request.nextUrl.searchParams);
  if (!query) return error(404);
  const jobs = listJobs();
  const file = await openLocalDownload(
    jobs.find((job) => job.id === query.id),
    jobs,
    getDownloadDir(),
    query.rev,
  );
  if (!file) return error(404);
  const etag = `"${file.revision}"`;
  const suppliedRange = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeHeader = suppliedRange && (!ifRange || ifRange === etag) ? suppliedRange : null;
  const range = byteRange(rangeHeader, file.size);
  const headers = new Headers({
    ...PROXY_SECURITY_HEADERS,
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    ETag: etag,
  });
  if (!range) {
    await file.handle.close();
    headers.set("Content-Range", `bytes */${file.size}`);
    return applySignedCors(new NextResponse(null, { status: 416, headers }), via);
  }
  headers.set("Content-Length", String(range.end - range.start + 1));
  if (rangeHeader) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
  if (head) {
    await file.handle.close();
    return applySignedCors(
      new NextResponse(null, { status: rangeHeader ? 206 : 200, headers }),
      via,
    );
  }
  const stream = file.handle.createReadStream({
    start: range.start,
    end: range.end,
    autoClose: true,
    signal: request.signal,
  });
  return applySignedCors(
    new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: rangeHeader ? 206 : 200,
      headers,
    }),
    via,
  );
}

export const GET = (request: NextRequest) => serve(request);
export const HEAD = (request: NextRequest) => serve(request, true);
export const OPTIONS = (request: NextRequest) => signedPreflight(request);
