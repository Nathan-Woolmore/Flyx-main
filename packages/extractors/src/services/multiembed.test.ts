import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeXpsSources, parseServersFromEmbed } from "./multiembed";

describe("MultiEmbed server changes", () => {
  it("recognizes current servers without turning Vsrc into a Swish hash", () => {
    const servers = parseServersFromEmbed(`
      <a onclick="go('https://vidsrc.buzz/embed/tv/1396/2/3')">Vsrc</a>
      <a onclick="go('https://videm.xyz/embed/tv/1396/2/3')">Videm</a>
      <a onclick="go('https://streamsrcs.2embed.cc/vcr-tv?tmdb=1396&s=2&e=3')">Vcr</a>
      <iframe data-src="https://vidsrc.buzz/embed/tv/1396/2/3"></iframe>
    `);
    expect(servers.map((s) => s.type)).toEqual(["vsrc", "videm", "vcr"]);
    expect(servers[0]?.url).toBe("https://vidsrc.buzz/embed/tv/1396/2/3");
    expect(parseServersFromEmbed('<iframe data-src="https://unknown.example/player"></iframe>')).toEqual([]);
  });

  it("authenticates and decodes the dynamic XPS list; rejects a wrong token", () => {
    const url = new URL("https://play.xpass.top/data/movie/550?token=fixture.signature");
    const key = createHash("sha256").update(`spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|${url.pathname}|fixture.signature`).digest();
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const servers = [{ name: "TIK 1", url: "/mdata/movie/playlist.json" }];
    const payload = Buffer.concat([iv, cipher.update(JSON.stringify(servers)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    expect(decodeXpsSources(payload, url)).toEqual(servers);
    url.searchParams.set("token", "wrong.signature");
    expect(() => decodeXpsSources(payload, url)).toThrow();
    expect(() => decodeXpsSources("short", url)).toThrow(/Truncated/);
  });
});
