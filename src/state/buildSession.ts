/**
 * Build generation autosave: the parts (meshes), settings, builds and locks
 * are kept in the browser (IndexedDB), so a crash or a closed tab does not
 * lose the work; the next visit offers to restore it. Meshes are written
 * only when they change (big parts are not rewritten on every edit).
 */
import type { MeshData } from '../geometry';
import type { BuildGenState, BuildPart } from './types';
import { getState, notify, setState, useStore } from './store';
import { fitBuildView, updateDisplayMeshes } from './buildActions';
import { printerById } from './printers';

const DB = 'autonest-session',
  META = 'meta',
  MESHES = 'meshes';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META);
        req.result.createObjectStore(MESHES);
      };
      req.onerror = () => resolve(null);
      req.onsuccess = () => resolve(req.result);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** What is kept of the build state (no running state, no light display copies). */
type SavedPart = Omit<BuildPart, 'mesh' | 'display' | 'orient'> & { orient?: { q: [number, number, number, number]; rule?: 'flat' | 'powder' } };
interface Saved {
  savedAt: number;
  gen: Omit<BuildGenState, 'parts'> & { parts: SavedPart[] };
}

const savedMeshes = new WeakMap<MeshData, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSaved: BuildGenState | null = null;
let enabled = false;

async function save(gen: BuildGenState) {
  const db = await open();
  if (!db) return;
  const parts: SavedPart[] = gen.parts.map((p) => {
    const { mesh: _m, display: _d, orient, ...rest } = p;
    void _m;
    void _d;
    return { ...rest, orient: orient && orient.mesh === p.mesh ? { q: orient.q, rule: orient.rule } : undefined };
  });
  // meshes that changed since the last save
  const changed = gen.parts.filter((p) => savedMeshes.get(p.mesh) !== p.id);
  const keep = new Set(gen.parts.map((p) => p.id));
  await tx(db, [MESHES], 'readwrite', (t) => {
    const st = t.objectStore(MESHES);
    for (const p of changed) st.put({ positions: p.mesh.positions, indices: p.mesh.indices }, p.id);
    const all = st.getAllKeys();
    all.onsuccess = () => {
      for (const k of all.result) if (!keep.has(String(k))) st.delete(k);
    };
  });
  for (const p of changed) savedMeshes.set(p.mesh, p.id);
  const record: Saved = { savedAt: Date.now(), gen: { ...gen, parts, busy: false, improving: null, checks: null } };
  await tx(db, [META], 'readwrite', (t) => t.objectStore(META).put(record, 'session'));
  db.close();
}

/** Start saving the build state a few seconds after every change (once a session was restored or declined). */
export function startBuildAutosave() {
  if (enabled) return;
  enabled = true;
  useStore.subscribe((s) => {
    const gen = s.buildGen;
    if (gen === lastSaved || gen.busy) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const g = getState().buildGen;
      if (g.busy) return; // saved after the nesting
      lastSaved = g;
      void save(g);
    }, 3000);
  });
}

/** The saved session, if any: when it was saved and how many parts / copies it has. */
export async function savedBuildSession(): Promise<{ savedAt: number; parts: number; copies: number } | null> {
  const db = await open();
  if (!db) return null;
  const rec = (await tx<Saved>(db, [META], 'readonly', (t) => t.objectStore(META).get('session'))) ?? null;
  db.close();
  if (!rec || !rec.gen.parts.length) return null;
  return { savedAt: rec.savedAt, parts: rec.gen.parts.length, copies: rec.gen.parts.reduce((a, p) => a + p.quantity, 0) };
}

/**
 * Sessions saved before powder beds defaulted to 1 mm margins and 1 mm off the
 * platform still hold the old 5 mm defaults: bring those to 1 mm (once).
 */
function upgradeSpacing(g: BuildGenState, saved: { spacingDefaults?: number }): BuildGenState {
  if (saved.spacingDefaults) return g;
  const powder = printerById(g.printerId).tech === 'powder';
  return { ...g, spacingDefaults: 1, ...(powder && g.margin === 5 ? { margin: 1 } : {}), ...(powder && g.zOffset === 5 ? { zOffset: 1 } : {}) };
}

/** Bring back the saved session (parts, settings, builds, locks). */
export async function restoreBuildSession(): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  const rec = await tx<Saved>(db, [META], 'readonly', (t) => t.objectStore(META).get('session'));
  if (!rec) {
    db.close();
    return false;
  }
  const meshes = new Map<string, MeshData>();
  await tx(db, [MESHES], 'readonly', (t) => {
    const st = t.objectStore(MESHES);
    for (const p of rec.gen.parts) {
      const r = st.get(p.id);
      r.onsuccess = () => r.result && meshes.set(p.id, r.result as MeshData);
    }
  });
  db.close();
  const parts: BuildPart[] = [];
  for (const p of rec.gen.parts) {
    const mesh = meshes.get(p.id);
    if (!mesh) continue;
    savedMeshes.set(mesh, p.id);
    parts.push({ ...p, mesh, orient: p.orient ? { mesh, q: p.orient.q, rule: p.orient.rule } : undefined });
  }
  if (!parts.length) return false;
  const gen: BuildGenState = upgradeSpacing({ ...getState().buildGen, ...rec.gen, parts, busy: false, improving: null, checks: null }, rec.gen);
  lastSaved = gen;
  setState({ buildGen: gen, buildPast: [], buildFuture: [], selection: [] });
  void updateDisplayMeshes();
  fitBuildView();
  notify('success', `Restored ${parts.length} part${parts.length > 1 ? 's' : ''} and ${gen.builds.length} build${gen.builds.length === 1 ? '' : 's'} from ${new Date(rec.savedAt).toLocaleString()}`);
  return true;
}

/** Forget the saved session. */
export async function discardBuildSession() {
  const db = await open();
  if (!db) return;
  await tx(db, [META, MESHES], 'readwrite', (t) => {
    t.objectStore(META).clear();
    t.objectStore(MESHES).clear();
  });
  db.close();
}

/**
 * At start-up: a saved session is offered (state `savedBuildSession`, shown
 * in Build generation) and kept until it is restored or discarded, or new
 * parts are added; otherwise saving starts straight away.
 */
let initDone = false;
export async function initBuildSession() {
  if (initDone) return;
  initDone = true;
  const saved = await savedBuildSession();
  if (!saved) return startBuildAutosave();
  setState({ savedBuildSession: saved });
  notify('info', `Your last Build generation session (${saved.parts} part${saved.parts > 1 ? 's' : ''}) can be restored in Build generation`);
  // adding new parts instead of restoring: the old session gets replaced
  const unsub = useStore.subscribe((s) => {
    if (!s.savedBuildSession) return unsub();
    if (s.buildGen.parts.length) {
      setState({ savedBuildSession: null });
      startBuildAutosave();
      unsub();
    }
  });
}

/** Banner buttons */
export async function acceptSavedSession(restore: boolean) {
  setState({ savedBuildSession: null });
  if (restore) await restoreBuildSession();
  else await discardBuildSession();
  startBuildAutosave();
}
