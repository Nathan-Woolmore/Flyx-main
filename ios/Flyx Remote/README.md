# Flyx Remote for iOS

A SwiftUI iPhone/iPad app with Standalone and Mac Remote modes. In Mac Remote, the Mac supplies catalogues, authentication, media sources, watch progress, watchlist and download jobs. The phone can control Mac playback, play compatible MP4/clear on-demand HLS locally, and transfer playback through the Mac's native Google Cast bridge.

This folder is independent of the JavaScript workspaces. Existing desktop build paths are unchanged. Electron's package allowlist and Next.js tracing exclusions keep this tree out of the Mac payload.

## Build in Simulator

Requirements: a Mac, Xcode with Swift 6 and an iOS 18 or later SDK. Google Cast 4.8.6 is pinned through the official Swift Package Manager package; Xcode resolves it when building.

Open `Flyx Remote.xcodeproj`, choose the **Flyx Remote** scheme and an iOS Simulator, and build. From the repository root:

```sh
xcodebuild -project "ios/Flyx Remote/Flyx Remote.xcodeproj" \
  -scheme "Flyx Remote" -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath /tmp/FlyxRemoteBuild \
  CODE_SIGNING_ALLOWED=NO build
```

The checked-in Xcode project is ready to open. If changing file lists or build settings, regenerate it with [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
xcodegen generate --spec "ios/Flyx Remote/project.yml"
```

## Build for your own iPhone

In Xcode, sign in with your own Apple account. In the app target's **Signing & Capabilities**, choose your own team and a bundle identifier available to that team. Select your device and build using Xcode's normal development workflow. Do not commit team-specific changes, device identifiers, provisioning profiles, certificates or `xcuserdata`.

A free Personal Team supports personal-device testing, with periodic reprovisioning. It does not make a downloaded IPA generally installable. See [Apple's account and Personal Team guidance](https://developer.apple.com/help/account/basics/about-your-developer-account).

No signing team, certificate, provisioning profile, phone enrollment or remembered credential is supplied here. This is source distribution; there is no TestFlight/App Store release or generally installable IPA.

## Pair with your own Mac

Build the matching Mac source from this repository. Complete its normal local account/provider setup and keep Flyx open. Configure the private TLS listener described in [Flyx Remote setup](../../docs/flyx-remote.md), then enable it in **Settings → Security → Flyx Remote**. Compare the certificate fingerprint shown on the Mac, enter the Mac's HTTPS `.local` endpoint and pairing details on the phone, and explicitly approve the request on the Mac.

The phone stores only its own scoped credential and certificate pin in its non-synchronizing, device-only Keychain. The Mac stores credential digests. Watchlist writing and Mac download management require separate Mac-side permission. Revocation and disabling the listener are available in the Mac settings. No admin password or host master token should be copied into the phone.

## Playback and limits

In Mac Remote, Browse supports movies, TV, anime and manga through the Mac backend. The Now Playing **Playback destination** menu offers Mac, This iPhone and **Cast to TV**. Receiver discovery and casting go through the Mac. Unsupported/unavailable outputs show an error or disabled state. Encrypted/live/unsupported phone formats remain unavailable.

One shared playback session owns the phone player across Browse detail and Watch screens. Closing controls or pressing Done does not stop playback or cancel a transfer; use the explicit Cancel transfer or Stop control. Transfers preserve episode identity, position and paused state after destination acknowledgement. Progress is saved through the Mac's account-scoped store.

The current integration checks use generated silent video, an actual Simulator AVPlayer, production controller/protocol code and inert Mac/Cast outputs. They cover repeated handoffs, source failures, cancellation, lost replies, Done during preparation, reopening controls and rotation. They do not establish complete live-provider or physical-TV compatibility. See [remote tests](../../tests/remote/README.md).


## Fullscreen visibility and foreground recovery (build 70)

Fullscreen uses the existing video layer and a single Flyx overlay. Controls fade after three seconds of uninterrupted playback and reveal on a video tap. Pause, buffering, errors, scrubbing, held buttons, sheets, VoiceOver and Switch Control keep them available. Hidden controls leave hit testing and the accessibility tree; the video retains an accessible reveal action. Fullscreen hides tab/navigation chrome. Leaving fullscreen, backgrounding or dismissing cancels the idle deadline, and Reduce Motion suppresses the fade animation. Closing portrait fullscreen does not suppress the next landscape entry.

Foreground polling restarts independently of view preparation. Cached Mac/TV identity and progress survive transient connection loss while fresh status is reconciled; one warmup idle response cannot erase an active session. Confirmed idle or another actual Mac/TV session is accepted, and stale pre-background replies are rejected. Automatic routing retains the Remote backend while playback context exists. Phone playback saves its position and explicit play/pause intent, retains the same player/item when healthy, and can rebuild a suspended asset/listener using the same media lease and position without sending another prepare/start or remote play command. Failed recovery offers a local retry rather than resetting the application. Expired/revoked access still requires the appropriate user recovery.

Focused isolated Simulator checks use generated silent MP4 and HLS, in both standalone and Mac-backed phone pipelines, plus inert Mac/TV status changes and connection failures. These simulate scene lifecycle; they do not establish prolonged physical-device suspension behavior. A phone-hosted TV relay still requires Flyx in the foreground. No background relay capability or new OS permission is added. Physical playback is left untouched during validation; build/install status is recorded separately.

## Watch destination consistency (build 69)

The playback tab is named **Watch** in both backend modes. Selecting Play on This iPhone records the local destination before presenting controls or awaiting media/capability requests. The loading screen identifies This iPhone immediately; previous Mac status cannot replace the phone selection. Preparation runs under the shared playback owner, so closing controls does not retire it. Failure/cancellation keeps the phone selection with an unavailable state rather than displaying unrelated Mac playback.

A pending transfer displays its requested destination while controls stay routed to the confirmed owner. Success adopts the acknowledged output; failure/cancellation retains the origin. The same presentation ID prevents duplicate preparations, and generation checks reject stale Mac status and cancelled media replies. Settings still calls the backend connection mode Mac Remote. Focused Simulator checks use embedded generated silent video and inert Mac/TV responses; no physical playback or pairing is touched. Build and verification receipts stay outside source.

## Standalone candidate (build 68)

**Settings → Connection** offers Automatic, This iPhone and Mac Remote. Automatic opens the iPhone Home immediately and checks the existing paired Mac in the background. It prefers the paired Mac, checking every 10 seconds while active. Adoption and offline fallback wait for the Home root, at least 3 seconds after interaction, with no active/preparing playback or Settings sheet. The shared Home view and playback owner remain stable, preserving navigation, category and scroll state; generation checks reject stale replies. Manual selection suppresses automatic reconnect. An unavailable/unpaired Mac leaves Home usable on iPhone. Manual mode changes remain available, with the existing confirmation before ending active playback. No new pairing, credentials or permissions are created.

The watchlist keeps a durable phone replica and queued additions/removals. With the paired Mac available, it synchronizes in either mode, on refresh and every 20 seconds while the app is active. Pending edits overlay fresh Mac snapshots; acknowledged edits are removed by their individual operation IDs so a later phone edit survives a stale reply. Each Mac/account has a separate replica, and the Mac rejects writes for a changed account and remembers recent retry IDs. The first connection unions the existing lists. Offline changes wait for the Mac; an existing `watchlist.write` permission is required to send them. Viewing progress remains separate. The bridge owns pinned Mac transport; standalone catalogue/media services never receive a Mac credential.

### Home, manga and launch consistency in build 68

Standalone Home now matches every Remote category's section IDs, order, titles and ranked rows. Movies and TV use the matching TMDB list endpoints. Anime retains AniList metadata with equivalent popular/airing/top/upcoming/movie feeds. Manga now uses the existing Mac WeebCentral catalogue, including its popular/latest/genre sections, exact series identities, chapter lists and advertised page addresses. Both modes render the same native Home cards and rails. Individual feed failures preserve previously loaded rows and display an accurate unavailable state.

Existing MangaDex bookmarks remain supported separately. Some MangaDex popular titles report English availability but return zero hosted English chapters. A genuine empty list now explains that limitation. Provider HTTP/page failures remain errors rather than successful empty chapter lists. The shared WeebCentral path never guesses a page CDN or falls back after an access refusal. Its native reader was checked with Solo Leveling:201 chapters, the first chapter's page rendered through the production client/service/reader, with native ImageIO decoding720 ×4000. Vertical pages use the available width and their true aspect ratio; offscreen decoded images are released while preserving scroll height. This is a focused source/reader check, not a full manga catalogue guarantee.

The signed iPhone and isolated Simulator builds pass. Inert checks cover safe automatic adoption, interaction/playback guards, manual override, delayed replies and existing mode-change confirmation. Offline watchlist checks cover initial union, Mac removal, offline edits, relaunch, stale acknowledgements, account isolation and mixed media IDs. Focused Mac API checks cover account binding, retry receipts, MangaDex bookmark identity and existing permission enforcement. Physical cross-device installation and synchronization status are recorded separately in the private diagnostics receipts.

### Brand New Day default-player support in build66

Spider-Man: Brand New Day advertises Swish as its default 2embed player. The iPhone adapter previously accepted only Vsrc/Videm and rejected that title before playback. It now recognizes the advertised Swish wrapper, applies the existing public wrapper-to-player mapping, and reads the player's static radix36 string table without evaluating JavaScript. Only its first advertised, same-origin HTTPS clear HLS source is selected; fetch failures do not trigger backup probing. Cookie scope, redirect refusal, encrypted/live HLS rejection and resource limits remain in the existing native pipeline. Swish is available for phone playback; its TV transport is not enabled by this change.

The initial rejection was reproduced through iPhone Mirroring on installed build65. Signed build66 was then installed in place on the same phone. The normal title detail Play action resolved `2embed · Swish`, decoded video at1536 ×720, and advanced from0:08 to0:15 before being paused. This was a brief physical-phone playback check, not a full-film or TV check. Twenty-six focused parser checks pass, including captured current No Way Home and Brand New Day responses. The signed app and embedded Cast framework pass strict signature verification. Existing phone data/pairing and the running Mac build remain unchanged.

Offline parser checks:

```sh
xcrun swiftc -module-cache-path /tmp/flyx-provider-cache \
  "ios/Flyx Remote/App/StandaloneProviderPage.swift" \
  "ios/Flyx Remote/Tests/StandaloneProviderPageChecks.swift" -o /tmp/flyx-provider-check
/tmp/flyx-provider-check
```

### Canonical project and SDK linkage in build65

Mac and iOS source now live together in the single Flyx repository. Open `ios/Flyx Remote/Flyx Remote.xcodeproj`; there is no separately maintained signing source copy. The user's existing team is loaded from ignored `Config/LocalSigning.xcconfig`. Recoverable obsolete copies and the full Git history bundle are outside source in the sibling `Flyx Artifacts/Archive`, with an old-to-new migration map. No running Mac app or phone app was replaced during consolidation.

From the repository root, `python3 scripts/build-ios.py` builds and strictly verifies the signed iPhone app. Add `--simulator` for the unsigned isolated preview. Build products, logs and package caches go to the sibling `Flyx Artifacts` folder; `FLYX_ARTIFACTS_DIR` can select a different local destination. Xcode's global settings and unrelated projects are unaffected.

SDK4.8.6 remains pinned to Google's official dynamic-binary URL and checksum. A small relative local package manifest references that unchanged artifact without the upstream wrapper's redundant static GTMSessionFetcher dependency. Binary inspection confirmed seven duplicate GTM classes before this correction and zero afterward. This corrects a concrete SDK runtime conflict; it does not establish the cause of the earlier device memory termination.

### Settings, TMDB access and client lifetime in build64

Settings is integrated as a compact cog in the existing Home and Browse headers. The extra global top strip is removed. Connection states retain toolbar access to app mode, and Watchlist/Downloads expose Settings in their navigation bars. Home uses one header background and additional bottom scroll spacing; its existing loading and loaded card metrics are retained. The production Home loading and loaded views were visually checked in an isolated iPhone17 Simulator with inert networking. Wider/compact device and larger-text review remains pending.

TMDB setup accepts either API Key (v3 auth), sent as the `api_key` query parameter, or API Read Access Token, sent as `Authorization: Bearer`. The user chooses the credential type, enters it in a secure field and validates it against TMDB before saving. The existing device-only, non-synchronizing Keychain item is retained; legacy raw values are recognized by format. Validation errors explain format, rejected credentials, rate limits and network failures without echoing secrets or provider response text. Fifteen synthetic request/mock-response checks pass with no Keychain access or live credential use. A real user credential has not been validated by this engineering check.

RemoteClient now invalidates URLSessions it owns when the client is released; injected sessions remain caller-owned. A bounded test using the production initializer showed500 of500 sessions retained before the fix and0 after it, without network requests. This confirms a reconnect/client lifetime leak. It does not establish the cause or peak of the earlier physical-device memory kill: Xcode confirms build63 installed and launched, then ran for about12 minutes before iOS terminated it for memory use. The available Jetsam report predates that run and contains no Flyx entry. A separate21-second sample of the already-running phone app stayed between35.94 and36.30MiB physical footprint. Duplicate GTMSessionFetcher classes are present in the SDK launch console and remain a separate compatibility finding, with no measured link to the termination.

The External SSD checkout is canonical for both builds and local signing. `Config/Signing.xcconfig` optionally includes ignored `Config/LocalSigning.xcconfig`, preserving the user's selected team without committing it. Build64 Simulator and signed iPhone builds pass, including strict app/framework signature verification. Installed phone build63 is verified; build64 has not been installed. The Documents copy remains preserved pending recoverable consolidation after closing the open Xcode target.

### Real-source relay correction and screen wake in build63

The build62 provider timeout was caused by the relay's origin guard rejecting advertised segment CDN resources before fetching them. A same-selected-lease comparison established that the original phone proxy decoded the stream while the relay returned its own HTTP502. The relay now accepts only the two observed exact CDN hosts (`p16-ad-site-sign-sg.tiktokcdn.com` and `p19-ad-site-sign-sg.tiktokcdn.com`) for registered resources advertised by the existing selected vidsrc.buzz / videm.xyz source. Cookies and authorization are stripped on those CDN requests. Other cross-origin hosts, arbitrary URLs, redirects and oversized resources remain rejected; existing access-refusal handling is unchanged.

The Grand Budapest Hotel passes the corrected comparison: the original phone proxy and relay use the same resolved stream and both decode at1280 ×720 with advancing time. Relay pause, seek and resume pass. The provider emits a nonfatal declared-bandwidth warning; no relay502 occurs before teardown in the passing check. This proves real-source relay delivery through the production HTTP handler in a loopback-only Simulator surrogate. It does not establish real iPhone private-interface binding, Local Network permission behavior or Veon receiver compatibility.

Flyx disables its app-local idle timer only after the selected relay receives a matching active receiver acknowledgement. It restores the previous value on stop, cancel, failure, disconnect and background shutdown. The lifecycle check confirms active-relay wake and prior-setting restoration. Manually locking the phone or backgrounding Flyx still stops the relay. No system Auto-Lock setting or background mode changes. The signed iPhone build and strict signature verification pass; installed phone51 and Mac50 remain unchanged.

### Foreground selected-media relay in build62

Existing same-origin provider HLS is now eligible for a foreground phone relay. Only after explicit TV selection, the app chooses a private IPv4 Wi-Fi interface on the TV’s subnet and binds to that local address. The listener accepts only the selected receiver and a random 32-byte session path. It serves opaque resources from one selected media lease, never arbitrary URLs or files. Provider headers/cookies stay on the phone. HLS playlists, relative children and subtitle URIs are rewritten; the validated clear PNG-prefixed TS normalizer is reused. Single byte ranges apply after normalization. Cross-origin source resources, encrypted/live HLS and oversized resources are rejected.

Bounds are explicit: 4 client connections, 32 authenticated requests/second, 8 KiB headers, 8 MiB resources, the existing16,384-resource registry, 5 s header /30 s request deadlines, 8 s startup, 120 s idle expiry and 4 h maximum session lifetime. Upstream resource buffering is limited by a chunked URLSession delegate, with redirects disabled. Default Receiver CORS, Range, HEAD, OPTIONS, WebVTT MIME and private-network preflight headers are handled. End/cancel/mode changes/background/expiry close the listener; the app avoids stopping an unrelated receiver title.

Generated private HLS decoded through the actual HTTP handler at320 ×180 with advancing time, pause, seek and resume. Token/origin/query rejection, same-origin fetch restriction, normalized first/suffix ranges, HEAD, CORS, subtitle rewriting, oversized-resource rejection, background stop and expiry pass. Tests used a loopback-only surrogate and synthetic interface addresses; no actual private-LAN listener, Cast context, discovery or TV session was started.

The Grand Budapest Hotel provider relay test timed out before a decode result. Its cause remains unisolated and real provider relay playback is unverified. Actual iPhone private-interface binding, Veon access/decoding, controls and subtitles remain pending. This is an engineering checkpoint, not a verified casting release.

**Flyx must remain foreground with the phone awake/unlocked while relaying.** Backgrounding or screen lock intentionally ends the relay. No idle-timer override, background mode, VPN, public relay, network/firewall change or new credential/registration was added. The installed phone and Mac remain unchanged.

### Direct Cast checkpoint in build61

Standalone adds Cast to TV to the existing destination controls, using the official Google Cast iOS SDK4.8.6 and its Default Media Receiver. No custom receiver registration, new credential or system permission grant is created. Bonjour services and truthful Local Network usage text are declared in the app; discovery and media loading require explicit user interaction. SDK context initialization is deferred and analytics logging is disabled. Mac Remote keeps its existing Cast bridge.

This is a bounded compatibility checkpoint, not verified casting of the current movie provider. Header-free public HTTPS MP4 has a production direct-load path; an explicitly labelled public HLS sample exercises the same SDK request path in DEBUG. Existing provider HLS needs headers/cookies or phone-only segment normalization and is explicitly unavailable for direct Cast. No loopback URL or provider header is exported. At build61 a foreground phone LAN relay was not implemented, so those providers remained blocked; no public relay, VPN or custom receiver workaround is used.

Receiver state must confirm the selected URL before phone playback pauses. Loading sends current position and paused state. Stale/cancelled or mismatching acknowledgements are ignored, timeout/failure keeps phone playback, and unified controls dispatch pause/resume/seek to the receiver. A return-to-phone path restores the latest receiver position. These state paths are checked with an inert receiver; real Veon discovery, decoding, transfer behavior, receiver subtitles and background behavior require later hardware testing. Receiver quality is adaptive and separate from saved phone preferences. No hardware discovery/session is performed by the test.

Direct public media does not require a running phone media relay after loading, but receiver continuation and reconnect behavior remain unverified. A future relay-dependent provider must explain foreground execution limits and cannot promise background continuity. This build has not been installed on a phone or Mac.

### Quality preferences in build60

Standalone native playback now offers **Highest available** (the saved default), **Automatic**, and resolution preferences derived only from AVFoundation’s advertised HLS variants. A manual choice applies the native maximum-resolution and bitrate preferences to the same AVPlayerItem. It does not restart playback, move position or resume a paused item. The preference survives a new playback owner and mode switches. If a saved resolution is absent from a later source, the player uses highest available and explains the fallback; invalid new choices are rejected.

These are quality preferences, not forced rendition pinning. AVPlayer may adapt below the target. The controls show the source’s highest advertised resolution separately from the actual decoded dimensions. The real movie source in the focused check advertised1080p but was observed decoding720p; this is not a verified1080p playback claim.

Focused checks pass: the explicitly labelled public Apple HLS sample decodes at the selected480 ×270 target; The Grand Budapest Hotel continues native playback at the selected1280 ×720 preference after recovering from an inert502 before its live default source. Both retain the same player item, paused position and saved highest preference. Highest has no bitrate cap; Automatic clears resolution and bitrate caps. All existing offline mode/stale-reply/confirmation checks pass. Mac Remote’s Cast and phone-quality path remain unchanged.

Direct iPhone casting is a subsequent phase. No Cast SDK, TV session or hardware discovery has been added or run in this quality checkpoint. The current cookie-protected127.0.0.1 HLS listener cannot be passed to a receiver. Current provider headers/cookies and PNG-prefixed segments require a separate compatible receiver transport. Simulator checks cannot establish real Veon discovery/receiver playback or iOS background continuity.

### Focused build59 check

The Grand Budapest Hotel, Breaking Bad S1E2 and Death Note episode 3 all decode at 1280 × 720 in the muted Simulator, with advancing time, pause, seek, resume and matching saved progress. The anime uses live catalogue/details before the production player. The movie and TV samples exercise the production standalone resolver/player directly; personal-token TMDB catalogue browsing remains unverified. The passing full-length Inception check from build58 is retained because candidate59 does not alter movie/HLS/native playback code.

Breaking Bad S1E2 recovers from a clearly labelled inert502 before the real default source; episode identity remains S1E2 throughout. The separate offline403 refusal test stops fallback with zero network requests. Production still uses the first advertised source rather than probing backup servers.

All three new sources advertise Auto quality and expose a native CC option. Auto is selected without an artificial bitrate/resolution cap; decoded resolution is measured separately. Build59 did not expose manual resolution preferences; build60 adds them as described below.

The MangaDex URL builder now normalizes trailing base slashes and encodes reserved filename characters as path components. Offline compatibility checks pass. Refused standalone chapter/page loads hide Retry and explain that the user should check MangaDex service status/support. No denied image endpoint was retried, and the external HTTP403/code1010 refusal remains unresolved. Pages still save progress only after decoding.

These are headless production-pipeline checks. Manual tap-through remains blocked while the Mac is locked. Installed phone51 and Mac50 stay unchanged.

### Personal TMDB setup

Movie/TV catalogue browsing accepts the user's own TMDB API Key (v3 auth) or API Read Access Token. Enter it securely **after installation**:

1. Open **Settings**, turn **Remote mode** off, then use **Personal TMDB access**. The same setup is available through **Browse → Movies → Set up TMDB access**.
2. Under **Personal TMDB access**, select the matching credential type and enter its value in the secure field.
3. Tap **Validate and save on this iPhone**. TMDB must accept it before the catalogue refreshes.

The token uses a separate non-synchronizing, device-only Keychain item. No token needs to be sent in chat or copied from the Mac. Without one, Movies/TV show the setup card; keyless anime and manga discovery remain available. Movie/TV catalogue access with a user token has not been live-tested because no personal token was supplied.

### Verified scope and limits

- Inception plays through the advertised 2embed/Vsrc default source, decoded at 1280 × 536. Pause, seek, resume and local progress pass in a muted Simulator.
- Breaking Bad S1E1 plays at 1280 × 720; episode identity, pause, seek, resume and saved progress pass. A clearly labelled, inert 502 source placed before the live source verifies bounded recovery. Separate offline checks show a 403 refusal blocks fallback with zero network requests.
- Final build58 rechecks pass for Inception (native playback, pause, seek, resume and saved progress) and Breaking Bad S1E1 (the same controls plus matching episode identity). A preceding TV HTTP502 resolved on the one bounded same-path recheck; this does not guarantee provider uptime.
- Full-length HLS films can exceed 4,096 segment resources. Build58 fixes that local limit with a bounded 16,384-resource index and constant-time URL reuse; known resources remain usable at capacity. HTTPS validation, clear-media requirements, per-response limits and refusal handling remain in place.
- Production currently uses one advertised default source, without probing backup servers. The recovery check does not establish availability of multiple live providers or all titles.
- PNG-prefixed segments are accepted only when a bounded IEND parser finds verifiable clear 188-byte MPEG-TS packets. Scrambled packets, malformed data and oversized payloads are rejected. The validated prefix parser is unchanged from build55.
- Anime search, filters, paging and details work through AniList. TVmaze supplies episode mapping only when the animation title, release year and total episode count match exactly. Cowboy Bebop episode 1 plays through the independent default 2embed source at 970 × 720; advancing time, pause, seek, resume and saved progress pass in the muted Simulator. Anime films, OVAs and unmatched or ambiguous editions show an explicit unavailable state. Refused AnimeX hosts are not retried. Mac Remote retains its existing anime playback path. TVmaze attribution and its CC BY-SA API link appear in title information.
- A second anime check uses the live catalogue search and details APIs, then the production RemoteControlView, PhonePlaybackModel and AVPlayer for Cowboy Bebop episode 2. Catalogue ID1, IMDb tt0213338, provider S1E2 and saved progress agree. Video decodes at 486 × 360 with advancing time; this source supplies no selectable native subtitle tracks or recognized subtitle metadata. This is a headless production-pipeline check; a manual tap-through was blocked because the Mac was locked. Samurai Champloo episode 2 maps consistently, but its first advertised source returned HTTP404; no alternate server was probed.
- MangaDex catalogue/details/chapter lists work. Its advertised image endpoint returned Cloudflare HTTP 403 / error 1010, so reading/resume remains blocked by external image delivery. No alternate identity, image quality or CDN route was attempted after that refusal. The request matches MangaDex’s documented baseUrl/data-saver/hash/filename construction, carries no authentication header and was refused immediately after a fresh manifest. Build58 displays a specific MangaDex access-refused error; an offline check confirms the refusal path makes zero network requests. There is no established compliant client change that restores these refused images.
- Standalone is streaming-only by the agreed scope. Mac Remote Downloads remain available.
- Mac Remote retains its paired Keychain store, pinned TLS delegate and request transport. Connection-session generation checks now invalidate stale replies after a mode change. Focused offline checks pass for active-playback confirmation, delayed replies and switching both ways during unavailable/pending connection states, without reading or writing pairing credentials. Both mode choices restore across actual Simulator process relaunches. Connection, Settings and Remote UI were visually checked; no physical reconnect/playback check was performed for this candidate.

Simulator and signed iPhone build64 pass, including strict signature verification. Phone build63 was installed through Xcode and its current version is verified. Candidate64 remains uninstalled; Mac50 remains unchanged. No standalone GitHub publication has occurred.

Focused segment validation can be run with:

```sh
xcrun swiftc "ios/Flyx Remote/App/StandaloneSegment.swift" \
  "ios/Flyx Remote/Tests/StandaloneSegmentChecks.swift" -o /tmp/flyx-segment-check
/tmp/flyx-segment-check
```
