import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwind from "@tailwindcss/postcss";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

let server: ViteDevServer;
let baseURL: string;
let application: ElectronApplication;
let page: Page;
let profile: string;

test.beforeAll(async () => {
  const appRoot = path.resolve(__dirname, "../..");
  const fixture = path.join(__dirname, "fixture");
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.resolve(appRoot, "../../node_modules/.vite-search-test"),
    resolve: {
      alias: [
        { find: "@", replacement: path.join(appRoot, "src") },
        { find: "next/navigation", replacement: path.join(fixture, "navigation.tsx") },
        { find: "next/link", replacement: path.join(fixture, "link.tsx") },
      ],
      dedupe: ["react", "react-dom"],
    },
    css: { postcss: { plugins: [tailwind({ base: appRoot })] } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(appRoot, "../..")] } },
  });
  await server.listen();
  baseURL = server.resolvedUrls!.local[0];
});

test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-manga-layout-"));
  application = await _electron.launch({
    executablePath: path.resolve(
      __dirname,
      "../../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.join(__dirname, "fixture/layout-electron.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", FLYX_SEARCH_TEST_PROFILE: profile },
  });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.route("https://**/*", (route) => route.abort());
});
test.afterEach(async () => {
  await application?.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});

const tinyImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=",
  "base64",
);
const longTitle =
  "An extraordinarily long manga title with a journey across worlds and a surprisingly complicated subtitle";
const altTitle =
  "A long alternative title or description that must remain clear of the details action and carousel controls ".repeat(
    5,
  );
const manga = (id: string, title: string, alt?: string) => ({
  id,
  title,
  altTitle: alt,
  coverImage: "https://fixture.example/cover.png",
  chapterCount: 1200,
  status: "ongoing",
});

async function setup(cards: ReturnType<typeof manga>[]) {
  await page.route("**/api/manga/popular?**", (route) => route.fulfill({ json: { data: cards } }));
  await page.route("**/api/manga/image?**", (route) =>
    route.fulfill({ body: tinyImage, contentType: "image/png" }),
  );
}

