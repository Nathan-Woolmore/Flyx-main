import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { MangaData } from "@flyx/core";
import { getMangaCollectionDetails, getChapterPagesById } from "@flyx/extractors/services";
import { safeFetch, readBodyLimited } from "@/lib/security/safe-fetch";
import { MAX_MANGA_CHAPTER_BYTES, MAX_MANGA_IMAGE_BYTES, MAX_MANGA_PAGES } from "./limits";
import {
  collectionPlan,
  type MangaCollectionPlan,
  type MangaCollectionProgress,
  type MangaCollectionScope,
} from "./manga-collection-types";

export const MAX_COLLECTION_BYTES = 20 * 1024 ** 3;
const MAX_COLLECTION_PAGES = 100_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
class PermanentCollectionError extends Error {}
interface PageRecord {
  name: string;
  size: number;
  hash: string;
  urlHash: string;
}
interface ChapterJournal {
  version: 1;
  chapterId: string;
  total: number;
  complete: boolean;
  pages: PageRecord[];
}
interface PageFile {
  file: string;
  archiveName: string;
  size: number;
  hash: string;
}
export interface CollectionRequest extends MangaCollectionScope {
  mangaId: string;
  jobId: string;
  title?: string;
  plan?: MangaCollectionPlan;
}
interface Options {
  maxBytes?: number;
  forceZip64?: boolean;
  maxPages?: number;
}

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("cancelled");
}
async function wait(ms: number, signal?: AbortSignal) {
  abort(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
async function retry<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    abort(signal);
    try {
      return await task();
    } catch (error) {
      abort(signal);
      if (attempt >= 2 || error instanceof PermanentCollectionError) throw error;
      await wait(250 * 2 ** attempt, signal);
    }
  }
}

