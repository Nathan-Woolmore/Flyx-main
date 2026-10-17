import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { DownloadJob } from "./types";
import { buildFilename } from "./types";
import {
  findLocalDownloadSources,
  localFileRevision,
  openLocalDownload,
} from "./local-files";
import {
  localIdentityKey,
  localStreamQuery,
  matchesLocalDownload,
  parseLocalIdentity,
  watchUrlForDownload,
} from "./local-identity";
import { GET, HEAD, OPTIONS } from "@/app/api/stream/local/route";
import { GET as sourceGET } from "@/app/api/stream/local-source/route";
import { GET as handoffGET } from "@/app/api/stream/vlc/route";
import { hasValidSignature, signProxyUrl } from "@/lib/security/proxy-sign";
import { hostStreamUrl, validateHandoffUrl } from "@/lib/external-player";

const state = vi.hoisted(() => ({
  session: { isAdmin: true } as { isAdmin: boolean } | null,
  jobs: [] as DownloadJob[],
  directory: "",
  lan: "http://192.168.1.50:3891" as string | null,
}));
vi.mock("@/lib/db", () => ({ getSetting: () => "" }));
vi.mock("@/lib/auth/get-session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/downloads/manager", () => ({ listJobs: () => state.jobs }));
vi.mock("@/lib/downloads/types", async (original) => ({
  ...(await original<object>()),
  getDownloadDir: () => state.directory,
}));
vi.mock("@/lib/lan-origin", () => ({ castOrigin: () => state.lan }));
vi.mock("@/lib/extraction", () => ({
  pipeline: {
    extract: async () => ({
      success: true,
      provider: "online",
      sources: [{ url: "https://cdn.example/synthetic.mp4", quality: "720p", type: "mp4" }],
    }),
  },
}));

let temporary: string;
const identity = { tmdbId: 101, mediaType: "movie" as const };
const bytes = Buffer.alloc(128, 65);
bytes.writeUInt32BE(24, 0);
bytes.write("ftypisom", 4, "ascii");
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-local-test-"));
  state.directory = path.join(temporary, "Movies");
  await fs.mkdir(state.directory);
  state.jobs = [];
  state.session = { isAdmin: true };
  state.lan = "http://192.168.1.50:3891";
  vi.stubEnv("JWT_SECRET", "synthetic-test-secret-never-a-real-account-key");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temporary, { recursive: true, force: true });
});

async function job(overrides: Partial<DownloadJob> = {}) {
  const item: DownloadJob = {
    id: randomUUID(),
    kind: "video",
    status: "done",
    label: "Synthetic fixture",
    tmdbId: 101,
    mediaType: "movie",
    progress: 100,
    bytes: 128,
    totalBytes: 128,
    outTimeMs: 0,
    createdAt: 1,
    updatedAt: 2,
    filename: "Fixture.mp4",
    filepath: path.join(state.directory, "Fixture.mp4"),
    ...overrides,
  };
  if (item.filepath) await fs.writeFile(item.filepath, bytes);
  if (item.filepath && overrides.fileRevision !== "")
    item.fileRevision = localFileRevision(await fs.stat(item.filepath, { bigint: true }));
  state.jobs.push(item);
  return item;
}
async function source() {
  return (await findLocalDownloadSources(state.jobs, state.directory, identity))[0]!;
}
const request = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(url, "http://127.0.0.1:3891"), { headers });

