export type StartupQualityPreference = "highest" | "fast-start";

export function normalizeStartupQualityPreference(value: unknown): StartupQualityPreference {
  return value === "fast-start" ? "fast-start" : "highest";
}

interface QualitySource { url: string; quality?: string; type?: string }

/** Advertised resolution, not a claim that a remote file is playable. */
export function qualityRank(label?: string): number {
  const text = (label || "").trim().toLowerCase();
  if (/\b8k\b/.test(text)) return 4320;
  if (/\b4k\b/.test(text)) return 2160;
  const dimensions = text.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (dimensions) return Number(dimensions[2]);
  const resolution = text.match(/\b(\d{3,4})(?:p\b|\b)/);
  return resolution ? Number(resolution[1]) : 0;
}

/** Keep automatic recovery from cycling through the same failed media URL. */
export function untriedSources<T extends QualitySource>(
  sources: readonly T[], failed: ReadonlySet<string>,
): T[] {
  const seen = new Set(failed);
  return sources.filter((source) => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

export function highestQualitySource<T extends QualitySource>(
  sources: readonly T[], failed: ReadonlySet<string> = new Set(),
): T | null {
  return untriedSources(sources, failed).sort((a, b) => {
    const resolution = qualityRank(b.quality) - qualityRank(a.quality);
    if (resolution) return resolution;
    // On a known-resolution tie, retain the existing preference for MP4.
    // Without a resolution, prefer an adaptive playlist over an unknown file.
    const preferredType = qualityRank(a.quality) ? "mp4" : "hls";
    return Number(b.type === preferredType) - Number(a.type === preferredType);
  })[0] ?? null;
}

/** HLS manifest order can follow bitrate rather than resolution. */
export function highestHlsStartLevel(
  levels: readonly { height?: number; width?: number; bitrate?: number }[],
): number {
  if (!levels.length) return -1;
  return levels.reduce((best, level, index) => {
    const previous = levels[best]!;
    for (const key of ["height", "width", "bitrate"] as const) {
      const difference = (level[key] || 0) - (previous[key] || 0);
      if (difference) return difference > 0 ? index : best;
    }
    return best;
  }, 0);
}


/** Prefer a quicker source only when the viewer requests faster startup. */
export function fastStartRank(source: QualitySource): number {
  const resolution = qualityRank(source.quality);
  if (source.type === "hls" || source.url.includes(".m3u8")) {
    return 2000 + (resolution > 0 ? Math.min(resolution, 100) : 50);
  }
  if (source.type === "mp4" || /\.mp4(\?|$)/i.test(source.url)) {
    let tier = 200;
    if (resolution === 720) tier = 300;
    else if (resolution === 480) tier = 280;
    else if (resolution === 360 || resolution === 540) tier = 260;
    else if (resolution > 0 && resolution < 720) tier = 240;
    else if (resolution === 1080) tier = 120;
    else if (resolution > 1080) tier = 80;
    return 1000 + tier;
  }
  return resolution;
}

export function orderedStartupSources<T extends QualitySource>(
  sources: readonly T[], preference: StartupQualityPreference,
  failed: ReadonlySet<string> = new Set(),
): T[] {
  const available = untriedSources(sources, failed);
  if (preference === "fast-start") return available.sort((a, b) => fastStartRank(b) - fastStartRank(a));
  // Stable extraction order on ties; use the same numeric ranking as the
  // highest-quality picker, never string ordering of resolution labels.
  return available.sort((a, b) => {
    const resolution = qualityRank(b.quality) - qualityRank(a.quality);
    if (resolution) return resolution;
    const preferredType = qualityRank(a.quality) ? "mp4" : "hls";
    return Number(b.type === preferredType) - Number(a.type === preferredType);
  });
}

export function chooseStartupSource<T extends QualitySource>(
  sources: readonly T[], preference: StartupQualityPreference,
  failed: ReadonlySet<string> = new Set(),
): T | null {
  return orderedStartupSources(sources, preference, failed)[0] ?? null;
}

export function hlsStartupLevel(
  levels: Parameters<typeof highestHlsStartLevel>[0],
  preference: StartupQualityPreference,
  explicitSource = false,
): number {
  if (!levels.length) return -1;
  return preference === "fast-start" && !explicitSource ? 0 : highestHlsStartLevel(levels);
}
