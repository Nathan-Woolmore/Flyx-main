/**
 * Download job manager — in-memory queue with a small JSON history file so
 * the Downloads page survives restarts. Concurrency is capped because ffmpeg
 * remuxes and CDN pulls are heavy.
 *
 * State lives on globalThis: Next.js bundles each route handler separately,
 * so a plain module-level Map could be duplicated between /api/downloads and
 * /api/downloads/[id]. A process-global singleton guarantees they share one
 * queue.
 */

import fs from "node:fs";
import { trashManagedDownload } from "./trash-file";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localFileRevision, openLocalDownload, trashingDownloads } from "./local-files";
import { downloadIdentity, localIdentityKey } from "./local-identity";
import {
  assertRelinkUnambiguous,
  LocalRelinkError,
  relinkContext,
  validateLocalRelink,
} from "./local-relink";
import {
  ensureDownloadDir,
  getDownloadDir,
  buildFilename,
  sanitizeFilename,
  type DownloadItemInput,
  type DownloadJob,
} from "./types";
import { downloadVideo, type VideoDownloadRequest } from "./video";
import { downloadMangaChapter, type MangaDownloadRequest } from "./manga";
import { downloadMangaCollection, discardMangaCollectionCache } from "./manga-collection";

const MAX_CONCURRENT = 2;

const HISTORY_DIR = process.env.FLYX_DATA_DIR
  ? path.resolve(process.env.FLYX_DATA_DIR)
  : path.resolve(process.cwd(), ".flyx");
const HISTORY_PATH = path.join(HISTORY_DIR, "downloads.json");

interface DownloadState {
  jobs: Map<string, DownloadJob>;
  queue: string[];
  controllers: Map<string, AbortController>;
  active: number;
  initialized: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  admission?: Promise<void>;
  removing?: Set<string>;
}

const g = globalThis as unknown as { __flyxDownloads?: DownloadState };
const state: DownloadState = (g.__flyxDownloads ??= {
  jobs: new Map(),
  queue: [],
  controllers: new Map(),
  active: 0,
  initialized: false,
  persistTimer: null,
});

// ── Persistence ──────────────────────────────────────────────────

function persist(): boolean {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(
      HISTORY_PATH,
      JSON.stringify(Array.from(state.jobs.values()), null, 2),
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

// Progress updates fire frequently (ffmpeg emits ~2/sec per job) — debounce
// the JSON history write so we don't hammer the disk mid-download.
function schedulePersist(): void {
  if (state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    persist();
  }, 1000);
}

function persistNow(): boolean {
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }
  return persist();
}