describe("Exact download identity", () => {
  it("matches identifiers, never titles or filename guesses", async () => {
    const item = await job();
    expect(matchesLocalDownload(item, identity)).toBe(true);
    expect(matchesLocalDownload(item, { ...identity, tmdbId: 102 })).toBe(false);
    expect(matchesLocalDownload({ ...item, malId: 101 }, identity)).toBe(false);
    expect(
      matchesLocalDownload({ ...item, malId: 9, tmdbId: 0 }, { ...identity, malId: 9, tmdbId: 0 }),
    ).toBe(true);
  });
  it("requires exact season and episode, including season zero specials", async () => {
    const item = await job({ mediaType: "tv", season: 0, episode: 2 });
    expect(
      matchesLocalDownload(item, { ...identity, mediaType: "tv", season: 0, episode: 2 }),
    ).toBe(true);
    for (const change of [
      { season: 1, episode: 2 },
      { season: 0, episode: 1 },
    ])
      expect(matchesLocalDownload(item, { ...identity, mediaType: "tv", ...change })).toBe(false);
  });
  it("keeps MAL episodes/audio distinct from TMDB and other episodes", async () => {
    const item = await job({
      tmdbId: 0,
      malId: 20,
      mediaType: "tv",
      season: 1,
      episode: 3,
      language: "dub",
    });
    const anime = { tmdbId: 0, malId: 20, mediaType: "tv" as const, season: 1, episode: 3 };
    expect(matchesLocalDownload(item, anime)).toBe(true);
    expect(matchesLocalDownload(item, { ...anime, episode: 4 })).toBe(false);
    expect(localIdentityKey(anime)).not.toBe(localIdentityKey({ ...anime, malId: 21 }));
    expect(matchesLocalDownload(item, { ...anime, language: "sub" })).toBe(false);
  });
  it.each(["downloading", "processing", "queued", "error", "cancelled"] as const)(
    "does not play %s jobs",
    async (status) => {
      await job({ status });
      expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    },
  );
  it("builds Play links using metadata without exposing disk paths", async () => {
    const item = await job({ mediaType: "tv", season: 0, episode: 2 });
    const url = watchUrlForDownload(item)!;
    expect(new URL(url, "http://flyx.test").searchParams.get("episode")).toBe("2");
    expect(url).not.toContain(state.directory);
    expect(watchUrlForDownload({ ...item, status: "processing" })).toBeNull();
    expect(() =>
      parseLocalIdentity(new URLSearchParams("tmdbId=101&mediaType=tv&episode=2")),
    ).toThrow();
  });
  it("gives equal-title queued downloads unique filenames without changing ordinary download names", () => {
    const input = {
      kind: "video" as const,
      tmdbId: 101,
      mediaType: "movie" as const,
      title: "Same title",
    };
    expect(buildFilename(input)).toBe("Same title.mp4");
    expect(buildFilename(input, randomUUID())).not.toBe(buildFilename(input, randomUUID()));
    expect(
      buildFilename({ ...input, title: "x".repeat(500) }, randomUUID()).length,
    ).toBeLessThanOrEqual(150);
  });
});

