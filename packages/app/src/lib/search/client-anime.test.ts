import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSearchPage } from "./client";
import { readSearchParameters } from "./state";

beforeEach(() => vi.stubGlobal("window", { location: { origin: "http://flyx.test" } }));
afterEach(() => vi.unstubAllGlobals());
const parameters = (query = "") => readSearchParameters(new URLSearchParams("type=anime&" + query));
const anime = {
  mal_id: 123,
  title: "Ghost School",
  score: 7.5,
  year: null,
  aired: { from: "2010-04-12T00:00:00+00:00" },
  members: 1200,
  type: "OVA",
  images: {},
};
function response(data: unknown[] = [anime], has_next_page = true) {
  return new Response(JSON.stringify({ data, pagination: { has_next_page } }));
}

describe("Anime search client", () => {
  it("sends combined Jikan filters in its 0–10 score scale and normalizes real airing dates", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const result = await fetchSearchPage(
      parameters(
        "q=ghost&genre=horror,mystery&minRating=7.5&yearFrom=2000&yearTo=2020&sort=rating",
      ),
      2,
      signal,
    );
    const url = fetch.mock.calls[0][0] as URL;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      path: "/anime",
      q: "ghost",
      genres: "14,7",
      min_score: "7.5",
      start_date: "2000-01-01",
      end_date: "2020-12-31",
      order_by: "score",
      sort: "desc",
      page: "2",
    });
    expect(fetch.mock.calls[0][1].signal).toBe(signal);
    expect(result).toMatchObject({
      items: [
        {
          id: "123",
          mediaType: "anime",
          vote_average: 7.5,
          popularity: 1200,
          first_air_date: anime.aired.from,
        },
      ],
      page: 2,
      nextPage: 3,
    });
  });

  it("leaves provider relevance intact for a title query", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    await fetchSearchPage(parameters("q=ghost"), 1, new AbortController().signal);
    const url = fetch.mock.calls[0][0] as URL;
    expect(url.searchParams.has("order_by")).toBe(false);
    expect(url.searchParams.has("sort")).toBe(false);
  });

  it("retains a continuation on an empty page, and stops on a genuine final empty page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([], true)));
    expect(await fetchSearchPage(parameters(), 1, new AbortController().signal)).toEqual({
      items: [],
      page: 1,
      nextPage: 2,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([], false)));
    expect(await fetchSearchPage(parameters(), 2, new AbortController().signal)).toEqual({
      items: [],
      page: 2,
      nextPage: null,
    });
  });

  it("reports a soft upstream failure as retryable instead of No results found", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: [], error: "Upstream unavailable", source: "empty" }),
          ),
        ),
    );
    await expect(fetchSearchPage(parameters(), 1, new AbortController().signal)).rejects.toThrow(
      "temporarily unavailable",
    );
  });

  it("rejects malformed pagination rather than silently ending results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }))));
    await expect(fetchSearchPage(parameters(), 1, new AbortController().signal)).rejects.toThrow(
      "invalid response",
    );
  });
});
