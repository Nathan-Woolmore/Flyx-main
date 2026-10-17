import { describe, expect, it } from "vitest";
import {
  readSearchParameters,
  restoreSearchSnapshot,
  saveSearchSnapshot,
  searchHref,
  type SearchSnapshot,
} from "./state";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("Search URL and return-state persistence", () => {
  it("round-trips a query, multiple genres, years, minimum rating and sorting", () => {
    const parameters = readSearchParameters(
      new URLSearchParams(
        "q=ghost+%26+house&type=movie&genre=horror,mystery&yearFrom=1980&yearTo=2020&minRating=7.5&sort=rating",
      ),
    );
    expect(
      readSearchParameters(new URL(searchHref(parameters), "https://flyx.test").searchParams),
    ).toEqual(parameters);
    expect(parameters.filters).toMatchObject({
      genres: ["horror", "mystery"],
      yearRange: [1980, 2020],
      minRating: 7.5,
      sortBy: "rating",
    });
  });

  it("normalizes malformed numeric URL parameters", () => {
    const { filters } = readSearchParameters(
      new URLSearchParams("type=bogus&yearFrom=invalid&yearTo=1700&minRating=100&sort=bogus"),
    );
    expect(filters).toMatchObject({
      contentType: "movie",
      yearRange: [1900, 1900],
      minRating: 10,
      sortBy: "relevance",
    });
  });

  it("restores exact list order, provider cursor and zero scroll for the matching URL only", () => {
    const parameters = readSearchParameters(
      new URLSearchParams("q=ghost&genre=horror&minRating=7&sort=rating"),
    );
    const snapshot: SearchSnapshot = {
      ...parameters,
      version: 1,
      href: searchHref(parameters),
      items: [
        { id: 2, title: "Second", mediaType: "movie" },
        { id: 1, title: "First", mediaType: "movie" },
      ],
      page: 5,
      nextPage: 6,
      scrollY: 0,
    };
    const session = storage();
    saveSearchSnapshot(session, snapshot);
    expect(restoreSearchSnapshot(session, parameters)).toEqual(snapshot);
    expect(
      restoreSearchSnapshot(session, readSearchParameters(new URLSearchParams("q=other"))),
    ).toBeNull();
  });

  it("ignores malformed snapshots and tolerates unavailable storage", () => {
    const parameters = readSearchParameters(new URLSearchParams());
    expect(restoreSearchSnapshot({ getItem: () => "{broken" }, parameters)).toBeNull();
    expect(
      restoreSearchSnapshot(
        {
          getItem: () => {
            throw new Error("denied");
          },
        },
        parameters,
      ),
    ).toBeNull();
    const bad = {
      ...parameters,
      version: 1,
      href: searchHref(parameters),
      items: [],
      page: 5,
      nextPage: 5,
      scrollY: 0,
    };
    expect(restoreSearchSnapshot({ getItem: () => JSON.stringify([bad]) }, parameters)).toBeNull();
  });
});