async function directoryAt(parent: string, name: string): Promise<string> {
  const dest = path.join(parent, name);
  await fsp.mkdir(dest, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fsp.lstat(dest);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    path.dirname(await fsp.realpath(dest)) !== (await fsp.realpath(parent))
  )
    throw new PermanentCollectionError("Download cache location is unsafe.");
  return dest;
}
async function fileBytes(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fsp.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new PermanentCollectionError("Download cache file is invalid.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function jsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await fileBytes(file, 8 * 1024 * 1024)).toString("utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PermanentCollectionError(
      "Download cache metadata is damaged. Remove this unfinished entry and start again.",
    );
  }
}
async function atomicFile(file: string, bytes: Uint8Array | string) {
  const temporary = `${file}.writing`;
  await fsp.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const handle = await fsp.open(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, file);
}
async function writeJson(file: string, value: unknown) {
  await atomicFile(file, JSON.stringify(value));
}
function validatePlan(plan: MangaCollectionPlan, req: CollectionRequest): MangaCollectionPlan {
  if (
    !plan ||
    plan.version !== 1 ||
    plan.source !== "weebcentral" ||
    plan.mangaId !== req.mangaId ||
    plan.language !== req.language ||
    plan.edition !== req.edition ||
    !Array.isArray(plan.chapters) ||
    !Number.isFinite(Date.parse(plan.createdAt))
  )
    throw new PermanentCollectionError("Saved chapter selection no longer matches this download.");
  const checked = collectionPlan(
    req.mangaId,
    {
      id: plan.mangaId,
      title: plan.title,
      chapters: plan.chapters.map((chapter) => ({
        ...chapter,
        pageCount: 0,
        language: plan.language,
        edition: plan.edition,
      })),
    } as MangaData,
    req,
    plan.createdAt,
  );
  if (JSON.stringify(checked.chapters) !== JSON.stringify(plan.chapters))
    throw new PermanentCollectionError("Saved chapter order is inconsistent.");
  return plan;
}
function imageType(bytes: Uint8Array): "png" | "jpg" | "webp" {
  const data = Buffer.from(bytes);
  if (
    data.length >= 45 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 &&
    data.toString("ascii", 12, 16) === "IHDR" &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(20) > 0
  ) {
    let hasData = false;
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset),
        tag = data.toString("ascii", offset + 4, offset + 8);
      if (length > data.length - offset - 12) break;
      if (tag === "IDAT") hasData = true;
      if (tag === "IEND" && length === 0 && hasData) return "png";
      offset += length + 12;
    }
  }
  if (
    data.length >= 8 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255 &&
    data.at(-2) === 255 &&
    data.at(-1) === 217
  )
    return "jpg";
  if (
    data.length >= 20 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(data.toString("ascii", 12, 16))
  )
    return "webp";
  throw new PermanentCollectionError("The source returned a non-image page.");
}
async function image(url: string, signal?: AbortSignal) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const response = await safeFetch(url, {
    signal: requestSignal,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "image/png,image/jpeg,image/webp" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Page request failed (HTTP ${response.status})`);
  }
  const bytes = await readBodyLimited(response, MAX_MANGA_IMAGE_BYTES);
  if (!bytes.length) throw new PermanentCollectionError("The source returned an empty page.");
  return { bytes, ext: imageType(bytes) };
}
async function cachedPage(
  folder: string,
  record: PageRecord | undefined,
  number: number,
): Promise<string | null> {
  if (
    !record ||
    !new RegExp(`^${String(number).padStart(5, "0")}\\.(png|jpg|webp)$`).test(record.name) ||
    !/^[a-f0-9]{64}$/.test(record.hash) ||
    !Number.isSafeInteger(record.size) ||
    record.size <= 0 ||
    record.size > MAX_MANGA_IMAGE_BYTES
  )
    return null;
  const file = path.join(folder, record.name);
  try {
    const bytes = await fileBytes(file, MAX_MANGA_IMAGE_BYTES);
    return bytes.length === record.size && sha(bytes) === record.hash ? file : null;
  } catch {
    return null;
  }
}
const xml = (value: unknown) =>
  String(value ?? "")
    // eslint-disable-next-line no-control-regex -- XML 1.0 excludes these control characters
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
    );

export async function writeCollectionArchive(
  part: string,
  pages: PageFile[],
  plan: MangaCollectionPlan,
  signal: AbortSignal | undefined,
  options: Options,
  onPacked: (pages: number) => void = () => {},
) {
  const archiveNames = new Set<string>();
  for (const page of pages) {
    if (
      !/^\d{6}_Chapter_[0-9.e+-]+\/\d{5}\.(png|jpg|webp)$/.test(page.archiveName) ||
      page.archiveName.includes("\n") ||
      archiveNames.has(page.archiveName)
    )
      throw new PermanentCollectionError("Invalid or duplicate archive page path.");
    archiveNames.add(page.archiveName);
  }
  const zip = new ZipFile();
  let active: Readable | undefined;
  let source: Readable | undefined;
  let packed = 0;
  let size = 0;
  const hash = createHash("sha256");
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > (options.maxBytes ?? MAX_COLLECTION_BYTES) + 64 * 1024 * 1024) {
        callback(new PermanentCollectionError("The combined CBZ exceeds the archive size limit."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const output = fs.createWriteStream(part, { flags: "wx", mode: 0o600 });
  zip.on("error", (error: Error) => zip.outputStream.destroy(error));
  const cancel = () => {
    source?.destroy(new Error("cancelled"));
    active?.destroy(new Error("cancelled"));
    zip.outputStream.destroy(new Error("cancelled"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const writing = pipeline(zip.outputStream, meter, output, { signal });
  void writing.catch(() => undefined);
  try {
    const mtime = new Date(plan.createdAt);
    const pageCounts = new Map<string, number>();
    for (const page of pages) {
      const folder = page.archiveName.split("/")[0];
      pageCounts.set(folder, (pageCounts.get(folder) || 0) + 1);
    }
    const comicInfo = `<?xml version="1.0" encoding="UTF-8"?><ComicInfo><Series>${xml(plan.title)}</Series><Title>${xml(plan.title)} — available chapters</Title><LanguageISO>${xml(plan.language)}</LanguageISO><PageCount>${pages.length}</PageCount><Summary>${plan.chapters.length} available ${xml(plan.edition)} chapters from WeebCentral, snapshot ${xml(plan.createdAt)}. See flyx-manifest.json for the exact chapter list.</Summary><Web>https://weebcentral.com</Web></ComicInfo>`;
    zip.addBuffer(Buffer.from(comicInfo), "ComicInfo.xml", { compress: false, mtime });
    zip.addBuffer(
      Buffer.from(
        JSON.stringify(
          {
            ...plan,
            pageCount: pages.length,
            chapters: plan.chapters.map((chapter, index) => ({
              ...chapter,
              folder: `${String(index + 1).padStart(6, "0")}_Chapter_${chapter.number}`,
              pages:
                pageCounts.get(`${String(index + 1).padStart(6, "0")}_Chapter_${chapter.number}`) ||
                0,
            })),
          },
          null,
          2,
        ),
      ),
      "flyx-manifest.json",
      { compress: false, mtime },
    );
    for (const page of pages) {
      zip.addReadStreamLazy(
        page.archiveName,
        { size: page.size, compress: false, mtime },
        (done) => {
          void (async () => {
            abort(signal);
            const handle = await fsp.open(
              page.file,
              fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
            );
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size !== page.size) {
              await handle.close();
              throw new Error("A cached page changed while packaging.");
            }
            source = handle.createReadStream({ autoClose: true, signal });
            const pageHash = createHash("sha256");
            const verified = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                pageHash.update(chunk);
                callback(null, chunk);
              },
              flush(callback) {
                if (pageHash.digest("hex") !== page.hash) {
                  callback(
                    new Error(
                      "A cached page changed while packaging. Retry to verify the saved pages.",
                    ),
                  );
                  return;
                }
                onPacked(++packed);
                callback();
              },
            });
            active = verified;
            void pipeline(source, verified, { signal }).catch((error: Error) =>
              zip.outputStream.destroy(error),
            );
            done(null, verified);
          })().catch((error: Error) => done(error));
        },
      );
    }
    zip.end({ forceZip64Format: options.forceZip64 });
    await writing;
    return { size, hash: hash.digest("hex") };
  } finally {
    signal?.removeEventListener("abort", cancel);
    active?.destroy();
    source?.destroy();
  }
}

