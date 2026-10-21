import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Browser } from "bonjour-service";
import { CastDiscoveryRecords } from "../src/cast-discovery-records.js";

const instance = "Test-TV._googlecast._tcp.local";
const host = "test-tv.local";
const ptr = { name: "_googlecast._tcp.local", type: "PTR", data: instance, ttl: 120 };
const srv = { name: instance, type: "SRV", data: { target: host, port: 8009 }, ttl: 120 };
const txt = { name: instance, type: "TXT", data: [Buffer.from("fn=Bedroom TV"), Buffer.from("md=Smart TV")], ttl: 120 };
const ip = { name: host, type: "A", data: "192.168.1.23", ttl: 120 };
const packet = (...answers) => ({ answers, additionals: [] });

describe("Cast DNS-SD records", () => {
  it("reproduces the library missing split replies and resolves the same records across packets", () => {
    const mdns = new EventEmitter(); mdns.query = vi.fn();
    const onUp = vi.fn(), browser = new Browser(mdns, { type: "googlecast", protocol: "tcp" }, onUp);
    const records = new CastDiscoveryRecords();
    for (const reply of [packet(ptr), packet(srv, txt), packet(ip)]) {
      mdns.emit("response", reply, { address: ip.data }); records.ingest(reply);
    }
    expect(onUp).not.toHaveBeenCalled();
    expect(records.services()).toMatchObject([{ port: 8009, addresses: [ip.data], txt: { fn: "Bedroom TV", md: "Smart TV" } }]);
    browser.stop();
  });
  it("accepts separate records in any order and normalizes DNS case and trailing dots", () => {
    const records = new CastDiscoveryRecords();
    records.ingest(packet({ ...ip, name: "TEST-TV.LOCAL." }));
    records.ingest(packet(txt, srv)); records.ingest(packet({ ...ptr, data: instance.toUpperCase() + "." }));
    expect(records.services()).toHaveLength(1);
  });
  it("asks for missing SRV, TXT and then IPv4 records", () => {
    const records = new CastDiscoveryRecords(); records.ingest(packet(ptr));
    expect(records.missingQueries().map(q => q.type)).toEqual(["SRV", "TXT"]);
    records.ingest(packet(srv, txt));
    expect(records.missingQueries()).toEqual([{ name: host, type: "A" }]);
    records.ingest(packet(ip)); expect(records.missingQueries()).toEqual([]);
  });
  it("rejects non-Cast services, public and loopback addresses, arbitrary ports and targets", () => {
    for (const address of ["8.8.8.8", "127.0.0.1", "169.254.1.1"]) {
      const records = new CastDiscoveryRecords(); records.ingest(packet(ptr, srv, { ...ip, data: address }));
      expect(records.services()).toEqual([]);
    }
    const records = new CastDiscoveryRecords();
    records.ingest(packet(ptr, { ...srv, data: { target: "example.org", port: 8009 } }, ip));
    records.ingest(packet({ ...srv, data: { target: host, port: 80 } }));
    expect(records.services()).toEqual([]);
    expect(records.missingQueries().every(q => q.name.endsWith(".local"))).toBe(true);
  });
  it("removes a receiver on goodbye rather than keeping stale services", () => {
    const records = new CastDiscoveryRecords(); records.ingest(packet(ptr, srv, txt, ip));
    expect(records.services()).toHaveLength(1);
    records.ingest(packet({ ...ptr, ttl: 0 })); expect(records.services()).toEqual([]);
  });
  it("replaces an old address after a cache-flush answer", () => {
    const records = new CastDiscoveryRecords(); records.ingest(packet(ptr, srv, txt, ip));
    records.ingest(packet({ ...ip, data: "192.168.1.24", flush: true }));
    expect(records.services()[0].addresses).toEqual(["192.168.1.24"]);
  });
  it("expires cached records and bounds retained records", () => {
    let time = 0; const records = new CastDiscoveryRecords(() => time);
    records.ingest(packet(...[ptr, srv, txt, ip].map(r => ({ ...r, ttl: 1 }))));
    time = 1001; expect(records.services()).toEqual([]);
    for (let i = 0; i < 600; i++) records.ingest(packet({ ...ip, name: `host-${i}.local` }));
    expect(records.records.size).toBe(512);
  });
});
