/**
 * Supports in Build generation (SLA / DLP / DMLS): parts switched to
 * "supported" get supports under every placed copy, made for the exact
 * orientation of that copy, so they always stand straight up from the
 * platform. Whenever a copy turns (nesting, hand edits) or the support
 * settings change, the supports are made again in the background; results
 * are cached per part, orientation and settings.
 */
import { Matrix4, Quaternion } from 'three';
import { applyMatrix, type MeshData, type SupportParams } from '../geometry';
import { getState, setState, useStore } from './store';
import { printerById } from './printers';
import { pool, CancelledError } from '../workers/client';
import type { BuildGenState, BuildPart } from './types';

export interface SupportEntry {
  /** supports, in the frame where the turned part is lifted to the support lift (z = 0 is the platform) */
  mesh: MeshData;
  /** how far the turned, centred part was moved up in that frame */
  dz: number;
  count: number;
  volume: number;
}

const meshIds = new WeakMap<MeshData, number>();
let nextMeshId = 1;
const meshId = (m: MeshData) => {
  let id = meshIds.get(m);
  if (!id) meshIds.set(m, (id = nextMeshId++));
  return id;
};

const cache = new Map<string, SupportEntry>();
const failed = new Set<string>();

/** The support settings with the technology of the current printer (null on powder printers). */
export function supportParams(g: BuildGenState = getState().buildGen): SupportParams | null {
  const tech = printerById(g.printerId).tech;
  if (tech === 'powder') return null;
  const { skip: _skip, ...st } = getState().settings.supports;
  void _skip;
  return { ...st, tech };
}

const qKey = (q: readonly number[]) => q.map((v) => Math.round(v * 1e4)).join(',');
const keyOf = (p: BuildPart, q: readonly number[], params: SupportParams) => `${p.id}|${meshId(p.mesh)}|${qKey(q)}|${JSON.stringify(params)}`;

/** How far a copy of this part is lifted off the platform for its supports. */
export function supportLift(p: BuildPart, g: BuildGenState = getState().buildGen): number {
  const params = p.supportsOn ? supportParams(g) : null;
  return params ? Math.max(0, params.lift) : 0;
}

/** The supports of a copy in this orientation, once made. */
export function supportFor(p: BuildPart, q: readonly number[], g: BuildGenState = getState().buildGen): SupportEntry | undefined {
  const params = p.supportsOn ? supportParams(g) : null;
  return params ? cache.get(keyOf(p, q, params)) : undefined;
}

/** Totals over the copies of the active build that have supports. */
export function supportTotals(g: BuildGenState): { copies: number; ready: number; count: number; volume: number } {
  const b = g.builds[g.active];
  const byId = new Map(g.parts.map((p) => [p.id, p]));
  let copies = 0, ready = 0, count = 0, volume = 0;
  for (const pl of b?.placements ?? []) {
    const p = byId.get(pl.partId);
    if (!p?.supportsOn) continue;
    copies++;
    const e = supportFor(p, pl.quaternion, g);
    if (e) (ready++, (count += e.count), (volume += e.volume));
  }
  return { copies, ready, count, volume };
}

let running = false;
let again = false;

/** Make the supports that are missing for the placed copies (one at a time, in a worker). */
export async function updateSupports() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const g = getState().buildGen;
      const params = supportParams(g);
      if (!params) break;
      const byId = new Map(g.parts.map((p) => [p.id, p]));
      const todo = new Map<string, { part: BuildPart; q: [number, number, number, number] }>();
      for (const b of g.builds)
        for (const pl of b.placements) {
          const p = byId.get(pl.partId);
          if (!p?.supportsOn) continue;
          const k = keyOf(p, pl.quaternion, params);
          if (!cache.has(k) && !failed.has(k)) todo.set(k, { part: p, q: pl.quaternion });
        }
      if (!todo.size) break;
      setState({ supportPending: todo.size });
      for (const [k, { part, q }] of todo) {
        // stop early when the builds changed again meanwhile (the new orientations are done next)
        if (again) break;
        const turned = applyMatrix(part.mesh, new Matrix4().makeRotationFromQuaternion(new Quaternion(...q)).elements);
        try {
          const r = await pool.run('supports', { mesh: turned, params, skip: [] }).promise;
          cache.set(k, { mesh: r.supports, dz: r.dz, count: r.count, volume: r.supportVolume });
        } catch (e) {
          if (e instanceof CancelledError) return;
          failed.add(k);
          console.warn('Supports failed', (e as Error).message);
        }
        setState((s) => ({ supportTick: s.supportTick + 1, supportPending: Math.max(0, s.supportPending - 1) }));
      }
      // keep the cache from growing without end: drop what no copy uses any more
      if (cache.size > 400) {
        const used = new Set<string>();
        const g2 = getState().buildGen, p2 = supportParams(g2);
        if (p2) for (const b of g2.builds) for (const pl of b.placements) { const p = g2.parts.find((x) => x.id === pl.partId); if (p) used.add(keyOf(p, pl.quaternion, p2)); }
        for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
      }
    } while (again);
  } finally {
    running = false;
    setState({ supportPending: 0 });
  }
}

// follow every change of the builds or the support settings
let timer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (s.buildGen === prev.buildGen && s.settings.supports === prev.settings.supports) return;
  if (!s.buildGen.parts.some((p) => p.supportsOn)) return;
  if (running) again = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void updateSupports(), 200);
});
