import fs, { type BigIntStats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DownloadJob } from "./types";
import {
  LOCAL_STREAM_PATH,
  localIdentityKey,
  matchesLocalDownload,
  watchUrlForDownload,
  type LocalPlaybackIdentity,
} from "./local-identity";

export function localFileRevision(stat: BigIntStats): string {
  return createHash("sha256")
    .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"))
    .digest("hex");
}

/** Only completed video files bound at completion and directly inside the configured folder. Never enumerate a folder.
 * Legacy history requires an explicit confirmed relink; never bind a possibly replaced file at first playback lookup. */
export async function openLocalDownload(
  job: DownloadJob | undefined,
  jobs: DownloadJob[],
  directory: string,
  revision?: string,
): Promise<{ handle: FileHandle; size: number; revision: string } | null> {
  if (
    !job ||
    !watchUrlForDownload(job) ||
    !job.filepath ||
    ![".mp4", ".m4v"].includes(path.extname(job.filepath).toLowerCase())
  )
    return null;
  const root = path.resolve(directory),
    file = path.resolve(job.filepath);
  if (path.dirname(file) !== root) return null;
  const key = localIdentityKey(job as LocalPlaybackIdentity);
  // A different or in-progress download with the same destination could have overwritten it.
  for (const other of jobs) {
    if (other.id === job.id) continue;
    const otherFile = other.filepath
      ? path.resolve(other.filepath)
      : other.filename && path.basename(other.filename) === other.filename
        ? path.resolve(root, other.filename)
        : null;
    if (otherFile !== file) continue;
    if (["queued", "downloading", "processing", "error", "cancelled"].includes(other.status))
      return null;
    if (localIdentityKey(other as LocalPlaybackIdentity) !== key) return null;
  }
  if (revision && revision !== job.fileRevision) return null;
  return openDownloadFile(root, file, job.fileRevision);
}

/** Open just one explicitly recorded/selected file; callers must authorize the record separately. */
export async function openDownloadFile(
  directory: string,
  filepath: string,
  revision?: string,
): Promise<{ handle: FileHandle; size: number; revision: string; modifiedAt: number } | null> {
  const root = path.resolve(directory),
    file = path.resolve(filepath);
  if (path.dirname(file) !== root || ![".mp4", ".m4v"].includes(path.extname(file).toLowerCase()))
    return null;
  let handle: FileHandle | undefined;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(file);
    if (path.dirname(canonicalFile) !== canonicalRoot) return null;
    handle = await open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    if (
      (await realpath(root)) !== canonicalRoot ||
      path.dirname(await realpath(file)) !== canonicalRoot
    ) {
      await handle.close();
      return null;
    }
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    if (!stat.isFile() || !Number.isSafeInteger(size) || size < 24) {
      await handle.close();
      return null;
    }
    const current = localFileRevision(stat);
    if (revision && current !== revision) {
      await handle.close();
      return null;
    }
    const header = Buffer.alloc(24);
    await handle.read(header, 0, header.length, 0);
    if (
      header.toString("ascii", 4, 8) !== "ftyp" ||
      !/^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|msdh|msix|cmf[cs]|hvc1|hev1)$/.test(
        header.toString("ascii", 8, 12),
      )
    ) {
      await handle.close();
      return null;
    }
    return { handle, size, revision: current, modifiedAt: Number(stat.mtimeMs) };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

export async function findLocalDownloadSources(
  jobs: DownloadJob[],
  directory: string,
  identity: LocalPlaybackIdentity,
) {
  const sources: Array<{
    url: string;
    provider: string;
    type: "mp4";
    title: string;
    quality: string;
    language?: string;
    requiresSegmentProxy: false;
  }> = [];
  const seen = new Set<string>();
  for (const job of [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (
      !matchesLocalDownload(job, identity) ||
      !job.filepath ||
      seen.has(path.resolve(job.filepath))
    )
      continue;
    const file = await openLocalDownload(job, jobs, directory);
    if (!file) continue;
    await file.handle.close();
    seen.add(path.resolve(job.filepath));
    sources.push({
      url: `${LOCAL_STREAM_PATH}?${new URLSearchParams({ id: job.id, rev: file.revision })}`,
      provider: "local",
      type: "mp4",
      title: "Local download",
      quality: job.quality || "Original",
      language: job.language,
      requiresSegmentProxy: false,
    });
  }
  return sources;
}

export function byteRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!value) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;
  if (first === null)
    return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