function init(): void {
  if (state.initialized) return;
  state.initialized = true;
  try {
    if (!fs.existsSync(HISTORY_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
    if (!Array.isArray(raw)) return;
    for (const j of raw) {
      if (!j || typeof j.id !== "string") continue;
      // A running job at shutdown can't resume — mark it as interrupted.
      if (j.status === "queued" || j.status === "downloading" || j.status === "processing") {
        j.status = "error";
        j.error = "Interrupted — the app restarted";
        j.updatedAt = Date.now();
      }
      state.jobs.set(j.id, j as DownloadJob);
    }
  } catch {
    /* corrupt history — start fresh */
  }
}

// ── Job construction ─────────────────────────────────────────────

function buildJob(item: DownloadItemInput): DownloadJob {
  const now = Date.now();
  const base: DownloadJob = {
    id: randomUUID(),
    kind: item.kind,
    label: "",
    status: "queued",
    progress: 0,
    bytes: 0,
    totalBytes: 0,
    outTimeMs: 0,
    createdAt: now,
    updatedAt: now,
  };

  if (item.kind === "video") {
    base.tmdbId = item.tmdbId;
    base.mediaType = item.mediaType;
    base.season = item.season;
    base.episode = item.episode;
    base.malId = item.malId;
    base.provider = item.provider;
    base.quality = item.quality;
    base.language = item.language;
    base.durationSec = item.durationSec;
    base.filename = buildFilename(item, base.id);
    if (item.mediaType === "tv" && item.season != null && item.episode != null) {
      const e = String(item.episode).padStart(2, "0");
      // Anime uses absolute episode numbers (no season), e.g. "E05".
      if (item.malId) {
        base.label = `${item.title || "Episode"} — E${e}`;
      } else {
        const s = String(item.season).padStart(2, "0");
        base.label = `${item.title || "Episode"} — S${s}E${e}`;
      }
    } else {
      base.label = item.title || "Movie";
    }
  } else {
    base.mangaId = item.mangaId;
    base.chapter = item.chapter;
    base.collection = item.collection;
    base.filename = buildFilename(item, item.collection ? base.id : undefined);
    base.label = item.collection
      ? `${item.title || "Manga"} — Available chapters (${item.collection.language}, ${item.collection.edition})`
      : `${item.title || "Manga"} — Chapter ${item.chapter}`;
  }

  return base;
}

// ── Processing ───────────────────────────────────────────────────

function patch(id: string, p: Partial<DownloadJob>, { immediate = false } = {}): void {
  const job = state.jobs.get(id);
  if (!job) return;
  Object.assign(job, p, { updatedAt: Date.now() });
  if (immediate) persistNow();
  else schedulePersist();
}

async function runJob(id: string): Promise<void> {
  // Release the queue slot on every path, including early returns.
  try {
    await runJobInner(id);
  } finally {
    state.active -= 1;
    pump();
  }
}

async function runJobInner(id: string): Promise<void> {
  const job = state.jobs.get(id);
  if (!job) return;

  const dir = getDownloadDir();
  if (job.collectionRoot && path.resolve(dir) !== job.collectionRoot) {
    patch(
      id,
      {
        status: "error",
        error:
          "The download folder changed. Restore the original folder to retry, or start a fresh collection.",
      },
      { immediate: true },
    );
    return;
  }
  try {
    if (job.collectionRoot && !fs.statSync(dir).isDirectory())
      throw new Error("Original folder is unavailable");
    ensureDownloadDir(dir);
  } catch (err) {
    patch(
      id,
      { status: "error", error: `Cannot create download folder: ${(err as Error).message}` },
      { immediate: true },
    );
    return;
  }

  // Absolute (never starts with "-", so ffmpeg can't read it as an option)
  // and confined to the download folder: the filename is sanitized, but
  // re-check in case it came from somewhere else.
  const root = path.resolve(dir);
  const dest = path.resolve(root, sanitizeFilename(job.filename || `${id}.download`));
  if (path.dirname(dest) !== root) {
    patch(id, { status: "error", error: "Invalid download filename" }, { immediate: true });
    return;
  }
  const controller = new AbortController();
  state.controllers.set(id, controller);
  if (job.collection) patch(id, { collectionRoot: root }, { immediate: true });

  try {
    if (job.kind === "video") {
      const req: VideoDownloadRequest = {
        tmdbId: job.tmdbId!,
        mediaType: job.mediaType!,
        season: job.season,
        episode: job.episode,
        malId: job.malId,
        title: job.label,
        provider: job.provider,
        durationSec: job.durationSec,
        quality: job.quality,
        language: job.language,
      };
      await downloadVideo(
        req,
        dest,
        ({ bytes, totalBytes, outTimeMs, durationSec }) => {
          let progress = 0;
          if (totalBytes > 0) progress = Math.min(99, Math.round((bytes / totalBytes) * 100));
          else if (durationSec && outTimeMs > 0) {
            progress = Math.min(99, Math.round((outTimeMs / 1000 / durationSec) * 100));
          }
          patch(id, { status: "downloading", bytes, totalBytes, outTimeMs, progress });
        },
        controller.signal,
      );
    } else if (job.collection) {
      const result = await downloadMangaCollection(
        { ...job.collection, mangaId: job.mangaId!, jobId: id, plan: job.collectionPlan },
        dest,
        (value) => {
          const fraction =
            value.phase === "downloading" && value.pageTotal > 0
              ? value.pageDone / value.pageTotal
              : 0;
          patch(id, {
            status: value.phase === "packing" ? "processing" : "downloading",
            collectionProgress: value,
            bytes: value.bytes,
            totalBytes: 0,
            progress: value.chaptersTotal
              ? Math.min(
                  99,
                  Math.floor(
                    ((value.chaptersDone +
                      (value.chaptersDone < value.chaptersTotal ? fraction : 0)) /
                      value.chaptersTotal) *
                      99,
                  ),
                )
              : 0,
          });
        },
        (plan) => patch(id, { collectionPlan: plan }, { immediate: true }),
        controller.signal,
      );
      patch(id, {
        bytes: result.bytes,
        totalBytes: result.bytes,
        collectionProgress: {
          phase: "packing",
          chaptersDone: result.chapters,
          chaptersTotal: result.chapters,
          pageDone: result.pages,
          pageTotal: result.pages,
          bytes: result.bytes,
        },
      });
    } else {
      const req: MangaDownloadRequest = {
        mangaId: job.mangaId!,
        chapter: job.chapter!,
        title: job.label,
      };
      await downloadMangaChapter(
        req,
        dest,
        ({ done, total }) => {
          patch(id, {
            status: "downloading",
            progress: Math.min(99, Math.round((done / total) * 100)),
            totalBytes: total,
            bytes: done,
          });
        },
        controller.signal,
      );
    }

    patch(
      id,
      {
        status: "done",
        progress: 100,
        filepath: dest,
        error: undefined,
        fileRevision:
          localFileRevision(fs.statSync(dest, { bigint: true })),
      },
      { immediate: true },
    );
    // Keep recovery metadata if the history write failed. Never remove the final CBZ.
    if (job.collection && persistNow())
      await discardMangaCollectionCache(root, id).catch(() => undefined);
  } catch (err) {
    if (controller.signal.aborted) {
      patch(id, { status: "cancelled" }, { immediate: true });
    } else {
      patch(id, { status: "error", error: (err as Error).message }, { immediate: true });
    }
    try {
      if (!job.collection && fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {
      /* partial file may be locked/absent */
    }
  } finally {
    state.controllers.delete(id);
    if (job.collection && !state.jobs.has(id))
      await discardMangaCollectionCache(root, id).catch(() => undefined);
  }
}

function pump(): void {
  while (state.active < MAX_CONCURRENT && state.queue.length > 0) {
    const id = state.queue.shift();
    if (!id) break;
    const job = state.jobs.get(id);
    if (!job || job.status !== "queued") continue;
    state.active += 1;
    void runJob(id);
  }
}

// ── Public API ───────────────────────────────────────────────────

export function listJobs(): DownloadJob[] {
  init();
  return Array.from(state.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getJob(id: string): DownloadJob | null {
  init();
  return state.jobs.get(id) || null;
}

export function createJobs(items: DownloadItemInput[]): DownloadJob[] {
  init();
  const created: DownloadJob[] = [];
  for (const item of items) {
    const job = buildJob(item);
    state.jobs.set(job.id, job);
    state.queue.push(job.id);
    created.push(job);
  }
  persistNow();
  pump();
  return created;
}

/** Serialize queue admission across route bundles; persisted jobs also protect after restart. */
export async function createOrReuseJobs(items: DownloadItemInput[]): Promise<DownloadJob[]> {
  init();
  const before = state.admission ?? Promise.resolve();
  let release!: () => void;
  state.admission = new Promise<void>(resolve => { release = resolve; });
  await before.catch(() => undefined);
  try {
    const result: DownloadJob[] = [];
    for (const item of items) {
      const identity = item.kind === "video"
        ? downloadIdentity({ ...item, status: "done" } as DownloadJob) : null;
      let existing: DownloadJob | undefined;
      if (identity) {
        for (const job of listJobs()) {
          const other = downloadIdentity({ ...job, status: "done" });
          if (!other || localIdentityKey(other) !== localIdentityKey(identity)) continue;
          if (["queued", "downloading", "processing"].includes(job.status)) { existing = job; break; }
          if (job.status === "done") {
            const file = await openLocalDownload(job, listJobs(), getDownloadDir());
            if (file) { await file.handle.close(); const current=state.jobs.get(job.id); if(current?.status === "done" && current.fileRevision === file.revision){ existing = current; break; } }
          }
        }
      }
      result.push(existing ?? createJobs([item])[0]!);
    }
    return result;
  } finally { release(); }
}

export function cancelJob(id: string): boolean {
  init();
  const job = state.jobs.get(id);
  if (!job) return false;

  if (job.status === "queued") {
    const idx = state.queue.indexOf(id);
    if (idx !== -1) state.queue.splice(idx, 1);
    // Already picked up (e.g. still extracting or waiting for an ffmpeg slot).
    state.controllers.get(id)?.abort();
    patch(id, { status: "cancelled" }, { immediate: true });
    return true;
  }
  if (job.status === "downloading" || job.status === "processing") {
    state.controllers.get(id)?.abort();
    return true;
  }
  return false;
}

export function removeJob(id: string): boolean {
  init();
  const job = state.jobs.get(id);
  if (!job) return false;
  if (job.status === "downloading" || job.status === "queued" || job.status === "processing") {
    cancelJob(id);
  }
  state.jobs.delete(id);
  persistNow();
  if (job.collectionRoot && !state.controllers.has(id))
    void discardMangaCollectionCache(job.collectionRoot, id).catch(() => undefined);
  return true;
}

/** The HTTP Remove action reports cache-cleanup failure before dropping its queue row. */
export async function removeJobWithCache(id: string): Promise<boolean> {
  init();
  const job = state.jobs.get(id);
  if (!job) return false;
  const removing = state.removing ??= new Set<string>();
  if (removing.has(id)) throw new Error("This download is already being removed.");
  removing.add(id);
  try {
    if (job.collectionRoot) {
      if (state.controllers.has(id)) throw new Error("Wait for this download to stop before removing it.");
      await discardMangaCollectionCache(job.collectionRoot, id);
    }
    return removeJob(id);
  } finally { removing.delete(id); }
}

/** Keep the record until the native recoverable Trash operation is confirmed. */
export async function trashJob(id:string,revision:unknown):Promise<void>{
 init();const job=state.jobs.get(id),removing=state.removing ??= new Set<string>();
 if(!job||removing.has(id)||state.controllers.has(id)||job.status!=="done")throw new Error("DOWNLOAD_CHANGED");
 removing.add(id);trashingDownloads.add(id);
 try{
  await trashManagedDownload(job,listJobs(),getDownloadDir(),revision);
  // Publish the new history atomically before dropping the in-memory record.
  // If writing or renaming fails, the old history and record remain recoverable.
  const temporary=HISTORY_PATH+".trash-"+randomUUID()+".tmp";
  try{
   fs.mkdirSync(HISTORY_DIR,{recursive:true});
   fs.writeFileSync(temporary,JSON.stringify(listJobs().filter(value=>value.id!==id),null,2),{encoding:"utf8",flag:"wx"});
   fs.renameSync(temporary,HISTORY_PATH);
   state.jobs.delete(id);
  }catch{
   throw new Error("DOWNLOAD_HISTORY_FAILED");
  }finally{try{fs.unlinkSync(temporary);}catch{/* only this operation's temporary history file */}}
 }finally{removing.delete(id);trashingDownloads.delete(id);}
}

/** Reuses the exact chapter snapshot and verified cached pages. */
export function retryCollectionJob(id: string): boolean {
  init();
  const job = state.jobs.get(id);
  if (state.removing?.has(id) || !job?.collection || !["error", "cancelled"].includes(job.status) || state.controllers.has(id))
    return false;
  patch(id, { status: "queued", error: undefined, progress: 0 }, { immediate: true });
  state.queue.push(id);
  pump();
  return true;
}

/** Confirmed association only: update the history record, never write/move/delete the media. */
export async function relinkCompletedDownload(id: string, proof: unknown): Promise<DownloadJob> {
  init();
  const job = state.jobs.get(id);
  const directory = getDownloadDir();
  const file = await validateLocalRelink(job, listJobs(), directory, proof);
  const current = state.jobs.get(id);
  if (!current || relinkContext(current, getDownloadDir()) !== file.context) {
    throw new LocalRelinkError("The download record or folder changed. Check the file again.", 409);
  }
  assertRelinkUnambiguous(current, listJobs(), directory, file.filename);
  patch(
    id,
    {
      filepath: file.filepath,
      filename: file.filename,
      fileRevision: file.revision,
      fileRelinkedAt: Date.now(),
    },
    { immediate: true },
  );
  return state.jobs.get(id)!;
}
