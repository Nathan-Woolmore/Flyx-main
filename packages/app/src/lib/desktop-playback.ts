/** Runtime-only policy for the explicitly approved silent desktop test build. */
export function isSilentDesktopPlayback(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { flyxDesktop?: { silentPlaybackMode?: boolean } })
    .flyxDesktop?.silentPlaybackMode === true;
}

/** Apply source-ready autoplay policy without cancelling a user's pending Play. */
export function applyDesktopSourceAutoplay(
  video: Pick<HTMLVideoElement, 'muted' | 'volume' | 'play'>,
  silent = isSilentDesktopPlayback(),
): void {
  if (silent) {
    video.muted = true;
    video.volume = 0;
    // Autoplay is already disabled on the video element. A late metadata
    // callback must not pause playback that the user explicitly requested.
    return;
  }
  void video.play().catch(() => undefined);
}

/** Restore a torn-down tray session once; ordinary activation must not reload it. */
export function restoreHiddenDesktopPlayback(
  hidden: { current: boolean },
  reloadSource: () => void,
): boolean {
  if (!hidden.current) return false;
  hidden.current = false;
  reloadSource();
  return true;
}
