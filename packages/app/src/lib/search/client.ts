import type { MediaItem } from "@/types/media";
import { searchParams, type SearchPage, type SearchParameters } from "./state";

const MAL_GENRE_IDS: Record<string, number> = {
  action: 1,
  adventure: 2,
  comedy: 4,
  drama: 8,
  fantasy: 10,
  horror: 14,
  mystery: 7,
  romance: 22,
  "sci-fi": 24,
  "slice-of-life": 36,
  sports: 30,
  supernatural: 37,
  suspense: 41,
};

export async function fetchSearchPage(
  parameters: SearchParameters,
  page: number,
  signal: AbortSignal,
): Promise<SearchPage> {
  const { query, filters } = parameters;
  let url: URL;
  if (filters.contentType === "anime") {
    url = new URL("/api/anime/jikan", window.location.origin);
    url.search = new URLSearchParams({
      path: "/anime",
      sfw: "true",
      sort: "desc",
      page: String(page),
      limit: "24",
      order_by:
        filters.sortBy === "rating"
          ? "score"
          : filters.sortBy === "release_date"
            ? "start_date"
            : "members",
    }).toString();
    if (query.trim()) url.searchParams.set("q", query.trim());
    if (query.trim() && filters.sortBy === "relevance") {
      url.searchParams.delete("order_by");
      url.searchParams.delete("sort");
    }
    const genres = filters.genres.map((slug) => MAL_GENRE_IDS[slug]).filter(Boolean);
    if (genres.length) url.searchParams.set("genres", genres.join(","));
    url.searchParams.set("start_date", `${filters.yearRange[0]}-01-01`);
    url.searchParams.set("end_date", `${filters.yearRange[1]}-12-31`);
    if (filters.minRating) url.searchParams.set("min_score", String(filters.minRating));
  } else {
    url = new URL("/api/content/search", window.location.origin);
    url.search = searchParams(parameters).toString();
    url.searchParams.set("query", query.trim());
    url.searchParams.delete("q");
    url.searchParams.set("page", String(page));
    url.searchParams.set("excludeAnime", "true");
  }
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Search failed. Please try again.");
  if (filters.contentType === "anime" && (data.error || data.source === "empty")) {
    throw new Error("Anime catalog is temporarily unavailable. Please try again.");
  }
  if (filters.contentType !== "anime") {
    if (
      !Array.isArray(data.data) ||
      !Number.isInteger(data.page) ||
      data.page < page ||
      !(data.nextPage === null || (Number.isInteger(data.nextPage) && data.nextPage > data.page))
    )
      throw new Error("Search returned an invalid response. Please try again.");
    return { items: data.data, page: data.page, nextPage: data.nextPage };
  }
  if (!Array.isArray(data.data) || typeof data.pagination?.has_next_page !== "boolean") {
    throw new Error("Anime search returned an invalid response. Please try again.");
  }
  const items: MediaItem[] = data.data.map((anime: any) => ({
    id: String(anime.mal_id),
    title: anime.title_english || anime.title,
    name: anime.title,
    posterPath: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "",
    releaseDate: anime.aired?.from || (anime.year ? `${anime.year}-01-01` : ""),
    first_air_date: anime.aired?.from || (anime.year ? `${anime.year}-01-01` : ""),
    popularity: anime.members || 0,
    vote_average: anime.score || 0,
    rating: anime.score || 0,
    mediaType: "anime" as any,
    mal_id: anime.mal_id,
    anime_type: anime.type,
    episodes: anime.episodes ?? undefined,
  }));
  return { items, page, nextPage: data.pagination?.has_next_page ? page + 1 : null };
}
