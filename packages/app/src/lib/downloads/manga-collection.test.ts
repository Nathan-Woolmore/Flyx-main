import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import type { ChapterData, MangaData } from "@flyx/core";
import {
  collectionChoices,
  collectionPlan,
  type MangaCollectionProgress,
} from "./manga-collection-types";
import { buildFilename } from "./types";

const mock = vi.hoisted(() => ({ details: vi.fn(), pages: vi.fn(), fetch: vi.fn() }));
vi.mock("@flyx/extractors/services", () => ({
  getMangaCollectionDetails: mock.details,
  getChapterPagesById: mock.pages,
}));
vi.mock("@/lib/security/safe-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/security/safe-fetch")>()),
  safeFetch: mock.fetch,
}));
vi.mock("@/lib/db", () => ({ getSetting: () => "" }));
import {
  downloadMangaCollection,
  discardMangaCollectionCache,
  writeCollectionArchive,
} from "./manga-collection";
const id = (n: number) => String(n).padStart(26, "0");
const chapter = (n: number, number: number, extra: Partial<ChapterData> = {}): ChapterData => ({
  id: id(n),
  number,
  pageCount: 2,
  language: "en",
  edition: "official",
  ...extra,
});
const details = (chapters = [chapter(2, 10), chapter(1, 0.5)]): MangaData => ({
  id: "fixture",
  title: "Fixture & <manga>",
  chapters,
  altTitles: [],
  description: "",
  coverImage: "",
  status: "ongoing",
  genres: [],
  totalChapters: chapters.length,
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=",
  "base64",
);
const bytesFor = (url: string) => Buffer.concat([png, Buffer.from(url)]);
let root: string, dest: string, jobId: string;
const progress: MangaCollectionProgress[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-cbz-fixture-"));
  dest = path.join(root, "fixture.cbz");
  jobId = randomUUID();
  progress.length = 0;
  mock.details.mockReset().mockResolvedValue(details());
  mock.pages.mockReset().mockImplementation(async (chapterId: string) =>
    [1, 2].map((number) => ({
      pageNumber: number,
      imageUrl: `https://fixture.example/${chapterId}/${number}.png`,
    })),
  );
  mock.fetch
    .mockReset()
    .mockImplementation(
      async (url: string) =>
        new Response(bytesFor(url), { headers: { "content-type": "image/png" } }),
    );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const request = () => ({ mangaId: "fixture", jobId, language: "en", edition: "official" as const });
const run = (signal?: AbortSignal, options = {}) =>
  downloadMangaCollection(
    request(),
    dest,
    (value) => progress.push(value),
    () => {},
    signal,
    options,
  );
const exists = (file = dest) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

it("freezes one language/edition, deduplicates numeric chapters and orders zero/fractions numerically", () => {
  const data = details([
    chapter(1, 10),
    chapter(2, 0),
    chapter(3, 2.5),
    chapter(4, 2.5, { publishedAt: "2026-01-01" }),
    chapter(5, 1, { edition: "community" }),
    chapter(6, 3, { language: "fr" }),
  ]);
  const plan = collectionPlan("fixture", data, request());
  expect(plan.chapters.map((c) => c.number)).toEqual([0, 2.5, 10]);
  expect(plan.chapters[1].id).toBe(id(4));
  expect(plan.duplicatesExcluded).toBe(1);
  expect(collectionChoices([...data.chapters, chapter(7, NaN)]).map((c) => c.count)).toEqual([
    3, 1, 1,
  ]);
  expect(() => collectionPlan("other", data, request())).toThrow(/different manga/);
  expect(() =>
    collectionPlan("fixture", details([chapter(1, 1, { id: "../outside" })]), request()),
  ).toThrow(/invalid chapter/);
});
it("uses unique safe UTF-8 filenames for collections", () => {
  const item = {
    kind: "manga" as const,
    mangaId: "fixture",
    chapter: 0,
    title: "界".repeat(200),
    collection: { language: "en", edition: "official" as const },
  };
  const filename = buildFilename(item, jobId);
  expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(240);
  expect(filename.endsWith(` - ${jobId}.cbz`)).toBe(true);
  expect(buildFilename(item, randomUUID())).not.toBe(filename);
});
it.each([false, true])(
  "writes ordered complete archive, manifest and escaped ComicInfo (ZIP64=%s)",
  async (forceZip64) => {
    const result = await run(undefined, { forceZip64 });
    const bytes = await fs.readFile(dest);
    const entries = unzipSync(bytes);
    const images = Object.keys(entries).filter((name) => name.endsWith(".png"));
    expect(images).toEqual([
      "000001_Chapter_0.5/00001.png",
      "000001_Chapter_0.5/00002.png",
      "000002_Chapter_10/00001.png",
      "000002_Chapter_10/00002.png",
    ]);
    expect(entries[images[0]]).toEqual(
      new Uint8Array(bytesFor(`https://fixture.example/${id(1)}/1.png`)),
    );
    expect(entries[images[3]]).toEqual(
      new Uint8Array(bytesFor(`https://fixture.example/${id(2)}/2.png`)),
    );
    const manifest = JSON.parse(strFromU8(entries["flyx-manifest.json"]));
    expect(
      manifest.chapters.map((c: { number: number; pages: number }) => [c.number, c.pages]),
    ).toEqual([
      [0.5, 2],
      [10, 2],
    ]);
    expect(manifest.source).toBe("weebcentral");
    expect(manifest.edition).toBe("official");
    expect(strFromU8(entries["ComicInfo.xml"])).toContain("Fixture &amp; &lt;manga&gt;");
    expect(result.pages).toBe(4);
    expect(result.bytes).toBe(bytes.length);
    expect(mock.details).toHaveBeenCalledTimes(1);
    expect(mock.pages.mock.calls.map((c) => c[0])).toEqual([id(1), id(2)]);
    expect(progress.at(-1)?.phase).toBe("packing");
    if (forceZip64) expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  },
);
it("never publishes a partial failure; Retry keeps snapshot and reuses verified pages and finished chapters", async () => {
  const bad = `https://fixture.example/${id(2)}/2.png`;
  mock.fetch.mockImplementation(async (url: string) =>
    url === bad ? new Response("fail", { status: 503 }) : new Response(bytesFor(url)),
  );
  await expect(run()).rejects.toThrow(/Chapter 10, page 2 failed/);
  expect(await exists()).toBe(false);
  expect(mock.fetch.mock.calls.filter((c) => c[0] === bad)).toHaveLength(3);
  mock.details.mockRejectedValue(new Error("Retry must not resolve a new snapshot"));
  mock.fetch.mockReset().mockImplementation(async (url: string) => new Response(bytesFor(url)));
  mock.pages.mockClear();
  await run();
  expect(mock.fetch.mock.calls.map((c) => c[0])).toEqual([bad]);
  expect(mock.pages.mock.calls.map((c) => c[0])).toEqual([id(2)]);
  expect(unzipSync(await fs.readFile(dest))["000002_Chapter_10/00002.png"]).toBeDefined();
});
it("cancels without final CBZ and retries cached completed pages", async () => {
  const controller = new AbortController();
  await expect(
    downloadMangaCollection(
      request(),
      dest,
      (value) => {
        if (value.pageDone === 1 && value.phase === "downloading") controller.abort();
      },
      () => {},
      controller.signal,
    ),
  ).rejects.toThrow(/cancelled/);
  expect(await exists()).toBe(false);
  mock.fetch.mockClear();
  await run();
  expect(mock.fetch).toHaveBeenCalledTimes(3);
});
it("rechecks and redownloads a damaged cache page", async () => {
  const controller = new AbortController();
  await expect(
    downloadMangaCollection(
      request(),
      dest,
      (value) => {
        if (value.pageDone === 1) controller.abort();
      },
      () => {},
      controller.signal,
    ),
  ).rejects.toThrow();
  const page = path.join(root, ".flyx-manga-cache", jobId, "000001", "00001.png");
  await fs.writeFile(page, "changed");
  mock.fetch.mockClear();
  await run();
  expect(mock.fetch).toHaveBeenCalledTimes(4);
});
it("rejects source page-count changes across Retry", async () => {
  const controller = new AbortController();
  await expect(
    downloadMangaCollection(
      request(),
      dest,
      (value) => {
        if (value.pageDone === 1) controller.abort();
      },
      () => {},
      controller.signal,
    ),
  ).rejects.toThrow();
  mock.pages.mockResolvedValue([{ pageNumber: 1, imageUrl: "https://fixture.example/new.png" }]);
  await expect(run()).rejects.toThrow(/changed its page count/);
  expect(await exists()).toBe(false);
});
it("rejects non-images and caps total size without exposing a final file", async () => {
  mock.fetch.mockResolvedValue(new Response("<html>challenge</html>"));
  await expect(run()).rejects.toThrow(/non-image/);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(await exists()).toBe(false);
  mock.fetch.mockImplementation(async (url: string) => new Response(bytesFor(url)));
  await expect(run(undefined, { maxBytes: 100 })).rejects.toThrow(/size limit/);
  expect(await exists()).toBe(false);
});
it("never overwrites an existing final file, and cache removal preserves final files", async () => {
  await fs.writeFile(dest, "existing file");
  await expect(run()).rejects.toThrow(/already exists/);
  expect(await fs.readFile(dest, "utf8")).toBe("existing file");
  await discardMangaCollectionCache(root, jobId);
  expect(await exists()).toBe(true);
});
it("recovers a published archive after an interrupted history update and detects later replacement", async () => {
  const first = await run();
  mock.fetch.mockClear();
  const recovered = await run();
  expect(recovered).toEqual(first);
  expect(mock.fetch).not.toHaveBeenCalled();
  const bytes = await fs.readFile(dest);
  bytes[100] ^= 1;
  await fs.writeFile(dest, bytes);
  await expect(run()).rejects.toThrow(/archive changed/);
  expect(await exists()).toBe(true);
});
it("rejects a symlinked job cache and never removes its target", async () => {
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "kept");
  const base = path.join(root, ".flyx-manga-cache");
  await fs.mkdir(base);
  await fs.symlink(outside, path.join(base, jobId));
  await expect(run()).rejects.toThrow(/unsafe/);
  await discardMangaCollectionCache(root, jobId);
  expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("kept");
  expect(mock.details).not.toHaveBeenCalled();
});
it("fetches conservatively with no overlapping page requests", async () => {
  let active = 0,
    maximum = 0;
  mock.fetch.mockImplementation(async (url: string) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Response(bytesFor(url));
  });
  await run();
  expect(maximum).toBe(1);
});

