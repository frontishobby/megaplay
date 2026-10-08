import type { Storage, File as MegaFile } from 'megajs';
import { MegaService, type MegaNode } from './mega';
import { findThumbFolder } from './thumbnails';
import { isTransportStream } from './stream';
import type { ShortsScope } from './router.svelte';

const SCENES_SUFFIX = '.scenes.json';

/**
 * Ids of videos that have a scene sidecar, read from the .megastream folder's
 * child listing alone — node metadata is already in memory, no downloads.
 */
export function listSceneVideoIds(storage: Storage): Set<string> {
  const ids = new Set<string>();
  const folder = findThumbFolder(storage);
  if (!folder) return ids;
  for (const child of folder.children || []) {
    const name = child.name || '';
    if (!child.directory && name.endsWith(SCENES_SUFFIX)) {
      ids.add(name.slice(0, -SCENES_SUFFIX.length));
    }
  }
  return ids;
}

// isVideo deliberately keeps .ts (thumbnails only) — playback was removed,
// so shorts and shuffle must filter transport streams out on top of it.
function isPlayableVideo(name: string): boolean {
  return MegaService.isVideo(name) && !isTransportStream(name);
}

/**
 * Playable videos in a folder (`folder`) or its whole subtree (`tree`).
 * A missing folderId means the cloud root, so root + `tree` is every video in
 * the account. listChildren already hides .megastream, which keeps sidecars out.
 */
export function collectCandidates(
  storage: Storage,
  scope: ShortsScope,
  folderId?: string
): MegaNode[] {
  const files = (storage as unknown as { files: Record<string, MegaFile> }).files;
  const folder = folderId ? files[folderId] : (storage.root as unknown as MegaFile);
  if (!folder?.directory) return [];
  const out: MegaNode[] = [];
  const walk = (f: MegaFile) => {
    for (const n of MegaService.listChildren(f)) {
      if (n.type === 'folder') {
        if (scope === 'tree') walk(n.node);
      } else if (isPlayableVideo(n.name)) out.push(n);
    }
  };
  walk(folder);
  return out;
}

/** Uniform random pick avoiding recently watched ids; null if pool is empty. */
export function pickRandomVideo(
  pool: MegaNode[],
  recentIds: readonly string[]
): MegaNode | null {
  if (pool.length === 0) return null;
  const recent = new Set(recentIds);
  const fresh = pool.filter((v) => !recent.has(v.id));
  const source = fresh.length > 0 ? fresh : pool;
  return source[Math.floor(Math.random() * source.length)];
}
