"use strict";
const { EventEmitter } = require("node:events");
const { CastTransport } = require("./cast-transport");
const { CastDiscoveryRecords } = require("./cast-discovery-records");
const { getLocalIPs } = require("./network");
const { createPlatformBonjour } = require("./mac-bonjour");
const { isPrivateIPv4, receiverFromService, validateMedia, validateCommand } = require("./cast-security");
const empty = () => ({ isConnected: false, isCasting: false, deviceName: null, currentTime: 0, duration: 0,
  connectionID:0,mediaSessionID:null,deviceID:null,volume: 1, isMuted: false, playerState: "IDLE", idleReason:null, lastError: null });
class CastService extends EventEmitter {
  constructor({ getOrigins, createBonjour = createPlatformBonjour, createTransport = (options) => new CastTransport(options), discoveryMs = 8000, discoveryAttempts = 2, getDiscoveryInterface = () => getLocalIPs().find(item => isPrivateIPv4(item.address) && !/^(utun|tun|tap|vmnet|vbox|bridge)/i.test(item.interface))?.address } = {}) {
    super(); this.getOrigins = getOrigins || (() => []); this.createBonjour = createBonjour;
    this.createTransport = createTransport; this.discoveryMs = discoveryMs; this.getDiscoveryInterface = getDiscoveryInterface;
    this.discoveryAttempts = Math.max(1, Math.min(2, discoveryAttempts)); this.discoveryGeneration = 0; this.discoveryPause = null;
    this.devices = new Map(); this.fingerprints = new Map(); this.state = empty();
    this.generation = 0; this.transport = null; this.discovery = null; this.disposed = false;
  }
  snapshot() { return { ...this.state }; }
  update(patch) { this.state = { ...this.state, ...patch }; this.emit("state", this.snapshot()); }
  cancelDiscovery() {
    ++this.discoveryGeneration;
    if (this.discoveryPause) { clearTimeout(this.discoveryPause.timer); this.discoveryPause.resolve(); }
    this.discovery?.finish({ ok: true, devices: [] });
  }
  async discover() {
    this.cancelDiscovery(); const generation = this.discoveryGeneration;
    for (let attempt = 0; attempt < this.discoveryAttempts; attempt++) {
      if (generation !== this.discoveryGeneration) return { ok: true, devices: [] };
      const result = await this.discoverAttempt();
      if (generation !== this.discoveryGeneration) return { ok: true, devices: [] };
      result.diagnostics = { ...result.diagnostics, attempts: attempt + 1 };
      if (!result.ok || result.devices.length || attempt + 1 >= this.discoveryAttempts) return result;
      // Recreate multicast membership once after an empty cold search. Never
      // retry an access denial, and never restart after the picker is closed.
      await new Promise((resolve) => {
        const done = () => { if (this.discoveryPause?.resolve === done) this.discoveryPause = null; resolve(); };
        this.discoveryPause = { timer: setTimeout(done, 250), resolve: done };
      });
    }
  }
  discoverAttempt() {
    if (this.disposed) return Promise.resolve({ ok: false, error: "Cast is closed.", devices: [] });
    this.devices.clear();
    return new Promise((resolve) => {
      let bonjour, browser, mdns, timer, finished = false;
      const retries = [], records = new CastDiscoveryRecords();
      let queries = 0;
      const diagnostics = () => ({ backend: bonjour?.backend || "bonjour-service", responses: bonjour?.responseCount ?? records.responses, records: records.records.size, queries });
      const finish = (result) => {
        if (finished) return; finished = true; clearTimeout(timer); retries.forEach(clearTimeout);
        mdns?.removeListener("response", onResponse); mdns?.removeListener("error", onError);
        mdns?.removeListener("warning", onWarning);
        try { browser?.stop(); } catch {} try { bonjour?.destroy(); } catch {}
        if (this.discovery?.finish === finish) this.discovery = null;
        resolve({ ...result, diagnostics: diagnostics() });
      };
      const remember = (service) => {
        if (finished) return;
        const device = receiverFromService(service);
        if (device && (this.devices.has(device.id) || this.devices.size < 64)) this.devices.set(device.id, device);
      };
      const onError = (error) => {
        const denied = ["EACCES", "EPERM"].includes(error?.code);
        finish({ ok: false, devices: [], error: denied
          ? "macOS denied Flyx local-network discovery access. Check Flyx in System Settings > Privacy & Security > Local Network."
          : "TV discovery failed. Try its private IP address." });
      };
      const onWarning = (error) => { if (["EACCES", "EPERM"].includes(error?.code)) onError(error); };
      const queryMissing = () => {
        if (finished) return;
        const questions = records.missingQueries();
        if (questions.length && mdns?.query) { queries++; mdns.query(questions, (error) => { if (error && !finished) onError(error); }); }
      };
      const onResponse = (packet) => {
        if (finished) return;
        records.ingest(packet);
        if (records.castSeen) {
          this.devices.clear(); records.services().forEach(remember);
        }
      };
      this.discovery = { finish };
      try {
        const address = this.getDiscoveryInterface();
        // Refresh the interface on every search. Bind the shared mDNS port on
        // all addresses, while sending multicast on the current physical LAN.
        bonjour = this.createBonjour(address ? { interface: address, bind: "0.0.0.0" } : {}, onError);
        mdns = bonjour.server?.mdns;
        mdns?.on("response", onResponse); mdns?.on("error", onError); mdns?.on("warning", onWarning);
        browser = bonjour.find({ type: "googlecast", protocol: "tcp" }, remember);
        if (finished) { browser?.stop(); return; }
        browser.on("error", onError);
        browser.on("down", (service) => { const device = receiverFromService(service); if (device) this.devices.delete(device.id); });
        // A lost first multicast query is not a completed search. Re-query
        // a few times and explicitly resolve records delivered separately.
        for (const fraction of [0.125, 0.375, 0.75]) {
          retries.push(setTimeout(() => {
            if (finished) return;
            queries++; browser.update?.(); queryMissing();
          }, Math.max(1, Math.floor(this.discoveryMs * fraction))));
        }
        timer = setTimeout(() => {
          if (records.castSeen) { this.devices.clear(); records.services().forEach(remember); }
          finish({ ok: true, devices: [...this.devices.values()] });
        }, this.discoveryMs);
      } catch (error) { onError(error); }
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
      this.update({ idleReason:media.idleReason??null,mediaSessionID:media.mediaSessionId??null,isCasting: media.mediaSessionId != null && playerState !== "IDLE", playerState,
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
      this.update({ isConnected: true, connectionID:this.generation,deviceID:device.address,lastError: null }); return { ok: true };
    } catch (error) {
      if (current()) { this.transport = null; transport.close(); this.update({ ...empty(), lastError: error.message }); }
      return { ok: false, error: error.message || "Could not connect to the TV." };
    }
  }
  async load(payload) {
    const transport = this.transport, generation = this.generation;
    try {
      if (!transport || !this.state.isConnected) throw new Error("Choose a TV first.");
      const { media, startTime, autoplay } = validateMedia(payload, this.getOrigins());
      const loaded=await transport.load(media, startTime, autoplay);
      if (this.transport !== transport || generation !== this.generation) return { ok: false, error: "Cast connection was cancelled." };
      return { ok: true,mediaSessionID:loaded?.mediaSessionId??this.state.mediaSessionID,connectionID:generation };
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
