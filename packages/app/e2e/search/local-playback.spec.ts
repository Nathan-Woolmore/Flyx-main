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
    cacheDir: "/tmp/flyx-remote-vite-cache",
    resolve: {
      alias: [
        { find: "@/hooks/useMediaSession", replacement: path.join(fixture, "media-session.ts") },
        { find: "@/hooks/useCast", replacement: path.join(fixture, "cast-disabled.ts") },
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
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-local-ui-"));
  application = await _electron.launch({
    executablePath: path.resolve(
      __dirname,
      "../../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.join(__dirname, "fixture/electron.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", FLYX_SEARCH_TEST_PROFILE: profile },
  });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("flyx:player:help-never", "1");
    sessionStorage.setItem("flyx:account-scope", "synthetic-ui-account");
    localStorage.setItem(
      "flyx_player_prefs_v1",
      JSON.stringify({ showNowPlaying: false, externalPlayer: "off", autoPlayCountdown: 3 }),
    );
    let receive: ((request:any)=>void)|undefined;
    const pending=new Map<string,(value:any)=>void>();
    (window as any).__remoteSend=(payload:any)=>new Promise(resolve=>{const requestID=crypto.randomUUID();pending.set(requestID,resolve);receive!({requestID,action:'command',payload});});
    Object.defineProperty(window, "flyxDesktop", { value: { isDesktop: true,remote:{onRequest:(callback:any)=>{receive=callback;return()=>{receive=undefined;};},reply:async(reply:any)=>{pending.get(reply.requestID)?.(reply);pending.delete(reply.requestID);}} } });
    // Exercise the real player lifecycle without decoding, fetching media or producing audio.
    const times = new WeakMap<HTMLMediaElement, number>();
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperties(HTMLMediaElement.prototype, {
      src: {
        configurable: true,
        get() {
          return this.dataset.testSrc || "";
        },
        set(value) {
          this.dataset.testSrc = value;
          times.set(this, 0);
        },
      },
      currentSrc: {configurable:true,get(){return this.dataset.testSrc || "";}},
      currentTime: {
        configurable: true,
        get() {
          return times.get(this) || 0;
        },
        set(value) {
          times.set(this, value);
          queueMicrotask(() => {
            this.dispatchEvent(new Event("seeked"));
            this.dispatchEvent(new Event("timeupdate"));
          });
        },
      },
      duration: {
        configurable: true,
        get() {
          return 120;
        },
      },
      readyState: {
        configurable: true,
        get() {
          return 4;
        },
      },
      paused: {
        configurable: true,
        get() {
          return paused.get(this) ?? true;
        },
      },
      buffered: {
        configurable: true,
        get() {
          return { length: 1, start: () => 0, end: () => 120 };
        },
      },
      load: {
        configurable: true,
        value() {
          if (this.dataset.testSrc)
            queueMicrotask(() => {
              this.dispatchEvent(new Event("loadedmetadata"));
              this.dispatchEvent(new Event("canplay"));
            });
        },
      },
      play: {
        configurable: true,
        value() {
          paused.set(this, false);
          queueMicrotask(() => {
            this.dispatchEvent(new Event("play"));
            this.dispatchEvent(new Event("playing"));
          });
          return Promise.resolve();
        },
      },
      pause: {
        configurable: true,
        value() {
          paused.set(this, true);
          this.dispatchEvent(new Event("pause"));
        },
      },
    });
  });
  await page.route("**/api/**", (route) => route.fulfill({ json: { data: [], sources: [] } }));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user: { id: "synthetic-ui-account" } } }),
  );
});
test.afterEach(async () => {
  await application?.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});

const localUrl = "/api/stream/local?id=11111111-1111-4111-8111-111111111111&rev=" + "b".repeat(64);
const local = {
  url: localUrl,
  provider: "local",
  type: "mp4",
  title: "Local download",
  quality: "1080p",
  requiresSegmentProxy: false,
};
const remote = "https://cdn.example/synthetic.mp4";
const video = () => page.locator("video");

