/** Runtime-only policy for the explicitly approved silent desktop test build. */
export function isSilentDesktopPlayback(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { flyxDesktop?: { silentPlaybackMode?: boolean } })
    .flyxDesktop?.silentPlaybackMode === true;
}
