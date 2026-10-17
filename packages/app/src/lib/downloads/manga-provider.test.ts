import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMangaCollectionDetails, getChapterPagesById } from "@flyx/extractors/services";
const series = "00000000000000000000000001",
  chapter = "00000000000000000000000002";
const fetcher = vi.fn();
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());
it("resolves exactly one series and chapter list, exposing source editions", async () => {
  fetcher.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/search/data")
      return new Response(`<a href="https://weebcentral.com/series/${series}/fixture">Fixture</a>`);
    if (url.pathname === `/series/${series}/fixture`)
      return new Response("<title>Fixture | WeebCentral</title><div>full-chapter-list</div>");
    if (url.pathname === `/series/${series}/full-chapter-list`)
      return new Response(
        `<div class="flex items-center" x-data="{ new_chapter: checkNewChapter('2026-01-01') }"><a href="/chapters/${chapter}"><span class="">Chapter 0.5</span><span class="chapter-badge-official"></span></a></div><div class="flex items-center" x-data="{ new_chapter: checkNewChapter('2026-01-02') }"><a href="/chapters/${series}"><span class="">Chapter 1</span></a></div>`,
      );
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
  const data = await getMangaCollectionDetails("fixture");
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(data.chapters.map((c) => [c.id, c.number, c.language, c.edition])).toEqual([
    [chapter, 0.5, "en", "official"],
    [series, 1, "en", "community"],
  ]);
});
it("never falls back to the first search result for another series", async () => {
  fetcher.mockResolvedValue(
    new Response(`<a href="https://weebcentral.com/series/${series}/other">Other</a>`),
  );
  await expect(getMangaCollectionDetails("fixture")).rejects.toThrow(/exact manga/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("fetches pages directly by exact ID and preserves DOM ordering, without a series search", async () => {
  fetcher.mockResolvedValue(
    new Response(
      `<img src="https://fixture.example/010.png"><img alt="Page" src='https://fixture.example/002.jpg?x=1&amp;y=2'>`,
    ),
  );
  expect(await getChapterPagesById(chapter)).toEqual([
    { pageNumber: 1, imageUrl: "https://fixture.example/010.png" },
    { pageNumber: 2, imageUrl: "https://fixture.example/002.jpg?x=1&y=2" },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toContain(`/chapters/${chapter}/images?`);
});
it("rejects malformed or missing page sources instead of silently publishing a shorter chapter", async () => {
  fetcher.mockResolvedValue(
    new Response(
      '<img src="https://fixture.example/1.png"><img data-src="https://fixture.example/missing.png">',
    ),
  );
  await expect(getChapterPagesById(chapter)).rejects.toThrow(/incomplete page list/);
  await expect(getChapterPagesById("../../outside")).rejects.toThrow(/Invalid chapter/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("propagates cancellation through the exact page request", async () => {
  const controller = new AbortController();
  fetcher.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("cancelled"))),
      ),
  );
  const operation = getChapterPagesById(chapter, controller.signal);
  controller.abort();
  await expect(operation).rejects.toThrow(/cancelled/);
});

it("bounds metadata response size before parsing", async () => {
  fetcher.mockResolvedValue(
    new Response("oversized metadata", { headers: { "content-length": String(33 * 1024 * 1024) } }),
  );
  await expect(getChapterPagesById(chapter)).rejects.toThrow(/size limit/);
});
