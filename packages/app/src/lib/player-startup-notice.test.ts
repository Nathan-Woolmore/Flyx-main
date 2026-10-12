import { describe, expect, it } from 'vitest';
import { getStartupNotice, playFromStartupButton } from './player-startup-notice';

const pausedSource = {
  status: 'ready' as const, hasSource: true, hasStarted: false,
  playing: false, pauseOnStartup: true,
};

describe('watch startup notice', () => {
  it('offers Play for an available source intentionally paused at startup', () => {
    expect(getStartupNotice(pausedSource)).toBe('press-play');
  });
  it('retains first-frame buffering once playback has actually been requested', () => {
    expect(getStartupNotice({ ...pausedSource, playing: true })).toBe('buffering');
  });
  it('does not change normal autoplay startup', () => {
    expect(getStartupNotice({ ...pausedSource, pauseOnStartup: false })).toBe('buffering');
  });
  it('does not cover the frame when an already-started movie is paused', () => {
    expect(getStartupNotice({ ...pausedSource, hasStarted: true })).toBeNull();
  });
  it.each(['idle', 'loading', 'error'] as const)('does not label %s as ready to play', (status) => {
    expect(getStartupNotice({ ...pausedSource, status })).toBeNull();
  });
  it('does not offer Play when no source is available', () => {
    expect(getStartupNotice({ ...pausedSource, hasSource: false })).toBeNull();
  });
});

it('one startup Play click cannot bubble into a second stage toggle', () => {
  let playing = false;
  let propagationStopped = false;
  let toggleCount = 0;
  const togglePlay = () => { playing = !playing; toggleCount++; };
  playFromStartupButton({ stopPropagation: () => { propagationStopped = true; } }, togglePlay);
  // The stage's single-tap handler would otherwise toggle back after 280ms.
  if (!propagationStopped) togglePlay();
  expect(playing).toBe(true);
  expect(toggleCount).toBe(1);
});
