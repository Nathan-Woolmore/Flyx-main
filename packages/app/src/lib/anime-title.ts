// Simple in-memory title cache (TTL ~10 min, resets on restart)
const titleCache = new Map<number, { title: string; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function resolveAnimeTitle(malId: number): Promise<string | null> {
  // Check cache
  const cached = titleCache.get(malId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.title;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(
      `https://api.jikan.moe/v4/anime/${malId}`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[ANIME-STREAM] Jikan title resolution HTTP ${res.status} for MAL ${malId}`);
      return null;
    }

    const data = await res.json();
    const title = data?.data?.title_english || data?.data?.title || null;

    if (title) {
      titleCache.set(malId, { title, ts: Date.now() });
      console.log(`[ANIME-STREAM] Jikan resolved MAL ${malId} → "${title}"`);
    }

    return title;
  } catch (err) {
    console.warn(`[ANIME-STREAM] Jikan title resolution failed for MAL ${malId}: ${(err as Error).message || 'timeout/network'}`);
    return null;
  }
}
