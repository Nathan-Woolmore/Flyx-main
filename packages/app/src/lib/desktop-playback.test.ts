import { describe, expect, it, vi } from 'vitest';
import { applyDesktopSourceAutoplay, restoreHiddenDesktopPlayback } from './desktop-playback';

function fakeVideo(paused = true) {
  return { muted: false, volume: 0.6, paused,
    play: vi.fn(() => Promise.resolve()), pause: vi.fn() };
}

describe('desktop source-ready autoplay policy', () => {
  it('keeps initial silent startup paused without issuing play or pause', () => {
    const video = fakeVideo();
    applyDesktopSourceAutoplay(video, true);
    expect(video).toMatchObject({ muted: true, volume: 0, paused: true });
    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });
  it('does not abort an explicit Play when source metadata arrives late', async () => {
    let resolvePlay!: () => void;
    let rejectPlay!: (error: Error) => void;
    const pendingPlay = new Promise<void>((resolve, reject) => {
      resolvePlay = resolve; rejectPlay = reject;
    });
    const video = fakeVideo(false);
    video.play.mockImplementation(() => pendingPlay);
    video.pause.mockImplementation(() => rejectPlay(new Error('Play interrupted by pause')));
    const userPlay = video.play();
    applyDesktopSourceAutoplay(video, true);
    resolvePlay();
    await expect(userPlay).resolves.toBeUndefined();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).not.toHaveBeenCalled();
    expect(video).toMatchObject({ muted: true, volume: 0, paused: false });
  });
  it('does not stop already-playing silent video on another timeline callback', () => {
    const video = fakeVideo(false);
    applyDesktopSourceAutoplay(video, true);
    expect(video.paused).toBe(false);
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
  });
  it('preserves normal source-ready autoplay', () => {
    const video = fakeVideo();
    applyDesktopSourceAutoplay(video, false);
    expect(video.play).toHaveBeenCalledOnce();
    expect(video).toMatchObject({ muted: false, volume: 0.6 });
    expect(video.pause).not.toHaveBeenCalled();
  });
});

it('ordinary window activation cannot reload a visible movie', () => {
  const reload = vi.fn();
  expect(restoreHiddenDesktopPlayback({ current: false }, reload)).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
it('a genuine tray restore reloads once and repeated show events do not repeat it', () => {
  const hidden = { current: true };
  const reload = vi.fn();
  expect(restoreHiddenDesktopPlayback(hidden, reload)).toBe(true);
  expect(hidden.current).toBe(false);
  expect(restoreHiddenDesktopPlayback(hidden, reload)).toBe(false);
  expect(reload).toHaveBeenCalledOnce();
});
