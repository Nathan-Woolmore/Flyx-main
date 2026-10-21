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
  const browser = new EventEmitter(); browser.stop = vi.fn(); browser.update = vi.fn();
  const mdns = new EventEmitter(); mdns.query = vi.fn();
  let announce;
  const bonjour = { server: { mdns }, find: vi.fn((_query, onUp) => { announce = onUp; return browser; }), destroy: vi.fn() };
  const service = new CastService({ createBonjour: () => bonjour, createTransport: () => transport,
    getOrigins: () => ["http://192.168.1.50:3891"], discoveryMs: 100, discoveryAttempts: 1 });
  return { service, transport, browser, bonjour, mdns, announce: (value) => announce(value) };
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


describe("Cast discovery refresh and error handling", () => {
  it("queries again and resolves records received after the first reply", async () => {
    vi.useFakeTimers(); const f = fixture(); const result = f.service.discover();
    const instance = "Test._googlecast._tcp.local";
    f.mdns.emit("response", { answers: [{ type: "PTR", name: "_googlecast._tcp.local", data: instance, ttl: 120 }] });
    await vi.advanceTimersByTimeAsync(13);
    expect(f.browser.update).toHaveBeenCalled(); expect(f.mdns.query).toHaveBeenCalled();
    f.mdns.emit("response", { answers: [{ type: "SRV", name: instance, data: { target: "tv.local", port: 8009 }, ttl: 120 }] });
    f.mdns.emit("response", { answers: [{ type: "A", name: "tv.local", data: "192.168.1.2", ttl: 120 }] });
    await vi.advanceTimersByTimeAsync(87);
    expect(await result).toMatchObject({ ok: true, devices: [{ address: "192.168.1.2" }], diagnostics: { responses: 3 } });
    expect(f.mdns.listenerCount("response")).toBe(0); f.service.dispose();
  });
  it("reports an app access denial explicitly and never tries a bypass", async () => {
    const f = fixture(); const result = f.service.discover();
    f.mdns.emit("warning", Object.assign(new Error("denied"), { code: "EPERM" }));
    expect(await result).toMatchObject({ ok: false, devices: [], error: expect.stringContaining("macOS denied Flyx") });
    expect(f.transport.connect).not.toHaveBeenCalled(); expect(f.bonjour.destroy).toHaveBeenCalledOnce(); f.service.dispose();
  });
  it("cancels old searches, clears stale results and reads a changed interface on refresh", async () => {
    vi.useFakeTimers(); const f = fixture();
    const chooseInterface = vi.fn().mockReturnValueOnce("192.168.1.10").mockReturnValueOnce("192.168.2.10");
    f.service.getDiscoveryInterface = chooseInterface;
    const first = f.service.discover(); f.announce({ port: 8009, addresses: ["192.168.1.2"] });
    const second = f.service.discover();
    expect(await first).toMatchObject({ ok: true, devices: [] });
    expect(f.service.devices.size).toBe(0); expect(chooseInterface).toHaveBeenCalledTimes(2);
    expect(f.mdns.listenerCount("response")).toBe(1);
    await vi.advanceTimersByTimeAsync(100); expect((await second).devices).toEqual([]);
    const queries = f.browser.update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); expect(f.browser.update).toHaveBeenCalledTimes(queries); f.service.dispose();
  });
  it("does not retain a device after a DNS-SD goodbye", async () => {
    vi.useFakeTimers(); const f = fixture(), result = f.service.discover();
    const ptr = { type: "PTR", name: "_googlecast._tcp.local", data: "TV._googlecast._tcp.local", ttl: 120 };
    f.mdns.emit("response", { answers: [ptr,
      { type: "SRV", name: ptr.data, data: { target: "tv.local", port: 8009 }, ttl: 120 },
      { type: "A", name: "tv.local", data: "192.168.1.2", ttl: 120 }] });
    expect(f.service.devices.size).toBe(1);
    f.mdns.emit("response", { answers: [{ ...ptr, ttl: 0 }] });
    await vi.advanceTimersByTimeAsync(100); expect((await result).devices).toEqual([]); f.service.dispose();
  });
});


describe("bounded fresh discovery retry", () => {
  it("recreates an empty cold search once and finds a receiver in the second attempt", async () => {
    vi.useFakeTimers(); const f = fixture(); f.service.discoveryAttempts = 2;
    const result = f.service.discover();
    await vi.advanceTimersByTimeAsync(350);
    expect(f.bonjour.find).toHaveBeenCalledTimes(2);
    f.announce({ port: 8009, addresses: ["192.168.1.2"], txt: { fn: "TV" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ ok: true, devices: [{ name: "TV" }], diagnostics: { attempts: 2 } });
    f.service.dispose();
  });
  it("cancelling between attempts prevents a delayed browser from starting", async () => {
    vi.useFakeTimers(); const f = fixture(); f.service.discoveryAttempts = 2;
    const result = f.service.discover(); await vi.advanceTimersByTimeAsync(100);
    f.service.cancelDiscovery(); expect(await result).toMatchObject({ ok: true, devices: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bonjour.find).toHaveBeenCalledOnce(); f.service.dispose();
  });
});

describe('paused destination preparation',()=>{
 it('forwards autoplay false and retains a paused receiver acknowledgement',async()=>{const f=fixture();await f.service.connect({address:'192.168.1.2'});f.transport.load.mockImplementation(async()=>f.transport.emit('media',{mediaSessionId:8,playerState:'PAUSED',currentTime:25,media:{duration:90}}));expect((await f.service.load({...payload,autoplay:false})).ok).toBe(true);expect(f.transport.load.mock.calls[0][2]).toBe(false);expect(f.service.snapshot()).toMatchObject({playerState:'PAUSED',currentTime:25});f.service.dispose();});
});
