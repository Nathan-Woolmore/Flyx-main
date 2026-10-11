# Native movie casting on macOS

Based on Flyx v3.2.10. The Electron Watch page now opens a native Google Cast
picker rather than relying on a browser Cast SDK that Electron does not provide.
The TV receives a signed, expiring URL from the existing Flyx LAN proxy. This
workflow sends the movie directly; it does not mirror a display or tab.

## Use

Enable Flyx LAN sharing, keep Flyx open, and put the TV on the same home network.
Open a movie, choose **Cast to TV**, then select the receiver. A private IPv4
address can be entered if Bonjour discovery does not find it.

The receiver must acknowledge both mute and volume zero before every media load.
Local playback pauses when TV media is actually accepted. The native overlay
provides playback, seeking, stop, mute, and volume controls. An explicitly marked
silent test package also disables local autoplay and mutes Electron audio; normal
packages do not permanently disable local audio.

## macOS packaging

The bundle declares its Local Network usage and the `_googlecast._tcp` Bonjour
service. macOS may require the user to approve Local Network access. No permission
is automatically granted, and privacy databases, firewall settings, quarantine,
and system security protections are not changed.

Apple TN3178 requires distinct primary-executable UUIDs for distinct apps.
The packaging hook re-links the primary executable from the Electron entry-point
source with an app-specific identity before signing. It preserves Electron's
normal and Node entry points and the existing RunAsNode fuse check. The Electron
framework and security fuse settings stay unchanged. macOS builds now require
Apple's command-line compiler tools. The adapted source retains Electron's MIT
license in `build/mac-main-LICENSE.txt`.

Desktop incremental caches stay in bounded memory so the server does not write
new files into the signed application bundle.

## Validation and remaining limit

- Production standalone build passed.
- All 129 desktop tests passed, including Cast framing, silent-load acknowledgement,
  device/session lifecycle, IPC origin checks, private-address validation, and
  signed host-proxy URL validation.
- Application type checking passed; touched player files have zero lint errors
  and pre-existing explicit-any warnings.
- Installed Watch-page picker and paused, muted, zero-volume startup were verified.
- A separate silent receiver fixture verified playback and transport controls.

Actual movie handoff from the installed application remains unverified. On the
tested Mac, the installed app still received `EHOSTUNREACH` although the receiver
port was reachable outside the app; macOS showed neither a Flyx Local Network
entry nor an approval prompt. The rebuilt primary executable has a distinct UUID, and the installed bundle
signature remains valid after Home and Watch startup. The receiver still advertises
Google Cast and its port is reachable, but the corrected app still fails to connect
with `EHOSTUNREACH` and has no Local Network entry or prompt. Ad-hoc signing is retained;
Apple recommends an Apple-issued signing identity for reliable permission tracking.
Do not interpret the standalone fixture result as proof of installed-app casting.

References: [Apple TN3178](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems),
[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy),
[Electron v43.4.0 entry point](https://github.com/electron/electron/blob/v43.4.0/shell/app/electron_main_mac.cc).
