import { afterEach, describe, expect, it, vi } from "vitest";
import { extractVidSrc } from "./vidsrc";

afterEach(() => vi.unstubAllGlobals());

describe("VidSrc player bootstrap", () => {
  it.each([ ["movie", undefined, undefined], ["tv", 2, 3] ] as const)(
    "uses a freshly issued API token for %s and preserves episode selection",
    async (type, season, episode) => {
      let issued = 0;
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname === "/vs_src.php") {
          expect(url.origin).toBe("https://vidsrc.sh");
          return Response.json({ src: "https://cloudorchestranova.com/embed/movie/550?vs=gate" });
        }
        if (url.pathname === "/embed/movie/550") {
          return new Response('window.CFG = {"playerUrl":"/embed/player/movie/550?vs=inner"};');
        }
        if (url.pathname === "/embed/player/movie/550") {
          issued++;
          return new Response(`window.CONFIG = ${JSON.stringify({ api: `https://data.vidsrc.sh/api.php?type=${type}&tmdb=550`, apiToken: `fresh-${issued}` })};`);
        }
        expect(url.origin).toBe("https://data.vidsrc.sh");
        expect(url.searchParams.get("api_token")).toBe(`fresh-${issued}`);
        expect(url.searchParams.has("stream_urls")).toBe(true);
        if (type === "tv") {
          expect(url.searchParams.get("season")).toBe("2");
          expect(url.searchParams.get("episode")).toBe("3");
        }
        return Response.json({ status_code: "200", data: { stream_urls: ["https://cdn.example/master.m3u8"] } });
      });
      vi.stubGlobal("fetch", fetchMock);
      for (let i = 0; i < 2; i++) {
        const result = await extractVidSrc(550, type, season, episode);
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0]).toMatchObject({ requiresSegmentProxy: true, referer: "https://cloudorchestranova.com/" });
      }
      expect(issued).toBe(2);
    },
  );

  it("rejects an unexpected player host without fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ src: "https://evil.example/embed/movie/550" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await extractVidSrc(550)).sources).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