it("cancels while packing, removes its partial archive and retries without refetching completed chapters", async () => {
  const controller = new AbortController();
  await expect(
    downloadMangaCollection(
      request(),
      dest,
      (value) => {
        if (value.phase === "packing" && value.pageDone === 1) controller.abort();
      },
      () => {},
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(await exists()).toBe(false);
  expect(await exists(path.join(root, ".flyx-manga-cache", jobId, "archive.part"))).toBe(false);
  mock.fetch.mockClear();
  mock.pages.mockClear();
  await run();
  expect(mock.fetch).not.toHaveBeenCalled();
  expect(mock.pages).not.toHaveBeenCalled();
  expect(
    progress.filter((value) => value.phase === "packing").map((value) => value.pageDone),
  ).toEqual([0, 1, 2, 3, 4]);
});
it("detects a same-sized page replacement after cache verification and never publishes it", async () => {
  await expect(
    downloadMangaCollection(
      request(),
      dest,
      (value) => {
        if (value.phase === "packing" && value.pageDone === 0) {
          const file = path.join(root, ".flyx-manga-cache", jobId, "000001", "00001.png");
          const bytes = fsSync.readFileSync(file);
          bytes[30] ^= 1;
          fsSync.writeFileSync(file, bytes);
        }
      },
      () => {},
    ),
  ).rejects.toThrow(/changed while packaging/);
  expect(await exists()).toBe(false);
  mock.fetch.mockClear();
  await run();
  expect(mock.fetch).toHaveBeenCalledTimes(1);
});
it("preserves a destination created by another writer at publication time", async () => {
  const link = vi.spyOn(fs, "link").mockImplementationOnce(async (_source, target) => {
    await fs.writeFile(target, "another writer");
    const error = new Error("destination exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  });
  try {
    await expect(run()).rejects.toThrow(/destination exists/);
    expect(await fs.readFile(dest, "utf8")).toBe("another writer");
  } finally {
    link.mockRestore();
  }
});
it("fails clearly on a filesystem without hard links and retains retryable pages", async () => {
  const link = vi
    .spyOn(fs, "link")
    .mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }));
  try {
    await expect(run()).rejects.toThrow(/APFS/);
    expect(await exists()).toBe(false);
  } finally {
    link.mockRestore();
  }
  mock.fetch.mockClear();
  await run();
  expect(mock.fetch).not.toHaveBeenCalled();
});
it("rejects truncated PNG and oversized page bodies", async () => {
  mock.fetch.mockImplementation(async () => new Response(png.subarray(0, 40)));
  await expect(run()).rejects.toThrow(/non-image/);
  expect(await exists()).toBe(false);
  mock.fetch.mockImplementation(
    async () =>
      new Response("small body", { headers: { "content-length": String(21 * 1024 * 1024) } }),
  );
  await expect(run()).rejects.toThrow(/exceeds/);
  expect(await exists()).toBe(false);
});
it("caps chapters/pages and refuses duplicate or unsafe archive names", async () => {
  expect(() =>
    collectionPlan(
      "fixture",
      details(Array.from({ length: 10_001 }, (_, index) => chapter(index, index))),
      request(),
    ),
  ).toThrow(/too large/);
  mock.pages.mockResolvedValue(
    Array.from({ length: 1000 }, (_, index) => ({
      pageNumber: index + 1,
      imageUrl: "https://fixture.example/page.png",
    })),
  );
  await expect(run()).rejects.toThrow(/invalid page list/);
  expect(mock.fetch).not.toHaveBeenCalled();
  const plan = collectionPlan("fixture", details(), request());
  for (const name of [
    "../outside.png",
    "/absolute.png",
    "000001_Chapter_1/../../outside.png",
    "000001_Chapter_1/00001.png\n",
  ])
    await expect(
      writeCollectionArchive(
        path.join(root, "unsafe.part"),
        [{ file: dest, size: 1, hash: "", archiveName: name }],
        plan,
        undefined,
        {},
      ),
    ).rejects.toThrow(/archive page path/);
  expect(await exists(path.join(root, "unsafe.part"))).toBe(false);
});
it("automatically uses ZIP64 above 65535 entries and produces an independently valid archive", async () => {
  const file = path.join(root, "one-synthetic-page.png");
  await fs.writeFile(file, png);
  const hash = createHash("sha256").update(png).digest("hex");
  const chapters = Array.from({ length: 66 }, (_, index) => chapter(index, index));
  const plan = collectionPlan("fixture", details(chapters), request());
  const pages = Array.from({ length: 65_536 }, (_, index) => ({
    file,
    size: png.length,
    hash,
    archiveName: `${String(Math.floor(index / 999) + 1).padStart(6, "0")}_Chapter_${Math.floor(index / 999)}/${String((index % 999) + 1).padStart(5, "0")}.png`,
  }));
  const archive = path.join(root, "large-synthetic.cbz");
  let packed = 0;
  await writeCollectionArchive(archive, pages, plan, undefined, {}, (count) => {
    packed = count;
  });
  expect(packed).toBe(65_536);
  const bytes = await fs.readFile(archive);
  expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  const check = execFileSync(
    "/opt/homebrew/bin/python3",
    [
      "-c",
      "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); a=z.infolist(); assert z.testzip() is None; print(json.dumps({'entries':len(a),'first':a[2].filename,'last':a[-1].filename}))",
      archive,
    ],
    { encoding: "utf8" },
  );
  const actual = JSON.parse(check);
  expect(actual.entries).toBe(65_538);
  expect(actual.first).toBe(pages[0].archiveName);
  expect(actual.last).toBe(pages.at(-1)!.archiveName);
}, 120_000);

it("stops before downloading a chapter that would exceed the total page cap", async () => {
  await expect(run(undefined, { maxPages: 3 })).rejects.toThrow(/total page limit/);
  expect(mock.fetch).toHaveBeenCalledTimes(2);
  expect(await exists()).toBe(false);
});

it("bounds metadata for 10000 Unicode chapter titles so its frozen plan remains retryable", () => {
  const plan = collectionPlan(
    "fixture",
    details(
      Array.from({ length: 10000 }, (_, index) =>
        chapter(index, index, { title: "𠮷".repeat(500), publishedAt: "not a date" }),
      ),
    ),
    request(),
  );
  expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(8 * 1024 * 1024);
  expect(plan.chapters[0].publishedAt).toBeUndefined();
  expect(Array.from(plan.chapters[0].title!).length).toBe(128);
});
