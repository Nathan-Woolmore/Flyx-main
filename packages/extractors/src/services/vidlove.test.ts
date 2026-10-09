import { afterEach, describe, expect, it, vi } from "vitest";
import { extractVidLove } from "./vidlove";

afterEach(() => vi.unstubAllGlobals());

describe("VidLove", () => {
  it("maps opaque MP4 qualities, deduplicates URLs and filters invalid subtitles", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        source: {
          label: "MovieBox",
          url: "https://cdn.example/api?token=a",
          qualities: [
            { url: "https://cdn.example/api?token=a", quality: "1080p", type: "mp4" },
            { url: "javascript:invalid", type: "mp4" },
          ],
        },
        subtitles: [
          { label: "English", file: "https://cdn.example/en.vtt" },
          { file: "data:text/vtt,invalid" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await extractVidLove(550, "movie");
    expect(fetcher.mock.calls[0][0]).toBe("https://api.vidlove.cc/movie?id=550&mode=json");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      type: "mp4",
      quality: "1080p",
      requiresSegmentProxy: true,
    });
    expect(result.subtitles).toEqual([
      { label: "English", url: "https://cdn.example/en.vtt", language: "en" },
    ]);
  });

  it("passes the requested TV episode, including specials, and handles HLS", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ source: { url: "https://cdn.example/master.m3u8" } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await extractVidLove(1396, "tv", 0, 2)).sources[0].type).toBe("hls");
    expect(fetcher.mock.calls[0][0]).toContain("tv?id=1396&mode=json&season=0&episode=2");
  });

  it("rejects missing TV coordinates before fetching", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(extractVidLove(1396, "tv")).rejects.toThrow("season and episode");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, {}, { source: { url: "https://cdn.example/unknown" } }])(
    "does not invent streams for incomplete responses",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      expect((await extractVidLove(550, "movie")).sources).toEqual([]);
    },
  );

  it("reports upstream HTTP failures for provider fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(extractVidLove(550, "movie")).rejects.toThrow("HTTP 503");
  });
});
