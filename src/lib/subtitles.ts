// Subtitles uploaded by hand (.srt or .vtt), stored as WebVTT sidecars at
// .megastream/<nodeId>.sub.<lang>.vtt — one track per language.

import type { MutableFile, Storage } from 'megajs';
import { ensureThumbFolder, findThumbFolder, uploadBytes } from './thumbnails';

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  ja: 'Japanese',
};

/** Language code used when the file name doesn't carry one. */
export const UNKNOWN_LANG = 'und';

export function subtitleLangLabel(lang: string): string {
  if (lang === UNKNOWN_LANG) return 'Subtitles';
  return LANG_NAMES[lang] ?? lang;
}

export interface StoredSubtitle {
  lang: string;
  vtt: string;
}

const SUB_INFIX = '.sub.';
const SUB_EXT = '.vtt';

function subtitleFileName(videoId: string, lang: string): string {
  return `${videoId}${SUB_INFIX}${lang}${SUB_EXT}`;
}

function subtitleLangOf(videoId: string, name: string): string | null {
  const prefix = `${videoId}${SUB_INFIX}`;
  if (!name.startsWith(prefix) || !name.endsWith(SUB_EXT)) return null;
  return name.slice(prefix.length, -SUB_EXT.length) || null;
}

const cache = new Map<string, StoredSubtitle[]>();

export async function getStoredSubtitles(
  videoId: string,
  storage: Storage | undefined
): Promise<StoredSubtitle[]> {
  const hit = cache.get(videoId);
  if (hit) return hit;
  if (!storage?.root) return [];
  const folder = findThumbFolder(storage);
  if (!folder) return [];
  const out: StoredSubtitle[] = [];
  for (const file of (folder.children || []) as MutableFile[]) {
    const lang = !file.directory && subtitleLangOf(videoId, file.name || '');
    if (!lang) continue;
    try {
      const buf = await file.downloadBuffer({});
      out.push({ lang, vtt: new TextDecoder().decode(buf as unknown as Uint8Array) });
    } catch (err) {
      console.warn('Subtitle load failed', file.name, err);
    }
  }
  cache.set(videoId, out);
  return out;
}

/** "movie.ko.srt" → "ko"; anything without a short language tag → "und". */
function langFromFileName(name: string): string {
  const m = /\.([a-z]{2,3})(?:-[a-z0-9]+)?\.(?:srt|vtt)$/i.exec(name);
  return m ? m[1].toLowerCase() : UNKNOWN_LANG;
}

/** UTF-8 when it decodes cleanly, else CP949 — most Korean .srt files are. */
function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function toVtt(text: string): string {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(body)) return body + '\n';
  // SRT: same cue layout, but comma decimal separators in the timestamps.
  const cues = body.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    (_, hms: string, ms: string) => `${hms.padStart(8, '0')}.${ms}`
  );
  return `WEBVTT\n\n${cues}\n`;
}

/**
 * Converts an uploaded .srt/.vtt to WebVTT and stores it for the video,
 * replacing an earlier track in the same language. Returns the saved track.
 */
export async function uploadSubtitleFile(
  storage: Storage,
  videoId: string,
  file: File
): Promise<StoredSubtitle> {
  if (!/\.(srt|vtt)$/i.test(file.name)) throw new Error('only .srt and .vtt files are supported');
  const vtt = toVtt(decodeText(await file.arrayBuffer()));
  if (!/-->/.test(vtt)) throw new Error('no subtitle cues found in the file');
  const track = { lang: langFromFileName(file.name), vtt };

  const folder = await ensureThumbFolder(storage);
  const name = subtitleFileName(videoId, track.lang);
  // MEGA allows duplicate names; replace instead of piling up copies.
  const stale = ((folder.children || []) as MutableFile[]).filter(
    (c) => !c.directory && c.name === name
  );
  for (const f of stale) {
    try {
      await f.delete(true);
    } catch (err) {
      console.warn('Failed to remove stale subtitles', err);
    }
  }
  await uploadBytes(folder, name, new TextEncoder().encode(track.vtt));

  // Not cached yet means nothing was loaded; the next load reads the folder.
  const cached = cache.get(videoId);
  if (cached) cache.set(videoId, [track, ...cached.filter((t) => t.lang !== track.lang)]);
  return track;
}
