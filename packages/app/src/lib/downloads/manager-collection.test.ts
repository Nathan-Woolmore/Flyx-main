import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
const mock = vi.hoisted(() => ({
  session: { isAdmin: true } as { isAdmin: boolean } | null,
  fetch: vi.fn(),
  details: vi.fn(),
  pages: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getSetting: () => "" }));
vi.mock("@/lib/auth/get-session", () => ({ getSession: async () => mock.session }));
vi.mock("@flyx/extractors/services", () => ({
  getMangaCollectionDetails: mock.details,
  getChapterPagesById: mock.pages,
}));
vi.mock("@/lib/security/safe-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/security/safe-fetch")>()),
  safeFetch: mock.fetch,
}));
vi.mock("./video", () => ({
  downloadVideo: () => {
    throw new Error("No video in this test");
  },
}));
vi.mock("./manga", () => ({
  downloadMangaChapter: () => {
    throw new Error("No individual manga in this test");
  },
}));
let root: string;
const globalState = globalThis as unknown as {
  __flyxDownloads?: {
    persistTimer?: ReturnType<typeof setTimeout> | null;
    controllers: Map<string, AbortController>;
  };
};
const input = {
  kind: "manga" as const,
  mangaId: "fixture",
  chapter: 0,
  title: "Fixture",
  collection: { language: "en", edition: "official" as const },
};
const chapterId = "00000000000000000000000001";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=",
  "base64",
);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-collection-manager-"));
  vi.stubEnv("FLYX_DATA_DIR", path.join(root, "state"));
  vi.stubEnv("FLYX_DEFAULT_DOWNLOAD_DIR", path.join(root, "Books"));
  delete globalState.__flyxDownloads;
  vi.resetModules();
  mock.session = { isAdmin: true };
  mock.details.mockReset().mockResolvedValue({
    id: "fixture",
    title: "Fixture",
    chapters: [{ id: chapterId, number: 0.5, pageCount: 0, language: "en", edition: "official" }],
  });
  mock.pages
    .mockReset()
    .mockResolvedValue([{ pageNumber: 1, imageUrl: "https://fixture.example/page.png" }]);
  mock.fetch.mockReset().mockImplementation(async () => new Response(png));
});
afterEach(async () => {
  for (const controller of globalState.__flyxDownloads?.controllers.values() || [])
    controller.abort();
  if (globalState.__flyxDownloads?.persistTimer)
    clearTimeout(globalState.__flyxDownloads.persistTimer);
  delete globalState.__flyxDownloads;
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const post = (items: unknown) =>
  new NextRequest("http://127.0.0.1/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
it("queues from the real admin API, persists scope and plan, completes one unique CBZ, then removes only history/cache", async () => {
  const api = await import("@/app/api/downloads/route");
  const manager = await import("./manager");
  const response = await api.POST(
    post([{ ...input, collectionPlan: { mangaId: "tampered" }, collectionRoot: "/outside" }]),
  );
  expect(response.status).toBe(200);
  const { jobs } = await response.json();
  await vi.waitFor(() => expect(manager.getJob(jobs[0].id)?.status).toBe("done"));
  const job = manager.getJob(jobs[0].id)!;
  expect(job.collectionPlan?.mangaId).toBe("fixture");
  expect(job.collectionRoot).toBe(path.join(root, "Books"));
  expect(job.collectionProgress?.chaptersDone).toBe(1);
  expect(job.progress).toBe(100);
  const visible = (await (await api.GET()).json()).jobs;
  expect(visible[0].collectionPlan).toBeUndefined();
  expect(visible[0].collection).toEqual(input.collection);
  expect(job.bytes).toBeGreaterThan(0);
  expect(job.filename).toContain(job.id);
  const saved = JSON.parse(await fs.readFile(path.join(root, "state/downloads.json"), "utf8"));
  expect(saved[0].collectionPlan.chapters[0].id).toBe(chapterId);
  await vi.waitFor(() => expect(globalState.__flyxDownloads?.controllers.size).toBe(0));
  expect(manager.removeJob(job.id)).toBe(true);
  expect((await fs.stat(job.filepath!)).size).toBe(job.bytes);
});
it("rejects unauthorized or invalid collection scope before any network/download work", async () => {
  const api = await import("@/app/api/downloads/route");
  mock.session = null;
  expect((await api.POST(post([input]))).status).toBe(403);
  mock.session = { isAdmin: true };
  for (const collection of [
    null,
    { language: "../../", edition: "official" },
    { language: "en", edition: "mixed" },
  ])
    expect((await api.POST(post([{ ...input, collection }]))).status).toBe(400);
  expect(mock.details).not.toHaveBeenCalled();
});
it("keeps failure state across restart and retries through the real API with the same snapshot", async () => {
  const manager = await import("./manager");
  mock.fetch.mockImplementation(async () => new Response("upstream failed", { status: 503 }));
  const [job] = manager.createJobs([input]);
  await vi.waitFor(() => expect(manager.getJob(job.id)?.status).toBe("error"), { timeout: 3000 });
  expect(manager.getJob(job.id)?.error).toContain("Chapter 0.5, page 1");
  await vi.waitFor(() => expect(globalState.__flyxDownloads?.controllers.size).toBe(0));
  delete globalState.__flyxDownloads;
  vi.resetModules();
  const reloaded = await import("./manager");
  expect(reloaded.getJob(job.id)?.collectionPlan?.chapters[0].id).toBe(chapterId);
  mock.details.mockClear();
  mock.fetch.mockImplementation(async () => new Response(png));
  const api = await import("@/app/api/downloads/[id]/retry/route");
  const context = { params: Promise.resolve({ id: job.id }) };
  mock.session = null;
  expect((await api.POST(post([]), context)).status).toBe(403);
  mock.session = { isAdmin: true };
  expect((await api.POST(post([]), context)).status).toBe(200);
  await vi.waitFor(() => expect(reloaded.getJob(job.id)?.status).toBe("done"));
  expect(mock.details).not.toHaveBeenCalled();
  expect((await api.POST(post([]), context)).status).toBe(409);
});
it("cancels and retries an active collection, then rejects a changed destination", async () => {
  const manager = await import("./manager");
  mock.fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("cancelled"))),
      ),
  );
  const [job] = manager.createJobs([input]);
  await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalled());
  expect(manager.cancelJob(job.id)).toBe(true);
  await vi.waitFor(() => expect(manager.getJob(job.id)?.status).toBe("cancelled"));
  await vi.waitFor(() => expect(globalState.__flyxDownloads?.controllers.size).toBe(0));
  vi.stubEnv("FLYX_DEFAULT_DOWNLOAD_DIR", path.join(root, "Other"));
  expect(manager.retryCollectionJob(job.id)).toBe(true);
  await vi.waitFor(() => expect(manager.getJob(job.id)?.error).toContain("folder changed"));
  expect(await fs.stat(path.join(root, "Other")).catch(() => null)).toBeNull();
});
it("preserves an existing destination if collection processing fails", async () => {
  const manager = await import("./manager");
  let release: (data: unknown) => void = () => {};
  mock.details.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const [job] = manager.createJobs([input]);
  const file = path.join(root, "Books", job.filename!);
  await fs.writeFile(file, "preserved");
  release({
    id: "fixture",
    title: "Fixture",
    chapters: [{ id: chapterId, number: 1, language: "en", edition: "official" }],
  });
  await vi.waitFor(() => expect(manager.getJob(job.id)?.status).toBe("error"));
  expect(await fs.readFile(file, "utf8")).toBe("preserved");
});

