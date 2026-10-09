import { describe, expect, it } from "vitest";
import { applyStreamProxy } from "./stream-proxy";

describe("playback proxy routing", () => {
  it.each(["videasy", "vidsrc", "multiembed", "vidlove"])("keeps %s CDN requests on the local server with their headers", (provider) => {
    const media = "https://cdn.example/master.m3u8?key=a%2Bb&quality=hd";
    const proxied = new URL(applyStreamProxy(media, provider, true, "https://player.example/", "https://player.example"), "http://localhost:3000");
    expect(proxied.pathname).toBe("/api/stream/proxy");
    expect(proxied.searchParams.get("url")).toBe(media);
    expect(proxied.searchParams.get("referer")).toBe("https://player.example/");
    expect(proxied.searchParams.get("origin")).toBe("https://player.example");
  });
  it("does not wrap an already proxied stream", () => {
    const url = "/api/stream/proxy?url=https%3A%2F%2Fcdn.example%2Fa.m3u8";
    expect(applyStreamProxy(url, "vidsrc", true)).toBe(url);
  });
});
