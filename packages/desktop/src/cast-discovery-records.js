"use strict";
const { isPrivateIPv4 } = require("./cast-security");
const CAST_TYPE = "_googlecast._tcp.local";
const normalize = (name) => typeof name === "string" && name.length <= 255
  ? name.replace(/\.$/, "").toLowerCase() : "";
const localName = (name) => /^[^\s\x00-\x1f]+\.local$/.test(name);

/** Join DNS-SD records across packets; bonjour-service only joins one packet. */
class CastDiscoveryRecords {
  constructor(now = Date.now) {
    this.now = now; this.records = new Map(); this.castSeen = false; this.responses = 0;
  }
  prune() {
    const now = this.now();
    for (const [key, record] of this.records) if (record.expires <= now) this.records.delete(key);
  }
  ingest(packet) {
    this.responses++;
    this.prune();
    for (const record of [...(packet?.answers || []), ...(packet?.additionals || [])].slice(0, 256)) {
      if (!record || !["PTR", "SRV", "TXT", "A"].includes(record.type)) continue;
      const name = normalize(record.name);
      if (!localName(name) || !Number.isFinite(record.ttl) || record.ttl < 0) continue;
      if (record.type === "PTR" && (name !== CAST_TYPE || !normalize(record.data).endsWith(`.${CAST_TYPE}`))) continue;
      if (record.type === "PTR") this.castSeen = true;
      if (record.type === "A" && !isPrivateIPv4(record.data)) continue;
      if (record.type === "SRV" && (!localName(normalize(record.data?.target)) || record.data.port !== 8009)) continue;
      const suffix = record.type === "PTR" ? normalize(record.data) : record.type === "A" ? record.data : "";
      const key = `${record.type}:${name}:${suffix}`;
      if (record.ttl === 0) { this.records.delete(key); continue; }
      if (record.type === "A" && record.flush) {
        // A changed address replaces older cache-flush answers for this host.
        for (const [oldKey, old] of this.records) {
          if (old.type === "A" && old.name === name && old.data !== record.data) this.records.delete(oldKey);
        }
      }
      if (this.records.has(key) || this.records.size < 512) {
        this.records.set(key, { type: record.type, name, data: record.data,
          expires: this.now() + Math.min(record.ttl, 120) * 1000 });
      }
    }
  }
  services() {
    this.prune(); const records = [...this.records.values()], services = [];
    for (const ptr of records.filter(r => r.type === "PTR" && r.name === CAST_TYPE)) {
      const fqdn = normalize(ptr.data);
      const srv = records.find(r => r.type === "SRV" && r.name === fqdn);
      if (!srv) continue;
      const host = normalize(srv.data.target);
      const addresses = records.filter(r => r.type === "A" && r.name === host).map(r => r.data);
      if (!addresses.length) continue;
      const txt = {}, rawTxt = records.find(r => r.type === "TXT" && r.name === fqdn)?.data;
      for (const item of Array.isArray(rawTxt) ? rawTxt.slice(0, 32) : []) {
        if (!Buffer.isBuffer(item) && typeof item !== "string") continue;
        const text = String(item), equals = text.indexOf("=");
        const key = text.slice(0, equals);
        if (equals > 0 && ["fn", "md"].includes(key)) txt[key] = text.slice(equals + 1, equals + 121).replace(/[\x00-\x1f]/g, "");
      }
      services.push({ fqdn, host, port: 8009, addresses, txt, name: fqdn.slice(0, -CAST_TYPE.length - 1) });
      if (services.length >= 64) break;
    }
    return services;
  }
  missingQueries() {
    this.prune(); const records = [...this.records.values()], questions = new Map();
    const add = (name, type) => questions.set(`${type}:${name}`, { name, type });
    for (const ptr of records.filter(r => r.type === "PTR" && r.name === CAST_TYPE).slice(0, 64)) {
      const fqdn = normalize(ptr.data);
      const srv = records.find(r => r.type === "SRV" && r.name === fqdn);
      if (!srv) add(fqdn, "SRV");
      if (!records.some(r => r.type === "TXT" && r.name === fqdn)) add(fqdn, "TXT");
      if (srv) {
        const host = normalize(srv.data.target);
        if (!records.some(r => r.type === "A" && r.name === host)) add(host, "A");
      }
    }
    return [...questions.values()].slice(0, 64);
  }
}
module.exports = { CastDiscoveryRecords };
