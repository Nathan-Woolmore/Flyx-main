# Flyx Remote architecture and setup

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/app` | Existing Flyx web UI, canonical catalogue/progress and renderer-side remote adapter |
| `packages/desktop/src/remote` | HTTPS protocol, pairing, scopes, media grants and transfer coordination |
| `ios/Flyx Remote` | Independent SwiftUI app and portable Xcode project |
| `tests/remote` | Synthetic bridge regressions and opt-in native Simulator fixture servers |

The iOS tree is not an npm workspace or an Electron resource. The existing Mac build commands and paths remain in place.

## Setup checklist

1. Build the matching Mac and iOS source from this fork's canonical `main` (or the same pairing feature commit on both devices). Upstream releases do not contain this companion work.
2. Keep both devices on the same local network. In Flyx on the Mac, open **Settings → Connect Devices → Connect your iPhone**. On a new or moved Mac, choose **Review connection setup** and review the native confirmation before creating this Mac's private identity and restarting Flyx. This uses the Mac's existing `.local` name; it does not rename macOS or install system trust.
3. Choose **Create connection code**, then copy the complete code. It combines the HTTPS endpoint, certificate pin, existing 256-bit pairing secret and expiry. It remains valid for two minutes, with the existing five-attempt limit. Keep it private.
4. On the iPhone choose **App mode → Mac Remote**. On **Your Mac. In reach.**, paste the code and connect. Approve that iPhone's request explicitly in the Mac panel. Download permissions remain optional.
5. A remembered Mac always offers **Retry** and **Use a new code**. Offline, old-hostname and rejected connections keep the existing Keychain record until a replacement is approved. Cancel abandons only that request; it cannot revoke an older enrolled device. Browser HTTP QR pairing remains a separate flow.

The code supplies the pinned identity out of band; neither public discovery nor a short numeric password establishes trust. DNS resolves the supplied `.local` name. After a same-hostname LAN address change, reviewing setup updates the private binding while retaining the certificate. A changed hostname or expired certificate requires explicit native confirmation and a new phone code. Setup retains previous identity/configuration files and existing account, download and device records. Installation and isolated tests do not establish physical phone playback.

The iOS app needs existing personal Xcode signing or a supported distribution channel. This repository does not supply a generally installable IPA.

## Mac build

Use the repository's existing development prerequisites and a supported Node.js runtime (Node 24 was used for validation). From the root:

```sh
npm ci
npm run desktop:build
npm run dist --workspace=@flyx/desktop -- --mac --arm64 --dir --publish never
```

macOS packaging also requires Apple's command-line compiler tools for the native launcher and DNS-SD addon. Build the CPU architecture you intend to run. These commands build a candidate; they do not install it or configure remote access. See [desktop documentation](desktop.md) and [native Cast notes](../packages/desktop/NATIVE_CAST.md).

## Private listener setup

Remote access defaults off. **Settings → Connect Devices → Connect your iPhone** offers private setup after an explicit native confirmation. Reading setup state or cancelling creates no directory, identity, configuration or enrollment. A new identity is never silently generated during launch. The manual schema below remains an advanced fallback; do not replace an existing identity without the owner's approval.

Use the Mac's own resolvable `.local` hostname and a private IPv4 address assigned to its current LAN interface. Prepare a server certificate with that hostname in its SAN and its private key on that Mac. Keep the `remote` directory inside Flyx's user data directory private (mode `0700`); the configuration, certificate and key must be ordinary, owner-held files with mode `0600`, in that same directory. Symlinks, escaping paths, public/wildcard bindings and unavailable interface addresses are rejected.

For a normal macOS build the data directory is `~/Library/Application Support/flyx`. The following is a schema example, not an enrolled connection; replace the placeholders with your own local paths and values:

```json
{
  "host": "your-mac.local",
  "bindAddress": "192.168.1.10",
  "port": 3892,
  "certFile": "/absolute/private/flyx/remote/server-cert.pem",
  "keyFile": "/absolute/private/flyx/remote/server-key.pem",
  "enabled": false
}
```

Save it as `remote/config.json`. Keep every referenced file in that directory. Restart your own source-built candidate after configuring it, then enable secure remote in Mac settings when you intend to grant network access. Any macOS Local Network prompt is the owner's decision; do not change privacy databases, disable security protections or forward the port to the internet. A LAN-address change can be reviewed in the connection panel without renaming the Mac.

The complete connection code carries the certificate fingerprint; advanced connection details also show it on the Mac. The HTTPS client validates the pinned identity; it does not require globally trusting a private CA. Pairing offers are short-lived, require explicit Mac approval and return the phone credential once. The Mac persists digests; the iOS Keychain holds its scoped credential. Disable/revoke access from Mac settings. Admin credentials and provider URLs remain on the Mac.

Approved phone pairings do not expire and survive app and Mac restarts until explicitly revoked. Existing approved devices, including records with the former time limits, migrate to permanent pairing; revoked devices stay removed. Stored `expires: 0` and protocol `expiresAt: 0` / `expiresIn: 0` mean no pairing expiry and remain compatible with existing iPhone builds. Connection codes and pending approval still have their short time limits.

Closing the Mac window or choosing Quit (including Command-Q) hides Flyx and keeps the phone connection running. Use **Quit Flyx Completely** in the menu bar tray to stop the app and its connection service.

## Command and media flow

The phone sends allowlisted, authenticated operations to the Mac HTTPS listener. The Electron main process applies scopes and forwards bounded requests only to the trusted renderer. That renderer reuses the existing Flyx catalogue, download manager, source selection and native player/Cast implementation. Download/watchlist mutations require their explicit scopes.

Phone media is accessed through expiring, owner-bound opaque handles. The phone does not receive the Mac administrator secret or arbitrary provider URLs. Clear on-demand HLS resources are rewritten to bounded opaque resource IDs; encrypted/live playlists are rejected.

Transfers use caller-known transaction IDs with prepare, commit, native/origin confirmation, status reconciliation and cancellation. Native readiness, media identity, transfer tickets and receiver session identity are checked before stopping the origin. The iOS shared session retains ownership across screens and rejects stale polling results. Progress is saved in the existing account-scoped canonical store with session/sequence protection against stale writes.

## Download library and playback

The companion download library shows the Mac's canonical movie/episode identity, available artwork, state, progress and known file sizes. Play checks the saved record/file again before opening the normal iPhone, Mac or TV flow. Existing verified local media is preferred by the shared source resolver. Missing or unbound files require retry/relinking rather than being labelled ready.

Queue admission is serialized and checks persisted exact movie/episode identities. An active job or a verified completed file is reused, including repeated requests after relaunch; different episodes and specials remain separate. A failed/missing-file retry creates a separate output and does not overwrite completed media.

Cancel stops an active job; partial video output may be discarded. Cancelling a manga collection keeps verified cached chapter pages for retry. The Remote offers Delete download for revision-bound finished files, confirmed as a recoverable move to Mac Trash. List-only removal is retained only in the underlying Mac API for compatibility. An explicit action intent prevents a stale confirmation from changing meaning.

These features require the matching build-41 Mac bridge and iOS companion. Existing pairing, scoped permissions and the Mac silent-playback policy stay in place.

## Native Home and source reporting

Build 44 adds a native iOS Home tab alongside Browse, Watchlist, Remote and Downloads. The Mac Home page and companion feed share the same five TMDB lists; anime and manga reuse their existing Mac catalogue routes. Top 10 movie badges retain weekly trending positions. Other rows keep their provider order without a combined ranking. The scoped Home endpoint supports a short memory cache, coalesced refreshes and explicit stale/empty/error rows. Title details keep the existing resume, save, download and playback-destination flows.

Home categories load their own supported Mac sections: weekly trending, popular and top-rated TV; popular, airing, top-rated, upcoming and movie anime; and popular, latest, action, romance and fantasy manga. Category caches and response ownership stay separate during switching. The mixed All feed remains available. Fetch timestamps and ranking diagnostics stay internal.

Now Playing reports the selected download or provider and its requested/advertised quality label. Mac and iPhone dimensions come from their current player when available; TV resolution remains unknown. Confirmed TV session metadata is retained independently of subsequent Mac browsing. Source fallback notices identify download failure or a previous source failure. Only allowlisted provenance crosses the Remote boundary; media URLs and signing queries remain private.

Casting a completed local download serves the saved MP4's unchanged range bytes. Download creation can stream-copy or compatibility-encode a source; a requested quality label is not a measured file resolution or bitrate. Buffering does not add detail to an already-saved file.

## Distribution status

This fork is public source. As checked on 17 October 2026, the fork has no GitHub release assets containing these changes. Upstream release links in the general README refer to upstream builds and do not include this branch's companion/bridge work.

The default Mac packaging configuration uses ad-hoc signing, disables hardened runtime and has no notarization workflow. A privately development-signed local build is not a public Developer ID/notarized release. General Mac distribution still needs an appropriate release/signing/notarization workflow; see [Apple Developer ID](https://developer.apple.com/developer-id/) and [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

The iOS project can be cloned and built in Simulator or signed by each developer for their own device. There is no universal IPA, TestFlight or App Store distribution here. Apple's [Personal Team rules](https://developer.apple.com/help/account/basics/about-your-developer-account) require periodic reprovisioning for free personal-device testing. No personal signed binaries, credentials, private keys or provisioning profiles belong in this repository.


Remote Downloads offers confirmed Delete download for finished files and Cancel download for active jobs. List-only removal is not offered in the phone UI; the underlying Mac API remains compatible. Delete uses the existing downloads.write permission, requires the completed file revision, checks the exact configured-root child and rejects symlinks, replacements, shared destinations and open files. The macOS backend uses Foundation Trash with no permanent file-deletion fallback. Native failure or unconfirmed completion keeps the record; history-save failure after a move reports the file may already be in Trash. History removal is atomic. Older unbound downloads need relinking before deletion.

Movie details show a trailer beneath the overview when TMDB supplies a valid YouTube trailer. The existing English catalogue prefers an official English trailer. Playback uses the official YouTube iframe API in WKWebView with the installed app bundle identity as its HTTPS base URL/Referer, requires a tap and never follows the movie output selector. Branding and player controls remain intact; an external YouTube fallback appears if embedding fails. No YouTube stream extraction, rehosting or custom Cast transfer is used. See https://developers.google.com/youtube/terms/required-minimum-functionality for WebView identity requirements. Browse uses the Flyx Browse heading; Home remains Flyx Home.

The featured Home card uses an opaque backing, a fully opaque gradient end, and a single final continuous rounded clip after compositing to keep artwork color from leaving a thin edge at the bottom corners.

Trailer previews use a rounded thumbnail with one centered Liquid Glass play button on iOS 26 and a material fallback on older supported versions. No phone-playback explanation or external link appears in the preview. An actionable YouTube fallback appears only on embedding failure. The custom preview is replaced completely by the official player when opened; it never overlays the player controls.

Movie and TV details load TMDB audience reviews independently at the bottom, beneath title information. The existing English TMDB reviews endpoints and catalog.read permission provide paginated review text in native TMDB order, without invented helpfulness ranks or spoiler claims. Cards use plain text, expandable previews, optional author dates/scores, and original TMDB review links. Empty results hide the section; a local retry leaves the rest of details usable. The unmodified approved TMDB SVG and required notice appear in review credits. Official endpoints: https://developer.themoviedb.org/reference/movie-reviews and https://developer.themoviedb.org/reference/tv-series-reviews ; attribution: https://developer.themoviedb.org/docs/faq .

The approved TMDB logo is preserved unchanged from the current official homepage asset: https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg .

Native poster cards and their loading placeholders use shared poster, metadata and title slots, with 2:3 responsive catalogue posters and shared adaptive columns across Browse and Watchlist. Home rails share headers, subtitles, card slots, margins and height metrics; category switches use only the selected category cache. Pagination reserves its footer geometry. Title details reuse the real disabled/redacted video-control panel while loading, with a neutral progress status for unknown title/chapter information rather than arbitrary fake rows. Shimmer retains its existing Reduce Motion static behavior. Visible destination actions say Cast to TV without an ellipsis.
