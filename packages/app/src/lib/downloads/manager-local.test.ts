import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { DownloadJob } from "./types";
import { signProxyUrl } from "@/lib/security/proxy-sign";
import { localFileRevision, findLocalDownloadSources } from "./local-files";

const auth = vi.hoisted(() => ({ session: { isAdmin: true } as { isAdmin: boolean } | null }));
vi.mock("@/lib/auth/get-session", () => ({ getSession: async () => auth.session }));
vi.mock("@/lib/db", () => ({ getSetting: () => "" }));
vi.mock("./video", () => ({
  downloadVideo: async (_request: unknown, destination: string) => {
    const buffer = Buffer.alloc(128, 65);
    buffer.writeUInt32BE(24, 0);
    buffer.write("ftypisom", 4, "ascii");
    await fs.writeFile(destination, buffer);
  },
}));
vi.mock("./manga", () => ({
  downloadMangaChapter: () => {
    throw new Error("No manga download allowed in this fixture");
  },
}));

let temporary: string;
const globalState = globalThis as unknown as {
  __flyxDownloads?: { persistTimer?: ReturnType<typeof setTimeout> | null };
};
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-manager-fixture-"));
  vi.stubEnv("FLYX_DATA_DIR", path.join(temporary, "state"));
  vi.stubEnv("FLYX_DEFAULT_DOWNLOAD_DIR", path.join(temporary, "Movies"));
  delete globalState.__flyxDownloads;
  auth.session = { isAdmin: true };
  vi.stubEnv("JWT_SECRET", "synthetic-test-confirmation-key-never-a-real-secret");
  vi.resetModules();
});
afterEach(async () => {
  if (globalState.__flyxDownloads?.persistTimer)
    clearTimeout(globalState.__flyxDownloads.persistTimer);
  delete globalState.__flyxDownloads;
  vi.unstubAllEnvs();
  await fs.rm(temporary, { recursive: true, force: true });
});

it("completes same-title jobs to distinct files, persists exact bindings, and removing a queue row preserves media", async () => {
  const { createJobs, listJobs, removeJob } = await import("./manager");
  const input = {
    kind: "video" as const,
    tmdbId: 101,
    mediaType: "movie" as const,
    title: "Synthetic fixture",
  };
  const created = createJobs([input, input]);
  await vi.waitFor(() => expect(listJobs().filter((job) => job.status === "done")).toHaveLength(2));
  const jobs = listJobs();
  expect(jobs[0].filepath).not.toBe(jobs[1].filepath);
  for (const job of jobs) {
    expect(job.fileRevision).toBe(
      localFileRevision(await fs.stat(job.filepath!, { bigint: true })),
    );
  }
  const saved = JSON.parse(await fs.readFile(path.join(temporary, "state/downloads.json"), "utf8"));
  expect(
    saved.every((job: { fileRevision?: string }) => /^[a-f0-9]{64}$/.test(job.fileRevision || "")),
  ).toBe(true);
  expect(await findLocalDownloadSources(jobs, path.join(temporary, "Movies"), input)).toHaveLength(
    2,
  );
  expect(removeJob(created[0].id)).toBe(true);
  expect((await fs.stat(jobs.find((job) => job.id === created[0].id)!.filepath!)).size).toBe(128);
});