/** One CBZ for a frozen exact chapter/edition selection. No final file is exposed on partial failure. */
export async function downloadMangaCollection(
  req: CollectionRequest,
  dest: string,
  onProgress: (progress: MangaCollectionProgress) => void,
  onPlan: (plan: MangaCollectionPlan) => void,
  signal?: AbortSignal,
  options: Options = {},
): Promise<{ chapters: number; pages: number; bytes: number }> {
  if (
    !uuid.test(req.jobId) ||
    !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(req.language) ||
    !["official", "community"].includes(req.edition)
  )
    throw new PermanentCollectionError("Invalid manga collection selection.");
  const root = path.dirname(path.resolve(dest));
  const base = await directoryAt(root, ".flyx-manga-cache");
  const work = await directoryAt(base, req.jobId);
  const part = path.join(work, "archive.part");
  let progress: MangaCollectionProgress = {
    phase: "resolving",
    chaptersDone: 0,
    chaptersTotal: 0,
    pageDone: 0,
    pageTotal: 0,
    bytes: 0,
  };
  const report = (update: Partial<MangaCollectionProgress>) => {
    progress = { ...progress, ...update };
    onProgress(progress);
  };
  report({});
  abort(signal);
  let plan = await jsonFile<MangaCollectionPlan>(path.join(work, "plan.json"));
  if (plan) plan = validatePlan(plan, req);
  else {
    plan = req.plan
      ? validatePlan(req.plan, req)
      : collectionPlan(
          req.mangaId,
          await retry(() => getMangaCollectionDetails(req.mangaId, signal), signal),
          req,
        );
    await writeJson(path.join(work, "plan.json"), plan);
  }
  onPlan(plan);
  report({ chaptersTotal: plan.chapters.length });
  const published = await jsonFile<{ filename: string; hash: string; size: number; pages: number }>(
    path.join(work, "published.json"),
  );
  const existing = await fsp.lstat(dest).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      !published ||
      published.filename !== path.basename(dest) ||
      existing.size !== published.size ||
      !Number.isSafeInteger(published.pages) ||
      published.pages <= 0
    )
      throw new PermanentCollectionError(
        "A file already exists at this destination; it was preserved.",
      );
    const hash = createHash("sha256");
    const handle = await fsp.open(
      dest,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== published.size)
        throw new PermanentCollectionError("The saved archive changed; it was preserved.");
      for await (const bytes of handle.createReadStream({ autoClose: false, signal }))
        hash.update(bytes as Buffer);
    } finally {
      await handle.close();
    }
    if (hash.digest("hex") !== published.hash)
      throw new PermanentCollectionError("The saved archive changed; it was preserved.");
    report({
      phase: "packing",
      chaptersDone: plan.chapters.length,
      pageDone: published.pages,
      pageTotal: published.pages,
      bytes: existing.size,
    });
    return { chapters: plan.chapters.length, pages: published.pages, bytes: existing.size };
  }
  const files: PageFile[] = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < plan.chapters.length; index++) {
      abort(signal);
      const chapter = plan.chapters[index];
      const prefix = `${String(index + 1).padStart(6, "0")}_Chapter_${chapter.number}`;
      const folder = await directoryAt(work, String(index + 1).padStart(6, "0"));
      const journalPath = path.join(folder, "pages.json");
      let journal = await jsonFile<ChapterJournal>(journalPath);
      if (
        journal &&
        (journal.version !== 1 ||
          journal.chapterId !== chapter.id ||
          !Array.isArray(journal.pages) ||
          !Number.isSafeInteger(journal.total) ||
          journal.total <= 0 ||
          journal.total > MAX_MANGA_PAGES)
      )
        throw new PermanentCollectionError("Cached chapter metadata is inconsistent.");
      report({
        phase: "checking",
        currentChapter: chapter.number,
        pageDone: 0,
        pageTotal: journal?.total || 0,
      });
      let cached: string[] | null = null;
      if (journal?.complete && journal.pages.length === journal.total) {
        cached = [];
        for (let pageIndex = 0; pageIndex < journal.total; pageIndex++) {
          abort(signal);
          const hit = await cachedPage(folder, journal.pages[pageIndex], pageIndex + 1);
          if (!hit) {
            cached = null;
            break;
          }
          cached.push(hit);
        }
      }
      if (!cached) {
        const pages = await retry(() => getChapterPagesById(chapter.id, signal), signal).catch(
          (error) => {
            abort(signal);
            throw new Error(
              `Chapter ${chapter.number} page list failed: ${(error as Error).message}. Completed pages are kept for Retry.`,
            );
          },
        );
        if (
          !pages.length ||
          pages.length > MAX_MANGA_PAGES ||
          pages.some((page, i) => page.pageNumber !== i + 1)
        )
          throw new PermanentCollectionError(`Chapter ${chapter.number} has an invalid page list.`);
        if (files.length + pages.length > (options.maxPages ?? MAX_COLLECTION_PAGES))
          throw new PermanentCollectionError("The manga collection exceeds the total page limit.");
        if (journal && journal.total !== pages.length)
          throw new PermanentCollectionError(
            `Chapter ${chapter.number} changed its page count. Start a fresh collection to avoid mixing versions.`,
          );
        journal = journal || {
          version: 1,
          chapterId: chapter.id,
          total: pages.length,
          complete: false,
          pages: [],
        };
        cached = [];
        let chapterBytes = 0;
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
          abort(signal);
          const page = pages[pageIndex];
          const urlHash = sha(page.imageUrl);
          const record = journal.pages[pageIndex];
          let hit =
            record?.urlHash === urlHash ? await cachedPage(folder, record, pageIndex + 1) : null;
          if (!hit) {
            report({ phase: "downloading", pageDone: pageIndex, pageTotal: pages.length });
            try {
              const result = await retry(() => image(page.imageUrl, signal), signal);
              if (
                totalBytes + chapterBytes + result.bytes.length >
                  (options.maxBytes ?? MAX_COLLECTION_BYTES) ||
                chapterBytes + result.bytes.length > MAX_MANGA_CHAPTER_BYTES
              )
                throw new PermanentCollectionError(
                  "The manga collection exceeds the download size limit.",
                );
              const name = `${String(pageIndex + 1).padStart(5, "0")}.${result.ext}`;
              hit = path.join(folder, name);
              await atomicFile(hit, result.bytes);
              journal.pages[pageIndex] = {
                name,
                size: result.bytes.length,
                hash: sha(result.bytes),
                urlHash,
              };
              journal.complete = false;
              await writeJson(journalPath, journal);
            } catch (error) {
              abort(signal);
              throw new Error(
                `Chapter ${chapter.number}, page ${pageIndex + 1} failed: ${(error as Error).message}. Completed pages are kept for Retry.`,
              );
            }
          }
          cached.push(hit);
          chapterBytes += journal.pages[pageIndex].size;
          report({
            phase: "downloading",
            pageDone: pageIndex + 1,
            pageTotal: pages.length,
            bytes: totalBytes + chapterBytes,
          });
        }
        journal.complete = true;
        await writeJson(journalPath, journal);
      }
      let chapterSize = 0;
      for (let pageIndex = 0; pageIndex < cached.length; pageIndex++) {
        const record = journal!.pages[pageIndex];
        chapterSize += record.size;
        files.push({
          file: cached[pageIndex],
          size: record.size,
          hash: record.hash,
          archiveName: `${prefix}/${record.name}`,
        });
      }
      if (chapterSize > MAX_MANGA_CHAPTER_BYTES)
        throw new PermanentCollectionError(
          `Chapter ${chapter.number} exceeds the chapter size limit.`,
        );
      totalBytes += chapterSize;
      if (
        totalBytes > (options.maxBytes ?? MAX_COLLECTION_BYTES) ||
        files.length > (options.maxPages ?? MAX_COLLECTION_PAGES)
      )
        throw new PermanentCollectionError(
          "The manga collection exceeds the download size/page limit.",
        );
      report({
        phase: "checking",
        chaptersDone: index + 1,
        bytes: totalBytes,
        pageDone: cached.length,
        pageTotal: cached.length,
      });
    }
    abort(signal);
    report({ phase: "packing", pageDone: 0, pageTotal: files.length });
    await fsp.unlink(part).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const archive = await writeCollectionArchive(part, files, plan, signal, options, (pageDone) =>
      report({ pageDone }),
    );
    await writeJson(path.join(work, "published.json"), {
      filename: path.basename(dest),
      hash: archive.hash,
      size: archive.size,
      pages: files.length,
    });
    abort(signal);
    await fsp.link(part, dest).catch((error: NodeJS.ErrnoException) => {
      if (["ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(error.code || ""))
        throw new Error(
          "This filesystem cannot publish a CBZ safely. Choose an APFS or Mac OS Extended download folder and start a fresh collection.",
        );
      throw error;
    }); // publish without overwriting any existing saved file
    await fsp.unlink(part);
    return { chapters: plan.chapters.length, pages: files.length, bytes: archive.size };
  } catch (error) {
    await fsp.unlink(part).catch(() => undefined);
    throw error;
  }
}

/** Only this queue job's private unfinished cache; completed CBZ files are never removed. */
export async function discardMangaCollectionCache(root: string, jobId: string) {
  if (!uuid.test(jobId)) return;
  const base = path.join(path.resolve(root), ".flyx-manga-cache"),
    work = path.join(base, jobId);
  try {
    const [a, b] = await Promise.all([fsp.lstat(base), fsp.lstat(work)]);
    if (
      !a.isDirectory() ||
      a.isSymbolicLink() ||
      !b.isDirectory() ||
      b.isSymbolicLink() ||
      path.dirname(await fsp.realpath(base)) !== (await fsp.realpath(root)) ||
      path.dirname(await fsp.realpath(work)) !== (await fsp.realpath(base))
    )
      return;
    await fsp.rm(work, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
