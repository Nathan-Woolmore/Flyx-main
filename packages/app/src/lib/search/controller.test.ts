import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchController, type SearchFetcher } from "./controller";
import {
  readSearchParameters,
  restoreSearchSnapshot,
  saveSearchSnapshot,
  type SearchPage,
} from "./state";

const parameters = (query = "") => readSearchParameters(new URLSearchParams(query));
const item = (id: number, score = 8) => ({
  id,
  mediaType: "movie" as const,
  title: `Movie ${id}`,
  vote_average: score,
});
const result = (id: number, page = 1, nextPage: number | null = null): SearchPage => ({
  items: [item(id)],
  page,
  nextPage,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Search request coordination", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not discard rating changes made during the genre request", async () => {
    const old = deferred<SearchPage>();
    const fresh = deferred<SearchPage>();
    const fetch = vi
      .fn<SearchFetcher>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const controller = new SearchController(parameters("genre=horror"), fetch);
    controller.activate(parameters("genre=horror"));
    controller.setFilters({ minRating: 6 });
    controller.setFilters({ minRating: 7.5 });
    await vi.advanceTimersByTimeAsync(180);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][2].aborted).toBe(true);
    expect(fetch.mock.calls[1][0].filters).toMatchObject({ genres: ["horror"], minRating: 7.5 });
    old.resolve(result(1)); // Simulate a transport that ignores AbortSignal.
    await flush();
    expect(controller.getSnapshot().loading).toBe(true);
    fresh.resolve(result(2));
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      items: [item(2)],
      loading: false,
      error: null,
    });
  });

  it("ignores an old failure and an old append after the filters change", async () => {
    const initial = deferred<SearchPage>();
    const append = deferred<SearchPage>();
    const newSearch = deferred<SearchPage>();
    const fetch = vi
      .fn<SearchFetcher>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(append.promise)
      .mockReturnValueOnce(newSearch.promise);
    const controller = new SearchController(parameters(), fetch);
    controller.activate(parameters());
    initial.resolve(result(1, 1, 2));
    await flush();
    controller.loadMore();
    controller.setFilters({ genres: ["horror"], minRating: 7 });
    await vi.advanceTimersByTimeAsync(180);
    append.reject(new Error("old failure"));
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, error: null });
    newSearch.resolve(result(3));
    await flush();
    expect(controller.getSnapshot().items.map((entry) => entry.id)).toEqual([3]);
  });

  it("blocks stale successful append responses from a previous filter set", async () => {
    const append = deferred<SearchPage>();
    const fetch = vi
      .fn<SearchFetcher>()
      .mockResolvedValueOnce(result(1, 1, 2))
      .mockReturnValueOnce(append.promise)
      .mockResolvedValueOnce(result(3));
    const controller = new SearchController(parameters(), fetch);
    controller.activate(parameters());
    await flush();
    controller.loadMore();
    controller.setFilters({ minRating: 8 });
    await vi.advanceTimersByTimeAsync(180);
    append.resolve(result(2, 2));
    await flush();
    expect(controller.getSnapshot().items.map((entry) => entry.id)).toEqual([3]);
  });

  it("retains a continuation through an empty filtered batch and stops only at the real end", async () => {
    const fetch = vi
      .fn<SearchFetcher>()
      .mockResolvedValueOnce({ items: [], page: 5, nextPage: 6 })
      .mockResolvedValueOnce(result(6, 6, null));
    const controller = new SearchController(parameters("q=ghost&genre=horror&minRating=8"), fetch);
    controller.activate(parameters("q=ghost&genre=horror&minRating=8"));
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      items: [],
      nextPage: 6,
      loading: false,
      error: null,
    });
    controller.loadMore();
    await flush();
    expect(fetch.mock.calls[1][1]).toBe(6);
    expect(controller.getSnapshot()).toMatchObject({ items: [item(6)], nextPage: null });
    controller.loadMore();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a genuine empty result from a failed request and allows retry", async () => {
    const fetch = vi
      .fn<SearchFetcher>()
      .mockRejectedValueOnce(new Error("Rate limit reached"))
      .mockResolvedValueOnce({ items: [], page: 1, nextPage: null });
    const controller = new SearchController(parameters(), fetch);
    controller.activate(parameters());
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      error: "Rate limit reached",
      resultsHref: null,
      loading: false,
    });
    controller.retry();
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      items: [],
      nextPage: null,
      error: null,
      loading: false,
    });
  });

  it("restores detail-to-Back query, all filters, sorting, list, page cursor and scroll before loading more", async () => {
    const params = parameters(
      "q=ghost&genre=horror,mystery&yearFrom=1980&yearTo=2020&minRating=7&sort=rating",
    );
    const fetch = vi
      .fn<SearchFetcher>()
      .mockResolvedValueOnce({ items: [item(1, 8)], page: 2, nextPage: 3 })
      .mockResolvedValueOnce({ items: [item(2, 9)], page: 3, nextPage: 4 });
    const first = new SearchController(params, fetch);
    first.activate(params);
    await flush();
    first.loadMore();
    await flush();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    saveSearchSnapshot(storage, first.capture(847)!);
    first.cancel();
    const restored = restoreSearchSnapshot(storage, params)!;
    const nextFetch = vi
      .fn<SearchFetcher>()
      .mockResolvedValue({ items: [item(2, 9), item(3, 7.5)], page: 4, nextPage: null });
    const back = new SearchController(params, nextFetch);
    back.activate(params, restored);
    expect(nextFetch).not.toHaveBeenCalled();
    expect(back.getSnapshot()).toMatchObject({ ...params, page: 3, nextPage: 4, loading: false });
    expect(back.getSnapshot().items.map((entry) => entry.id)).toEqual([2, 1]);
    expect(back.capture(847)?.scrollY).toBe(847);
    back.loadMore();
    await flush();
    expect(nextFetch.mock.calls[0][1]).toBe(4);
    expect(back.getSnapshot().items.map((entry) => entry.id)).toEqual([2, 1, 3]);
  });

  it("does not attach a stale cursor when filters change away and back before either request completes", async () => {
    const fetch = vi.fn<SearchFetcher>().mockResolvedValue(result(1, 3, 4));
    const controller = new SearchController(parameters("genre=horror"), fetch);
    controller.activate(parameters("genre=horror"));
    await flush();
    controller.setFilters({ minRating: 7 });
    controller.setFilters({ minRating: 0 });
    expect(controller.capture(100)).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ nextPage: 1, page: 0, resultsHref: null });
    controller.cancel();
  });

  it("never snapshots an old list under newly selected filters", async () => {
    const fetch = vi.fn<SearchFetcher>().mockResolvedValue(result(1));
    const controller = new SearchController(parameters(), fetch);
    controller.activate(parameters());
    await flush();
    controller.setFilters({ genres: ["horror"] });
    expect(controller.capture(100)).toBeNull();
    controller.cancel();
  });
});
