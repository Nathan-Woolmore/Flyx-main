# Remote bridge tests

From the repository root, after `npm ci`:

```sh
npm run test:remote
cd packages/app
npx vitest run src/lib/watch-progress.test.ts src/lib/remote/progress-bridge.test.ts
cd ../desktop
npx vitest run
```

The Node suite uses synthetic tokens, fake native players/receivers and loopback transport. Its TLS identity is generated in a temporary directory by `openssl` and removed immediately after reading it; no private key is checked in. Tests exercise scopes, revocation, catalogue filters, series identity, source/media bounds, HLS rewriting, audio-policy refusal, download/watchlist validation and transfer prepare/commit/confirm/cancel failure paths.

## Native Simulator fixtures (opt-in)

The `*.fixture.ts` files are intentionally outside normal test discovery. They start synthetic production-protocol/core/media/progress/transfer services on loopback only. Mac player/Cast objects are inert. They never contact the installed Flyx app or real TVs. Run one fixture at a time, from the root:

```sh
npx vitest run --config tests/remote/native-fixtures.config.ts tests/remote/native-switching-server40.fixture.ts
```

Build the iOS app in Debug. Generate a small 120-second silent H.264 MP4 with your local ffmpeg, then place it at `Library/Application Support/synthetic-progress.mp4` inside the dedicated Simulator app container:

```sh
ffmpeg -f lavfi -i color=c=black:s=320x180:r=2 -t 120 -an -c:v libx264 -pix_fmt yuv420p synthetic-progress.mp4
xcrun simctl get_app_container booted local.flyx.remote data
xcrun simctl launch booted local.flyx.remote --flyx-ui-fixture switching-e2e40
```

Use only a dedicated Simulator. Wait for **Native controller tests passed** before the optional UI checks. Open shared controls to inspect the destination menu. The slow-handoff button supports checking Done while preparation is pending; Done and closing controls must preserve the transfer and the player. Probe assertions are written inside that Simulator's app-data container, never committed. Rotate between upright portrait and either landscape and confirm the Close button is separate from volume.

The fixture has `/fixture/probe`, `/fixture/reset`, `/fixture/mode` and `/fixture/stop` endpoints on `127.0.0.1:47140`. Stop it with a POST of `{}` to `/fixture/stop`. It times out after ten minutes. The separate progress fixture uses port47138 and the `native-progress-save`, `native-progress-resume` and `native-progress-end` app modes. For ending tests, supply a six-second generated silent clip and reset the synthetic history first.

These fixtures cover the actual iOS AVPlayer and shared controller against production protocol logic. They do not prove physical-TV picture/audio, every provider, live media handoffs or real-device networking. Keep those as explicit manual acceptance checks.
