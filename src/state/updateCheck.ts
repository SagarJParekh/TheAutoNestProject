/**
 * New versions of the app: each deploy publishes new file names for the code
 * (hashed), and the old files disappear. A tab opened before a deploy then
 * fails as soon as it needs a file it has not loaded yet (the geometry worker
 * that reads imported files, a file format reader...). Here: find out whether
 * a newer version is online, and if so reload (nothing loaded yet) or show the
 * update banner (work in progress: the person chooses when).
 */
import { getState, setState } from './store';

/** the main script of the version running in this tab */
const runningScript = (): string | null => {
  if (typeof document === 'undefined') return null;
  const s = document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null;
  return s ? new URL(s.src, location.href).pathname : null;
};

let checking: Promise<boolean> | null = null;

/** Is a newer version online than the one running here? (false when it cannot be told, e.g. in development) */
export function newerVersionOnline(): Promise<boolean> {
  const mine = runningScript();
  if (!mine) return Promise.resolve(false);
  checking ??= fetch(`${location.pathname}?v=${Date.now()}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/) ?? html.match(/src="([^"]*\/assets\/index[^"]+\.js)"/);
      return !!m && new URL(m[1], location.href).pathname !== mine;
    })
    .catch(() => false)
    .finally(() => {
      checking = null;
    });
  return checking;
}

/** Nothing would be lost by reloading now (no parts loaded in either unit). */
const nothingLoaded = () => {
  const s = getState();
  return !s.parts.length && !s.buildGen.parts.length;
};

/**
 * Something the app needed could not be loaded: if a newer version is online,
 * reload straight away when nothing is loaded, else show the update banner.
 * Returns whether that was the cause.
 */
export async function handleMissingCode(): Promise<boolean> {
  if (!(await newerVersionOnline())) return false;
  if (nothingLoaded()) {
    location.reload();
    return true;
  }
  setState({ updateAvailable: 'required' });
  return true;
}

/** Look for a new version now and then (and when the tab comes back into view), so the banner shows before anything fails. */
export function watchForUpdates() {
  if (typeof window === 'undefined' || !runningScript()) return;
  const check = async () => {
    if (getState().updateAvailable) return;
    if (await newerVersionOnline()) setState({ updateAvailable: 'available' });
  };
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  // a chunk loaded on demand is missing (old deploy): Vite reports it here
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault();
    void handleMissingCode();
  });
}
