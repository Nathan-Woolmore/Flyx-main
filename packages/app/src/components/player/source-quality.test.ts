import { describe, expect, it } from "vitest";
import { qualityRank, highestQualitySource, untriedSources, highestHlsStartLevel } from "./source-quality";

const source = (quality: string, type = "mp4", url = quality) => ({ quality, type, url });

describe("highest advertised startup quality", () => {
  it("orders numbered qualities numerically, regardless of provider ordering", () => {
    const sources = [source("480p"), source("720p"), source("1080p"), source("360p")];
    expect(highestQualitySource(sources)?.quality).toBe("1080p");
    expect(sources[0]?.quality).toBe("480p");
  });
  it("recognises 4K, 2160p and dimension labels", () => {
    expect(qualityRank("4K")).toBe(2160);
    expect(qualityRank("2160p")).toBe(2160);
    expect(qualityRank("1920x1080")).toBe(1080);
    expect(highestQualitySource([source("1080p"), source("4K")])?.quality).toBe("4K");
  });
  it("does not label Auto or unknown sources as HD", () => {
    expect(qualityRank("Auto")).toBe(0);
    expect(qualityRank("HD")).toBe(0);
    expect(highestQualitySource([source("Auto"), source("480p")])?.quality).toBe("480p");
  });
  it("retains a single low quality when that is all the provider advertised", () => {
    expect(highestQualitySource([source("360p")])?.quality).toBe("360p");
  });
  it("skips a failed HD URL and chooses the best remaining resolution", () => {
    const choices = [source("1080p"), source("480p"), source("720p")];
    expect(highestQualitySource(choices, new Set(["1080p"]))?.quality).toBe("720p");
  });
  it("never reselects an exhausted provider or duplicate failed URL", () => {
    const choices = [source("1080p"), source("720p", "mp4", "1080p")];
    expect(highestQualitySource(choices, new Set(["1080p"]))).toBeNull();
    expect(untriedSources([source("480p"), source("480p")], new Set())).toHaveLength(1);
  });
  it("prefers an adaptive source only when all resolutions are unknown", () => {
    expect(highestQualitySource([source("Auto"), source("Auto", "hls", "adaptive")])?.url).toBe("adaptive");
    expect(highestQualitySource([source("720p", "hls"), source("720p", "mp4", "file")])?.url).toBe("file");
  });
  it("returns no candidate for an empty list or missing URL", () => {
    expect(highestQualitySource([])).toBeNull();
    expect(highestQualitySource([source("1080p", "mp4", "")])).toBeNull();
  });
});

describe("highest HLS startup variant", () => {
  it("selects resolution before bitrate rather than assuming the last level is best", () => {
    expect(highestHlsStartLevel([
      { height: 720, width: 1280, bitrate: 6000000 },
      { height: 1080, width: 1920, bitrate: 3000000 },
      { height: 480, width: 854, bitrate: 8000000 },
    ])).toBe(1);
  });
  it("uses width then bitrate to break resolution ties", () => {
    expect(highestHlsStartLevel([
      { height: 800, width: 1280, bitrate: 6000000 },
      { height: 800, width: 1920, bitrate: 3000000 },
      { height: 800, width: 1920, bitrate: 5000000 },
    ])).toBe(2);
  });
  it("falls back to bandwidth when the manifest omits dimensions", () => {
    expect(highestHlsStartLevel([{ bitrate: 1000000 }, { bitrate: 5000000 }])).toBe(1);
  });
  it("supports single-variant and empty playlists", () => {
    expect(highestHlsStartLevel([{ height: 480 }])).toBe(0);
    expect(highestHlsStartLevel([])).toBe(-1);
  });
});