describe("Read-only local file confinement", () => {
  it("finds bound completed records but emits only opaque IDs and a file revision", async () => {
    await job();
    const found = await source();
    expect(found).toMatchObject({
      provider: "local",
      type: "mp4",
      title: "Local download",
      requiresSegmentProxy: false,
    });
    expect(found.url).not.toContain("Fixture");
    expect(found.url).not.toContain(temporary);
  });
  it("leaves legacy records unbound instead of trusting a possibly replaced file", async () => {
    const item = await job({ fileRevision: "" });
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    expect(watchUrlForDownload(item)).toBeNull();
    expect(item.fileRevision).toBe("");
  });
  it("rejects malformed identities even when the file is bound", async () => {
    await job({ tmdbId: 0 });
    expect(
      await findLocalDownloadSources(state.jobs, state.directory, {
        tmdbId: 0,
        mediaType: "movie",
      }),
    ).toEqual([]);
  });
  it("handles a missing file and a detached configured folder without directory scanning", async () => {
    const item = await job();
    await fs.unlink(item.filepath!);
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    expect(
      await findLocalDownloadSources(state.jobs, path.join(temporary, "Detached"), identity),
    ).toEqual([]);
  });
  it("rejects unrecorded, outside-root, nested and symlinked files", async () => {
    expect(await findLocalDownloadSources([], state.directory, identity)).toEqual([]);
    const item = await job({ filepath: path.join(temporary, "Outside.mp4") });
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    const target = item.filepath!;
    const link = path.join(state.directory, "Link.mp4");
    await fs.symlink(target, link);
    item.filepath = link;
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
  });
  it("rejects a final symlink even when its target is inside the configured folder", async () => {
    const item = await job();
    const linked = path.join(state.directory, "Alias.mp4");
    await fs.symlink(item.filepath!, linked);
    item.filepath = linked;
    expect(await openLocalDownload(item, state.jobs, state.directory)).toBeNull();
  });
  it("rejects same-size replacement, a changed configured root, and non-regular files", async () => {
    const item = await job();
    const found = await source();
    await fs.rename(item.filepath!, path.join(temporary, "Moved.mp4"));
    await fs.writeFile(item.filepath!, bytes);
    expect(await openLocalDownload(item, state.jobs, state.directory)).toBeNull();
    expect((await GET(request(found.url))).status).toBe(404);
    expect(await openLocalDownload(item, state.jobs, temporary)).toBeNull();
    await fs.unlink(item.filepath!);
    await fs.mkdir(item.filepath!);
    expect(await openLocalDownload(item, state.jobs, state.directory)).toBeNull();
  });
  it("rejects unsupported containers, empty and disguised non-media files", async () => {
    const item = await job({ filepath: path.join(state.directory, "Fixture.mkv") });
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    item.filepath = path.join(state.directory, "Fixture.mp4");
    await fs.writeFile(item.filepath, "<html>not a movie</html>");
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    await fs.writeFile(item.filepath, "");
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
  });
  it("rejects an ambiguous old filename, active overwrite and changed completion binding", async () => {
    const item = await job();
    state.jobs.push({ ...item, id: randomUUID(), tmdbId: 202 });
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    state.jobs.pop();
    item.fileRevision = localFileRevision(await fs.stat(item.filepath!, { bigint: true }));
    const old = await source();
    await fs.writeFile(item.filepath!, Buffer.concat([bytes, bytes]));
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
    expect(await GET(request(old.url))).toHaveProperty("status", 404);
  });
  it("rejects a current pending download that shares an old recorded destination", async () => {
    const item = await job();
    state.jobs.push({
      ...item,
      id: randomUUID(),
      filepath: undefined,
      status: "downloading",
      updatedAt: 3,
    });
    expect(await findLocalDownloadSources(state.jobs, state.directory, identity)).toEqual([]);
  });
});

