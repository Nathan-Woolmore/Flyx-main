import { describe, it, expect } from "vitest";
import { isPrivateIPv4, receiverFromService, validateMedia, validateCommand, isTrustedCastSender } from "../src/cast-security.js";

const origin = "http://192.168.1.50:3891";
const url = `${origin}/api/stream/proxy?url=https%3A%2F%2Fexample.org%2Fmovie.mp4&exp=${Math.floor(Date.now() / 1000) + 3600}&sig=${"a".repeat(43)}`;
const media = { url, contentType: "video/mp4", title: "Test", startTime: 25 };

describe("Cast bridge validation", () => {
  it("trusts only the application main frame, never a LAN browser or iframe", () => {
    const mainFrame = { url: "http://127.0.0.1:3891/watch" };
    const webContents = { mainFrame };
    const window = { webContents, isDestroyed: () => false };
    expect(isTrustedCastSender({ sender: webContents, senderFrame: mainFrame }, window, 3891)).toBe(true);
    expect(isTrustedCastSender({ sender: webContents, senderFrame: { ...mainFrame } }, window, 3891)).toBe(false);
    expect(isTrustedCastSender({ sender: {}, senderFrame: mainFrame }, window, 3891)).toBe(false);
    expect(isTrustedCastSender({ sender: webContents, senderFrame: mainFrame }, window, 3892)).toBe(false);
    expect(isTrustedCastSender({ sender: webContents, senderFrame: mainFrame }, null, 3891)).toBe(false);
  });
  it("restricts receivers to private literal IPv4 addresses", () => {
    for (const ip of ["192.168.1.2", "10.0.0.1", "172.16.1.2", "172.31.1.2"]) expect(isPrivateIPv4(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "127.0.0.1", "169.254.169.254", "172.32.1.2", "0.0.0.0", "localhost", "192.168.01.2", "::1", null]) expect(isPrivateIPv4(ip)).toBe(false);
    expect(receiverFromService({ port: 8009, addresses: ["8.8.8.8", "192.168.1.2"], txt: { fn: "TV" } })).toMatchObject({ id: "192.168.1.2", name: "TV" });
    expect(receiverFromService({ port: 80, addresses: ["192.168.1.2"] })).toBeNull();
  });
  it("hands off only this host's signed media route", () => {
    expect(validateMedia(media, [origin])).toMatchObject({ media: { contentId: url, contentType: "video/mp4" }, startTime: 25 });
    for (const bad of [
      url.replace("192.168.1.50", "192.168.1.51"), url.replace("3891", "3892"),
      url.replace("/api/stream/proxy", "/api/settings"), url.replace("http:", "file:"),
      url.replace("sig=", "unsigned="), url.replace(/exp=\d+/, "exp=1"),
      url.replace("192.168.1.50", "user:password@192.168.1.50"), `${url}#secret`,
      "http://127.0.0.1:3891/api/stream/proxy?sig=x", "https://example.org/movie.mp4",
    ]) expect(() => validateMedia({ ...media, url: bad }, [origin])).toThrow();
    expect(() => validateMedia({ ...media, contentType: "text/html" }, [origin])).toThrow();
    expect(() => validateMedia({ ...media, startTime: NaN }, [origin])).toThrow();
  });
  it("rejects arbitrary controls and invalid numeric values", () => {
    expect(validateCommand({ type: "seek", value: 42 })).toEqual({ type: "seek", value: 42 });
    for (const command of [{ type: "LAUNCH" }, { type: "volume", value: 2 }, { type: "seek", value: -1 }, { type: "mute", value: "false" }, { type: "seek", value: Infinity }]) {
      expect(() => validateCommand(command)).toThrow();
    }
  });
});
