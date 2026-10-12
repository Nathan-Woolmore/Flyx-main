import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlayerPreferences, savePlayerPreferences } from "./player-preferences";

const key = "flyx_player_prefs_v1";
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => stored.set(name, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("persistent startup-quality preference", () => {
  it("defaults to highest quality without writing or resetting storage", () => {
    expect(getPlayerPreferences().preferredQuality).toBe("highest");
    expect(stored.size).toBe(0);
  });
  it("reads legacy auto as highest while preserving unrelated preferences", () => {
    const legacy = JSON.stringify({ preferredQuality: "auto", autoPlayNextEpisode: false,
      playbackSpeed: 1.25, showNowPlaying: false, externalPlayer: "off" });
    stored.set(key, legacy);
    expect(getPlayerPreferences()).toMatchObject({ preferredQuality: "highest",
      autoPlayNextEpisode: false, playbackSpeed: 1.25, showNowPlaying: false, externalPlayer: "off" });
    expect(stored.get(key)).toBe(legacy);
  });
  it("keeps existing values when older storage omits quality", () => {
    stored.set(key, JSON.stringify({ autoPlayCountdown: 20, playbackSpeed: 1.5 }));
    expect(getPlayerPreferences()).toMatchObject({ preferredQuality: "highest",
      autoPlayCountdown: 20, playbackSpeed: 1.5 });
  });
  it("persists faster startup across a fresh module load, like a relaunch", async () => {
    stored.set(key, JSON.stringify({ autoPlayNextEpisode: false, autoPlayCountdown: 20 }));
    savePlayerPreferences({ ...getPlayerPreferences(), preferredQuality: "fast-start" });
    vi.resetModules();
    const reloaded = await import("./player-preferences");
    expect(reloaded.getPlayerPreferences()).toMatchObject({ preferredQuality: "fast-start",
      autoPlayNextEpisode: false, autoPlayCountdown: 20 });
  });
  it("persists a switch back to highest without changing other settings", () => {
    stored.set(key, JSON.stringify({ preferredQuality: "fast-start", showNowPlaying: false }));
    savePlayerPreferences({ ...getPlayerPreferences(), preferredQuality: "highest" });
    expect(getPlayerPreferences()).toMatchObject({ preferredQuality: "highest", showNowPlaying: false });
  });
  it("uses a valid default for corrupt or unsupported legacy quality values", () => {
    stored.set(key, "broken json");
    expect(getPlayerPreferences().preferredQuality).toBe("highest");
    stored.set(key, JSON.stringify({ preferredQuality: "1080p", playbackSpeed: 2 }));
    expect(getPlayerPreferences()).toMatchObject({ preferredQuality: "highest", playbackSpeed: 2 });
  });
});
