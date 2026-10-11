import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { CastTransport, encodeMessage, decodeMessage, NS, MAX_MESSAGE } from "../src/cast-transport.js";

afterEach(() => vi.useRealTimers());
function fixture(options = {}) {
  const socket = new EventEmitter();
  socket.write = vi.fn(); socket.destroy = vi.fn();
  socket.getPeerCertificate = () => ({ fingerprint256: "AA:BB" });
  const transport = new CastTransport({ connect: (_options, connected) => { queueMicrotask(connected); return socket; }, ...options });
  transport.on("failure", () => {});
  const reply = (namespace, data, source = "receiver-0") => transport.receive(encodeMessage(source, transport.sender, namespace, data));
  const sent = () => socket.write.mock.calls.map(([bytes]) => decodeMessage(bytes.subarray(4)));
  return { socket, transport, reply, sent };
}
async function connectedFixture() {
  const f = fixture();
  const promise = f.transport.connect("192.168.1.2");
  await new Promise((resolve) => setImmediate(resolve));
  const mute = f.sent().find((packet) => packet.data.type === "SET_VOLUME");
  expect(mute.data.volume).toEqual({ muted: true, level: 0 });
  f.reply(NS.receiver, { type: "RECEIVER_STATUS", requestId: mute.data.requestId, status: { volume: { muted: true, level: 0 } } });
  await new Promise((resolve) => setImmediate(resolve));
  const launch = f.sent().find((packet) => packet.data.type === "LAUNCH");
  f.reply(NS.receiver, { type: "RECEIVER_STATUS", requestId: launch.data.requestId,
    status: { applications: [{ appId: "CC1AD845", transportId: "web-1", sessionId: "session-1" }] } });
  await promise;
  return f;
}

describe("native Cast V2 protocol", () => {
  it("encodes the standard protobuf envelope and UTF-8 metadata", () => {
    const bytes = encodeMessage("sender", "receiver-0", NS.media, { type: "LOAD", title: "Movie 🎬" });
    expect(bytes.readUInt32BE()).toBe(bytes.length - 4);
    expect([...bytes.subarray(4, 6)]).toEqual([8, 0]);
    expect(decodeMessage(bytes.subarray(4))).toEqual({ source: "sender", destination: "receiver-0", namespace: NS.media, data: { type: "LOAD", title: "Movie 🎬" } });
    expect(() => decodeMessage(Buffer.from([18, 10, 1]))).toThrow();
    expect(() => decodeMessage(Buffer.alloc(MAX_MESSAGE + 1))).toThrow();
  });
  it("launches the default receiver and sends a media URL with resume position", async () => {
    const f = await connectedFixture();
    expect(f.sent().some((p) => p.destination === "web-1" && p.data.type === "CONNECT")).toBe(true);
    const load = f.transport.load({ contentId: "http://192.168.1.50:3891/api/stream/proxy?signed", contentType: "video/mp4" }, 25);
    const mute = f.sent().at(-1);
    f.reply(NS.receiver, { type: "RECEIVER_STATUS", requestId: mute.data.requestId, status: { volume: { muted: true, level: 0 } } });
    await new Promise((resolve) => setImmediate(resolve));
    const request = f.sent().at(-1);
    expect(request).toMatchObject({ destination: "web-1", namespace: NS.media, data: { type: "LOAD", autoplay: true, currentTime: 25 } });
    f.reply(NS.media, { type: "MEDIA_STATUS", requestId: request.data.requestId,
      status: [{ mediaSessionId: 7, playerState: "PLAYING", currentTime: 25 }] }, "web-1");
    await load;
    const pause = f.transport.control({ type: "pause" });
    const control = f.sent().at(-1);
    expect(control.data).toMatchObject({ type: "PAUSE", mediaSessionId: 7 });
    f.reply(NS.media, { type: "MEDIA_STATUS", requestId: control.data.requestId, status: [{ mediaSessionId: 7, playerState: "PAUSED" }] }, "web-1");
    await pause; f.transport.close();
  });
  it("handles fragmented frames and namespace-bound request IDs", async () => {
    const f = fixture(); f.transport.socket = f.socket;
    const pending = f.transport.request(NS.receiver, { type: "GET_STATUS" });
    const response = encodeMessage("receiver-0", f.transport.sender, NS.receiver, { type: "RECEIVER_STATUS", requestId: 1, status: {} });
    f.reply(NS.media, { type: "MEDIA_STATUS", requestId: 1, status: [] });
    expect(f.transport.pending.size).toBe(1);
    f.transport.receive(response.subarray(0, 2)); f.transport.receive(response.subarray(2, 9)); f.transport.receive(response.subarray(9));
    await expect(pending).resolves.toMatchObject({ type: "RECEIVER_STATUS" });
    f.transport.close();
  });
  it("bounds frame sizes and catches malformed JSON instead of crashing", () => {
    const f = fixture(); f.transport.socket = f.socket;
    const bytes = Buffer.alloc(4); bytes.writeUInt32BE(MAX_MESSAGE + 1);
    f.transport.receive(bytes);
    expect(f.transport.closed).toBe(true);
    expect(f.socket.destroy).toHaveBeenCalledOnce();
  });
  it("rejects timed-out pending work and releases all timers on disconnect", async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 50 }); f.transport.socket = f.socket;
    const pending = f.transport.request(NS.media, { type: "GET_STATUS" });
    const rejection = expect(pending).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(50); await rejection;
    expect(f.transport.pending.size).toBe(0);
    const next = f.transport.request(NS.media, { type: "GET_STATUS" });
    const closed = expect(next).rejects.toThrow("disconnected");
    f.transport.close(); await closed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pins a chosen receiver's certificate during reconnects", async () => {
    const f = fixture({ fingerprint: "CHANGED" });
    await expect(f.transport.connect("192.168.1.2")).rejects.toThrow("certificate changed");
    expect(f.transport.closed).toBe(true);
    expect(f.sent()).toHaveLength(0);
  });
  it("refuses media loading when silent playback is not acknowledged", async () => {
    const f = await connectedFixture();
    const load = f.transport.load({ contentId: "http://192.168.1.50/movie.mp4", contentType: "video/mp4" }, 0);
    const mute = f.sent().at(-1);
    f.reply(NS.receiver, { type: "RECEIVER_STATUS", requestId: mute.data.requestId, status: { volume: { muted: false, level: 1 } } });
    await expect(load).rejects.toThrow("did not confirm silent");
    expect(f.sent().some((packet) => packet.data.type === "LOAD")).toBe(false); f.transport.close();
  });
  it("clears the media session when the receiver reports idle", async () => {
    const f = await connectedFixture();
    f.reply(NS.media, { type: "MEDIA_STATUS", status: [{ mediaSessionId: 5, playerState: "PLAYING" }] }, "web-1");
    f.reply(NS.media, { type: "MEDIA_STATUS", status: [] }, "web-1");
    await expect(f.transport.control({ type: "pause" })).rejects.toThrow("No movie"); f.transport.close();
  });
});
