import { describe, expect, it, vi } from 'vitest';
import { listenForMp4Source } from './mp4-source-events';

function fixture() {
  const video = Object.assign(new EventTarget(), { currentTime: 0, paused: true, seeking: false });
  const callbacks = { onMetadata: vi.fn(), onError: vi.fn(), onProgress: vi.fn(), onHealthyPlayback: vi.fn() };
  const stop = listenForMp4Source(video, callbacks);
  return { video, callbacks, stop };
}

describe('MP4 source event lifetime', () => {
  it('keeps recovery attached when a source fails after successful metadata', () => {
    const { video, callbacks } = fixture();
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('error'));
    expect(callbacks.onMetadata).toHaveBeenCalledOnce();
    expect(callbacks.onError).toHaveBeenCalledOnce();
  });
  it('keeps buffering updates attached after metadata', () => {
    const { video, callbacks } = fixture();
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('progress'));
    expect(callbacks.onProgress).toHaveBeenCalledOnce();
  });
  it('does not reapply startup policy on repeated metadata events', () => {
    const { video, callbacks } = fixture();
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(callbacks.onMetadata).toHaveBeenCalledOnce();
  });
  it('removes all stale callbacks when a source is replaced', () => {
    const { video, callbacks, stop } = fixture();
    stop();
    for (const type of ['loadedmetadata', 'error', 'progress']) video.dispatchEvent(new Event(type));
    expect(callbacks.onMetadata).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onProgress).not.toHaveBeenCalled();
  });
});

it('metadata and four seconds of failed playback do not reset the retry budget', () => {
  const { video, callbacks } = fixture();
  video.dispatchEvent(new Event('loadedmetadata'));
  video.paused = false;
  for (let time = 0; time <= 4; time += 0.25) {
    video.currentTime = time; video.dispatchEvent(new Event('timeupdate'));
  }
  video.dispatchEvent(new Event('error'));
  expect(callbacks.onHealthyPlayback).not.toHaveBeenCalled();
  expect(callbacks.onError).toHaveBeenCalledOnce();
});
it('resets the retry budget only after ten seconds of actual playback progress', () => {
  const { video, callbacks } = fixture();
  video.paused = false;
  for (let time = 0; time <= 11; time += 0.25) {
    video.currentTime = time; video.dispatchEvent(new Event('timeupdate'));
  }
  expect(callbacks.onHealthyPlayback).toHaveBeenCalledOnce();
});
it('does not treat seeking far forward as sustained playback', () => {
  const { video, callbacks } = fixture();
  video.paused = false;
  video.dispatchEvent(new Event('timeupdate'));
  video.currentTime = 1800; video.dispatchEvent(new Event('timeupdate'));
  for (let time = 1800.25; time <= 1804; time += 0.25) {
    video.currentTime = time; video.dispatchEvent(new Event('timeupdate'));
  }
  expect(callbacks.onHealthyPlayback).not.toHaveBeenCalled();
});
it('does not count a paused time jump as playback progress', () => {
  const { video, callbacks } = fixture();
  video.dispatchEvent(new Event('timeupdate'));
  video.currentTime = 100; video.dispatchEvent(new Event('timeupdate'));
  expect(callbacks.onHealthyPlayback).not.toHaveBeenCalled();
});
