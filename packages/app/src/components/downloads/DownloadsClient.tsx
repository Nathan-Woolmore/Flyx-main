"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DownloadJob } from "@/lib/downloads/types";
import { isDesktopHost } from "@/lib/downloads/client";
import { downloadIdentity, watchUrlForDownload } from "@/lib/downloads/local-identity";

interface FolderInfo {
  dir: string;
  custom: string | null;
  defaultDir: string;
}

interface RelinkPreview {
  file: { filename: string; filepath: string; size: number; modifiedAt: number };
  proof: string;
  relocated: boolean;
  replacement: boolean;
}
interface RelinkState {
  job: DownloadJob;
  filename: string;
  preview: RelinkPreview | null;
  confirmed: boolean;
  busy: boolean;
  error: string;
}

type QueueFilter = "all" | "active" | "finished";

const ACTIVE_STATUSES = new Set(["queued", "downloading", "processing"]);

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function statusLabel(status: DownloadJob["status"]): string {
  if (status === "done") return "Ready";
  if (status === "processing") return "Finishing";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function DownloadsClient() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const [folderInput, setFolderInput] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [folderMessage, setFolderMessage] = useState("");
  const [error, setError] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [relink, setRelink] = useState<RelinkState | null>(null);
  const [relinkMessage, setRelinkMessage] = useState("");
  const relinkGeneration = useRef(0);

  useEffect(() => setIsHost(isDesktopHost()), []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/downloads", { cache: "no-store" });
      if (response.ok) {
        const result = await response.json();
        setJobs(result.jobs ?? []);
        setError("");
      } else if (response.status === 403) {
        setError(
          isDesktopHost() ? "Administrator access is required to manage host downloads." : "",
        );
      }
    } catch {
      setError("The download queue is temporarily unavailable.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    void fetch("/api/settings/downloads")
      .then((response) => response.json())
      .then((result: FolderInfo) => {
        setFolder(result);
        setFolderInput(result.dir || "");
      })
      .catch(() => undefined);
  }, []);

  const activeCount = jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
  const completedCount = jobs.filter((job) => job.status === "done").length;
  const failedCount = jobs.filter((job) => job.status === "error").length;
  const visibleJobs = useMemo(() => {
    if (filter === "active") return jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    if (filter === "finished") return jobs.filter((job) => !ACTIVE_STATUSES.has(job.status));
    return jobs;
  }, [filter, jobs]);

  async function saveFolder() {
    setSavingFolder(true);
    setFolderMessage("");
    try {
      const response = await fetch("/api/settings/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: folderInput }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not save this folder");
      setFolder((current) =>
        current ? { ...current, dir: result.dir, custom: folderInput.trim() || null } : current,
      );
      setFolderMessage("Download folder saved");
    } catch (reason) {
      setFolderMessage(reason instanceof Error ? reason.message : "Could not save this folder");
    } finally {
      setSavingFolder(false);
    }
  }

  async function resetFolder() {
    if (!folder) return;
    setFolderInput(folder.defaultDir);
    setSavingFolder(true);
    try {
      const response = await fetch("/api/settings/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: "" }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not reset the folder");
      setFolder({ ...folder, dir: result.dir, custom: null });
      setFolderInput(result.dir);
      setFolderMessage("Using the default Downloads folder");
    } catch (reason) {
      setFolderMessage(reason instanceof Error ? reason.message : "Could not reset the folder");
    } finally {
      setSavingFolder(false);
    }
  }

  async function retryCollection(jobId: string) {
    try {
      const response = await fetch(`/api/downloads/${jobId}/retry`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Could not retry this collection.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry this collection.");
    }
  }

  async function removeJob(jobId: string) {
    try {
      const response = await fetch(`/api/downloads/${jobId}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Could not update this download.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this download.");
    }
  }

  async function clearFinished() {
    const finishedJobs = jobs.filter((job) => !ACTIVE_STATUSES.has(job.status));
    await Promise.all(
      finishedJobs.map((job) => fetch(`/api/downloads/${job.id}`, { method: "DELETE" })),
    );
    await refresh();
  }

  async function checkSavedFile(job: DownloadJob, filename: string) {
    const generation = ++relinkGeneration.current;
    setRelink({ job, filename, preview: null, confirmed: false, busy: true, error: "" });
    setRelinkMessage("");
    try {
      const query = new URLSearchParams({ filename });
      const response = await fetch(`/api/downloads/${encodeURIComponent(job.id)}/relink?${query}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Could not check this saved file.");
      if (generation === relinkGeneration.current)
        setRelink({
          job,
          filename,
          preview: result.preview,
          confirmed: false,
          busy: false,
          error: "",
        });
    } catch (error) {
      if (generation === relinkGeneration.current)
        setRelink({
          job,
          filename,
          preview: null,
          confirmed: false,
          busy: false,
          error: error instanceof Error ? error.message : "Could not check this saved file.",
        });
    }
  }

  async function confirmSavedFile() {
    if (!relink?.preview || !relink.confirmed || relink.busy) return;
    const generation = relinkGeneration.current;
    const current = relink;
    setRelink({ ...current, busy: true, error: "" });
    try {
      const response = await fetch(`/api/downloads/${encodeURIComponent(current.job.id)}/relink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, proof: current.preview!.proof }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Could not link this saved file.");
      if (generation === relinkGeneration.current) {
        setRelink(null);
        setRelinkMessage("Saved file linked. You can play it in Flyx.");
      }
      await refresh();
    } catch (error) {
      if (generation === relinkGeneration.current)
        setRelink({
          ...current,
          preview: null,
          confirmed: false,
          busy: false,
          error: error instanceof Error ? error.message : "Could not link this saved file.",
        });
    }
  }

  return (
    <main className="downloads-page content-container">
      <header className="downloads-header">
        <div>
          <span className="downloads-eyebrow">Offline library</span>
          <h1>Downloads</h1>
          <p>Save movies and episodes, follow their progress, and play completed files.</p>
        </div>
        <Link href="/browse" className="btn-primary">
          Find something to download
        </Link>
      </header>

      <section className="downloads-stats" aria-label="Download summary">
        <div>
          <span>Active</span>
          <strong>{activeCount}</strong>
          <small>{activeCount === 1 ? "item downloading" : "items downloading"}</small>
        </div>
        <div>
          <span>Ready</span>
          <strong>{completedCount}</strong>
          <small>saved to this computer</small>
        </div>
        <div>
          <span>Needs attention</span>
          <strong>{failedCount}</strong>
          <small>{failedCount ? "check failed items" : "everything looks good"}</small>
        </div>
      </section>

      {isHost && (
        <section className="download-destination">
          <div className="download-destination-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2" />
            </svg>
          </div>
          <div className="download-destination-copy">
            <span>Save location</span>
            <strong>Choose where finished files are stored</strong>
            <small>Downloads started from this desktop app are written to this folder.</small>
          </div>
          <div className="download-folder-field">
            <input
              value={folderInput}
              onChange={(event) => setFolderInput(event.target.value)}
              placeholder={folder?.defaultDir || "Downloads folder"}
              aria-label="Download folder"
            />
            <button type="button" onClick={() => void saveFolder()} disabled={savingFolder}>
              {savingFolder ? "Saving…" : "Save folder"}
            </button>
            {folder?.custom && (
              <button
                type="button"
                className="secondary"
                onClick={() => void resetFolder()}
                disabled={savingFolder}
              >
                Use default
              </button>
            )}
          </div>
          {folderMessage && <p className="download-folder-message">{folderMessage}</p>}
        </section>
      )}

      {!isHost && (
        <section className="download-device-note">
          <strong>Downloads go directly to this device</strong>
          <span>
            Because you opened Flyx in a browser, your browser manages downloaded files instead of
            the desktop queue.
          </span>
        </section>
      )}

      {error && (
        <div className="downloads-error" role="alert">
          {error}
        </div>
      )}

      {jobs.some((job) => job.kind === "video" && job.status === "done" && !job.fileRevision) && (
        <p className="download-device-note">
          Your existing files can play in Flyx. Choose Link saved file, check the file details, and
          confirm the matching movie or episode.
        </p>
      )}

      {relinkMessage && (
        <p className="download-device-note" role="status">
          {relinkMessage}
        </p>
      )}
      {relink && (
        <section className="download-relink" aria-label="Link saved file">
          <div className="download-relink-heading">
            <div>
              <h2>Link saved file</h2>
              <strong>{relink.job.label}</strong>
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={relink.busy}
              onClick={() => {
                relinkGeneration.current++;
                setRelink(null);
              }}
            >
              Close
            </button>
          </div>
          <p>
            {relink.job.malId ? `MAL ${relink.job.malId}` : `TMDB ${relink.job.tmdbId}`} ·{" "}
            {relink.job.mediaType === "tv"
              ? `Season ${relink.job.season}, Episode ${relink.job.episode}`
              : "Movie"}
            {relink.job.language ? ` · ${relink.job.language.toUpperCase()}` : ""}
          </p>
          <p>
            Choose the existing file in your download folder. Flyx will link this queue entry
            without moving or changing the file.
          </p>
          <label htmlFor="download-relink-filename">
            Exact filename in {folder?.dir || "your download folder"}
          </label>
          <div className="download-relink-field">
            <input
              id="download-relink-filename"
              value={relink.filename}
              disabled={relink.busy}
              onChange={(event) => {
                relinkGeneration.current++;
                setRelink({
                  ...relink,
                  filename: event.target.value,
                  preview: null,
                  confirmed: false,
                  error: "",
                });
              }}
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={relink.busy || !relink.filename}
              onClick={() => void checkSavedFile(relink.job, relink.filename)}
            >
              {relink.busy ? "Checking…" : "Check file"}
            </button>
          </div>
          {relink.error && (
            <p className="download-job-error" role="alert">
              {relink.error}
            </p>
          )}
          {relink.preview && (
            <>
              <dl className="download-relink-details">
                <div>
                  <dt>Saved file</dt>
                  <dd>
                    <code>{relink.preview.file.filepath}</code>
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(relink.preview.file.size)}</dd>
                </div>
                <div>
                  <dt>Modified</dt>
                  <dd>{new Date(relink.preview.file.modifiedAt).toLocaleString()}</dd>
                </div>
              </dl>
              {relink.preview.relocated && (
                <p>This file is in a different location from the original download record.</p>
              )}
              {relink.preview.replacement && (
                <p>
                  This file has changed since it was linked. Confirm its contents before linking it
                  again.
                </p>
              )}
              <p>
                File details cannot prove which movie or episode is inside. Confirm the match before
                using it as a playback source.
              </p>
              <label className="download-relink-confirm">
                <input
                  type="checkbox"
                  checked={relink.confirmed}
                  disabled={relink.busy}
                  onChange={(event) => setRelink({ ...relink, confirmed: event.target.checked })}
                />
                This file is {relink.job.label}
                {relink.job.mediaType === "tv"
                  ? ` (Season ${relink.job.season}, Episode ${relink.job.episode})`
                  : ""}
                .
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={!relink.confirmed || relink.busy}
                onClick={() => void confirmSavedFile()}
              >
                {relink.busy ? "Linking…" : "Confirm and link file"}
              </button>
            </>
          )}
        </section>
      )}

      {jobs.some((job) => job.collection) && (
        <p className="download-device-note">
          CBZ collections open in a compatible comic reader. Cancel keeps completed pages for Retry.
          Remove or Clear finished deletes unfinished collection cache and keeps any finished CBZ.
        </p>
      )}

      <section className="download-queue">
        <div className="download-queue-toolbar">
          <div>
            <h2>Download queue</h2>
            <span>
              {jobs.length} total item{jobs.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="download-filter" role="tablist" aria-label="Filter downloads">
            {(["all", "active", "finished"] as QueueFilter[]).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={filter === option}
                className={filter === option ? "active" : undefined}
                onClick={() => setFilter(option)}
              >
                {option === "all" ? "All" : option === "active" ? "In progress" : "Finished"}
              </button>
            ))}
          </div>
          {jobs.some((job) => !ACTIVE_STATUSES.has(job.status)) && (
            <button type="button" className="download-clear" onClick={() => void clearFinished()}>
              Clear finished
            </button>
          )}
        </div>

        {visibleJobs.length === 0 ? (
          <div className="download-empty">
            <span className="download-empty-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M12 3v11m0 0 4-4m-4 4-4-4M4 19h16" />
              </svg>
            </span>
            <h3>{jobs.length ? "No downloads match this filter" : "Your queue is empty"}</h3>
            <p>Open any movie or episode and choose Download to add it here.</p>
            {!jobs.length && (
              <Link href="/browse" className="btn-secondary">
                Browse movies and shows
              </Link>
            )}
          </div>
        ) : (
          <div className="download-job-list">
            {visibleJobs.map((job) => {
              const active = ACTIVE_STATUSES.has(job.status);
              const playUrl = watchUrlForDownload(job);
              const indeterminate =
                (job.status === "downloading" || job.status === "processing") &&
                job.progress === 0 &&
                job.outTimeMs > 0;
              return (
                <article key={job.id} className={`download-job download-job-${job.status}`}>
                  <div className="download-job-icon" aria-hidden>
                    {job.kind === "video" ? "▶" : "▤"}
                  </div>
                  <div className="download-job-main">
                    <div className="download-job-heading">
                      <div>
                        <h3>{job.label}</h3>
                        <p>
                          {job.kind === "video"
                            ? "Video"
                            : job.collection
                              ? `Manga CBZ · WeebCentral · ${job.collection.language.toUpperCase()} · ${job.collection.edition}`
                              : "Manga"}
                          {job.quality ? ` · ${job.quality}` : ""}
                          {job.language ? ` · ${job.language.toUpperCase()}` : ""}
                        </p>
                      </div>
                      <span className="download-job-status">{statusLabel(job.status)}</span>
                    </div>
                    {active && (
                      <div className="download-progress">
                        <div>
                          <span
                            className={indeterminate ? "indeterminate" : undefined}
                            style={indeterminate ? undefined : { width: `${job.progress}%` }}
                          />
                        </div>
                        <p>
                          {job.progress > 0
                            ? `${job.progress}%`
                            : indeterminate
                              ? `Processing ${formatTime(job.outTimeMs)}`
                              : "Starting…"}
                          {job.bytes > 0 ? ` · ${formatBytes(job.bytes)}` : ""}
                        </p>
                      </div>
                    )}
                    {job.collectionProgress && (
                      <p className="download-collection-progress" role="status">
                        {job.status === "done"
                          ? "Saved"
                          : job.collectionProgress.phase === "packing"
                            ? "Packing CBZ"
                            : job.collectionProgress.phase === "resolving"
                              ? "Finding available chapters"
                              : job.collectionProgress.phase === "checking"
                                ? "Checking saved pages"
                                : "Downloading pages"}
                        {job.collectionProgress.chaptersTotal > 0 &&
                          ` · ${job.collectionProgress.chaptersDone}/${job.collectionProgress.chaptersTotal} chapters`}
                        {job.collectionProgress.phase !== "packing" &&
                          job.collectionProgress.currentChapter != null &&
                          ` · Ch. ${job.collectionProgress.currentChapter}`}
                        {job.collectionProgress.pageTotal > 0 &&
                          ` · ${job.collectionProgress.pageDone}/${job.collectionProgress.pageTotal} pages`}
                      </p>
                    )}
                    {job.error && <p className="download-job-error">{job.error}</p>}
                    {job.filepath && job.status === "done" && (
                      <code className="download-job-path">{job.filepath}</code>
                    )}
                  </div>
                  <div className="download-job-actions">
                    {job.collection && ["error", "cancelled"].includes(job.status) && (
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-label={`Retry ${job.label}`}
                        onClick={() => void retryCollection(job.id)}
                      >
                        Retry
                      </button>
                    )}
                    {downloadIdentity(job) && (
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-label={`${job.fileRevision ? "Relink" : "Link saved file for"} ${job.label}`}
                        onClick={() =>
                          void checkSavedFile(
                            job,
                            job.filepath?.split("/").pop() || job.filename || "",
                          )
                        }
                      >
                        {job.fileRevision ? "Relink file" : "Link saved file"}
                      </button>
                    )}
                    {playUrl && (
                      <Link
                        href={playUrl}
                        className="btn-secondary"
                        aria-label={`Play ${job.label}`}
                      >
                        Play
                      </Link>
                    )}
                    <button
                      type="button"
                      className={active ? "download-job-cancel" : "download-job-remove"}
                      onClick={() => void removeJob(job.id)}
                    >
                      {active ? "Cancel" : "Remove"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
