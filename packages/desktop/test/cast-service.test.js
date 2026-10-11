import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { CastService } from "../src/cast-service.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const transport = new EventEmitter();
  transport.fingerprint = "AA:BB";
  transport.connect = vi.fn(async () => {});
  transport.load = vi.fn(async () => { transport.emit("media", { mediaSessionId: 1, playerState: "PLAYING", currentTime: 25, media: { duration: 90 } }); });
  transport.control = vi.fn(async () => {});
  transport.close = vi.fn(() => transport.emit("close"));
  transport.stop = vi.fn(async () => transport.close());
  const browser = new EventEmitter(); browser.stop = vi.fn();
  let announce;
  const bonjour = { find: vi.fn((_query, onUp) => { announce = onUp; return browser; }), destroy: vi.fn() };
  const service = new CastService({ createBonjour: () => bonjour, createTransport: () => transport,
    getOrigins: () => ["http://192.168.1.50:3891"], discoveryMs: 100 });
  return { service, transport, browser, bonjour, announce: (value) => announce(value) };
}
const payload = { url: `http://192.168.1.50:3891/api/stream/proxy?url=https://example.org/movie.mp4&sig=${"a".repeat(43)}&exp=${Math.floor(Date.now() / 1000) + 3600}`,
  contentType: "video/mp4", title: "Test", startTime: 25 };

describe("Cast service lifecycle", () => {
  it("discovers only Google Cast on 8009 and closes multicast resources", async () => {
    vi.useFakeTimers(); const f = fixture(); const discovery = f.service.discover();
    f.announce({ port: 8009, addresses: ["192.168.1.2"], txt: { fn: "TV" } });
    f.announce({ port: 80, addresses: ["192.168.1.3"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(await discovery).toMatchObject({ ok: true, devices: [{ name: "TV", id: "192.168.1.2" }] });
    expect(f.browser.stop).toHaveBeenCalledOnce(); expect(f.bonjour.destroy).toHaveBeenCalledOnce();
    f.service.dispose();
  });
  it("validates selection and signed media, then forwards playback controls", async () => {
    const f = fixture();
    expect((await f.service.connect({ address: "8.8.8.8" })).ok).toBe(false);
    expect(f.transport.connect).not.toHaveBeenCalled();
    expect((await f.service.connect({ address: "192.168.1.2" })).ok).toBe(true);
    expect(f.service.snapshot().isCasting).toBe(false);
    expect((await f.service.load(payload)).ok).toBe(true);
    expect(f.service.snapshot()).toMatchObject({ isCasting: true, playerState: "PLAYING", currentTime: 25, duration: 90 });
    expect(JSON.stringify(f.service.snapshot())).not.toContain("sig=");
    await f.service.control({ type: "seek", value: 42 });
    expect(f.transport.control).toHaveBeenCalledWith({ type: "seek", value: 42 });
    await f.service.disconnect(); expect(f.service.snapshot().isConnected).toBe(false); f.service.dispose();
  });
  it("never sends an arbitrary URL and cleans up after a load failure", async () => {
    const f = fixture(); await f.service.connect({ address: "192.168.1.2" });
    expect((await f.service.load({ ...payload, url: "file:///secret" })).ok).toBe(false);
    expect(f.transport.load).not.toHaveBeenCalled(); expect(f.transport.stop).toHaveBeenCalledOnce();
    expect(f.service.snapshot().isConnected).toBe(false); f.service.dispose();
  });
  it("cancels a pending connection without allowing late success to restore it", async () => {
    const f = fixture(); let complete;
    f.transport.connect = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const connect = f.service.connect({ address: "192.168.1.2" });
    await f.service.disconnect(); complete();
    expect((await connect).ok).toBe(false); expect(f.service.snapshot().isConnected).toBe(false); f.service.dispose();
  });
});
