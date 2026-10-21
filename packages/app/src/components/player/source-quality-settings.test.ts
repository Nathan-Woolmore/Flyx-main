import { describe, expect, it } from "vitest";
import { chooseStartupSource, orderedStartupSources, hlsStartupLevel, normalizeStartupQualityPreference } from "./source-quality";

const source = (quality: string, type = "mp4", url = quality) => ({ quality, type, url });
describe("saved source startup modes", () => {
  it("chooses 1080 over 720 and 480 in highest mode", () => {
    expect(chooseStartupSource([source("720p"), source("480p"), source("1080p")], "highest")?.quality).toBe("1080p");
  });
  it("uses the faster MP4 order only in faster startup mode", () => {
    const sources = [source("1080p"), source("480p"), source("720p")];
    expect(chooseStartupSource(sources, "fast-start")?.quality).toBe("720p");
    expect(chooseStartupSource([source("1080p"), source("480p")], "fast-start")?.quality).toBe("480p");
  });
  it("prefers an adaptive HLS source for faster startup", () => {
    expect(chooseStartupSource([source("1080p"), source("Auto", "hls", "adaptive")], "fast-start")?.url).toBe("adaptive");
  });
  it("does not revive failed or duplicated URLs in either mode", () => {
    for (const preference of ["highest", "fast-start"] as const) {
      const sources = [source("1080p"), source("720p"), source("720p"), source("480p")];
      const failed = new Set<string>();
      const attempts: string[] = [];
      while (true) {
        const next = chooseStartupSource(sources, preference, failed);
        if (!next) break;
        attempts.push(next.url); failed.add(next.url);
      }
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts).size).toBe(3);
    }
  });
  it("orders a standalone player's entire fallback list without mutating input", () => {
    const sources = [source("480p"), source("1080p"), source("720p")];
    expect(orderedStartupSources(sources, "highest").map(s => s.quality)).toEqual(["1080p", "720p", "480p"]);
    expect(sources[0]?.quality).toBe("480p");
  });
  it("normalizes legacy auto and unsupported values to the new default", () => {
    expect(normalizeStartupQualityPreference("auto")).toBe("highest");
    expect(normalizeStartupQualityPreference(undefined)).toBe("highest");
    expect(normalizeStartupQualityPreference("fast-start")).toBe("fast-start");
  });
});

describe("HLS startup mode and manual override", () => {
  const levels = [{ height: 360 }, { height: 720 }, { height: 1080 }];
  it("starts at the highest resolution in highest mode", () => {
    expect(hlsStartupLevel(levels, "highest")).toBe(2);
  });
  it("starts at the lowest rung in faster startup mode", () => {
    expect(hlsStartupLevel(levels, "fast-start")).toBe(0);
  });
  it("honours an explicit player source instead of applying the faster default", () => {
    expect(hlsStartupLevel(levels, "fast-start", true)).toBe(2);
  });
  it("never requests a nonexistent HLS level", () => {
    expect(hlsStartupLevel([], "fast-start")).toBe(-1);
    expect(hlsStartupLevel([{ height: 480 }], "highest")).toBe(0);
  });
});
