import { afterEach, describe, expect, it, vi } from "vitest";
import { anilistFromJikanPath } from "./anilist-server";

const media = {
  id: 101,
  idMal: 1,
  title: { romaji: "Ghost School" },
  averageScore: 75,
  popularity: 4000,
  seasonYear: null,
  startDate: { year: 2010, month: 4, day: 12 },
  genres: ["Horror", "Mystery"],
  format: "TV",
  coverImage: {},
};
function provider(items: unknown[] = [media], hasNextPage = true, page = 2) {
  return new Response(
    JSON.stringify({
      data: { Page: { media: items, pageInfo: { hasNextPage, currentPage: page, lastPage: 4 } } },
    }),
  );
}
function setup(items: unknown[] = [media], more = true, page = 2) {
  const fetch = vi.fn().mockImplementation(async () => provider(items, more, page));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe("AniList fallback preserves Anime search criteria", () => {
  it("supports blank browsing, the requested page and real pagination metadata", async () => {
    const fetch = setup();
    const result = await anilistFromJikanPath(
      "/anime?sfw=true&page=2&limit=24&order_by=members&sort=desc",
    );
    expect(result).toMatchObject({
      data: [{ mal_id: 1, score: 7.5, year: 2010, members: 4000, aired: { from: "2010-04-12" } }],
      pagination: { current_page: 2, has_next_page: true },
    });
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.variables).toMatchObject({
      page: 2,
      perPage: 24,
      sort: ["POPULARITY_DESC"],
      isAdult: false,
    });
    expect(payload.query).toContain("pageInfo { hasNextPage currentPage lastPage }");
  });

  it("combines text, every genre, inclusive 0–10 rating and date bounds, and explicit sorting", async () => {
    const fetch = setup();
    await anilistFromJikanPath(
      "/anime?q=ghost&genres=14,7&min_score=7.5&start_date=2000-01-01&end_date=2020-12-31&order_by=score&sort=desc&page=2&limit=24",
    );
    const { variables, query } = JSON.parse(fetch.mock.calls[0][1].body);
    expect(variables).toMatchObject({
      search: "ghost",
      genres: ["Horror", "Mystery"],
      minScore: 74,
      startAfter: 19991231,
      startBefore: 20210101,
      sort: ["SCORE_DESC"],
      page: 2,
    });
    expect(query).toContain("averageScore_greater: $minScore");
    expect(query).toContain("genre_in: $genres");
  });

  it.each([
    ["score", "desc", "SCORE_DESC"],
    ["score", "asc", "SCORE"],
    ["start_date", "desc", "START_DATE_DESC"],
    ["members", "desc", "POPULARITY_DESC"],
    ["members", "asc", "POPULARITY"],
    // Jikan popularity is a rank; AniList popularity is a member count.
    ["popularity", "asc", "POPULARITY_DESC"],
    ["popularity", "desc", "POPULARITY"],
  ])("honors %s %s even with a title query", async (order, direction, expected) => {
    const fetch = setup();
    await anilistFromJikanPath(`/anime?q=ghost&order_by=${order}&sort=${direction}`);
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables.sort).toEqual([expected]);
  });

  it("keeps most-popular ordering, filters and page cursor across fallback pages", async () => {
    const fetch = setup();
    for (const page of [1,2]) {
      await anilistFromJikanPath(`/anime?genres=1&min_score=6&start_date=2000-01-01&order_by=popularity&sort=asc&page=${page}&limit=20`);
    }
    const variables=fetch.mock.calls.map(call=>JSON.parse(call[1].body).variables);
    expect(variables.map(value=>value.page)).toEqual([1,2]);
    for(const value of variables)expect(value).toMatchObject({sort:["POPULARITY_DESC"],genres:["Action"],minScore:59,startAfter:19991231,perPage:20});
  });

  it("uses title relevance only when no explicit sort is requested", async () => {
    const fetch = setup();
    await anilistFromJikanPath("/anime?q=ghost");
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables.sort).toEqual([
      "SEARCH_MATCH",
      "POPULARITY_DESC",
    ]);
  });

  it("keeps the final page genuinely empty and distinguishes provider failure", async () => {
    setup([], false, 1);
    expect(await anilistFromJikanPath("/anime?min_score=10")).toMatchObject({
      data: [],
      pagination: { has_next_page: false },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    expect(await anilistFromJikanPath("/anime?min_score=10")).toBeNull();
  });

  it("rejects missing fallback pagination instead of inventing an end to results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { Page: { media: [] } } }))),
    );
    expect(await anilistFromJikanPath("/anime?page=2")).toBeNull();
  });

  it("maps Suspense to the AniList Thriller genre and retains requested top-list pages", async () => {
    const fetch = setup();
    await anilistFromJikanPath("/anime?genres=41");
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables.genres).toEqual(["Thriller"]);
    await anilistFromJikanPath("/top/anime?page=3&filter=bypopularity");
    expect(JSON.parse(fetch.mock.calls[1][1].body).variables.page).toBe(3);
  });
});
