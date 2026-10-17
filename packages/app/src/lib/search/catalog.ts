import type { MediaItem } from "@/types/media";
import { GENRES } from "@/lib/constants/genres";
import { tmdbApi } from "@/lib/utils/tmdb-api";
import { sortSearchItems, type SearchPage, type SearchParameters } from "./state";

export function genreIdsForSearch(parameters: SearchParameters): number[] {
  return [
    ...new Set(
      parameters.filters.genres.flatMap((slug) =>
        GENRES.filter(
          (genre) =>
            genre.type === parameters.filters.contentType &&
            (genre.slug === slug.toLowerCase() ||
              genre.name.toLowerCase() === slug.toLowerCase() ||
              String(genre.id) === slug),
        ).map((genre) => genre.id),
      ),
    ),
  ];
}

function isLikelyAnime(
  item: MediaItem & { original_language?: string; original_title?: string; original_name?: string },
): boolean {
  if (!item.genre_ids?.includes(16)) return false;
  return (
    item.original_language === "ja" ||
    /\bseason\s*\d+\b.*(?:part|cour)|\b(?:ova|ona|special)\b/i.test(
      `${item.title || item.name || ""} ${item.original_title || item.original_name || ""}`,
    )
  );
}

/** Provider page cursors survive post-filtering; an empty batch is not an exhausted search. */
export async function searchCatalog(
  parameters: SearchParameters,
  startPage: number,
  excludeAnime: boolean,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const { query, filters } = parameters;
  const genreIds = genreIdsForSearch(parameters);
  let page = startPage;
  let nextPage: number | null = null;
  let items: MediaItem[] = [];
  // Bound work per request. If five sparse pages have no matches, return a continuation,
  // rather than falsely displaying a definitive empty result or issuing unbounded calls.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    signal?.throwIfAborted();
    const result = await tmdbApi.getCatalogPage(
      { ...filters, query: query.trim(), genreIds, page },
      signal,
    );
    items = result.items.filter((item: MediaItem) => {
      if (excludeAnime && isLikelyAnime(item)) return false;
      if (genreIds.length && !genreIds.some((id) => (item.genre_ids || []).includes(id)))
        return false;
      if ((item.vote_average ?? item.rating ?? 0) < filters.minRating) return false;
      const minVotes=filters.minVotes ?? (filters.sortBy === "rating" ? 10:0);
      if (minVotes>0 && (!Number.isSafeInteger(item.vote_count) || item.vote_count!<minVotes)) return false;
      const year = Number(
        (item.release_date || item.first_air_date || item.releaseDate || "").slice(0, 4),
      );
      if (!year)
        return filters.yearRange[0] === 1900 && filters.yearRange[1] === new Date().getFullYear();
      return year >= filters.yearRange[0] && year <= filters.yearRange[1];
    });
    nextPage = page < Math.min(result.totalPages, 500) ? page + 1 : null;
    if (items.length || nextPage === null) break;
    if (attempt < 4) page = nextPage;
  }
  return { items: query.trim() ? sortSearchItems(items, filters.sortBy) : items, page, nextPage };
}
