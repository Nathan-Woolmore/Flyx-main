"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ChapterData } from "@flyx/core";
import { collectionChoices } from "@/lib/downloads/manga-collection-types";
import { deliverDownloads } from "@/lib/downloads/client";

export default function MangaCollectionDownload({
  mangaId,
  title,
  chapters,
}: {
  mangaId: string;
  title: string;
  chapters: ChapterData[];
}) {
  const choices = useMemo(() => collectionChoices(chapters), [chapters]);
  const [selection, setSelection] = useState("");
  const [state, setState] = useState<"idle" | "queuing" | "queued">("idle");
  const [error, setError] = useState("");
  const selected =
    choices.find((choice) => `${choice.scope.language}:${choice.scope.edition}` === selection) ||
    choices[0];
  if (!selected)
    return (
      <p className="manga-collection-note">
        One-file download needs chapter language and edition details. Reload this manga to check
        availability.
      </p>
    );
  async function download() {
    if (!selected || state !== "idle") return;
    setState("queuing");
    setError("");
    const result = await deliverDownloads([
      { kind: "manga", mangaId, chapter: 0, title, collection: selected.scope },
    ]);
    if (result.ok) setState("queued");
    else {
      setError(result.error || "Could not queue this collection.");
      setState("idle");
    }
  }
  return (
    <section className="manga-collection" aria-label="Download manga as one file">
      <div>
        <h3>All available chapters, one file</h3>
        <p>
          One CBZ from WeebCentral, in chapter order. This includes currently available chapters in
          the selected edition; ongoing series may have more later.
        </p>
      </div>
      <div className="manga-collection-controls">
        <label htmlFor="manga-collection-edition">Language and edition</label>
        <select
          id="manga-collection-edition"
          value={`${selected.scope.language}:${selected.scope.edition}`}
          disabled={state !== "idle"}
          onChange={(event) => {
            setSelection(event.target.value);
            setError("");
          }}
        >
          {choices.map(({ scope, count }) => (
            <option
              key={`${scope.language}:${scope.edition}`}
              value={`${scope.language}:${scope.edition}`}
            >
              {scope.language.toUpperCase()} ·{" "}
              {scope.edition === "official" ? "Official" : "Community"} · {count}{" "}
              {count === 1 ? "chapter" : "chapters"}
            </option>
          ))}
        </select>
        {state === "queued" ? (
          <Link href="/downloads" className="btn-primary">
            Queued · View downloads
          </Link>
        ) : (
          <button
            type="button"
            className="btn-primary"
            disabled={state === "queuing"}
            onClick={() => void download()}
          >
            {state === "queuing" ? "Queuing…" : "Download all as one CBZ"}
          </button>
        )}
      </div>
      <p className="manga-collection-note">
        {selected.count} {selected.count === 1 ? "chapter" : "chapters"}, Ch. {selected.first}–
        {selected.last}. Duplicate chapter numbers use the newest release in this edition. The exact
        chapter list is fixed when the job starts.
      </p>
      <p className="manga-collection-note">
        Desktop app only · Saves to your Downloads save location · Keep space for both cached pages
        and the CBZ while packing. APFS or Mac OS Extended storage is required. Open the CBZ in a
        compatible comic reader; Flyx cannot open local CBZ files.
      </p>
      {error && (
        <p className="download-job-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
