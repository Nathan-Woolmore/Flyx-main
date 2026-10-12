export type StartupNotice = 'press-play' | 'buffering' | null;

/** A source awaiting an intentional Play action is not stalled playback. */
export function getStartupNotice({
  status, hasSource, hasStarted, playing, pauseOnStartup,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error';
  hasSource: boolean;
  hasStarted: boolean;
  playing: boolean;
  pauseOnStartup: boolean;
}): StartupNotice {
  if (status !== 'ready' || !hasSource || hasStarted) return null;
  return pauseOnStartup && !playing ? 'press-play' : 'buffering';
}

/** Keep the Play button from also triggering the stage's tap-to-pause handler. */
export function playFromStartupButton(
  event: { stopPropagation: () => void },
  togglePlay: () => void,
): void {
  event.stopPropagation();
  togglePlay();
}