it("removes an active collection only after aborting work and then clears its private cache", async () => {
  const manager = await import("./manager");
  mock.fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("cancelled"))),
      ),
  );
  const [job] = manager.createJobs([input]);
  await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalled());
  expect(manager.removeJob(job.id)).toBe(true);
  await vi.waitFor(() => expect(globalState.__flyxDownloads?.controllers.size).toBe(0));
  expect(manager.getJob(job.id)).toBeNull();
  await vi.waitFor(async () =>
    expect(
      await fs.stat(path.join(root, "Books/.flyx-manga-cache", job.id)).catch(() => null),
    ).toBeNull(),
  );
});
it("marks interrupted collection history as retryable and the HTTP Remove action clears its cache", async () => {
  await fs.mkdir(path.join(root, "state"));
  const id = "00000000-0000-0000-0000-000000000001";
  const cache = path.join(root, "Books/.flyx-manga-cache", id);
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, "synthetic-page"), png);
  await fs.writeFile(
    path.join(root, "state/downloads.json"),
    JSON.stringify([
      {
        ...input,
        id,
        label: "Interrupted fixture",
        status: "processing",
        collectionRoot: path.join(root, "Books"),
        progress: 99,
        bytes: 1,
        totalBytes: 0,
        outTimeMs: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
  const manager = await import("./manager");
  expect(manager.getJob(id)?.status).toBe("error");
  expect(manager.getJob(id)?.error).toContain("restarted");
  const api = await import("@/app/api/downloads/[id]/route");
  const response = await api.DELETE(post([]), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect(manager.getJob(id)).toBeNull();
  expect(await fs.stat(cache).catch(() => null)).toBeNull();
});