describe("Local media HTTP and signed Cast handoff", () => {
  it("serves full bytes and HEAD without loading a user's media", async () => {
    await job();
    const found = await source();
    const head = await HEAD(request(found.url));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("Content-Length")).toBe("128");
    const response = await GET(request(found.url));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it.each([
    ["bytes=0-9", 0, 9],
    ["bytes=20-", 20, 127],
    ["bytes=-12", 116, 127],
    ["bytes=100-999", 100, 127],
  ] as const)("seeks/resumes with %s", async (range, first, last) => {
    await job();
    const response = await GET(request((await source()).url, { Range: range }));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes ${first}-${last}/128`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(first, last + 1));
  });
  it.each([
    "bytes=200-",
    "bytes=4-1",
    "bytes=-0",
    "bytes=0-2,5-7",
    "path=/etc/passwd",
    "bytes=0-9007199254740992",
  ])("rejects bad or unsatisfiable range %s", async (range) => {
    await job();
    const response = await GET(request((await source()).url, { Range: range }));
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */128");
  });
  it("honors If-Range and prevents replay after file replacement", async () => {
    const item = await job();
    const found = await source();
    const response = await GET(
      request(found.url, { Range: "bytes=0-5", "If-Range": '"different"' }),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await fs.writeFile(item.filepath!, Buffer.concat([bytes, bytes]));
    expect((await GET(request(found.url))).status).toBe(404);
  });
  it("requires admin cookies or an exact signed capability; never enables cookie CORS", async () => {
    await job();
    const found = await source();
    const signed = signProxyUrl(found.url);
    state.session = null;
    expect((await GET(request(found.url))).status).toBe(401);
    const allowed = await GET(request(signed));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await allowed.arrayBuffer();
    expect((await GET(request(signed.replace("id=", "other=")))).status).toBe(401);
    expect((await OPTIONS(request(signed))).status).toBe(204);
    expect((await OPTIONS(request(found.url))).status).toBe(401);
    state.session = { isAdmin: false };
    expect((await GET(request(found.url))).status).toBe(403);
    expect(
      (await sourceGET(request("/api/stream/local-source?tmdbId=101&mediaType=movie"))).status,
    ).toBe(403);
  });
  it("scopes capabilities to the exact job, revision, expiry and route, and revokes removed records", async () => {
    const item = await job();
    const found = await source();
    const signed = signProxyUrl(found.url);
    state.session = null;
    for (const invalid of [
      signProxyUrl(found.url, -1),
      signed.replace("rev=", "rev=a"),
      signed.replace("/api/stream/local?", "/api/stream/proxy?"),
    ]) {
      // Reusing a signature under another path or changing any bound field cannot authorize local bytes.
      expect((await GET(request(invalid))).status).toBe(401);
    }
    state.jobs = state.jobs.filter((entry) => entry.id !== item.id);
    expect((await GET(request(signed))).status).toBe(404);
    const head = await HEAD(request(found.url));
    expect(head.status).toBe(401);
    expect(await head.text()).toBe("");
    state.session = { isAdmin: true };
    state.jobs = [item];
    vi.stubEnv("JWT_SECRET", "");
    expect(
      (
        await handoffGET(
          request(`/api/stream/vlc?format=json&url=${encodeURIComponent(found.url)}`),
        )
      ).status,
    ).toBe(503);
  });
  it("rejects path injection even for an authenticated host", async () => {
    await job();
    const found = await source();
    expect((await GET(request(found.url + "&path=/etc/passwd"))).status).toBe(404);
    expect(
      localStreamQuery(new URLSearchParams("id=../../etc/passwd&rev=" + "a".repeat(64))),
    ).toBeNull();
    for (const duplicate of ["id", "rev", "sig", "exp"]) {
      const query = new URL(found.url, "http://flyx.test").searchParams;
      query.append(duplicate, "one");
      query.append(duplicate, "two");
      expect(localStreamQuery(query)).toBeNull();
    }
    expect(
      localStreamQuery(new URLSearchParams("id=" + "-".repeat(36) + "&rev=" + "a".repeat(64))),
    ).toBeNull();
  });
  it("mints a scoped local URL on the existing LAN origin for Cast, with resume time", async () => {
    await job();
    const found = await source();
    const response = await handoffGET(
      request(`/api/stream/vlc?format=json&target=cast&t=37&url=${encodeURIComponent(found.url)}`),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    const url = new URL(data.url);
    expect(url.origin).toBe(state.lan);
    expect(url.pathname).toBe("/api/stream/local");
    expect(hasValidSignature(url)).toBe(true);
    expect(data.startTime).toBe(37);
    expect(data.url).not.toContain(temporary);
    expect(hostStreamUrl("http://127.0.0.1:3891", { url: found.url })).toBe(
      `http://127.0.0.1:3891${found.url}`,
    );
    expect(validateHandoffUrl(found.url)).toBe(found.url);
    state.session = { isAdmin: false };
    expect(
      (
        await handoffGET(
          request(`/api/stream/vlc?format=json&url=${encodeURIComponent(found.url)}`),
        )
      ).status,
    ).toBe(403);
  });
  it("prefers local for title-only handoff, falls back online after deletion, and respects LAN sharing", async () => {
    const item = await job();
    const q = "/api/stream/vlc?tmdbId=101&mediaType=movie&format=json";
    expect((await (await handoffGET(request(q))).json()).provider).toBe("local");
    await fs.unlink(item.filepath!);
    expect((await (await handoffGET(request(q))).json()).provider).toBe("online");
    state.lan = null;
    expect((await handoffGET(request(q + "&target=cast"))).status).toBe(409);
  });
});
