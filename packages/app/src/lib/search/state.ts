import type { MediaItem } from "@/types/media";

export interface SearchFilters {
  contentType: "movie" | "tv" | "anime";
  genres: string[];
  yearRange: [number, number];
  minRating: number;
  minVotes?: number;
  sortBy: "relevance" | "rating" | "release_date" | "popularity";
}

export interface SearchParameters {
  query: string;
  filters: SearchFilters;
}

export interface SearchPage {
  items: MediaItem[];
  page: number;
  nextPage: number | null;
}

export interface SearchSnapshot extends SearchPage, SearchParameters {
  version: 1;
  href: string;
  scrollY: number;
}

const CACHE_KEY = "flyx_search_snapshots_v1";

export function readSearchParameters(params: URLSearchParams): SearchParameters {
  const year = new Date().getFullYear();
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key);
    const value = raw === null || raw === "" ? fallback : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const from = Math.trunc(number("yearFrom", 1900, 1900, year));
  const to = Math.trunc(number("yearTo", year, from, year));
  const type = params.get("type");
  const sort = params.get("sort");
  return {
    query: params.get("q") ?? params.get("query") ?? "",
    filters: {
      contentType: type === "tv" || type === "anime" ? type : "movie",
      genres: [
        ...new Set(
          params
            .getAll("genre")
            .flatMap((value) => value.split(","))
            .filter(Boolean),
        ),
      ],
      yearRange: [from, to],
      minRating: number("minRating", 0, 0, 10),
      minVotes: Math.trunc(number("minVotes", sort === "rating" ? 10:0, 0, 1000000)),
      sortBy:
        sort === "rating" || sort === "release_date" || sort === "popularity" ? sort : "relevance",
    },
  };
}

export function searchParams({ query, filters }: SearchParameters): URLSearchParams {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("type", filters.contentType);
  if (filters.genres.length) params.set("genre", filters.genres.join(","));
  if (filters.yearRange[0] !== 1900) params.set("yearFrom", String(filters.yearRange[0]));
  if (filters.yearRange[1] !== new Date().getFullYear())
    params.set("yearTo", String(filters.yearRange[1]));
  if (filters.minRating) params.set("minRating", String(filters.minRating));
  const minimumVotes=filters.minVotes ?? (filters.sortBy === "rating" ? 10:0);
  if (minimumVotes>0 || filters.sortBy === "rating") params.set("minVotes", String(minimumVotes));
  if (filters.sortBy !== "relevance") params.set("sort", filters.sortBy);
  return params;
}

export function searchHref(parameters: SearchParameters): string {
  return `/search?${searchParams(parameters)}`;
}

export function sortSearchItems(items: MediaItem[], sort: SearchFilters["sortBy"]): MediaItem[] {
  const date = (item: MediaItem) =>
    Date.parse(item.release_date || item.first_air_date || item.releaseDate || "") || 0;
  const score = (item: MediaItem) => item.vote_average ?? item.rating ?? 0;
  if (sort === "rating") return [...items].sort((a, b) => score(b) - score(a));
  if (sort === "release_date") return [...items].sort((a, b) => date(b) - date(a));
  if (sort === "popularity")
    return [...items].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return items;
}

function readCache(storage: Pick<Storage, "getItem">): SearchSnapshot[] {
  try {
    const value = JSON.parse(storage.getItem(CACHE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((entry) => entry?.version === 1) : [];
  } catch {
    return [];
  }
}

export function restoreSearchSnapshot(
  storage: Pick<Storage, "getItem">,
  parameters: SearchParameters,
): SearchSnapshot | null {
  const href = searchHref(parameters);
  const entry = readCache(storage).find((snapshot) => snapshot.href === href);
  if (
    !entry ||
    !Array.isArray(entry.items) ||
    !Number.isInteger(entry.page) ||
    entry.page < 1 ||
    !(
      entry.nextPage === null ||
      (Number.isInteger(entry.nextPage) && entry.nextPage > entry.page)
    ) ||
    !Number.isFinite(entry.scrollY) ||
    entry.scrollY < 0
  )
    return null;
  try {
    if (searchHref(entry) !== href) return null;
    // URL parameters remain authoritative; a different search never adopts a stale snapshot.
    return { ...entry, ...parameters };
  } catch {
    return null;
  }
}

export function saveSearchSnapshot(
  storage: Pick<Storage, "getItem" | "setItem">,
  snapshot: SearchSnapshot,
): void {
  const entries = [
    snapshot,
    ...readCache(storage).filter((entry) => entry.href !== snapshot.href),
  ].slice(0, 4);
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch {
    try {
      storage.setItem(CACHE_KEY, JSON.stringify([snapshot]));
    } catch {
      /* URL still restores filters if storage is unavailable. */
    }
  }
}
