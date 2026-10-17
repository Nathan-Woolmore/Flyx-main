# Flyx Remote for iOS

A SwiftUI iPhone/iPad companion for the Flyx Mac app. The Mac supplies catalogues, authentication, media sources, watch progress, watchlist and download jobs. The phone can control Mac playback, play compatible MP4/clear on-demand HLS locally, and transfer playback through the Mac's native Google Cast bridge.

This folder is independent of the JavaScript workspaces. Existing desktop build paths are unchanged. Electron's package allowlist and Next.js tracing exclusions keep this tree out of the Mac payload.

## Build in Simulator

Requirements: a Mac, Xcode with Swift 6 and an iOS 18 or later SDK. There are no third-party Swift dependencies.

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

Browse supports movies, TV, anime and manga through the Mac backend. The Now Playing **Playback destination** menu offers Mac, This iPhone and **Cast to TV…**. Receiver discovery and casting go through the Mac. Unsupported/unavailable outputs show an error or disabled state. Encrypted/live/unsupported phone formats remain unavailable.

One shared playback session owns the phone player across Browse detail and Remote screens. Closing controls or pressing Done does not stop playback or cancel a transfer; use the explicit Cancel transfer or Stop control. Transfers preserve episode identity, position and paused state after destination acknowledgement. Progress is saved through the Mac's account-scoped store.

The current integration checks use generated silent video, an actual Simulator AVPlayer, production controller/protocol code and inert Mac/Cast outputs. They cover repeated handoffs, source failures, cancellation, lost replies, Done during preparation, reopening controls and rotation. They do not establish complete live-provider or physical-TV compatibility. See [remote tests](../../tests/remote/README.md).
