import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

afterEach(() => vi.unstubAllGlobals());
const media = {
  id: 101,
  idMal: 1,
  title: { romaji: "Ghost School" },
  averageScore: 80,
  popularity: 4000,
  startDate: { year: 2010, month: 4, day: 12 },
  coverImage: {},
};

describe("Anime proxy search fallback", () => {
  it("returns fallback results for a blank Anime search when Jikan is unavailable", async () => {
    vi.resetModules();
    const fetch = vi
      .fn()
      .mockImplementation(async (url: string) =>
        String(url).includes("api.jikan.moe")
          ? new Response("{}", { status: 503 })
          : new Response(
              JSON.stringify({
                data: { Page: { media: [media], pageInfo: { currentPage: 2, hasNextPage: true } } },
              }),
            ),
      );
    vi.stubGlobal("fetch", fetch);
    const { GET } = await import("@/app/api/anime/jikan/route");
    const response = await GET(
      new NextRequest(
        "http://flyx.test/api/anime/jikan?path=/anime&page=2&order_by=members&sfw=true",
      ),
    );
    expect(response.headers.get("X-Flyx-Cache")).toBe("ANILIST");
    expect(await response.json()).toMatchObject({
      data: [{ mal_id: 1, score: 8 }],
      pagination: { has_next_page: true, current_page: 2 },
    });
  });

  it("keeps combined criteria in the fallback request and caches each rating separately", async () => {
    vi.resetModules();
    const fetch = vi
      .fn()
      .mockImplementation(async (url: string) =>
        String(url).includes("api.jikan.moe")
          ? new Response("{}", { status: 503 })
          : new Response(
              JSON.stringify({
                data: {
                  Page: { media: [media], pageInfo: { currentPage: 1, hasNextPage: false } },
                },
              }),
            ),
      );
    vi.stubGlobal("fetch", fetch);
    const { GET } = await import("@/app/api/anime/jikan/route");
    const request = (score: number) =>
      new NextRequest(
        `http://flyx.test/api/anime/jikan?path=/anime&q=ghost&genres=14,7&min_score=${score}&start_date=2000-01-01&end_date=2020-12-31&order_by=score&sort=desc`,
      );
    await GET(request(7));
    await GET(request(8));
    const variables = fetch.mock.calls
      .filter(([url]) => String(url).includes("graphql.anilist.co"))
      .map(([, options]) => JSON.parse(options.body).variables);
    expect(variables.map((value) => value.minScore)).toEqual([69, 79]);
    expect(variables[0]).toMatchObject({
      search: "ghost",
      genres: ["Horror", "Mystery"],
      startAfter: 19991231,
      startBefore: 20210101,
      sort: ["SCORE_DESC"],
    });
    const calls = fetch.mock.calls.length;
    expect((await GET(request(8))).headers.get("X-Flyx-Cache")).toBe("HIT");
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});
