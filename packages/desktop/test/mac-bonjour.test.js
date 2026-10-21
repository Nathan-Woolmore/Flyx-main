import { describe, expect, it, vi } from "vitest";
import { createMacBonjour } from "../src/mac-bonjour.js";
import { buildMacBonjour } from "../build/build-mac-bonjour.cjs";

function fixture() {
  let notify;
  const stop = vi.fn(), error = vi.fn(), up = vi.fn();
  const start = vi.fn(callback => { notify = callback; return { stop }; });
  const bonjour = createMacBonjour({}, error, () => ({ start }));
  const browser = bonjour.find({ type: "googlecast", protocol: "tcp" }, up);
  const down = vi.fn(); browser.on("down", down);
  return { bonjour, browser, stop, error, up, down, start, notify: (...values) => notify(...values) };
}
const tv = { name: "TV", interfaceIndex: 15, port: 8009, addresses: ["192.168.1.2"], txt: { fn: "Bedroom TV" } };

describe("native macOS Bonjour adapter", () => {
  it("uses native browse/resolve updates without a separate multicast socket or process", () => {
    const f = fixture(); f.notify(null, tv);
    expect(f.up).toHaveBeenCalledWith(tv);
    expect(f.bonjour.backend).toBe("macOS DNS-SD"); expect(f.bonjour.server).toBeUndefined();
    f.browser.update(); expect(f.start).toHaveBeenCalledOnce(); f.bonjour.destroy();
  });
  it("forwards a native access denial and never falls back to another network path", () => {
    const f = fixture(), denied = Object.assign(new Error("denied"), { code: "EPERM", nativeCode: -65570 });
    f.notify(denied); expect(f.error).toHaveBeenCalledWith(denied); expect(f.up).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledOnce(); f.bonjour.destroy();
  });
  it("removes old addresses before reporting an updated receiver", () => {
    const f = fixture(); f.notify(null, tv);
    const next = { ...tv, addresses: ["192.168.1.3"] }; f.notify(null, next);
    expect(f.down).toHaveBeenCalledWith(tv); expect(f.up).toHaveBeenLastCalledWith(next); f.bonjour.destroy();
  });
  it("retains a service if it disappears from one interface but remains on another", () => {
    const f = fixture(); f.notify(null, tv); f.notify(null, { ...tv, interfaceIndex: 16 });
    f.notify(null, { ...tv, removed: true }); expect(f.down).not.toHaveBeenCalled();
    f.notify(null, { ...tv, interfaceIndex: 16, removed: true }); expect(f.down).toHaveBeenCalledOnce(); f.bonjour.destroy();
  });
  it("stops once and ignores queued callbacks after closing or cancelling", () => {
    const f = fixture(); f.browser.stop(); f.bonjour.destroy(); f.notify(null, tv);
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.up).not.toHaveBeenCalled();
  });
  it("cleans a synchronous native error callback during start", () => {
    const stop = vi.fn(); let bonjour;
    bonjour = createMacBonjour({}, () => bonjour.destroy(), () => ({ start: callback => {
      callback(Object.assign(new Error("denied"), { code: "EPERM" })); return { stop };
    } }));
    bonjour.find({ type: "googlecast", protocol: "tcp" }, vi.fn()); expect(stop).toHaveBeenCalledOnce();
  });
});

describe("native Bonjour packaging", () => {
  const context = { electronPlatformName: "darwin", arch: "arm64", appOutDir: "/out", packager: { appInfo: { productFilename: "Flyx" } } };
  it("builds an arm64 Node-API module linked to the macOS system DNS-SD exports", () => {
    const execFile = vi.fn();
    buildMacBonjour(context, { execFile, headers: "/headers", exists: () => true, mkdir: vi.fn() });
    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe("/usr/bin/xcrun"); expect(args).toContain("arm64"); expect(args).toContain("-lSystem");
    expect(args).not.toContain("-ldns_sd"); expect(args.at(-1)).toBe("/out/Flyx.app/Contents/Resources/native/cast-bonjour.node");
  });
  it("does not add native code on other platforms and fails clearly if headers are missing", () => {
    const execFile = vi.fn(); buildMacBonjour({ ...context, electronPlatformName: "win32" }, { execFile });
    expect(execFile).not.toHaveBeenCalled();
    expect(() => buildMacBonjour(context, { headers: "/missing", exists: () => false })).toThrow("Node-API headers");
  });
});