async function routes(localAvailable = true, onlineAvailable = true) {
  await page.route("**/api/stream/local-source?**", (route) =>
    route.fulfill({
      json: { success: true, provider: "local", sources: localAvailable ? [local] : [] },
    }),
  );
  for (const endpoint of ["stream/extract", "anime/stream"]) {
    await page.route(`**/api/${endpoint}?**`, (route) =>
      route.fulfill({
        json: {
          success: onlineAvailable,
          provider: "online",
          sources: onlineAvailable ? [{ url: remote, type: "mp4", quality: "720p" }] : [],
          message: "Synthetic online source unavailable",
        },
      }),
    );
  }
  await page.route("**/api/tmdb?**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("path") || "";
    return route.fulfill({
      json: query.includes("/season/")
        ? {
            episodes: [
              { id: 1, name: "One", episode_number: 1, season_number: 1 },
              { id: 2, name: "Two", episode_number: 2, season_number: 1 },
            ],
          }
        : { id: 101, title: "Synthetic fixture", name: "Synthetic fixture", number_of_seasons: 1 },
    });
  });
  await page.route("**/api/anime/jikan?**", (route) =>
    route.fulfill({ json: { data: { title: "Synthetic Anime", episodes: 2 } } }),
  );
}

async function failLocal(at = 31) {
  await video().evaluate((node: HTMLVideoElement, time) => {
    node.currentTime = time;
  }, at);
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(at);
  await video().evaluate((node: HTMLVideoElement) => node.dispatchEvent(new Event("error")));
}

test("prefers a completed local source, shows its provider, and applies the resume time", async () => {
  await routes();
  await page.goto(`${baseURL}watch?tmdbId=101&mediaType=movie&t=42`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(42);
  await page.getByRole("button", { name: "Servers and sources", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Local download/ })).toHaveClass(/is-playing/);
  await expect(page.getByRole("tab", { name: /Local download/ })).toContainText("1 source");
  await page.screenshot({ path: test.info().outputPath("local-source-selected.png") });
});

