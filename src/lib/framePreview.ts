// Live frame previews for the desktop player's progress bar. A hidden second
// <video> plays the same MEGA node over its own stream session and seeks to
// wherever the pointer hovers; each completed seek hands the element to the
// caller to paint onto a canvas. Seeks run one at a time and only the latest
// requested time survives, so a fast sweep across the bar costs a handful of
// range requests rather than one per pixel. The session isn't opened until
// the first request, so merely watching a video never pays for it.

import { createStreamUrl } from './stream';

interface MegaFileLike {
  size?: number;
  name?: string | null;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

export interface FramePreviewer {
  /** Asks for the frame at `time` (seconds). A newer request replaces an older unserved one. */
  request(time: number): void;
  /** True once a seek has failed for good; callers can stop asking. */
  readonly failed: boolean;
  dispose(): void;
}

// Requests closer than this to the frame being shown are not worth a seek.
const MIN_STEP_S = 0.25;
const SEEK_TIMEOUT_MS = 12000;
const METADATA_TIMEOUT_MS = 20000;

export function createFramePreviewer(
  node: MegaFileLike,
  onFrame: (video: HTMLVideoElement, time: number) => void
): FramePreviewer {
  let video: HTMLVideoElement | null = null;
  let cleanup: (() => void) | null = null;
  let loading: Promise<void> | null = null;
  let pending: number | null = null;
  let shown: number | null = null;
  let busy = false;
  let disposed = false;
  let failed = false;

  function makeVideo(): HTMLVideoElement {
    const v = document.createElement('video');
    v.muted = true;
    // 'metadata' still decodes the frame at each seek target but stops the
    // browser reading far ahead of it, which would burn MEGA transfer quota.
    v.preload = 'metadata';
    v.playsInline = true;
    return v;
  }

  function waitMetadata(v: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      if (v.readyState >= 1) return resolve();
      const timer = window.setTimeout(() => {
        off();
        reject(new Error('metadata timeout'));
      }, METADATA_TIMEOUT_MS);
      const off = () => {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', onLoaded);
        v.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        off();
        resolve();
      };
      const onError = () => {
        off();
        reject(new Error('video load error'));
      };
      v.addEventListener('loadedmetadata', onLoaded);
      v.addEventListener('error', onError);
    });
  }

  // `seeked` alone can fire before a decodable frame is available, so poll
  // readyState as the strip capturer does.
  function waitSeek(v: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + SEEK_TIMEOUT_MS;
      const check = () => {
        if (disposed) return reject(new Error('disposed'));
        if (v.error) return reject(new Error(v.error.message || `video error ${v.error.code}`));
        if (!v.seeking && v.readyState >= 2 && v.videoWidth > 0) return resolve();
        if (Date.now() > deadline) return reject(new Error('seek timeout'));
        window.setTimeout(check, 40);
      };
      check();
    });
  }

  async function load(): Promise<void> {
    const stream = await createStreamUrl(node);
    if (disposed) {
      stream.cleanup();
      return;
    }
    cleanup = stream.cleanup;
    const v = makeVideo();
    video = v;
    v.src = stream.url;
    try {
      await waitMetadata(v);
    } catch (err) {
      failed = true;
      throw err;
    }
  }

  async function pump(): Promise<void> {
    if (busy || disposed || failed || !video) return;
    busy = true;
    try {
      while (pending != null && !disposed) {
        const t = pending;
        pending = null;
        if (shown != null && Math.abs(shown - t) < MIN_STEP_S) continue;
        try {
          video.currentTime = t;
          await waitSeek(video);
        } catch (err) {
          if (disposed) return;
          if (video.error) {
            failed = true;
            console.warn('Frame preview stream failed:', err);
            return;
          }
          // A timed-out seek just drops this request; the next hover retries.
          continue;
        }
        shown = t;
        onFrame(video, t);
      }
    } finally {
      busy = false;
    }
  }

  return {
    get failed() {
      return failed;
    },
    request(time: number) {
      if (disposed || failed) return;
      pending = time;
      if (!loading) {
        loading = load()
          .then(() => pump())
          .catch((err) => {
            console.warn('Frame preview unavailable:', err);
          });
        return;
      }
      pump();
    },
    dispose() {
      disposed = true;
      pending = null;
      const v = video;
      video = null;
      if (v) {
        try {
          v.pause();
        } catch (_) {}
        v.removeAttribute('src');
        try {
          v.load();
        } catch (_) {}
      }
      cleanup?.();
      cleanup = null;
    },
  };
}
