import type { DownloadJob } from "./types";

export interface LocalPlaybackIdentity {
  tmdbId: number;
  mediaType: "movie" | "tv";
  malId?: number;
  season?: number;
  episode?: number;
  language?: "sub" | "dub";
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseLocalIdentity(params: URLSearchParams): LocalPlaybackIdentity {
  const mediaType = params.get("mediaType");
  const tmdbId = Number(params.get("tmdbId"));
  const malId = params.has("malId") ? Number(params.get("malId")) : undefined;
  const season = params.has("season") ? Number(params.get("season")) : undefined;
  const episode = params.has("episode") ? Number(params.get("episode")) : undefined;
  if (
    (mediaType !== "movie" && mediaType !== "tv") ||
    (malId !== undefined && !positive(malId)) ||
    (!positive(tmdbId) && !positive(malId)) ||
    (mediaType === "tv" && (!Number.isSafeInteger(season) || season! < 0 || !positive(episode)))
  ) {
    throw new Error("Invalid movie or episode identity");
  }
  const language = params.get("language");
  return {
    tmdbId: positive(tmdbId) ? tmdbId : 0,
    malId,
    mediaType,
    season,
    episode,
    language: language === "sub" || language === "dub" ? language : undefined,
  };
}

export function localIdentityKey(identity: LocalPlaybackIdentity): string {
  return JSON.stringify([
    identity.malId ? "mal" : "tmdb",
    identity.malId || identity.tmdbId,
    identity.mediaType,
    identity.mediaType === "tv" ? identity.season : null,
    identity.mediaType === "tv" ? identity.episode : null,
  ]);
}

export function matchesLocalDownload(job: DownloadJob, identity: LocalPlaybackIdentity): boolean {
  if (job.kind !== "video" || job.status !== "done" || job.mediaType !== identity.mediaType)
    return false;
  if (
    identity.malId
      ? job.malId !== identity.malId
      : Boolean(job.malId) || job.tmdbId !== identity.tmdbId
  )
    return false;
  if (
    identity.mediaType === "tv" &&
    (job.season !== identity.season || job.episode !== identity.episode)
  )
    return false;
  if (identity.language && job.language !== identity.language) return false;
  return true;
}

export function hasLocalFileBinding(job: DownloadJob): boolean {
  return typeof job.fileRevision === "string" && /^[a-f0-9]{64}$/.test(job.fileRevision);
}

/** Exact catalog identity from a completed download record, including legacy records. */
export function downloadIdentity(job: DownloadJob): LocalPlaybackIdentity | null {
  if (job.kind !== "video" || job.status !== "done") return null;
  const params = new URLSearchParams({
    tmdbId: String(job.tmdbId || 0),
    mediaType: job.mediaType || "",
  });
  if (job.malId) params.set("malId", String(job.malId));
  if (job.language) params.set("language", job.language);
  if (job.mediaType === "tv") {
    params.set("season", String(job.season));
    params.set("episode", String(job.episode));
  }
  try {
    return parseLocalIdentity(params);
  } catch {
    return null;
  }
}

export function watchUrlForDownload(job: DownloadJob): string | null {
  const identity = downloadIdentity(job);
  if (!identity || !hasLocalFileBinding(job)) return null;
  const params = new URLSearchParams({
    tmdbId: String(identity.tmdbId),
    mediaType: identity.mediaType,
    title: job.label,
    source: "local",
  });
  if (identity.malId) params.set("malId", String(identity.malId));
  if (identity.language) params.set("language", identity.language);
  if (identity.mediaType === "tv") {
    params.set("season", String(identity.season));
    params.set("episode", String(identity.episode));
  }
  return `/watch?${params}`;
}

export const LOCAL_STREAM_PATH = "/api/stream/local";
export function localStreamQuery(params: URLSearchParams): { id: string; rev: string } | null {
  if (
    [...params.keys()].some(
      (key) => !["id", "rev", "sig", "exp"].includes(key) || params.getAll(key).length !== 1,
    )
  )
    return null;
  const id = params.get("id") || "",
    rev = params.get("rev") || "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) &&
    /^[a-f0-9]{64}$/.test(rev)
    ? { id, rev }
    : null;
}
