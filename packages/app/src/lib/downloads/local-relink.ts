import path from "node:path";
import { createHash } from "node:crypto";
import type { DownloadJob } from "./types";
import { downloadIdentity, localIdentityKey } from "./local-identity";
import { openDownloadFile } from "./local-files";
import { hasValidSignature, signProxyUrl } from "@/lib/security/proxy-sign";

export class LocalRelinkError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Only a basename inside the configured folder; never an arbitrary path or a scan. */
export function validRelinkFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    // eslint-disable-next-line no-control-regex -- reject path separators and control characters in a filename
    !/[\\/\u0000-\u001f\u007f]/.test(value) &&
    path.basename(value) === value &&
    [".mp4", ".m4v"].includes(path.extname(value).toLowerCase())
  );
}

export function recordedRelinkFilename(job: DownloadJob): string | null {
  const filename = job.filepath ? path.basename(job.filepath) : job.filename;
  return validRelinkFilename(filename) ? filename : null;
}

export function relinkContext(job: DownloadJob, directory: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        path.resolve(directory),
        job.id,
        job.kind,
        job.status,
        job.tmdbId,
        job.malId,
        job.mediaType,
        job.season,
        job.episode,
        job.language,
        job.filename,
        job.filepath,
        job.fileRevision,
        job.updatedAt,
        job.label,
        job.quality,
        job.fileRelinkedAt,
      ]),
    )
    .digest("hex");
}

export function assertRelinkRecord(job: DownloadJob | undefined): asserts job is DownloadJob {
  if (
    !job ||
    !downloadIdentity(job) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(job.id)
  ) {
    throw new LocalRelinkError(
      "This completed download has no valid movie or episode identity.",
      404,
    );
  }
}

export function assertRelinkUnambiguous(
  job: DownloadJob,
  jobs: DownloadJob[],
  directory: string,
  filename: string,
): void {
  const target = path.resolve(directory, filename);
  const identity = downloadIdentity(job)!;
  for (const other of jobs) {
    if (other.id === job.id) continue;
    // Include legacy destinations projected into a moved configured folder. Never inspect those other files.
    const claimsTarget =
      (other.filepath && path.resolve(other.filepath) === target) ||
      recordedRelinkFilename(other) === filename;
    if (!claimsTarget) continue;
    if (
      other.status !== "done" ||
      !downloadIdentity(other) ||
      localIdentityKey(downloadIdentity(other)!) !== localIdentityKey(identity) ||
      other.language !== job.language
    ) {
      throw new LocalRelinkError(
        "Another download record also claims this file. Choose the correct saved file, or remove the incorrect queue entry first. Removing an entry keeps its saved file.",
        409,
      );
    }
  }
}

async function inspect(
  job: DownloadJob,
  jobs: DownloadJob[],
  directory: string,
  filename: string,
  revision?: string,
) {
  if (!validRelinkFilename(filename))
    throw new LocalRelinkError(
      "Enter the exact MP4 filename inside your download folder, without a folder path.",
      400,
    );
  assertRelinkUnambiguous(job, jobs, directory, filename);
  const filepath = path.resolve(directory, filename);
  const file = await openDownloadFile(directory, filepath, revision);
  if (!file)
    throw new LocalRelinkError(
      "The saved file is missing, changed, or not a supported MP4. Check the download folder and exact filename, then check the file again.",
      revision ? 409 : 404,
    );
  await file.handle.close();
  return {
    filename,
    filepath,
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
  };
}

export async function previewLocalRelink(
  job: DownloadJob | undefined,
  jobs: DownloadJob[],
  directory: string,
  selectedFilename?: string,
) {
  assertRelinkRecord(job);
  const filename = selectedFilename ?? recordedRelinkFilename(job) ?? "";
  const file = await inspect(job, jobs, directory, filename);
  const query = new URLSearchParams({
    filename,
    rev: file.revision,
    context: relinkContext(job, directory),
  });
  const proof = signProxyUrl(`/api/downloads/${job.id}/relink?${query}`, 5 * 60);
  if (!hasValidSignature(new URL(proof, "http://flyx.invalid")))
    throw new LocalRelinkError("Could not prepare confirmation. Restart Flyx and try again.", 503);
  return {
    file,
    proof,
    label: job.label,
    identity: downloadIdentity(job),
    relocated: Boolean(job.filepath && path.resolve(job.filepath) !== file.filepath),
    replacement: Boolean(job.fileRevision && job.fileRevision !== file.revision),
  };
}

export async function validateLocalRelink(
  job: DownloadJob | undefined,
  jobs: DownloadJob[],
  directory: string,
  proof: unknown,
) {
  assertRelinkRecord(job);
  if (
    typeof proof !== "string" ||
    proof.length > 8192 ||
    !proof.startsWith("/") ||
    proof.startsWith("//")
  )
    throw new LocalRelinkError("Check the saved file again before confirming.", 409);
  const parsed = new URL(proof, "http://flyx.invalid");
  const query = parsed.searchParams;
  if (
    parsed.origin !== "http://flyx.invalid" ||
    parsed.hash ||
    parsed.pathname !== `/api/downloads/${job.id}/relink` ||
    [...query.keys()].some(
      (key) =>
        !["filename", "rev", "context", "sig", "exp"].includes(key) ||
        query.getAll(key).length !== 1,
    ) ||
    !hasValidSignature(parsed) ||
    query.get("context") !== relinkContext(job, directory)
  ) {
    throw new LocalRelinkError(
      "The file, download record or folder changed, or confirmation expired. Check the file again.",
      409,
    );
  }
  const revision = query.get("rev") || "";
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new LocalRelinkError("Check the saved file again.", 409);
  return {
    ...(await inspect(job, jobs, directory, query.get("filename") || "", revision)),
    context: query.get("context")!,
  };
}
