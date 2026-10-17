import type { ChapterData, MangaData } from "@flyx/core";

export interface MangaCollectionScope {
  language: string;
  edition: "official" | "community";
}
export interface MangaCollectionPlan extends MangaCollectionScope {
  version: 1;
  mangaId: string;
  title: string;
  source: "weebcentral";
  createdAt: string;
  chapters: Array<Pick<ChapterData, "id" | "number" | "title" | "publishedAt">>;
  duplicatesExcluded: number;
}
export interface MangaCollectionProgress {
  phase: "resolving" | "checking" | "downloading" | "packing";
  chaptersDone: number;
  chaptersTotal: number;
  currentChapter?: number;
  pageDone: number;
  pageTotal: number;
  bytes: number;
}
export function collectionChoices(chapters: ChapterData[]) {
  const groups = new Map<
    string,
    { scope: MangaCollectionScope; count: number; first: number; last: number }
  >();
  for (const chapter of chapters) {
    if (
      !chapter.language ||
      !chapter.edition ||
      !Number.isFinite(chapter.number) ||
      chapter.number < 0
    )
      continue;
    const key = `${chapter.language}:${chapter.edition}`;
    const group = groups.get(key) || {
      scope: { language: chapter.language, edition: chapter.edition },
      count: 0,
      first: chapter.number,
      last: chapter.number,
    };
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const numbers = [
      ...new Set(
        chapters
          .filter(
            (chapter) =>
              chapter.language === group.scope.language &&
              chapter.edition === group.scope.edition &&
              Number.isFinite(chapter.number) &&
              chapter.number >= 0,
          )
          .map((chapter) => chapter.number),
      ),
    ].sort((a, b) => a - b);
    group.count = numbers.length;
    group.first = numbers[0];
    group.last = numbers[numbers.length - 1];
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.scope.language.localeCompare(b.scope.language) ||
      a.scope.edition.localeCompare(b.scope.edition),
  );
}
export function collectionPlan(
  mangaId: string,
  details: MangaData,
  scope: MangaCollectionScope,
  now = new Date().toISOString(),
): MangaCollectionPlan {
  if (details.id.toLowerCase() !== mangaId.toLowerCase())
    throw new Error("The source returned a different manga; download stopped.");
  const matching = details.chapters.filter(
    (chapter) => chapter.language === scope.language && chapter.edition === scope.edition,
  );
  if (!matching.length) throw new Error("No available chapters match this language and edition.");
  const byNumber = new Map<number, ChapterData>();
  for (const chapter of matching) {
    if (
      !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(chapter.id) ||
      !Number.isFinite(chapter.number) ||
      chapter.number < 0
    )
      throw new Error("The source has an invalid chapter entry; download stopped.");
    const previous = byNumber.get(chapter.number);
    // Same edition/number: choose the newest published release, then stable provider ID.
    const published = (entry: ChapterData) => {
      const date = Date.parse(entry.publishedAt || "");
      return Number.isFinite(date) ? date : 0;
    };
    if (
      !previous ||
      published(chapter) > published(previous) ||
      (published(chapter) === published(previous) && chapter.id.localeCompare(previous.id) > 0)
    )
      byNumber.set(chapter.number, chapter);
  }
  const chapters = [...byNumber.values()]
    .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
    .map(({ id, number, title, publishedAt }) => ({
      id,
      number,
      title: title ? Array.from(title).slice(0, 128).join("") : undefined,
      publishedAt:
        publishedAt && Number.isFinite(Date.parse(publishedAt))
          ? new Date(publishedAt).toISOString()
          : undefined,
    }));
  if (
    chapters.length > 10_000 ||
    new Set(chapters.map((chapter) => chapter.id)).size !== chapters.length
  )
    throw new Error("The source chapter list is too large or inconsistent.");
  return {
    version: 1,
    mangaId,
    title: Array.from(details.title).slice(0, 500).join(""),
    source: "weebcentral",
    createdAt: now,
    ...scope,
    chapters,
    duplicatesExcluded: matching.length - chapters.length,
  };
}
