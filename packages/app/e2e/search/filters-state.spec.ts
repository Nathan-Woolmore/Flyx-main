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
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-search-ui-"));
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
});
test.afterEach(async () => {
  await application?.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});

const item = (id: number, rating = 8.5) => ({
  id,
  title: `Ghost ${id}`,
  mediaType: "movie",
  vote_average: rating,
  genre_ids: [27],
  release_date: "2005-01-01",
});
const cards = () => page.getByRole("button", { name: /^View Ghost/ });

async function rating(value: number) {
  await page.getByRole("searchbox", { name: "Search content" }).click();
  const slider = page.getByRole("slider", { name: "Minimum rating minimum", exact: true });
  await slider.focus();
  await expect(slider).toBeFocused();
  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  for (let count = 0; count < value * 2; count += 1) {
    await slider.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", String((count + 1) / 2));
  }
}

test("Horror plus changing rating sends combined criteria and renders a genuine empty result only at exhaustion", async () => {
  const requests: URL[] = [];
  await page.route("**/api/content/search?**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const min = Number(url.searchParams.get("minRating") || 0);
    // Delayed obsolete request must not win over the newer slider selection.
    if (min === 7) await new Promise((resolve) => setTimeout(resolve, 650));
    await route
      .fulfill({
        json: { data: min > 9 ? [] : [item(min === 8 ? 8 : 1)], page: 1, nextPage: null },
      })
      .catch(() => {});
  });
  await page.goto(`${baseURL}search?type=movie`);
  await expect(cards()).toHaveCount(1);
  await page.getByRole("button", { name: "Horror", exact: true }).click();
  await rating(7);
  await expect
    .poll(() => requests.some((url) => url.searchParams.get("minRating") === "7"))
    .toBe(true);
  await rating(8);
  await expect(page.getByRole("button", { name: "View Ghost 8", exact: true })).toBeVisible();
  expect(requests.at(-1)!.searchParams.get("genre")).toBe("horror");
  await expect(page.getByRole("button", { name: "Horror", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rating(9.5);
  await expect(page.getByText("No results found", { exact: true })).toBeVisible();
  await expect(cards()).toHaveCount(0);
  await rating(7.5);
  await expect(cards()).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("horror-rating.png"), fullPage: true });
});

