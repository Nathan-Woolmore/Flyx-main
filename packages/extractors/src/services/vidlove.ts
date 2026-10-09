import type { MediaType, StreamSource, SubtitleTrack } from "@flyx/core";

const PLAYER = "https://player.vidlove.cc";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function streamType(value: Record<string, unknown>): StreamSource["type"] | undefined {
  if (value.type === "hls" || value.type === "mp4" || value.type === "dash") return value.type;
  if (typeof value.manifest === "string" && value.manifest.startsWith("#EXTM3U")) return "hls";
  if (!httpUrl(value.url)) return undefined;
  const path = new URL(value.url).pathname;
  if (/\.m3u8$/i.test(path)) return "hls";
  if (/\.mp4$/i.test(path)) return "mp4";
  if (/\.mpd$/i.test(path)) return "dash";
  return undefined;
}

/** VidLove's public JSON endpoint selects an available upstream for each title. */
export async function extractVidLove(
  tmdbId: number,
  mediaType: MediaType,
  season?: number,
  episode?: number,
): Promise<{ sources: StreamSource[]; subtitles: SubtitleTrack[] }> {
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || !["movie", "tv"].includes(mediaType)) {
    throw new Error("VidLove requires a valid TMDB ID and media type");
  }
  const params = new URLSearchParams({ id: String(tmdbId), mode: "json" });
  if (mediaType === "tv") {
    if (
      !Number.isSafeInteger(season) ||
      season! < 0 ||
      !Number.isSafeInteger(episode) ||
      episode! < 1
    ) {
      throw new Error("VidLove requires a season and episode for TV");
    }
    params.set("season", String(season));
    params.set("episode", String(episode));
  }
  const response = await fetch(`https://api.vidlove.cc/${mediaType}?${params}`, {
    headers: { Accept: "application/json", Referer: `${PLAYER}/`, Origin: PLAYER },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`VidLove returned HTTP ${response.status}`);
  const data = record(await response.json());
  const source = record(data.source);
  const variants = Array.isArray(source.qualities) ? source.qualities.map(record) : [];
  const candidates = [...variants, source];
  const sources: StreamSource[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!httpUrl(candidate.url) || seen.has(candidate.url)) continue;
    const type =
      streamType(candidate) ?? streamType(source) ?? variants.map(streamType).find(Boolean);
    // Opaque URLs without format metadata must not be mislabeled as HLS.
    if (!type) continue;
    seen.add(candidate.url);
    const quality = typeof candidate.quality === "string" ? candidate.quality : "Auto";
    sources.push({
      url: candidate.url,
      type,
      quality,
      title: `VidLove • ${typeof source.label === "string" ? source.label : "Server"} • ${quality}`,
      isHevc: candidate.codec === "hevc",
      requiresSegmentProxy: true,
      referer: `${PLAYER}/`,
      origin: PLAYER,
    });
  }
  const subtitles: SubtitleTrack[] = [];
  for (const item of Array.isArray(data.subtitles) ? data.subtitles : []) {
    const sub = record(item);
    const url = sub.file ?? sub.url;
    if (!httpUrl(url)) continue;
    const label = typeof sub.label === "string" ? sub.label : "Subtitle";
    subtitles.push({
      url,
      label,
      language:
        typeof sub.language === "string" ? sub.language : /^english\b/i.test(label) ? "en" : "und",
    });
  }
  return { sources, subtitles };
}
