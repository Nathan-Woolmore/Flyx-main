"use strict";
const { EventEmitter } = require("node:events");
const path = require("node:path");

/** Apple's DNS-SD runs inside Flyx; an OS access denial is never bypassed. */
function createMacBonjour(_options, onError, loadAddon = () => require(path.join(process.resourcesPath, "native", "cast-bonjour.node"))) {
  let handle = null, stopped = false;
  const services = new Map();
  const remove = (key, browser) => {
    const previous = services.get(key); services.delete(key);
    if (previous && ![...services.values()].some(service => service.addresses?.[0] === previous.addresses?.[0])) browser.emit("down", previous);
  };
  const bonjour = { backend: "macOS DNS-SD", responseCount: 0,
    find(query, onUp) {
      if (query.type !== "googlecast" || query.protocol !== "tcp") throw new Error("Unsupported native discovery query.");
      const browser = new EventEmitter();
      browser.stop = () => { stopped = true; handle?.stop(); handle = null; services.clear(); };
      browser.update = () => {}; // DNS-SD continuously browses and resolves on every active interface.
      const addon = loadAddon();
      handle = addon.start((error, service) => {
        if (stopped) return;
        bonjour.responseCount++;
        if (error) { onError(error); return; }
        if (!service || typeof service.name !== "string") return;
        const key = `${service.interfaceIndex}:${service.name}`;
        const previous = services.get(key);
        if (service.removed) {
          remove(key, browser); return;
        }
        if (previous && previous.addresses?.[0] !== service.addresses?.[0]) remove(key, browser);
        services.set(key, service); onUp(service);
      });
      // A synchronous native error callback can close the search during start.
      if (stopped) { handle?.stop(); handle = null; }
      return browser;
    },
    destroy() { stopped = true; handle?.stop(); handle = null; services.clear(); },
  };
  return bonjour;
}

function createPlatformBonjour(options, onError) {
  if (process.platform === "darwin") return createMacBonjour(options, onError);
  return new (require("bonjour-service").Bonjour)(options, onError);
}
module.exports = { createMacBonjour, createPlatformBonjour };
