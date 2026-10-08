export type Route =
  | { kind: 'home' }
  | { kind: 'file'; id: string }
  | { kind: 'folder'; id: string }
  // `folder` = the folder's own videos, `tree` = it plus every subfolder.
  // A missing folderId means the cloud root.
  | { kind: 'shorts'; scope: ShortsScope; folderId?: string };

export type ShortsScope = 'folder' | 'tree';

function parse(hash: string): Route {
  let m = hash.match(/^#\/file\/(.+)$/);
  if (m) return { kind: 'file', id: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/folder\/(.+)$/);
  if (m) return { kind: 'folder', id: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/shorts\/(folder|tree)(?:\/(.+))?$/);
  if (m) {
    const scope = m[1] as ShortsScope;
    return m[2]
      ? { kind: 'shorts', scope, folderId: decodeURIComponent(m[2]) }
      : { kind: 'shorts', scope };
  }
  // Pre-scope links: the old "Random shorts" covered the whole account.
  if (hash === '#/shorts/all') return { kind: 'shorts', scope: 'tree' };
  return { kind: 'home' };
}

let current = $state<Route>(parse(typeof location === 'undefined' ? '' : location.hash));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parse(location.hash);
  });
}

export const router = {
  get current(): Route {
    return current;
  },
};

export function navigate(r: Route) {
  if (r.kind === 'home') {
    if (location.hash) {
      history.pushState(null, '', location.pathname + location.search);
      current = r;
    }
    return;
  }
  let next: string;
  if (r.kind === 'shorts') {
    next = r.folderId
      ? `#/shorts/${r.scope}/${encodeURIComponent(r.folderId)}`
      : `#/shorts/${r.scope}`;
  } else {
    const prefix = r.kind === 'file' ? '#/file/' : '#/folder/';
    next = `${prefix}${encodeURIComponent(r.id)}`;
  }
  if (location.hash !== next) {
    location.hash = next;
  }
}