test("missing local file uses online and a midstream local failure preserves position", async () => {
  await routes(false);
  await page.goto(`${baseURL}watch?tmdbId=101&mediaType=movie`);
  await expect(video()).toHaveAttribute("data-test-src", remote);
  await routes(true);
  await page.goto(`${baseURL}watch?tmdbId=102&mediaType=movie`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  await failLocal();
  await expect(video()).toHaveAttribute("data-test-src", remote);
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(31);
});

test("local failure with no online replacement gives a useful recovery message", async () => {
  await routes(true, false);
  await page.goto(`${baseURL}watch?tmdbId=101&mediaType=movie`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  await failLocal();
  await expect(
    page.getByText(
      "The local download is unavailable and no online source could be loaded. Reconnect the drive or try again.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("auto-next episode performs a fresh exact local lookup and starts without the old episode's resume", async () => {
  await routes();
  const queries: URL[] = [];
  await page.route("**/api/stream/local-source?**", (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    return route.fulfill({
      json: {
        success: true,
        provider: "local",
        sources: [{ ...local, url: localUrl.slice(0, -1) + url.searchParams.get("episode") }],
      },
    });
  });
  await page.goto(`${baseURL}watch?tmdbId=101&mediaType=tv&season=1&episode=1&t=42`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl.slice(0, -1) + "1");
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(42);
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toBeVisible();
  await video().evaluate((node: HTMLVideoElement) => node.dispatchEvent(new Event("ended")));
  await expect(video()).toHaveAttribute("data-test-src", localUrl.slice(0, -1) + "2");
  expect(queries.at(-1)!.searchParams.get("season")).toBe("1");
  expect(queries.at(-1)!.searchParams.get("episode")).toBe("2");
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(0);
});

test("Anime uses MAL and the exact episode rather than a TMDB title guess", async () => {
  await routes();
  const queries: URL[] = [];
  await page.route("**/api/stream/local-source?**", (route) => {
    queries.push(new URL(route.request().url()));
    return route.fulfill({
      json: { success: true, provider: "local", sources: [{ ...local, language: "sub" }] },
    });
  });
  await page.goto(`${baseURL}watch?tmdbId=0&malId=20&mediaType=tv&season=1&episode=3`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  expect(Object.fromEntries(queries[0].searchParams)).toEqual({
    tmdbId: "0",
    malId: "20",
    mediaType: "tv",
    season: "1",
    episode: "3",
  });
});

test("Downloads offers Play only for completed bound movies and exact episodes", async () => {
  const base = {
    kind: "video",
    status: "done",
    label: "Movie",
    progress: 100,
    tmdbId: 101,
    mediaType: "movie",
    fileRevision: "b".repeat(64),
    createdAt: 1,
    updatedAt: 2,
  };
  const jobs = [
    { ...base, id: "movie" },
    { ...base, id: "episode", label: "Special", mediaType: "tv", season: 0, episode: 2 },
    {
      ...base,
      id: "anime",
      label: "Anime",
      tmdbId: 0,
      malId: 20,
      mediaType: "tv",
      season: 1,
      episode: 3,
    },
    { ...base, id: "legacy", label: "Old file", fileRevision: undefined },
    { ...base, id: "incomplete", label: "Incomplete", status: "downloading" },
    { ...base, id: "manga", label: "Manga", kind: "manga" },
  ];
  await page.route("**/api/downloads", (route) => route.fulfill({ json: { jobs } }));
  await page.route("**/api/settings/downloads", (route) =>
    route.fulfill({
      json: { dir: "/synthetic/Movies", defaultDir: "/synthetic/Movies", custom: null },
    }),
  );
  await page.goto(`${baseURL}downloads`);
  await expect(page.getByRole("link", { name: /^Play / })).toHaveCount(3);
  const episode = new URL(
    (await page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "Special", exact: true }) })
      .getByRole("link", { name: /^Play / })
      .getAttribute("href")) || "",
    baseURL,
  );
  expect(episode.searchParams.get("season")).toBe("0");
  expect(episode.searchParams.get("episode")).toBe("2");
  const anime = new URL(
    (await page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "Anime", exact: true }) })
      .getByRole("link", { name: /^Play / })
      .getAttribute("href")) || "",
    baseURL,
  );
  expect(anime.searchParams.get("malId")).toBe("20");
  expect(anime.searchParams.get("episode")).toBe("3");
  await expect(
    page.getByText("Your existing files can play in Flyx.", { exact: false }),
  ).toBeVisible();
});

test("a delayed fallback for an old Anime cannot replace the new title or carry over its position", async () => {
  await routes();
  let autoRequests = 0;
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fallbackPending = false;
  await page.route("**/api/anime/stream?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("malId") === "20" && !query.has("provider") && ++autoRequests >= 2) {
      fallbackPending = true;
      await delayed;
    }
    await route
      .fulfill({
        json: {
          success: true,
          provider: "online",
          sources: [{ url: remote, quality: "720p", type: "mp4" }],
        },
      })
      .catch(() => {});
  });
  await page.route("**/api/stream/local-source?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        success: true,
        provider: "local",
        sources: [
          {
            ...local,
            url: localUrl.slice(0, -1) + (url.searchParams.get("malId") === "20" ? "1" : "2"),
            language: "sub",
          },
        ],
      },
    });
  });
  await page.goto(`${baseURL}watch?tmdbId=0&malId=20&mediaType=tv&season=1&episode=1`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl.slice(0, -1) + "1");
  await failLocal(31);
  await expect.poll(() => fallbackPending).toBe(true);
  await page.evaluate(() => {
    history.pushState({}, "", "/watch?tmdbId=0&malId=21&mediaType=tv&season=1&episode=1");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(video()).toHaveAttribute("data-test-src", localUrl.slice(0, -1) + "2");
  release();
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(0);
  await expect(video()).toHaveAttribute("data-test-src", localUrl.slice(0, -1) + "2");
});

test("saved local progress resumes after reopening the same movie without a t parameter", async () => {
  await routes();
  await page.goto(`${baseURL}watch?tmdbId=101&mediaType=movie&t=31`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(31);
  await video().evaluate((node: HTMLVideoElement) => node.pause());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("flyx_watch_progress:synthetic-ui-account") || "[]")[0]
            ?.currentTime,
      ),
    )
    .toBe(31);
  await page.goto(`${baseURL}watch?tmdbId=101&mediaType=movie`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  await expect.poll(() => video().evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(31);
});