test("detail Back and browser Back restore all criteria, loaded pages, order, next cursor and scroll", async () => {
  const pages: number[] = [];
  await page.route("**/api/content/search?**", async (route) => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get("page"));
    pages.push(number);
    await route.fulfill({
      json: {
        data: Array.from({ length: 24 }, (_, index) =>
          item((number - 1) * 24 + index + 1, 9 - ((number - 1) * 24 + index) / 100),
        ),
        page: number,
        nextPage: number < 3 ? number + 1 : null,
      },
    });
  });
  const search = `${baseURL}search?q=ghost&type=movie&genre=horror,mystery&yearFrom=1980&yearTo=2020&minRating=7&sort=rating`;
  await page.goto(search);
  await expect(cards()).toHaveCount(24);
  await page.locator(".search-loading").scrollIntoViewIfNeeded();
  await expect(cards()).toHaveCount(48);
  await page.evaluate(() => window.scrollTo(0, 650));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(650);
  const before = await cards().allTextContents();
  // DOM click avoids Playwright changing the list scroll before navigation.
  await cards()
    .first()
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.getByRole("heading", { name: "Title details" })).toBeVisible();
  const callsBeforeBack = pages.length;
  await page.getByRole("button", { name: "← Back", exact: true }).click();
  await expect(cards()).toHaveCount(48);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(650);
  expect(await cards().allTextContents()).toEqual(before);
  expect(pages).toHaveLength(callsBeforeBack);
  await expect(page.getByRole("searchbox", { name: "Search content" })).toHaveValue("ghost");
  await expect(page.getByRole("combobox", { name: "Sort results" })).toHaveValue("rating");
  for (const genre of ["Horror", "Mystery"])
    await expect(page.getByRole("button", { name: genre, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  await expect(
    page.getByRole("slider", { name: "Minimum rating minimum", exact: true }),
  ).toHaveAttribute("aria-valuenow", "7");
  await expect(
    page.getByRole("slider", { name: "Release year minimum", exact: true }),
  ).toHaveAttribute("aria-valuenow", "1980");
  await expect(
    page.getByRole("slider", { name: "Release year maximum", exact: true }),
  ).toHaveAttribute("aria-valuenow", "2020");
  await page.screenshot({ path: test.info().outputPath("back-restored.png"), fullPage: true });
  await page.locator(".search-loading").scrollIntoViewIfNeeded();
  await expect(cards()).toHaveCount(72);
  expect(pages.at(-1)).toBe(3);
  await page.evaluate(() => window.scrollTo(0, 0));
  await cards().first().click();
  await expect(page.getByRole("heading", { name: "Title details" })).toBeVisible();
  await page.goBack();
  await expect(cards()).toHaveCount(72);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("sparse batches offer continuation and errors have a retry instead of a false empty state", async () => {
  let attempt = 0;
  await page.route("**/api/content/search?**", async (route) => {
    attempt += 1;
    if (attempt === 1) return route.fulfill({ json: { data: [], page: 5, nextPage: 6 } });
    if (attempt === 2)
      return route.fulfill({ status: 429, json: { message: "Please try again later" } });
    return route.fulfill({ json: { data: [item(6)], page: 6, nextPage: null } });
  });
  await page.goto(`${baseURL}search?q=ghost&genre=horror&minRating=8`);
  await expect(page.getByText("No results found", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Search more results" }).click();
  await expect(page.getByRole("alert")).toContainText("Please try again later");
  await expect(page.getByText("No results found", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Ghost 6", exact: true })).toBeVisible();
});

const animeRow = (id: number, score = 8.5) => ({
  mal_id: id,
  title: `Ghost Anime ${id}`,
  title_english: null,
  score,
  year: 2010,
  aired: { from: "2010-04-12T00:00:00+00:00" },
  members: 4000 - id,
  type: "TV",
  episodes: 0,
  images: {
    jpg: {
      image_url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      large_image_url:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    },
  },
  genres: [
    { mal_id: 14, name: "Horror" },
    { mal_id: 7, name: "Mystery" },
  ],
  relations: [],
});

test("Anime details Back and browser Back retain combined filters, rating, sorted pages and scroll", async () => {
  const pages: number[] = [];
  await page.route("**/api/anime/jikan?**", async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.searchParams.get("path") || "";
    if (endpoint === "/anime") {
      const number = Number(url.searchParams.get("page") || 1);
      pages.push(number);
      return route.fulfill({
        json: {
          data: Array.from({ length: 24 }, (_, index) =>
            animeRow((number - 1) * 24 + index + 1, 9 - ((number - 1) * 24 + index) / 100),
          ),
          pagination: { has_next_page: number < 3 },
        },
      });
    }
    if (/^[/]anime[/][0-9]+[/]full/.test(endpoint))
      return route.fulfill({ json: { data: animeRow(Number(endpoint.split("/")[2])) } });
    return route.fulfill({ json: { data: [], pagination: { has_next_page: false } } });
  });
  await page.goto(
    `${baseURL}search?type=anime&q=ghost&genre=horror,mystery&yearFrom=2000&yearTo=2020&minRating=7.5&sort=rating`,
  );
  const animeCards = page.getByRole("button", { name: /^View Ghost Anime/ });
  await expect(animeCards).toHaveCount(24);
  await page.locator(".search-loading").scrollIntoViewIfNeeded();
  await expect(animeCards).toHaveCount(48);
  await page.evaluate(() => window.scrollTo(0, 550));
  const order = await animeCards.allTextContents();
  await animeCards.first().evaluate((element: HTMLElement) => element.click());
  await expect(page.getByRole("heading", { name: "Ghost Anime 1", exact: true })).toBeVisible();
  const requestCount = pages.length;
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(animeCards).toHaveCount(48);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(550);
  expect(await animeCards.allTextContents()).toEqual(order);
  expect(pages).toHaveLength(requestCount);
  await expect(page.getByRole("button", { name: /^Anime/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("searchbox")).toHaveValue("ghost");
  await expect(page.getByRole("combobox", { name: "Sort results" })).toHaveValue("rating");
  await expect(
    page.getByRole("slider", { name: "Minimum rating minimum", exact: true }),
  ).toHaveAttribute("aria-valuenow", "7.5");
  for (const genre of ["Horror", "Mystery"])
    await expect(page.getByRole("button", { name: genre, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  await page.locator(".search-loading").scrollIntoViewIfNeeded();
  await expect(animeCards).toHaveCount(72);
  expect(pages.at(-1)).toBe(3);
  await page.evaluate(() => window.scrollTo(0, 0));
  await animeCards.first().click();
  await expect(page.getByRole("heading", { name: "Ghost Anime 1", exact: true })).toBeVisible();
  await page.goBack();
  await expect(animeCards).toHaveCount(72);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("Anime rating changes supersede an old request and provider failure is retryable", async () => {
  const queries: URL[] = [];
  let failed = false;
  await page.route("**/api/anime/jikan?**", async (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const min = Number(url.searchParams.get("min_score") || 0);
    if (min === 7) await new Promise((resolve) => setTimeout(resolve, 600));
    if (min === 9 && !failed) {
      failed = true;
      return route.fulfill({ json: { data: [], error: "Upstream unavailable", source: "empty" } });
    }
    return route
      .fulfill({
        json: { data: [animeRow(min === 8 ? 8 : 1, 9)], pagination: { has_next_page: false } },
      })
      .catch(() => {});
  });
  await page.goto(`${baseURL}search?type=anime&genre=horror`);
  await expect(page.getByRole("button", { name: "View Ghost Anime 1", exact: true })).toBeVisible();
  await rating(7);
  await expect
    .poll(() => queries.some((url) => url.searchParams.get("min_score") === "7"))
    .toBe(true);
  await rating(8);
  await expect(page.getByRole("button", { name: "View Ghost Anime 8", exact: true })).toBeVisible();
  expect(queries.at(-1)!.searchParams.get("genres")).toBe("14");
  await rating(9);
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByText("No results found", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Ghost Anime 1", exact: true })).toBeVisible();
});

for (const width of [1280, 375]) {
  test(`search input keeps placeholder and long typed text clear of both icons at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 850 });
    await page.route("**/api/anime/jikan?**", (route) =>
      route.fulfill({ json: { data: [animeRow(1)], pagination: { has_next_page: false } } }),
    );
    await page.goto(`${baseURL}search?type=anime`);
    const input = page.getByRole("searchbox", { name: "Search content" });
    await expect(input).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "View Ghost Anime 1", exact: true }),
    ).toBeVisible();
    const measure = () =>
      page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>("input.search-input")!;
        const style = getComputedStyle(field);
        const input = field.getBoundingClientRect();
        const icon = document.querySelector(".search-input-icon")!.getBoundingClientRect();
        const right = document.querySelector(".search-input-status")!.getBoundingClientRect();
        return {
          leftGap:
            input.left +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.paddingLeft) -
            icon.right,
          rightGap:
            right.left -
            (input.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)),
          padding: parseFloat(style.paddingLeft),
          width: input.width,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
    const placeholder = await measure();
    expect(placeholder.leftGap).toBeGreaterThanOrEqual(10);
    expect(placeholder.padding).toBe(48);
    expect(placeholder.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`input-placeholder-${width}.png`) });
    await input.fill(
      "A very long Anime title to verify the text stays clear of the search icon and clear button",
    );
    await expect(page.getByRole("button", { name: "Clear search", exact: true })).toBeVisible();
    const typed = await measure();
    expect(typed.leftGap).toBeGreaterThanOrEqual(10);
    expect(typed.rightGap).toBeGreaterThanOrEqual(6);
    expect(typed.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`input-typed-${width}.png`) });
  });
}
