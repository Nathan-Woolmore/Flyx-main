/**
 * GET  /api/downloads — list download jobs (with progress)
 * POST /api/downloads — queue one or more downloads ({ items: [...] })
 *
 * Admin-only: downloads write files to the server machine's disk.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/get-session";
import { createOrReuseJobs, listJobs } from "@/lib/downloads/manager";
import { openLocalDownload } from "@/lib/downloads/local-files";
import { getDownloadDir } from "@/lib/downloads/types";
import type { DownloadItemInput } from "@/lib/downloads/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validateItems(items: unknown): DownloadItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  if (items.length > 100) {
    throw new Error("too many items (max 100 per request)");
  }

  return items.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`items[${i}] is invalid`);
    }
    const it = item as Record<string, unknown>;

    if (it.kind === "video") {
      const tmdbId = Number(it.tmdbId);
      const malId = it.malId != null ? Number(it.malId) : undefined;
      if (
        !Number.isSafeInteger(tmdbId) ||
        tmdbId < 0 ||
        (malId !== undefined && (!Number.isSafeInteger(malId) || malId <= 0)) ||
        (tmdbId === 0 && !malId)
      ) {
        throw new Error(`items[${i}] is missing a valid tmdbId/malId`);
      }
      const mediaType = it.mediaType === "tv" ? "tv" : "movie";
      if (it.mediaType !== undefined && it.mediaType !== "tv" && it.mediaType !== "movie") {
        throw new Error(`items[${i}] has an invalid mediaType`);
      }
      const season = it.season != null ? Number(it.season) : undefined;
      const episode = it.episode != null ? Number(it.episode) : undefined;
      if (
        mediaType === "tv" &&
        (!Number.isSafeInteger(season) ||
          season! < 0 ||
          !Number.isSafeInteger(episode) ||
          episode! <= 0)
      ) {
        throw new Error(`items[${i}] is missing a valid season/episode`);
      }
      return {
        kind: "video",
        tmdbId,
        mediaType,
        season: mediaType === "tv" ? season : undefined,
        episode: mediaType === "tv" ? episode : undefined,
        malId,
        title: typeof it.title === "string" ? it.title : undefined,
        provider: typeof it.provider === "string" ? it.provider : undefined,
        quality: typeof it.quality === "string" ? it.quality : undefined,
        language: it.language === "dub" ? "dub" : it.language === "sub" ? "sub" : undefined,
        durationSec: it.durationSec ? Number(it.durationSec) : undefined,
      } as DownloadItemInput;
    }

    if (it.kind === "manga") {
      const mangaId = String(it.mangaId || "");
      if (it.collection !== undefined) {
        const scope = it.collection as Record<string, unknown> | null;
        if (
          !scope ||
          typeof scope !== "object" ||
          typeof scope.language !== "string" ||
          !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(scope.language) ||
          (scope.edition !== "official" && scope.edition !== "community") ||
          !/^[a-z0-9][a-z0-9._-]{0,299}$/i.test(mangaId)
        )
          throw new Error(`items[${i}] has an invalid collection selection`);
        return {
          kind: "manga",
          mangaId,
          chapter: 0,
          title: typeof it.title === "string" ? it.title : undefined,
          collection: { language: scope.language, edition: scope.edition },
        } as DownloadItemInput;
      }
      const chapter = Number(it.chapter);
      if (!mangaId || !Number.isFinite(chapter) || chapter <= 0) {
        throw new Error(`items[${i}] is missing a valid mangaId/chapter`);
      }
      return {
        kind: "manga",
        mangaId,
        chapter,
        title: typeof it.title === "string" ? it.title : undefined,
      } as DownloadItemInput;
    }

    throw new Error(`items[${i}] has an unsupported kind`);
  });
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return NextResponse.json({
    ok: true,
    jobs: await Promise.all(listJobs().map(async ({ collectionPlan: _plan, ...visible }) => {
      const file = visible.kind === "video" && visible.status === "done"
        ? await openLocalDownload(visible, listJobs(), getDownloadDir()) : null;
      const localPlaybackAvailable = file !== null;
      const fileBytes = file?.size;
      await file?.handle.close();
      return { ...visible, localPlaybackAvailable, ...(fileBytes ? { fileBytes } : {}) };
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  let body: { items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const items = validateItems(body?.items);
    const jobs = await createOrReuseJobs(items);
    return NextResponse.json({ ok: true, jobs: jobs.map((j) => ({ id: j.id, label: j.label })) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
