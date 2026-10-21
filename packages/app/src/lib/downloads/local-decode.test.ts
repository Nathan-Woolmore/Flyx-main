import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { _electron, type ElectronApplication } from "@playwright/test";
import { NextRequest } from "next/server";
import type { DownloadJob } from "./types";
import { localFileRevision, findLocalDownloadSources } from "./local-files";
import { GET, HEAD } from "@/app/api/stream/local/route";

const fixture = vi.hoisted(() => ({ jobs: [] as DownloadJob[], directory: "" }));
vi.mock("@/lib/auth/get-session", () => ({ getSession: async () => ({ isAdmin: true }) }));
vi.mock("@/lib/downloads/manager", () => ({ listJobs: () => fixture.jobs }));
vi.mock("@/lib/downloads/types", async (original) => ({
  ...(await original<object>()),
  getDownloadDir: () => fixture.directory,
}));
vi.mock("@/lib/db", () => ({ getSetting: () => "" }));

/** Opt-in Mac integration: generate only synthetic video and serve it through the real local route. */
it.runIf(process.platform === "darwin" && Boolean(process.env.FLYX_TEST_FFMPEG))(
  "decodes and seeks a generated silent H.264 fixture through the real read-only local route",
  async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "flyx-decode-fixture-"));
    let application: ElectronApplication | undefined;
    let server: http.Server | undefined;
    try {
      fixture.directory = path.join(temporary, "Movies");
      await fs.mkdir(fixture.directory);
      const filepath = path.join(fixture.directory, "Generated-color-test.mp4");
      await promisify(execFile)(
        process.env.FLYX_TEST_FFMPEG!,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=24",
          "-t",
          "8",
          "-an",
          "-c:v",
          "libx264",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          filepath,
        ],
        { timeout: 20_000 },
      );
      const stat = await fs.stat(filepath, { bigint: true });
      fixture.jobs = [
        {
          id: randomUUID(),
          kind: "video",
          status: "done",
          label: "Generated synthetic video",
          tmdbId: 101,
          mediaType: "movie",
          filename: path.basename(filepath),
          filepath,
          fileRevision: localFileRevision(stat),
          progress: 100,
          bytes: Number(stat.size),
          totalBytes: Number(stat.size),
          outTimeMs: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      ];
      const source = (
        await findLocalDownloadSources(fixture.jobs, fixture.directory, {
          tmdbId: 101,
          mediaType: "movie",
        })
      )[0]!;
      expect(source).toBeDefined();
      const requests: Array<{ method: string; range: string | null; status: number }> = [];
      server = http.createServer((request, response) => {
        void (async () => {
          if (request.url === "/") {
            response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
            response.end(
              '<!doctype html><html><body><video id="fixture" muted playsinline width="320" height="180"></video></body></html>',
            );
            return;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers))
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(",") : value);
          const url = new URL(request.url || "/", "http://127.0.0.1");
          if (url.pathname !== "/api/stream/local") {
            response.writeHead(404);
            response.end();
            return;
          }
          const next = new NextRequest(url, { headers });
          const result = await (request.method === "HEAD" ? HEAD(next) : GET(next));
          requests.push({
            method: request.method || "GET",
            range: headers.get("range"),
            status: result.status,
          });
          response.writeHead(result.status, Object.fromEntries(result.headers));
          if (result.body)
            await pipeline(
              Readable.fromWeb(result.body as import("node:stream/web").ReadableStream),
              response,
            );
          else response.end();
        })().catch(() => response.destroy());
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      application = await _electron.launch({
        executablePath: path.resolve(
          __dirname,
          "../../../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
        args: [path.resolve(__dirname, "../../../e2e/search/fixture/decode-electron.cjs")],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "",
          FLYX_DECODE_TEST_PROFILE: path.join(temporary, "profile"),
        },
      });
      const page = await application.firstWindow();
      await page.route("https://**/*", (route) => route.abort());
      await page.goto(origin);
      await page.evaluate(async (url) => {
        const video = document.querySelector<HTMLVideoElement>("video")!;
        video.muted = true;
        video.volume = 0;
        video.src = url;
        await video.play();
      }, source.url);
      await page.waitForFunction(
        () => {
          const video = document.querySelector<HTMLVideoElement>("video")!;
          return video.currentTime >= 0.35 && video.getVideoPlaybackQuality().totalVideoFrames >= 3;
        },
        undefined,
        { timeout: 15_000 },
      );
      const initial = await page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>("video")!;
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d")!;
        context.drawImage(video, 0, 0);
        const pixels = context.getImageData(0, 0, 320, 180).data;
        const colors = new Set<number>();
        for (let i = 0; i < pixels.length; i += 4 * 111)
          colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
        video.pause();
        return {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
          colors: colors.size,
          muted: video.muted,
          volume: video.volume,
        };
      });
      expect(initial).toMatchObject({ width: 320, height: 180, muted: true, volume: 0 });
      expect(initial.duration).toBeCloseTo(8, 1);
      expect(initial.colors).toBeGreaterThan(10);
      const seeks: number[] = [];
      for (const target of [5.25, 1.25]) {
        await page.evaluate(async (time) => {
          const video = document.querySelector<HTMLVideoElement>("video")!;
          await new Promise<void>((resolve, reject) => {
            video.addEventListener("seeked", () => resolve(), { once: true });
            video.addEventListener(
              "error",
              () => reject(new Error("Synthetic video decode failed")),
              { once: true },
            );
            video.currentTime = time;
          });
          await video.play();
        }, target);
        await page.waitForFunction(
          (time) => document.querySelector<HTMLVideoElement>("video")!.currentTime > time + 0.15,
          target,
        );
        seeks.push(
          await page.evaluate(() => {
            const video = document.querySelector<HTMLVideoElement>("video")!;
            video.pause();
            return video.currentTime;
          }),
        );
      }
      const range = await page.evaluate(async (url) => {
        const response = await fetch(url, { headers: { Range: "bytes=100-199" } });
        return {
          status: response.status,
          length: (await response.arrayBuffer()).byteLength,
          contentRange: response.headers.get("Content-Range"),
        };
      }, source.url);
      expect(range).toMatchObject({ status: 206, length: 100 });
      expect(requests.some((request) => request.range && request.status === 206)).toBe(true);
      const report = {
        syntheticVideoOnly: true,
        codec: "H.264 baseline, yuv420p",
        audioTrack: false,
        browser: "Isolated sandboxed Electron on arm64 Mac",
        initial,
        seekPositions: seeks,
        range,
        httpRequests: requests,
        userMediaRead: false,
        tvCommands: false,
      };
      if (process.env.FLYX_TEST_DECODE_REPORT)
        await fs.writeFile(
          process.env.FLYX_TEST_DECODE_REPORT,
          JSON.stringify(report, null, 2) + "\n",
        );
      console.info(
        "Synthetic local decode/seek passed",
        JSON.stringify({
          decodedFrames: initial.decodedFrames,
          duration: initial.duration,
          seeks,
          rangeStatus: range.status,
        }),
      );
    } finally {
      await application?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      fixture.jobs = [];
      await fs.rm(temporary, { recursive: true, force: true });
    }
  },
  45_000,
);