test("legacy files require a reviewed exact filename and explicit confirmation before Play appears", async () => {
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "video",
    status: "done",
    label: "Existing movie",
    tmdbId: 101,
    mediaType: "movie",
    filename: "Legacy.mp4",
    filepath: "/previous/location/Legacy.mp4",
    createdAt: 1,
    updatedAt: 2,
  };
  let bound = false;
  const submissions: unknown[] = [];
  await page.route("**/api/downloads", (route) =>
    route.fulfill({
      json: { jobs: [{ ...job, fileRevision: bound ? "b".repeat(64) : undefined }] },
    }),
  );
  await page.route("**/api/settings/downloads", (route) =>
    route.fulfill({
      json: { dir: "/synthetic/Movies", defaultDir: "/synthetic/Movies", custom: null },
    }),
  );
  await page.route("**/api/downloads/*/relink**", async (route) => {
    if (route.request().method() === "POST") {
      submissions.push(route.request().postDataJSON());
      bound = true;
      return route.fulfill({ json: { ok: true } });
    }
    const filename = new URL(route.request().url()).searchParams.get("filename");
    if (filename === "Missing.mp4")
      return route.fulfill({
        status: 404,
        json: { ok: false, error: "The saved file is missing. Check its exact filename." },
      });
    return route.fulfill({
      json: {
        ok: true,
        preview: {
          proof: "synthetic-proof",
          file: {
            filename,
            filepath: `/synthetic/Movies/${filename}`,
            size: 1024,
            modifiedAt: 1700000000000,
          },
          relocated: true,
          replacement: false,
        },
      },
    });
  });
  await page.goto(`${baseURL}downloads`);
  await expect(page.getByRole("link", { name: /^Play / })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Link saved file for Existing movie", exact: true })
    .click();
  const region = page.getByRole("region", { name: "Link saved file", exact: true });
  await expect(region).toContainText("/synthetic/Movies/Legacy.mp4");
  await expect(region).toContainText("TMDB 101");
  const confirm = region.getByRole("button", { name: "Confirm and link file", exact: true });
  await expect(confirm).toBeDisabled();
  expect(submissions).toEqual([]);
  await region.getByRole("checkbox", { name: "This file is Existing movie.", exact: true }).check();
  await expect(confirm).toBeEnabled();
  await region.getByRole("textbox", { name: /^Exact filename/ }).fill("Missing.mp4");
  await expect(confirm).toHaveCount(0);
  await region.getByRole("button", { name: "Check file", exact: true }).click();
  await expect(region.getByRole("alert")).toContainText("missing");
  await region.getByRole("textbox", { name: /^Exact filename/ }).fill("Chosen.mp4");
  await region.getByRole("button", { name: "Check file", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Confirm and link file", exact: true }),
  ).toBeDisabled();
  await region.getByRole("checkbox").check();
  await region.screenshot({ path: test.info().outputPath("legacy-relink-confirmation.png") });
  await page.setViewportSize({ width: 375, height: 850 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await region.screenshot({
    path: test.info().outputPath("legacy-relink-confirmation-narrow.png"),
  });
  await region.getByRole("button", { name: "Confirm and link file", exact: true }).click();
  await expect(page.getByRole("link", { name: "Play Existing movie", exact: true })).toBeVisible();
  expect(submissions).toEqual([{ confirmed: true, proof: "synthetic-proof" }]);
});

test("a downloaded dubbed Anime Play link selects its recorded local audio track", async () => {
  await routes();
  await page.route("**/api/stream/local-source?**", (route) =>
    route.fulfill({
      json: { success: true, provider: "local", sources: [{ ...local, language: "dub" }] },
    }),
  );
  await page.goto(`${baseURL}watch?tmdbId=0&malId=20&mediaType=tv&season=1&episode=3&language=dub`);
  await expect(video()).toHaveAttribute("data-test-src", localUrl);
  await expect(
    page
      .getByRole("group", { name: "Audio language", exact: true })
      .getByRole("button", { name: "Dub", exact: true }),
  ).toHaveClass(/is-active/);
});

for (const scenario of [
  {
    name: "season-zero special",
    query: "tmdbId=202&mediaType=tv&season=0&episode=2",
    identity: { tmdbId: 202, mediaType: "tv", season: 0, episode: 2 },
  },
  {
    name: "Anime movie",
    query: "malId=30&mediaType=movie",
    identity: { tmdbId: 0, malId: 30, mediaType: "movie" },
  },
  {
    name: "legacy Anime series URL",
    query: "malId=20&mediaType=anime&episode=3",
    identity: { tmdbId: 0, malId: 20, mediaType: "tv", season: 1, episode: 3 },
  },
]) {
  test(`normal Play prefers local and Download preserves the exact ${scenario.name} identity`, async () => {
    await routes();
    const lookups: URL[] = [];
    const qualities: URL[] = [];
    const queued: Array<{ items: Array<Record<string, unknown>> }> = [];
    await page.route("**/api/stream/local-source?**", (route) => {
      lookups.push(new URL(route.request().url()));
      return route.fulfill({ json: { success: true, provider: "local", sources: [local] } });
    });
    await page.route("**/api/downloads/qualities?**", (route) => {
      qualities.push(new URL(route.request().url()));
      return route.fulfill({ json: { ok: true, sources: [] } });
    });
    await page.route("**/api/downloads", (route) => {
      queued.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, count: 1 } });
    });
    await page.goto(`${baseURL}watch?${scenario.query}`);
    await expect(video()).toHaveAttribute("data-test-src", localUrl);
    const lookup = Object.fromEntries(lookups[0].searchParams);
    for (const [key, value] of Object.entries(scenario.identity))
      expect(lookup[key]).toBe(String(value));
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await page.getByRole("button", { name: "Download now", exact: true }).click();
    await expect.poll(() => queued.length).toBe(1);
    expect(queued[0].items[0]).toMatchObject(scenario.identity);
    if (scenario.identity.mediaType === "movie") {
      expect(queued[0].items[0]).not.toHaveProperty("episode");
      expect(queued[0].items[0]).not.toHaveProperty("season");
    } else {
      expect(qualities[0].searchParams.get("season")).toBe(String(scenario.identity.season));
    }
  });
}


