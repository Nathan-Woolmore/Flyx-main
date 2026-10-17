import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { searchCatalog } from "./catalog";
import { readSearchParameters } from "./state";
import { GET } from "@/app/api/content/search/route";

vi.mock("@/lib/utils/api-rate-limiter", () => ({
  getClientIP: () => "test",
  searchRateLimiter: { checkLimit: () => ({ allowed: true, remaining: 29, resetAt: 1 }) },
}));

const movie = (id: number, score = 8, genres = [27]) => ({
  id,
  title: `Horror ${id}`,
  vote_average: score,
  vote_count:100,
  release_date: "2010-01-01",
  genre_ids: genres,
});
const page = (results: unknown[], total_pages = 1) =>
  new Response(JSON.stringify({ results, total_pages }), {
    headers: { "Content-Type": "application/json" },
  });
const params = (query = "") => readSearchParameters(new URLSearchParams(query));

describe("Search catalog filtering and pagination", () => {
  beforeEach(() => vi.stubEnv("TMDB_API_KEY", "test-only-key"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends combined Horror, minimum rating, years and highest-rated sort to discovery", async () => {
    const fetch = vi.fn().mockResolvedValue(page([movie(1, 8.5)], 10));
    vi.stubGlobal("fetch", fetch);
    const result = await searchCatalog(
      params("genre=horror&yearFrom=1980&yearTo=2020&minRating=7.5&sort=rating"),
      1,
      true,
    );
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/3/discover/movie");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      with_genres: "27",
      "vote_average.gte": "7.5",
      "vote_count.gte":"10",
      "primary_release_date.gte": "1980-01-01",
      "primary_release_date.lte": "2020-12-31",
      sort_by: "vote_average.desc",
    });
    expect(result).toMatchObject({ page: 1, nextPage: 2, items: [{ id: 1 }] });
  });

  it("uses the correct TV genres, first-air dates and date sorting", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(page([{ ...movie(1, 8, [9648]), first_air_date: "2010-01-01" }]));
    vi.stubGlobal("fetch", fetch);
    await searchCatalog(params("type=tv&genre=mystery&sort=release_date&yearFrom=2000"), 1, false);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/3/discover/tv");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      with_genres: "9648",
      "first_air_date.gte": "2000-01-01",
      sort_by: "first_air_date.desc",
    });
  });

  it("applies all selected genres using the existing any-genre behavior", async () => {
    const fetch = vi.fn().mockResolvedValue(page([movie(1, 8, [9648])]));
    vi.stubGlobal("fetch", fetch);
    const result = await searchCatalog(params("genre=horror,mystery&minRating=7"), 1, true);
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("with_genres")).toBe("27|9648");
    expect(result.items).toHaveLength(1);
  });

  it("continues past a fully filtered title-search page to later matches", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page([movie(1, 4)], 2))
      .mockResolvedValueOnce(page([movie(2, 8)], 2));
    vi.stubGlobal("fetch", fetch);
    const result = await searchCatalog(params("q=ghost&genre=horror&minRating=7"), 1, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe("/3/search/movie");
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("page")).toBe("2");
    expect(result).toMatchObject({ items: [{ id: 2 }], page: 2, nextPage: null });
  });

  it("returns a continuation after a bounded sparse scan, with no skipped page", async () => {
    const fetch = vi.fn().mockImplementation(async () => page([movie(1, 4)], 20));
    vi.stubGlobal("fetch", fetch);
    expect(await searchCatalog(params("q=ghost&genre=horror&minRating=9"), 1, true)).toEqual({
      items: [],
      page: 5,
      nextPage: 6,
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("marks a genuinely exhausted filtered search empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(page([], 0)));
    expect(await searchCatalog(params("genre=horror&minRating=10"), 1, true)).toEqual({
      items: [],
      page: 1,
      nextPage: null,
    });
  });

  it("stops cancelled scans before making another provider request", async () => {
    const abort = new AbortController();
    const fetch = vi.fn().mockImplementation(async () => {
      abort.abort();
      return page([movie(1, 4)], 5);
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      searchCatalog(params("q=ghost&minRating=9"), 1, true, abort.signal),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the cursor contract through the actual API route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(page([movie(1)], 3)));
    const response = await GET(
      new NextRequest(
        "https://flyx.test/api/content/search?type=movie&genre=horror&minRating=7&sort=rating",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ id: 1 }],
      page: 1,
      nextPage: 2,
      hasMore: true,
    });
  });

  it("rejects invalid pages without calling the catalog", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await GET(new NextRequest("https://flyx.test/api/content/search?page=NaN"));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('minimum actual rating votes',()=>{
 beforeEach(()=>vi.stubEnv('TMDB_API_KEY','test-only-key'));
 afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
 it('sends minimum10 to discover on page2 and never leaks a one-vote10score fallback',async()=>{const fetch=vi.fn().mockResolvedValue(page([{...movie(1,10),vote_count:1},{...movie(2,9.9),vote_count:9},{...movie(3,9),vote_count:10}],4));vi.stubGlobal('fetch',fetch);const result=await searchCatalog(params('sort=rating&genre=horror&minRating=8'),2,false);expect(result.items.map(v=>v.id)).toEqual([3]);expect(result.nextPage).toBe(3);const url=new URL(fetch.mock.calls[0][0]);expect(url.searchParams.get('vote_count.gte')).toBe('10');expect(url.searchParams.get('page')).toBe('2');});
 it('continues title search through unqualified provider pages and combines minimum votes/score/genre/year',async()=>{const fetch=vi.fn().mockResolvedValueOnce(page([{...movie(1,10),vote_count:1}],2)).mockResolvedValueOnce(page([{...movie(2,9),vote_count:10}],2));vi.stubGlobal('fetch',fetch);const result=await searchCatalog(params('q=ghost&genre=horror&yearFrom=2000&yearTo=2020&minRating=8&minVotes=10'),1,false);expect(result.items.map(v=>v.id)).toEqual([2]);expect(fetch).toHaveBeenCalledTimes(2);expect(result.page).toBe(2);expect(result.nextPage).toBeNull();});
});
