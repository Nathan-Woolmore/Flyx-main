"use strict";

const { EventEmitter } = require("node:events");
const tls = require("node:tls");
const { randomUUID } = require("node:crypto");
const { isPrivateIPv4 } = require("./cast-security");

const NS = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
};
const APP_ID = "CC1AD845";
const MAX_MESSAGE = 65536;

// The fixed CastMessage protobuf envelope uses varints and UTF-8 fields.
// No general schema loader, eval, generated code or remote definitions.
function varint(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}
function textField(id, value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([varint((id << 3) | 2), varint(bytes.length), bytes]);
}
function encodeMessage(source, destination, namespace, data) {
  const body = Buffer.concat([
    Buffer.from([8, 0]), textField(2, source), textField(3, destination),
    textField(4, namespace), Buffer.from([40, 0]), textField(6, JSON.stringify(data)),
  ]);
  if (body.length > MAX_MESSAGE) throw new Error("Cast message is too large.");
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}
function decodeMessage(body) {
  if (!body.length || body.length > MAX_MESSAGE) throw new Error("Invalid Cast message size.");
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (offset >= body.length) throw new Error("Truncated Cast message.");
      const byte = body[offset++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid Cast varint.");
  };
  const fields = {};
  while (offset < body.length) {
    const tag = readVarint(), id = tag >>> 3, wire = tag & 7;
    if (wire === 0) fields[id] = readVarint();
    else if (wire === 2) {
      const length = readVarint();
      if (length > body.length - offset) throw new Error("Truncated Cast field.");
      fields[id] = body.subarray(offset, offset + length).toString("utf8"); offset += length;
    } else throw new Error("Unsupported Cast field.");
  }
  if (fields[1] !== 0 || fields[5] !== 0 || typeof fields[6] !== "string") {
    throw new Error("Unsupported Cast envelope.");
  }
  const data = JSON.parse(fields[6]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Cast payload.");
  return { source: fields[2], destination: fields[3], namespace: fields[4], data };
}

class CastTransport extends EventEmitter {
  constructor({ connect = tls.connect, timeoutMs = 10000, fingerprint } = {}) {
    super();
    this.connectSocket = connect;
    this.timeoutMs = timeoutMs;
    this.expectedFingerprint = fingerprint;
    this.sender = `flyx-${randomUUID()}`;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.transportId = null;
    this.sessionId = null;
    this.mediaSessionId = null;
    this.closed = false;
  }

  async connect(address) {
    if (!isPrivateIPv4(address)) throw new Error("Choose a TV on your private home network.");
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.removeListener("close", onClose);
        if (err) reject(err); else resolve();
      };
      const onClose = () => done(new Error("The TV closed the Cast connection."));
      this.once("close", onClose);
      const timer = setTimeout(() => { done(new Error("TV connection timed out. Check that it is awake and on the same network.")); this.close(); }, this.timeoutMs);
      // Google Cast receivers present self-signed certificates, not Web PKI
      // identities. This exception applies ONLY to the selected private IP
      // on 8009. Pin its certificate for reconnects in this app session.
      // Never change Electron certificate handling or global TLS settings.
      this.socket = this.connectSocket({ host: address, port: 8009, rejectUnauthorized: false }, () => {
        if (this.closed) return;
        try {
          const cert = this.socket.getPeerCertificate();
          if (!cert.fingerprint256 || (this.expectedFingerprint && cert.fingerprint256 !== this.expectedFingerprint)) {
            throw new Error("The TV’s Cast certificate changed. Restart Flyx after checking the TV’s address.");
          }
          this.fingerprint = cert.fingerprint256;
          this.send(NS.connection, { type: "CONNECT", origin: {} });
          this.lastHeartbeat = Date.now();
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastHeartbeat > 15000) { this.fail(new Error("Lost connection to the TV. Choose it again to reconnect.")); return; }
            try { this.send(NS.heartbeat, { type: "PING" }); } catch (err) { this.fail(err); }
          }, 5000);
          this.heartbeat.unref?.();
          done();
        } catch (err) { done(err); this.close(); }
      });
      this.socket.on("data", (bytes) => this.receive(bytes));
      this.socket.on("error", (err) => { done(err); this.fail(err); });
      this.socket.once("close", () => this.close());
    });
    try {
      await this.ensureSilent();
      const response = await this.request(NS.receiver, { type: "LAUNCH", appId: APP_ID });
      const application = response.status?.applications?.find((item) => item.appId === APP_ID);
      if (!application?.transportId || !application.sessionId) throw new Error("The TV could not launch the Google Cast media receiver.");
      this.transportId = application.transportId;
      this.sessionId = application.sessionId;
      this.send(NS.connection, { type: "CONNECT", origin: {} }, this.transportId);
      this.poll = setInterval(() => {
        if (this.pollPending || this.closed) return;
        this.pollPending = true;
        this.request(NS.media, { type: "GET_STATUS" }, this.transportId)
          .catch((err) => this.fail(err)).finally(() => { this.pollPending = false; });
      }, 1000);
      this.poll.unref?.();
    } catch (err) { this.close(); throw err; }
  }

  send(namespace, data, destination = "receiver-0") {
    if (this.closed || !this.socket) throw new Error("The TV is disconnected.");
    this.socket.write(encodeMessage(this.sender, destination, namespace, data));
  }

  request(namespace, data, destination = "receiver-0") {
    if (this.closed) return Promise.reject(new Error("The TV is disconnected."));
    if (this.pending.size >= 32) return Promise.reject(new Error("The TV is busy. Try again in a moment."));
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The TV did not respond. Check its connection and retry."));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, namespace, destination });
      try { this.send(namespace, { ...data, requestId }, destination); }
      catch (err) { clearTimeout(timer); this.pending.delete(requestId); reject(err); }
    });
  }

  receive(bytes) {
    if (this.closed) return;
    try {
      this.buffer = Buffer.concat([this.buffer, bytes]);
      // Limit incomplete buffered data as well as each decoded message.
      if (this.buffer.length > MAX_MESSAGE * 4) throw new Error("Invalid Cast frame size.");
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32BE();
        if (!size || size > MAX_MESSAGE) throw new Error("Invalid Cast frame size.");
        if (this.buffer.length < size + 4) break;
        const packet = decodeMessage(this.buffer.subarray(4, size + 4));
        this.buffer = this.buffer.subarray(size + 4);
        if (packet.destination !== this.sender && packet.destination !== "*") continue;
        if (!["receiver-0", this.transportId].includes(packet.source)) continue;
        const { namespace, data } = packet;
        if (namespace === NS.heartbeat) {
          this.lastHeartbeat = Date.now();
          if (data.type === "PING") this.send(NS.heartbeat, { type: "PONG" }, packet.source);
        }
        if (namespace === NS.connection && data.type === "CLOSE") { this.close(); return; }
        const pending = this.pending.get(data.requestId);
        if (pending && pending.namespace === namespace && pending.destination === packet.source) {
          this.pending.delete(data.requestId); clearTimeout(pending.timer);
          if (["LOAD_FAILED", "LOAD_CANCELLED", "LAUNCH_ERROR", "INVALID_REQUEST"].includes(data.type)) {
            // Do not echo receiver error fields: they can contain stream URLs.
            pending.reject(Object.assign(new Error(data.type === "LOAD_FAILED"
              ? "The TV could not play this source. Try another source or quality; the TV must support its codec."
              : "The TV rejected the Cast request. Check its Google Cast receiver and try again."), {code:data.type === "LOAD_FAILED" ? "CAST_LOAD_FAILED":"CAST_REQUEST_REJECTED"}));
          } else pending.resolve(data);
        }
        if (namespace === NS.media && data.type === "MEDIA_STATUS") {
          const status = data.status?.[0];
          this.mediaSessionId = status?.mediaSessionId ?? null;
          this.emit("media", status || { playerState: "IDLE" });
        }
        if (namespace === NS.receiver && data.type === "RECEIVER_STATUS") {
          if (data.status?.volume) this.silentVerified = data.status.volume.muted === true && data.status.volume.level === 0;
          this.emit("receiver", data.status || {});
          if (this.sessionId && Array.isArray(data.status?.applications) &&
            !data.status.applications.some((item) => item.sessionId === this.sessionId)) this.close();
        }
      }
    } catch (err) { this.fail(err); }
  }

  async ensureSilent() {
    this.silentVerified = false;
    const confirmed = (response) => response.type === "RECEIVER_STATUS" &&
      response.status?.volume?.muted === true && response.status.volume.level === 0;
    let response = await this.request(NS.receiver, { type: "SET_VOLUME", volume: { muted: true, level: 0 } });
    if (!confirmed(response)) {
      // Receivers may apply only one field from a combined volume update,
      // and changing the level may clear mute. Follow the sender SDK's separate
      // mute/volume operations, restore mute, then read the resulting state.
      for (const volume of [{ muted: true }, { level: 0 }, { muted: true }]) {
        await this.request(NS.receiver, { type: "SET_VOLUME", volume });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await this.request(NS.receiver, { type: "GET_STATUS" });
        if (confirmed(response)) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!confirmed(response)) {
      const volume = response.status?.volume;
      const mute = typeof volume?.muted === "boolean" ? String(volume.muted) : "not reported";
      const level = Number.isFinite(volume?.level) && volume.level >= 0 && volume.level <= 1
        ? String(volume.level) : "not reported";
      throw Object.assign(new Error(`The TV did not confirm silent playback (muted: ${mute}; volume: ${level}). Set the TV's own volume to zero and mute, then reconnect. No media was loaded.`), {code:"CAST_SILENT_UNCONFIRMED"});
    }
    this.silentVerified = true;
  }
  async load(media, startTime, autoplay = true) {
    // Never issue LOAD/autoplay before a receiver acknowledgement of mute
    // and zero volume. Re-check for each movie, including reconnects.
    await this.ensureSilent();
    const response = await this.request(NS.media, { type: "LOAD", media, autoplay, currentTime: startTime }, this.transportId);
    if (!response.status?.length) throw new Error("The TV did not confirm loading the movie.");
    return response.status[0];
  }
  async control(command) {
    if (command.type === "volume" || command.type === "mute") {
      return this.request(NS.receiver, { type: "SET_VOLUME", volume: command.type === "volume" ? { level: command.value } : { muted: command.value } });
    }
    if (this.mediaSessionId == null) throw new Error("No movie is loaded on the TV.");
    const data = { type: command.type.toUpperCase(), mediaSessionId: this.mediaSessionId };
    if (command.type === "seek") data.currentTime = command.value;
    return this.request(NS.media, data, this.transportId);
  }
  async stop() {
    try { if (this.sessionId && !this.closed) await this.request(NS.receiver, { type: "STOP", sessionId: this.sessionId }); }
    finally { this.close(); }
  }
  fail(err) { if (!this.closed) { this.emit("failure", err); this.close(); } }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat); clearInterval(this.poll);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new Error("The TV is disconnected."));
    }
    this.pending.clear(); this.buffer = Buffer.alloc(0);
    this.socket?.destroy(); this.socket = null;
    this.emit("close");
  }
}

module.exports = { CastTransport, encodeMessage, decodeMessage, NS, MAX_MESSAGE };