test("remote renderer starts the selected movie and acknowledges actual paused/seek state",async()=>{
 await routes();await page.goto(`${baseURL}search`);
 const result=await page.evaluate(()=> (window as any).__remoteSend({id:'movie',type:'play',kind:'movie',contentID:101}));
 expect(result.ok).toBe(true);expect(result.data.status.state).toBe('playing');
 await expect(video()).toHaveAttribute('data-flyx-remote-ready',JSON.stringify(['movie','101','1','1']));
 const paused=await page.evaluate(()=> (window as any).__remoteSend({id:'pause',type:'pause'}));expect(paused.data.status.state).toBe('paused');
 const seek=await page.evaluate(()=> (window as any).__remoteSend({id:'seek',type:'seek',seconds:35}));expect(seek.data.status.position).toBe(35);
});
test("remote renderer switches same-title TV episode before acknowledging playback",async()=>{
 await routes();
 await page.route("**/api/stream/local-source?**",route=>{const episode=new URL(route.request().url()).searchParams.get('episode');return route.fulfill({json:{success:true,provider:'local',sources:[{...local,url:localUrl.slice(0,-1)+episode}]}});});
 await page.goto(`${baseURL}watch?tmdbId=101&mediaType=tv&season=1&episode=1`);
 await expect(video()).toHaveAttribute('data-flyx-remote-ready',JSON.stringify(['tv','101','1','1']));
 const result=await page.evaluate(()=> (window as any).__remoteSend({id:'episode',type:'play',kind:'tv',contentID:101,season:1,episode:2}));
 expect(result.ok).toBe(true);expect(result.data.status.state).toBe('playing');
 await expect(video()).toHaveAttribute('data-test-src',localUrl.slice(0,-1)+'2');
 await expect(video()).toHaveAttribute('data-flyx-remote-ready',JSON.stringify(['tv','101','1','2']));
});
