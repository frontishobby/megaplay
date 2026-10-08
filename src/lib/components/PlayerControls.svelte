<script lang="ts">
  // Desktop-only control bar layered over the native <video>. Mobile keeps the
  // browser's own controls (VideoView decides). The headline feature is the
  // seek bar's hover preview: a live frame of the hovered moment, with the
  // stored scene strip as a stand-in until the frame arrives.
  import { Play, Pause, Volume2, Volume1, VolumeX, Maximize, Minimize, Captions, CaptionsOff } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import type { MegaNode } from '../mega';
  import type { SceneData } from '../scenes';
  import { createFramePreviewer, type FramePreviewer } from '../framePreview';
  import { getStoredStrip, pickTimes, type StripData } from '../strips';

  let {
    video,
    container,
    node,
    scenes = null,
    hasSubtitles = false,
  } = $props<{
    video: HTMLVideoElement;
    container: HTMLElement;
    node: MegaNode;
    scenes?: SceneData | null;
    hasSubtitles?: boolean;
  }>();

  const PREVIEW_W = 240;
  const IDLE_HIDE_MS = 2500;
  const VOLUME_KEY = 'megaplay.volume';

  // --- Mirrored <video> state ---------------------------------------------
  let paused = $state(true);
  let ended = $state(false);
  let stalled = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let bufferedEnd = $state(0);
  let volume = $state(1);
  let muted = $state(false);
  let fullscreen = $state(false);
  let ccOn = $state(false);
  let aspect = $state(16 / 9);

  function bufferedEndAt(v: HTMLVideoElement, t: number): number {
    const b = v.buffered;
    for (let k = 0; k < b.length; k++) {
      if (b.start(k) <= t && t <= b.end(k)) return b.end(k);
    }
    return t;
  }

  function sync() {
    paused = video.paused;
    ended = video.ended;
    currentTime = video.currentTime;
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    bufferedEnd = bufferedEndAt(video, video.currentTime);
    volume = video.volume;
    muted = video.muted;
    if (video.videoWidth > 0 && video.videoHeight > 0) aspect = video.videoWidth / video.videoHeight;
    ccOn = subtitleTracks().some((t) => t.mode === 'showing');
  }

  function subtitleTracks(): TextTrack[] {
    const list = video.textTracks;
    const out: TextTrack[] = [];
    for (let k = 0; k < list.length; k++) if (list[k].kind === 'subtitles') out.push(list[k]);
    return out;
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved?.volume === 'number') video.volume = Math.min(1, Math.max(0, saved.volume));
        if (typeof saved?.muted === 'boolean') video.muted = saved.muted;
      }
    } catch (_) {}
    sync();
    const events = [
      'play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata',
      'progress', 'volumechange', 'seeking', 'seeked',
    ];
    for (const ev of events) video.addEventListener(ev, sync);
    const onWaiting = () => (stalled = true);
    const onReady = () => (stalled = false);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onReady);
    video.addEventListener('canplay', onReady);
    const onFs = () => (fullscreen = document.fullscreenElement === container);
    document.addEventListener('fullscreenchange', onFs);
    video.textTracks.addEventListener('change', sync);
    return () => {
      for (const ev of events) video.removeEventListener(ev, sync);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onReady);
      video.removeEventListener('canplay', onReady);
      document.removeEventListener('fullscreenchange', onFs);
      video.textTracks.removeEventListener('change', sync);
      if (document.fullscreenElement === container) document.exitFullscreen().catch(() => {});
    };
  });

  // --- Actions --------------------------------------------------------------
  function togglePlay() {
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  function seekTo(t: number) {
    if (!duration) return;
    video.currentTime = Math.min(Math.max(0, t), duration);
    currentTime = video.currentTime;
  }

  function seekBy(delta: number) {
    seekTo(video.currentTime + delta);
  }

  function persistVolume() {
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
    } catch (_) {}
  }

  function setVolume(v: number) {
    video.volume = Math.min(1, Math.max(0, v));
    if (video.volume > 0) video.muted = false;
    persistVolume();
  }

  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
    persistVolume();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else container.requestFullscreen?.().catch(() => {});
  }

  let lastShownLang: string | null = null;
  function toggleCaptions() {
    const tracks = subtitleTracks();
    if (tracks.length === 0) return;
    const showing = tracks.find((t) => t.mode === 'showing');
    if (showing) {
      lastShownLang = showing.language;
      for (const t of tracks) t.mode = 'disabled';
    } else {
      const pick = tracks.find((t) => t.language === lastShownLang) ?? tracks[0];
      for (const t of tracks) t.mode = t === pick ? 'showing' : 'disabled';
    }
    sync();
  }

  // --- Visibility: hide while playing and the pointer rests ----------------
  let visible = $state(true);
  let overBar = $state(false);
  let idleTimer: number | undefined;

  function poke() {
    visible = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (!paused && !overBar && !scrubbing) visible = false;
    }, IDLE_HIDE_MS);
  }

  function onLeave() {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (!paused && !scrubbing) visible = false;
  }

  $effect(() => {
    // Pausing brings the bar back; resuming starts the idle countdown.
    if (paused) visible = true;
    else poke();
  });

  // Click toggles play; a double click within the window goes fullscreen
  // instead, so the single click is held back briefly.
  let clickTimer: number | undefined;
  function onSurfaceClick() {
    if (clickTimer !== undefined) {
      clearTimeout(clickTimer);
      clickTimer = undefined;
      toggleFullscreen();
      return;
    }
    clickTimer = window.setTimeout(() => {
      clickTimer = undefined;
      togglePlay();
    }, 220);
  }

  // --- Seek bar + hover preview ---------------------------------------------
  let barEl: HTMLDivElement | undefined = $state();
  let hoverFrac = $state<number | null>(null);
  let scrubbing = $state(false);
  let barWidth = $state(0);
  let previewCanvas: HTMLCanvasElement | undefined = $state();
  let shownFrameTime = $state<number | null>(null);
  let previewer: FramePreviewer | null = null;
  let strip = $state<StripData | null>(null);
  let stripRequested = false;

  const hoverTime = $derived(hoverFrac == null ? null : hoverFrac * duration);
  const playedPct = $derived(duration ? (currentTime / duration) * 100 : 0);
  const bufferedPct = $derived(duration ? Math.min(100, (bufferedEnd / duration) * 100) : 0);
  const previewH = $derived(Math.round(PREVIEW_W / aspect));
  const previewLeft = $derived.by(() => {
    if (hoverFrac == null) return 0;
    const half = PREVIEW_W / 2;
    const x = hoverFrac * barWidth;
    return Math.min(Math.max(x, half), Math.max(half, barWidth - half));
  });
  // Live frame is stale (or absent) while the hover is far from what's drawn.
  const previewStale = $derived(
    hoverTime == null || shownFrameTime == null || Math.abs(shownFrameTime - hoverTime) > 1.5
  );
  const stripTimes = $derived(scenes ? pickTimes(scenes) : []);
  const stripFrame = $derived.by(() => {
    if (!strip || hoverTime == null) return -1;
    if (stripTimes.length === strip.frames) {
      let best = 0;
      for (let k = 1; k < stripTimes.length; k++) {
        if (Math.abs(stripTimes[k] - hoverTime) < Math.abs(stripTimes[best] - hoverTime)) best = k;
      }
      return best;
    }
    return duration ? Math.min(strip.frames - 1, Math.floor((hoverTime / duration) * strip.frames)) : 0;
  });
  const hoverScene = $derived.by(() => {
    const list = scenes?.scenes;
    if (!list || list.length === 0 || hoverTime == null) return null;
    for (let k = list.length - 1; k >= 0; k--) {
      if (hoverTime >= list[k].start) return list[k];
    }
    return list[0];
  });

  function fracFromEvent(e: PointerEvent): number {
    if (!barEl) return 0;
    const rect = barEl.getBoundingClientRect();
    barWidth = rect.width;
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function ensurePreviewer() {
    if (!previewer) {
      previewer = createFramePreviewer(node.node, (v, t) => {
        const c = previewCanvas;
        if (!c) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, c.width, c.height);
        shownFrameTime = t;
      });
    }
    if (!stripRequested) {
      stripRequested = true;
      getStoredStrip(node.id, node.node).then((s) => {
        if (s) strip = s;
      });
    }
  }

  function onBarEnter(e: PointerEvent) {
    overBar = true;
    ensurePreviewer();
    onBarMove(e);
  }

  function onBarMove(e: PointerEvent) {
    const f = fracFromEvent(e);
    hoverFrac = f;
    if (duration) previewer?.request(f * duration);
    if (scrubbing) seekTo(f * duration);
  }

  function onBarLeave() {
    overBar = false;
    if (!scrubbing) hoverFrac = null;
  }

  function onBarDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing = true;
    barEl?.setPointerCapture(e.pointerId);
    const f = fracFromEvent(e);
    hoverFrac = f;
    seekTo(f * duration);
  }

  function onBarUp(e: PointerEvent) {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      barEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (!overBar) hoverFrac = null;
  }

  // Changing a canvas's dimensions clears it, so forget the frame it held.
  $effect(() => {
    previewH;
    shownFrameTime = null;
  });

  $effect(() => {
    return () => {
      previewer?.dispose();
      previewer = null;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (clickTimer !== undefined) clearTimeout(clickTimer);
    };
  });

  // --- Keyboard -------------------------------------------------------------
  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    // A focused button (e.g. just-clicked play) still activates on Space/Enter
    // natively; everything else should keep driving the player.
    if ((tag === 'BUTTON' || tag === 'A') && (e.key === ' ' || e.key === 'Enter')) return;
    let handled = true;
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        togglePlay();
        break;
      case 'ArrowLeft':
        seekBy(-5);
        break;
      case 'ArrowRight':
        seekBy(5);
        break;
      case 'j':
      case 'J':
        seekBy(-10);
        break;
      case 'l':
      case 'L':
        seekBy(10);
        break;
      case 'ArrowUp':
        setVolume(video.volume + 0.1);
        break;
      case 'ArrowDown':
        setVolume(video.volume - 0.1);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'c':
      case 'C':
        toggleCaptions();
        break;
      case 'Home':
        seekTo(0);
        break;
      case 'End':
        seekTo(duration);
        break;
      default:
        if (/^[0-9]$/.test(e.key)) seekTo((Number(e.key) / 10) * duration);
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      poke();
    }
  }

  function fmt(sec: number | null): string {
    if (sec == null || !Number.isFinite(sec)) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="absolute inset-0 select-none {visible ? '' : 'cursor-none'}"
  onpointermove={poke}
  onpointerleave={onLeave}
>
  <!-- Click surface: everything above the bar -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="absolute inset-0" onclick={onSurfaceClick}></div>

  {#if stalled && !paused}
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div class="w-12 h-12 border-4 border-white/70 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {/if}

  <div
    class="absolute inset-x-0 bottom-0 pt-16 pb-2 px-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent transition-opacity duration-200 pointer-events-none {visible
      ? 'opacity-100'
      : 'opacity-0'}"
  >
    <!-- Seek bar -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={barEl}
      class="relative h-5 flex items-center cursor-pointer group/bar {visible
        ? 'pointer-events-auto'
        : 'pointer-events-none'}"
      onpointerenter={onBarEnter}
      onpointermove={onBarMove}
      onpointerleave={onBarLeave}
      onpointerdown={onBarDown}
      onpointerup={onBarUp}
      onpointercancel={onBarUp}
    >
      <div
        class="relative w-full rounded-full bg-white/25 overflow-hidden transition-[height] duration-150 {overBar ||
        scrubbing
          ? 'h-1.5'
          : 'h-1'}"
      >
        <div class="absolute inset-y-0 left-0 bg-white/40" style="width: {bufferedPct}%"></div>
        {#if hoverFrac != null}
          <div class="absolute inset-y-0 left-0 bg-white/30" style="width: {hoverFrac * 100}%"></div>
        {/if}
        <div class="absolute inset-y-0 left-0 bg-red-600" style="width: {playedPct}%"></div>
        {#if scenes && scenes.scenes.length > 1 && duration}
          {#each scenes.scenes as s (s.i)}
            {#if s.i > 0}
              <div
                class="absolute inset-y-0 w-px bg-black/60"
                style="left: {(s.start / duration) * 100}%"
              ></div>
            {/if}
          {/each}
        {/if}
      </div>
      <div
        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-red-600 shadow transition-transform duration-150 {overBar ||
        scrubbing
          ? 'scale-100'
          : 'scale-0'}"
        style="left: {playedPct}%"
      ></div>

      <!-- Hover preview -->
      {#if hoverFrac != null && duration}
        <div
          class="absolute bottom-full mb-3 -translate-x-1/2 pointer-events-none flex flex-col items-center gap-1.5"
          style="left: {previewLeft}px"
        >
          <div
            class="relative rounded-md overflow-hidden bg-black ring-2 ring-white/80 shadow-xl"
            style="width: {PREVIEW_W}px; height: {previewH}px"
          >
            {#if strip && stripFrame >= 0}
              <div
                class="absolute inset-0 bg-no-repeat {shownFrameTime == null ? '' : 'opacity-0'}"
                style="background-image: url({strip.url}); background-size: {strip.frames *
                  100}% 100%; background-position: {strip.frames > 1
                  ? (stripFrame / (strip.frames - 1)) * 100
                  : 0}% 0"
              ></div>
            {/if}
            <canvas
              bind:this={previewCanvas}
              width={PREVIEW_W}
              height={previewH}
              class="absolute inset-0 w-full h-full transition-opacity duration-150 {shownFrameTime ==
              null
                ? 'opacity-0'
                : previewStale
                  ? 'opacity-60'
                  : 'opacity-100'}"
            ></canvas>
          </div>
          <div class="px-2 py-0.5 rounded bg-black/80 text-white text-xs font-medium tabular-nums">
            {fmt(hoverTime)}
            {#if hoverScene}
              <span class="text-gray-400">· #{hoverScene.i + 1}</span>
              {#if hoverScene.position}
                <span class="text-amber-300/90 uppercase text-[10px] tracking-wide">
                  {hoverScene.position}
                </span>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <!-- Buttons -->
    <div
      class="flex items-center gap-1 mt-1 text-white {visible ? 'pointer-events-auto' : 'pointer-events-none'}"
    >
      <button
        type="button"
        class="p-2 rounded hover:bg-white/10 transition-colors"
        onclick={togglePlay}
        title={paused ? 'Play (k)' : 'Pause (k)'}
        aria-label={paused ? 'Play' : 'Pause'}
      >
        {#if paused || ended}
          <Play size={22} fill="currentColor" />
        {:else}
          <Pause size={22} fill="currentColor" />
        {/if}
      </button>

      <div class="flex items-center group/vol">
        <button
          type="button"
          class="p-2 rounded hover:bg-white/10 transition-colors"
          onclick={toggleMute}
          title={muted ? 'Unmute (m)' : 'Mute (m)'}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {#if muted || volume === 0}
            <VolumeX size={22} />
          {:else if volume < 0.5}
            <Volume1 size={22} />
          {:else}
            <Volume2 size={22} />
          {/if}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.02"
          value={muted ? 0 : volume}
          oninput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value))}
          class="volume w-0 opacity-0 group-hover/vol:w-20 group-hover/vol:opacity-100 focus:w-20 focus:opacity-100 transition-all duration-200 mx-1"
          aria-label="Volume"
        />
      </div>

      <span class="ml-2 text-sm tabular-nums text-gray-200">
        {fmt(currentTime)} <span class="text-gray-500">/</span> {fmt(duration)}
      </span>

      <div class="flex-1"></div>

      {#if hasSubtitles}
        <button
          type="button"
          class="p-2 rounded hover:bg-white/10 transition-colors {ccOn ? 'text-white' : 'text-gray-400'}"
          onclick={toggleCaptions}
          title={ccOn ? 'Hide subtitles (c)' : 'Show subtitles (c)'}
          aria-label={ccOn ? 'Hide subtitles' : 'Show subtitles'}
        >
          {#if ccOn}
            <Captions size={22} />
          {:else}
            <CaptionsOff size={22} />
          {/if}
        </button>
      {/if}

      <button
        type="button"
        class="p-2 rounded hover:bg-white/10 transition-colors"
        onclick={toggleFullscreen}
        title={fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
        aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {#if fullscreen}
          <Minimize size={22} />
        {:else}
          <Maximize size={22} />
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  input.volume {
    appearance: none;
    height: 4px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.35);
    cursor: pointer;
  }
  input.volume::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: white;
  }
  input.volume::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: 0;
    border-radius: 9999px;
    background: white;
  }
</style>
