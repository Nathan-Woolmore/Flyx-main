"use strict";
const { EventEmitter } = require("node:events");
const { CastTransport } = require("./cast-transport");
const { isPrivateIPv4, receiverFromService, validateMedia, validateCommand } = require("./cast-security");
const empty = () => ({ isConnected: false, isCasting: false, deviceName: null, currentTime: 0, duration: 0,
  volume: 1, isMuted: false, playerState: "IDLE", lastError: null });
class CastService extends EventEmitter {
  constructor({ getOrigins, createBonjour = () => new (require("bonjour-service").Bonjour)(), createTransport = (options) => new CastTransport(options), discoveryMs = 4000 } = {}) {
    super(); this.getOrigins = getOrigins || (() => []); this.createBonjour = createBonjour;
    this.createTransport = createTransport; this.discoveryMs = discoveryMs;
    this.devices = new Map(); this.fingerprints = new Map(); this.state = empty();
    this.generation = 0; this.transport = null; this.discovery = null; this.disposed = false;
  }
  snapshot() { return { ...this.state }; }
  update(patch) { this.state = { ...this.state, ...patch }; this.emit("state", this.snapshot()); }
  cancelDiscovery() { this.discovery?.finish({ ok: true, devices: [] }); }
  discover() {
    this.cancelDiscovery();
    if (this.disposed) return Promise.resolve({ ok: false, error: "Cast is closed.", devices: [] });
    this.devices.clear();
    return new Promise((resolve) => {
      let bonjour, browser, timer, finished = false;
      const finish = (result) => {
        if (finished) return; finished = true; clearTimeout(timer);
        try { browser?.stop(); } catch {} try { bonjour?.destroy(); } catch {}
        if (this.discovery?.finish === finish) this.discovery = null;
        resolve(result);
      };
      this.discovery = { finish };
      try {
        bonjour = this.createBonjour();
        browser = bonjour.find({ type: "googlecast", protocol: "tcp" }, (service) => {
          if (finished) return;
          const device = receiverFromService(service);
          if (device && (this.devices.has(device.id) || this.devices.size < 64)) this.devices.set(device.id, device);
        });
        browser.on("error", () => finish({ ok: false, devices: [], error: "TV discovery failed. Try its private IP address." }));
        timer = setTimeout(() => finish({ ok: true, devices: [...this.devices.values()] }), this.discoveryMs);
      } catch { finish({ ok: false, devices: [], error: "TV discovery failed. Try its private IP address." }); }
    });
  }
  async connect(selection) {
    const device = selection && typeof selection.id === "string" ? this.devices.get(selection.id)
      : selection && isPrivateIPv4(selection.address) ? { id: selection.address, address: selection.address, name: "Google Cast TV" } : null;
    if (!device) return { ok: false, error: "Choose a discovered TV or a private home-network IPv4 address." };
    if (this.disposed) return { ok: false, error: "Cast is closed." };
    this.cancelDiscovery(); const generation = ++this.generation;
    this.transport?.close();
    const transport = this.createTransport({ fingerprint: this.fingerprints.get(device.address) });
    this.transport = transport; this.update({ ...empty(), deviceName: device.name });
    const current = () => this.transport === transport && generation === this.generation;
    transport.on("media", (media) => {
      if (!current()) return;
      const playerState = ["IDLE", "PLAYING", "PAUSED", "BUFFERING"].includes(media.playerState) ? media.playerState : "IDLE";
      this.update({ isCasting: media.mediaSessionId != null && playerState !== "IDLE", playerState,
        currentTime: Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0,
        duration: Number.isFinite(media.media?.duration) ? Math.max(0, media.media.duration) : 0 });
    });
    transport.on("receiver", (receiver) => {
      if (!current() || !receiver.volume) return;
      const volume = receiver.volume;
      this.update({ volume: Number.isFinite(volume.level) ? Math.max(0, Math.min(1, volume.level)) : this.state.volume,
        isMuted: typeof volume.muted === "boolean" ? volume.muted : this.state.isMuted });
    });
    transport.on("failure", () => { if (current()) this.update({ lastError: "Lost connection to the TV. Choose it again to reconnect." }); });
    transport.on("close", () => {
      if (!current()) return;
      this.transport = null; this.update({ isConnected: false, isCasting: false, playerState: "IDLE" });
    });
    try {
      await transport.connect(device.address);
      if (!current()) { transport.close(); return { ok: false, error: "Cast connection was cancelled." }; }
      if (transport.fingerprint) this.fingerprints.set(device.address, transport.fingerprint);
      this.update({ isConnected: true, lastError: null }); return { ok: true };
    } catch (error) {
      if (current()) { this.transport = null; transport.close(); this.update({ ...empty(), lastError: error.message }); }
      return { ok: false, error: error.message || "Could not connect to the TV." };
    }
  }
  async load(payload) {
    const transport = this.transport, generation = this.generation;
    try {
      if (!transport || !this.state.isConnected) throw new Error("Choose a TV first.");
      const { media, startTime } = validateMedia(payload, this.getOrigins());
      await transport.load(media, startTime);
      if (this.transport !== transport || generation !== this.generation) return { ok: false, error: "Cast connection was cancelled." };
      return { ok: true };
    } catch (error) {
      if (generation === this.generation) { await this.disconnect(); this.update({ lastError: error.message }); }
      return { ok: false, error: error.message || "Could not load the movie on the TV." };
    }
  }
  async control(payload) {
    try {
      const command = validateCommand(payload);
      if (!this.transport || !this.state.isConnected) throw new Error("The TV is disconnected.");
      await this.transport.control(command); return { ok: true };
    } catch (error) { return { ok: false, error: error.message || "The TV could not complete the request." }; }
  }
  async disconnect() {
    ++this.generation; this.cancelDiscovery(); const transport = this.transport; this.transport = null;
    this.update({ isConnected: false, isCasting: false, playerState: "IDLE" });
    try { await transport?.stop(); } catch { transport?.close(); }
    return { ok: true };
  }
  dispose() { this.disposed = true; ++this.generation; this.cancelDiscovery(); this.transport?.close(); this.transport = null; this.removeAllListeners(); }
}
module.exports = { CastService };
