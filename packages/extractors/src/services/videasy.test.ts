import { afterEach, expect, it, vi } from "vitest";
vi.mock("./vidsrc", () => ({ extractVidSrc: vi.fn() }));
import { extractVidSrc } from "./vidsrc";
import { extractVideasy } from "./videasy";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("uses an explicit Neon fallback during a seed outage and avoids repeated failing requests", async () => {
  const fetchMock = vi.fn(async () => new Response("Bad gateway", { status: 502 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(extractVidSrc).mockResolvedValue({ sources: [{ url: "https://cdn.example/master.m3u8", quality: "Auto", type: "hls", referer: "https://cloudorchestranova.com/", requiresSegmentProxy: true }], subtitles: [] });
  const movie = await extractVideasy(550, "movie");
  const tv = await extractVideasy(1396, "tv", 2, 3);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(extractVidSrc).toHaveBeenLastCalledWith(1396, "tv", 2, 3);
  for (const result of [movie, tv]) {
    expect(result.sources[0]).toMatchObject({ title: "Videasy Neon (VidSrc fallback)", requiresSegmentProxy: true, referer: "https://cloudorchestranova.com/" });
  }
});
