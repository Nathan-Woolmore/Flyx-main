/** Keep late MP4 errors and buffering updates observable after metadata arrives. */
export function listenForMp4Source(
  video: EventTarget & { currentTime: number; paused: boolean; seeking: boolean },
  callbacks: { onMetadata: () => void; onError: () => void; onProgress: () => void; onHealthyPlayback?: () => void },
): () => void {
  let closed = false;
  let metadataSeen = false;
  let lastTime: number | null = null;
  let playedSeconds = 0;
  let healthyNotified = false;
  const onMetadata = () => {
    if (closed || metadataSeen) return;
    metadataSeen = true;
    callbacks.onMetadata();
  };
  const onError = () => { if (!closed) callbacks.onError(); };
  const onProgress = () => { if (!closed) callbacks.onProgress(); };
  const onTime = () => {
    if (closed) return;
    if (video.paused || video.seeking) { lastTime = null; return; }
    const time = video.currentTime;
    if (!Number.isFinite(time)) return;
    if (lastTime != null) {
      const delta = time - lastTime;
      // Seek jumps are not evidence that the source delivered playable frames.
      if (delta > 0 && delta <= 1.5) playedSeconds += delta;
    }
    lastTime = time;
    if (playedSeconds >= 10 && !healthyNotified) {
      healthyNotified = true;
      callbacks.onHealthyPlayback?.();
    }
  };
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('loadedmetadata', onMetadata);
  video.addEventListener('error', onError);
  video.addEventListener('progress', onProgress);
  return () => {
    closed = true;
    video.removeEventListener('timeupdate', onTime);
    video.removeEventListener('loadedmetadata', onMetadata);
    video.removeEventListener('error', onError);
    video.removeEventListener('progress', onProgress);
  };
}
