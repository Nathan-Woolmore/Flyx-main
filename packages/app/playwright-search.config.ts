import { defineConfig } from "@playwright/test";

// Isolated UI tests: no live account, production profile, API keys or media requests.
export default defineConfig({
  testDir: "./e2e/search",
  testMatch: ["filters-state.spec.ts", "local-playback.spec.ts", "manga-layout.spec.ts"],
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "../../coverage/search-ui",
});