async function legacy(
  overrides: Partial<DownloadJob> = {},
  extra: Partial<DownloadJob>[] = [],
  write = true,
) {
  const directory = path.join(temporary, "Movies");
  await fs.mkdir(directory, { recursive: true });
  const filepath = path.join(directory, "Legacy.mp4");
  const bytes = Buffer.alloc(128, 65);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypisom", 4, "ascii");
  if (write) await fs.writeFile(filepath, bytes);
  const job: DownloadJob = {
    id: randomUUID(),
    kind: "video",
    status: "done",
    tmdbId: 101,
    mediaType: "movie",
    label: "Legacy fixture",
    filename: "Legacy.mp4",
    filepath,
    createdAt: 1,
    updatedAt: 2,
    progress: 100,
    bytes: 128,
    totalBytes: 128,
    outTimeMs: 0,
    ...overrides,
  };
  await fs.mkdir(path.join(temporary, "state"));
  await fs.writeFile(
    path.join(temporary, "state/downloads.json"),
    JSON.stringify([job, ...extra.map((other) => ({ ...job, id: randomUUID(), ...other }))]),
  );
  const manager = await import("./manager");
  const api = await import("@/app/api/downloads/[id]/relink/route");
  const context = { params: Promise.resolve({ id: job.id }) };
  const preview = (filename?: string) =>
    api.GET(
      new NextRequest(
        `http://127.0.0.1:3891/api/downloads/${job.id}/relink${filename === undefined ? "" : "?" + new URLSearchParams({ filename })}`,
      ),
      context,
    );
  const confirm = (proof: unknown, confirmed: unknown = true) =>
    api.POST(
      new NextRequest(`http://127.0.0.1:3891/api/downloads/${job.id}/relink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof, confirmed }),
      }),
      context,
    );
  return { directory, filepath, bytes, job, manager, api, context, preview, confirm };
}

it("links an existing completed movie only after explicit confirmation, persists the association and preserves file bytes", async () => {
  const fixture = await legacy();
  const { job, manager, preview, confirm, filepath, directory, bytes } = fixture;
  const before = localFileRevision(await fs.stat(filepath, { bigint: true }));
  const response = await preview();
  expect(response.status).toBe(200);
  const data = (await response.json()).preview;
  expect(data.file.filepath).toBe(filepath);
  expect(data.label).toBe(job.label);
  expect(manager.getJob(job.id)?.fileRevision).toBeUndefined();
  expect(
    await findLocalDownloadSources(manager.listJobs(), directory, {
      tmdbId: 101,
      mediaType: "movie",
    }),
  ).toEqual([]);
  expect((await confirm(data.proof, false)).status).toBe(400);
  expect((await confirm(data.proof)).status).toBe(200);
  expect(manager.getJob(job.id)).toMatchObject({ fileRevision: before, filepath });
  expect(manager.getJob(job.id)?.fileRelinkedAt).toBeGreaterThan(0);
  const history = JSON.parse(
    await fs.readFile(path.join(temporary, "state/downloads.json"), "utf8"),
  );
  expect(history[0].fileRevision).toBe(before);
  expect(await fs.readFile(filepath)).toEqual(bytes);
  expect(localFileRevision(await fs.stat(filepath, { bigint: true }))).toBe(before);
  expect(
    await findLocalDownloadSources(manager.listJobs(), directory, {
      tmdbId: 101,
      mediaType: "movie",
    }),
  ).toHaveLength(1);
  expect((await confirm(data.proof)).status).toBe(409);
});

it("relinks an exact legacy filename after moving the configured folder, including a season-zero episode", async () => {
  const f = await legacy({
    filepath: "/previous/download/location/Legacy.mp4",
    mediaType: "tv",
    season: 0,
    episode: 2,
  });
  const response = await f.preview();
  expect(response.status).toBe(200);
  const preview = (await response.json()).preview;
  expect(preview.relocated).toBe(true);
  expect(preview.identity).toMatchObject({ season: 0, episode: 2 });
  expect((await f.confirm(preview.proof)).status).toBe(200);
  expect(f.manager.getJob(f.job.id)?.filepath).toBe(f.filepath);
  expect(
    await findLocalDownloadSources(f.manager.listJobs(), f.directory, {
      tmdbId: 101,
      mediaType: "tv",
      season: 0,
      episode: 2,
    }),
  ).toHaveLength(1);
});

it("lets the host explicitly select a renamed file inside the folder, never scans or guesses an alternative", async () => {
  const f = await legacy({}, [], false);
  await fs.writeFile(path.join(f.directory, "Chosen.mp4"), f.bytes);
  expect((await f.preview()).status).toBe(404);
  expect(f.manager.getJob(f.job.id)?.fileRevision).toBeUndefined();
  const preview = (await (await f.preview("Chosen.mp4")).json()).preview;
  expect(preview.file.filename).toBe("Chosen.mp4");
  expect((await f.confirm(preview.proof)).status).toBe(200);
  expect(f.manager.getJob(f.job.id)?.filename).toBe("Chosen.mp4");
});

it("blocks ambiguous different-title records; removing an incorrect queue entry preserves the file and permits confirmation", async () => {
  const f = await legacy({}, [{ tmdbId: 202 }]);
  const response = await f.preview();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("Another download record");
  expect(f.manager.listJobs().every((job) => !job.fileRevision)).toBe(true);
  f.manager.removeJob(f.manager.listJobs().find((job) => job.id !== f.job.id)!.id);
  expect(await fs.readFile(f.filepath)).toEqual(f.bytes);
  const preview = (await (await f.preview()).json()).preview;
  expect((await f.confirm(preview.proof)).status).toBe(200);
});

it("rejects replacement between preview and confirmation, then explicitly identifies a changed bound file", async () => {
  const f = await legacy();
  const first = (await (await f.preview()).json()).preview;
  await fs.writeFile(path.join(f.directory, "Replacement.mp4"), f.bytes);
  await fs.rename(path.join(f.directory, "Replacement.mp4"), f.filepath);
  expect((await f.confirm(first.proof)).status).toBe(409);
  expect(f.manager.getJob(f.job.id)?.fileRevision).toBeUndefined();
  const next = (await (await f.preview()).json()).preview;
  expect((await f.confirm(next.proof)).status).toBe(200);
  await fs.writeFile(f.filepath, Buffer.concat([f.bytes, f.bytes]));
  const changed = (await (await f.preview()).json()).preview;
  expect(changed.replacement).toBe(true);
});

it("rejects folder or identity changes while confirmation is pending", async () => {
  const f = await legacy();
  const preview = (await (await f.preview()).json()).preview;
  vi.stubEnv("FLYX_DEFAULT_DOWNLOAD_DIR", path.join(temporary, "Moved"));
  expect((await f.confirm(preview.proof)).status).toBe(409);
  expect((await f.preview()).status).toBe(404);
  vi.stubEnv("FLYX_DEFAULT_DOWNLOAD_DIR", f.directory);
  f.manager.getJob(f.job.id)!.episode = 3;
  expect((await f.confirm(preview.proof)).status).toBe(409);
  expect(f.manager.getJob(f.job.id)?.fileRevision).toBeUndefined();
});

it("does not expand access through traversal, symlinks, expired/tampered proofs or non-admin requests", async () => {
  const f = await legacy();
  for (const filename of [
    "../Legacy.mp4",
    "/etc/Legacy.mp4",
    "nested/Legacy.mp4",
    "nested\\Legacy.mp4",
  ])
    expect((await f.preview(filename)).status).toBe(400);
  await fs.symlink(f.filepath, path.join(f.directory, "Alias.mp4"));
  expect((await f.preview("Alias.mp4")).status).toBe(404);
  const preview = (await (await f.preview()).json()).preview;
  expect((await f.confirm(preview.proof.replace("filename=", "filename=x"))).status).toBe(409);
  expect((await f.confirm(signProxyUrl(preview.proof, -1))).status).toBe(409);
  expect((await f.confirm(preview.proof + "&filename=Legacy.mp4")).status).toBe(409);
  auth.session = { isAdmin: false };
  expect((await f.preview()).status).toBe(403);
  expect((await f.confirm(preview.proof)).status).toBe(403);
  auth.session = null;
  expect((await f.preview()).status).toBe(401);
  expect((await f.confirm(preview.proof)).status).toBe(401);
  expect(f.manager.getJob(f.job.id)?.fileRevision).toBeUndefined();
});

it("can confirm one duplicate record for the same exact title without a newer legacy timestamp blocking playback", async () => {
  const f = await legacy({}, [{ updatedAt: Date.now() + 60_000 }]);
  const preview = (await (await f.preview()).json()).preview;
  expect((await f.confirm(preview.proof)).status).toBe(200);
  expect(
    await findLocalDownloadSources(f.manager.listJobs(), f.directory, {
      tmdbId: 101,
      mediaType: "movie",
    }),
  ).toHaveLength(1);
});

it("relinks the exact MAL episode/audio identity and never matches another Anime or episode", async () => {
  const f = await legacy({
    tmdbId: 0,
    malId: 20,
    mediaType: "tv",
    season: 1,
    episode: 3,
    language: "dub",
  });
  const preview = (await (await f.preview()).json()).preview;
  expect(preview.identity).toMatchObject({ malId: 20, season: 1, episode: 3, language: "dub" });
  expect((await f.confirm(preview.proof)).status).toBe(200);
  const identity = {
    tmdbId: 0,
    malId: 20,
    mediaType: "tv" as const,
    season: 1,
    episode: 3,
    language: "dub" as const,
  };
  expect(await findLocalDownloadSources(f.manager.listJobs(), f.directory, identity)).toHaveLength(
    1,
  );
  expect(
    await findLocalDownloadSources(f.manager.listJobs(), f.directory, { ...identity, malId: 21 }),
  ).toEqual([]);
  expect(
    await findLocalDownloadSources(f.manager.listJobs(), f.directory, { ...identity, episode: 4 }),
  ).toEqual([]);
});

it("the real download POST persists movie, TV, season-zero and MAL identities plus bindings, so normal playback needs no manual link", async () => {
  const { POST } = await import("@/app/api/downloads/route");
  const manager = await import("./manager");
  const items = [
    { kind: "video", tmdbId: 101, mediaType: "movie", title: "Movie fixture" },
    { kind: "video", tmdbId: 202, mediaType: "tv", season: 2, episode: 4, title: "Series fixture" },
    {
      kind: "video",
      tmdbId: 202,
      mediaType: "tv",
      season: 0,
      episode: 2,
      title: "Special fixture",
    },
    {
      kind: "video",
      tmdbId: 0,
      malId: 20,
      mediaType: "tv",
      season: 1,
      episode: 3,
      language: "dub",
      title: "MAL series fixture",
    },
    {
      kind: "video",
      tmdbId: 0,
      malId: 30,
      mediaType: "movie",
      language: "sub",
      title: "MAL movie fixture",
    },
  ];
  const request = new NextRequest("http://127.0.0.1:3891/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  expect((await POST(request)).status).toBe(200);
  await vi.waitFor(() =>
    expect(manager.listJobs().filter((job) => job.status === "done")).toHaveLength(5),
  );
  const saved: DownloadJob[] = JSON.parse(
    await fs.readFile(path.join(temporary, "state/downloads.json"), "utf8"),
  );
  for (const input of items) {
    const job = saved.find(
      (job) =>
        job.tmdbId === input.tmdbId &&
        job.malId === input.malId &&
        job.mediaType === input.mediaType &&
        job.season === input.season &&
        job.episode === input.episode,
    )!;
    expect(job).toBeDefined();
    expect(job.language).toBe(input.language);
    expect(job.fileRevision).toBe(
      localFileRevision(await fs.stat(job.filepath!, { bigint: true })),
    );
    expect(job.fileRelinkedAt).toBeUndefined();
    expect(
      await findLocalDownloadSources(saved, path.join(temporary, "Movies"), {
        tmdbId: input.tmdbId,
        malId: input.malId,
        mediaType: input.mediaType as "movie" | "tv",
        season: input.season,
        episode: input.episode,
      }),
    ).toHaveLength(1);
  }
  const special = saved.find((job) => job.season === 0)!;
  expect(special.label).toContain("S00E02");
  expect(special.filename).toContain("S00E02");
  // A fresh manager process view reads the automatically linked records back from disk.
  delete globalState.__flyxDownloads;
  vi.resetModules();
  const reloaded = await import("./manager");
  expect(reloaded.listJobs()).toHaveLength(5);
  expect(reloaded.listJobs().every((job) => /^[a-f0-9]{64}$/.test(job.fileRevision || ""))).toBe(
    true,
  );
  const { GET } = await import("@/app/api/stream/local-source/route");
  for (const input of items) {
    const params = new URLSearchParams({
      tmdbId: String(input.tmdbId),
      mediaType: input.mediaType,
    });
    if (input.malId) params.set("malId", String(input.malId));
    if (input.season != null) params.set("season", String(input.season));
    if (input.episode != null) params.set("episode", String(input.episode));
    const response = await GET(
      new NextRequest(`http://127.0.0.1:3891/api/stream/local-source?${params}`),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).sources).toHaveLength(1);
  }
});

it("rejects incomplete episode identity instead of persisting an unmatchable new download", async () => {
  const { POST } = await import("@/app/api/downloads/route");
  for (const item of [
    { kind: "video", tmdbId: 101, mediaType: "tv", episode: 2 },
    { kind: "video", tmdbId: 101, mediaType: "tv", season: 1 },
    { kind: "video", tmdbId: 101, mediaType: "tv", season: -1, episode: 2 },
    { kind: "video", tmdbId: 0, malId: -2, mediaType: "movie" },
  ]) {
    expect(
      (
        await POST(
          new NextRequest("http://127.0.0.1:3891/api/downloads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: [item] }),
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect((await import("./manager")).listJobs()).toEqual([]);
});