async function measurements() {
  return page.evaluate(() => {
    const title = document.querySelector("h1")!;
    const hero = title.closest("section")!;
    const details = [...hero.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("View Details"),
    )!;
    const dots = [...hero.querySelectorAll("button")].filter((node) =>
      node.getAttribute("aria-label")?.startsWith("Show featured"),
    );
    const titleBox = title.getBoundingClientRect(),
      action = details.getBoundingClientRect(),
      bounds = hero.getBoundingClientRect();
    const dotBoxes = dots.map((node) => node.getBoundingClientRect());
    return {
      actionGap: action.top - titleBox.bottom,
      indicatorGap: dotBoxes.length
        ? Math.min(...dotBoxes.map((box) => box.top)) - action.bottom
        : null,
      bottomGap: bounds.bottom - Math.max(action.bottom, ...dotBoxes.map((box) => box.bottom)),
      titleTopGap: titleBox.top - bounds.top,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

for (const [width, height] of [
  [375, 600],
  [768, 700],
  [1100, 850],
  [1280, 850],
  [2560, 1080],
]) {
  test(`Manga featured details and indicators stay separated at ${width}x${height}`, async () => {
    await page.setViewportSize({ width, height });
    await setup([
      manga("one-piece", "One Piece"),
      manga("long-title", longTitle, altTitle),
      manga("third", "Third title"),
    ]);
    await page.goto(`${baseURL}manga`);
    await expect(page.getByRole("heading", { name: "One Piece", exact: true })).toBeVisible();
    await expect(page.locator(".manga-featured-copy")).toHaveCSS("opacity", "1");
    const before = await measurements();
    expect(before.indicatorGap).toBeGreaterThanOrEqual(12);
    expect(before.bottomGap).toBeGreaterThanOrEqual(8);
    await page.getByRole("button", { name: "Show featured 2", exact: true }).click();
    await expect(page.getByRole("heading", { name: longTitle, exact: true })).toBeVisible();
    await expect(page.locator(".manga-featured-copy")).toHaveCSS("opacity", "1");
    const long = await measurements();
    expect(long.actionGap).toBeGreaterThanOrEqual(8);
    expect(long.indicatorGap).toBeGreaterThanOrEqual(12);
    expect(long.bottomGap).toBeGreaterThanOrEqual(8);
    expect(long.titleTopGap).toBeGreaterThanOrEqual(8);
    expect(long.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`manga-hero-${width}.png`) });
    await page.getByRole("button", { name: "View Details", exact: true }).click();
    await expect(page).toHaveURL(/[/]manga[/]long-title$/);
  });
}

test("single featured manga needs no indicator row and long details descriptions stay above the actions", async () => {
  await setup([manga("single", longTitle, altTitle)]);
  await page.route("**/api/manga/details?**", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "single",
          title: longTitle,
          altTitles: [altTitle],
          coverImage: "https://fixture.example/cover.png",
          description: "A long description with enough text to wrap across several lines. ".repeat(
            50,
          ),
          status: "ongoing",
          genres: ["Adventure", "Fantasy"],
          totalChapters: 2,
          chapters: [
            { id: "ch-1", number: 1, pageCount: 2 },
            { id: "ch-2", number: 2, pageCount: 2 },
          ],
        },
      },
    }),
  );
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto(`${baseURL}manga`);
  await expect(page.getByRole("heading", { name: longTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Show featured/ })).toHaveCount(0);
  await page.getByRole("button", { name: "View Details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start Reading", exact: true })).toBeVisible();
  const gaps = await page.evaluate(() => {
    const synopsis = document.querySelector(".anime-detail-synopsis")!.getBoundingClientRect();
    const actions = document.querySelector(".anime-detail-actions")!.getBoundingClientRect();
    return {
      gap: actions.top - synopsis.bottom,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(gaps.gap).toBeGreaterThanOrEqual(8);
  expect(gaps.overflow).toBeLessThanOrEqual(1);
});

const collectionDetails = {
  id: "collection-fixture",
  title: "Synthetic Manga Collection",
  altTitles: [],
  coverImage: "",
  description: "Synthetic fixtures only.",
  status: "ongoing",
  genres: ["Adventure"],
  totalChapters: 4,
  chapters: [
    {
      id: "00000000000000000000000001",
      number: 0.5,
      pageCount: 2,
      language: "en",
      edition: "official",
    },
    {
      id: "00000000000000000000000002",
      number: 2,
      pageCount: 2,
      language: "en",
      edition: "official",
    },
    {
      id: "00000000000000000000000003",
      number: 2,
      pageCount: 2,
      language: "en",
      edition: "community",
    },
    {
      id: "00000000000000000000000004",
      number: 1,
      pageCount: 2,
      language: "fr",
      edition: "community",
    },
  ],
};
async function collectionPage(desktop: boolean) {
  if (desktop)
    await page.addInitScript(() =>
      Object.defineProperty(window, "flyxDesktop", { value: { isDesktop: true } }),
    );
  await page.route("**/api/manga/details?**", (route) =>
    route.fulfill({ json: { data: collectionDetails } }),
  );
  await page.goto(`${baseURL}manga/collection-fixture`);
  await expect(
    page.getByRole("heading", { name: collectionDetails.title, exact: true }),
  ).toBeVisible();
}
test("one CBZ selection exposes source, edition, chapter scope and queues once", async () => {
  await page.setViewportSize({ width: 375, height: 850 });
  const requests: unknown[] = [];
  await page.route("**/api/downloads", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, jobs: [{ id: "fixture" }] } });
  });
  await collectionPage(true);
  const region = page.getByRole("region", { name: "Download manga as one file" });
  await expect(region).toContainText("WeebCentral");
  await expect(region).toContainText("Flyx cannot open local CBZ files");
  await expect(region.getByRole("combobox")).toHaveValue("en:official");
  await expect(region).toContainText("2 chapters, Ch. 0.5–2");
  await region.getByRole("combobox").selectOption("fr:community");
  await expect(region).toContainText("1 chapter, Ch. 1–1");
  await region.getByRole("button", { name: "Download all as one CBZ", exact: true }).click();
  await expect(
    region.getByRole("link", { name: "Queued · View downloads", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([
    {
      items: [
        {
          kind: "manga",
          mangaId: "collection-fixture",
          chapter: 0,
          title: collectionDetails.title,
          collection: { language: "fr", edition: "community" },
        },
      ],
    },
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: test.info().outputPath("manga-collection-mobile.png"),
    fullPage: true,
  });
});
test("collection queue errors remain visible and can be retried; browser use gives an honest desktop requirement", async () => {
  await page.route("**/api/downloads", (route) =>
    route.fulfill({ status: 403, json: { ok: false, error: "Administrator access required" } }),
  );
  await collectionPage(true);
  await page.getByRole("button", { name: "Download all as one CBZ", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Administrator access required");
  await expect(
    page.getByRole("button", { name: "Download all as one CBZ", exact: true }),
  ).toBeEnabled();
});
test("browser collection request stays on the page and explains desktop-only delivery", async () => {
  let queued = false;
  await page.route("**/api/downloads", (route) => {
    queued = true;
    return route.abort();
  });
  await collectionPage(false);
  await page.getByRole("button", { name: "Download all as one CBZ", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("require the desktop app");
  expect(queued).toBe(false);
});
test("Downloads shows real chapter/page stages and Retry for a failed collection", async () => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "flyxDesktop", { value: { isDesktop: true } }),
  );
  let job = {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "manga",
    label: "Synthetic Manga — available chapters",
    status: "downloading",
    progress: 37,
    bytes: 2097152,
    totalBytes: 0,
    outTimeMs: 0,
    createdAt: 1,
    updatedAt: 2,
    mangaId: "collection-fixture",
    chapter: 0,
    collection: { language: "en", edition: "official" },
    collectionProgress: {
      phase: "downloading",
      chaptersDone: 1,
      chaptersTotal: 4,
      currentChapter: 2,
      pageDone: 3,
      pageTotal: 5,
      bytes: 2097152,
    },
    error: "",
  };
  await page.route("**/api/downloads", (route) =>
    route.fulfill({ json: { ok: true, jobs: [job] } }),
  );
  await page.route("**/api/settings/downloads", (route) =>
    route.fulfill({
      json: { dir: "/synthetic/Books", custom: null, defaultDir: "/synthetic/Books" },
    }),
  );
  let retried = 0;
  await page.route("**/api/downloads/*/retry", async (route) => {
    retried++;
    job = {
      ...job,
      status: "processing",
      error: "",
      collectionProgress: {
        ...job.collectionProgress,
        phase: "packing",
        chaptersDone: 4,
        pageDone: 0,
        pageTotal: 20,
      },
    };
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${baseURL}downloads`);
  await expect(page.getByRole("status")).toContainText("1/4 chapters · Ch. 2 · 3/5 pages");
  await expect(page.getByText("37% · 2.0 MB", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  job = {
    ...job,
    status: "error",
    error: "Chapter 2, page 4 failed. Completed pages are kept for Retry.",
  };
  await expect(page.getByRole("button", { name: /^Retry/ })).toBeVisible();
  await page.getByRole("button", { name: /^Retry/ }).click();
  expect(retried).toBe(1);
  await expect(page.getByRole("status")).toContainText("Packing CBZ · 4/4 chapters");
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("manga-collection-progress.png") });
});
