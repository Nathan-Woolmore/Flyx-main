"use strict";

const net = require("node:net");
const { isTrustedSender } = require("./security");

function isTrustedCastSender(event, window, port) {
  return Boolean(window && !window.isDestroyed() && event &&
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    isTrustedSender(event, port));
}

// No DNS names, public addresses, loopback, link-local metadata endpoints,
// arbitrary ports or renderer-supplied commands cross this bridge.
function isPrivateIPv4(value) {
  if (typeof value !== "string" || net.isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function receiverFromService(service) {
  if (!service || service.port !== 8009) return null;
  const address = (Array.isArray(service.addresses) ? service.addresses : []).find(isPrivateIPv4);
  if (!address) return null;
  const txt = service.txt || {};
  const name = String(txt.fn || service.name || "Google Cast TV").slice(0, 120);
  return { id: address, address, name, model: String(txt.md || "").slice(0, 120) };
}

function validateMedia(payload, origins) {
  if (!payload || typeof payload.url !== "string" || payload.url.length > 8192) {
    throw new Error("Could not prepare a signed Flyx stream for the TV.");
  }
  const u = new URL(payload.url);
  if (
    u.protocol !== "http:" || u.username || u.password || u.hash ||
    !origins.includes(u.origin) || !isPrivateIPv4(u.hostname) ||
    !["/api/stream/proxy", "/api/livetv/playlist"].includes(u.pathname) ||
    !/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("sig") || "") ||
    !Number.isFinite(Number(u.searchParams.get("exp"))) ||
    Number(u.searchParams.get("exp")) <= Date.now() / 1000
  ) {
    throw new Error("The TV needs an unexpired signed stream on this Flyx host’s LAN address.");
  }
  // The server verifies the HMAC; the bridge only accepts this host's
  // signed media routes. Never give the receiver the master cookie/key.
  const contentType = payload.contentType;
  if (!["video/mp4", "application/x-mpegURL", "application/vnd.apple.mpegurl", "video/webm"].includes(contentType)) {
    throw new Error("This stream format is not supported by the Cast player.");
  }
  const startTime = payload.startTime === undefined ? 0 : payload.startTime;
  if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime < 0 || startTime > 604800) {
    throw new Error("Invalid playback position.");
  }
  return {
    media: {
      contentId: u.href,
      contentType,
      streamType: payload.isLive === true ? "LIVE" : "BUFFERED",
      metadata: {
        metadataType: 0,
        title: String(payload.title || "Flyx").slice(0, 200),
        subtitle: String(payload.subtitle || "").slice(0, 200),
      },
    },
    startTime,
  };
}

function validateCommand(payload) {
  if (!payload || !["play", "pause", "seek", "volume", "mute"].includes(payload.type)) {
    throw new Error("Unknown Cast control.");
  }
  if (payload.type === "mute") {
    if (typeof payload.value !== "boolean") throw new Error("Invalid mute setting.");
  } else if (["seek", "volume"].includes(payload.type)) {
    if (typeof payload.value !== "number" || !Number.isFinite(payload.value) || payload.value < 0 ||
      payload.value > (payload.type === "volume" ? 1 : 604800)) {
      throw new Error("Invalid Cast control value.");
    }
  }
  return { type: payload.type, value: payload.value };
}

module.exports = { isPrivateIPv4, receiverFromService, validateMedia, validateCommand, isTrustedCastSender };
