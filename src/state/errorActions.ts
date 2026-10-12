/**
 * Problem navigator for the repair tool: lists the clusters of problems
 * that are left on a part, zooms the view to one and marks it for editing.
 */
import { Vector3 } from 'three';
import { errorGroups, trianglesOfGroup } from '../geometry';
import type { ErrorGroup } from '../geometry';
import { getState, notify, partById, setState } from './store';
import { matrixOf } from './math';
import { viewerApi } from '../viewer/api';

const cache = new WeakMap<object, ErrorGroup[]>();

/** Problem clusters of a part from its (current) analysis and intersection check. */
export function partErrorGroups(partId: string): ErrorGroup[] | null {
  const s = getState();
  const part = partById(partId);
  const a = s.analysis[partId];
  if (!part || !a || a.mesh !== part.mesh) return null;
  const ix = s.intersections[partId];
  const inter = ix && ix.mesh === part.mesh ? ix.report : null;
  const key = inter ?? a.report;
  // cache per (report, intersections) pair
  let byReport = cache.get(a.report) as (ErrorGroup[] & { inter?: unknown }) | undefined;
  if (!byReport || byReport.inter !== key) {
    byReport = Object.assign(errorGroups(part.mesh, a.report, inter), { inter: key });
    cache.set(a.report, byReport);
  }
  return byReport;
}

/** Zoom the view to problem `index` of a part and highlight it. */
export function focusError(partId: string, index: number) {
  const part = partById(partId);
  const groups = partErrorGroups(partId);
  if (!part || !groups?.length) return;
  const i = ((index % groups.length) + groups.length) % groups.length;
  const g = groups[i];
  setState({ errorFocus: { partId, mesh: part.mesh, index: i, group: g } });
  // part-local box → world
  const m = matrixOf(part.transform);
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let c = 0; c < 8; c++) {
    const v = new Vector3(c & 1 ? g.max[0] : g.min[0], c & 2 ? g.max[1] : g.min[1], c & 4 ? g.max[2] : g.min[2]).applyMatrix4(m);
    min.min(v);
    max.max(v);
  }
  viewerApi.current?.viewer?.frameBox(min, max);
}

/** Step to the next (+1) or previous (-1) problem. */
export function stepError(partId: string, delta: number) {
  const f = getState().errorFocus;
  const part = partById(partId);
  const cur = f && part && f.partId === partId && f.mesh === part.mesh ? f.index : delta > 0 ? -1 : 0;
  focusError(partId, cur + delta);
}

export function clearErrorFocus() {
  if (getState().errorFocus) setState({ errorFocus: null });
}

/** Mark the triangles of a problem in the Edit tab so it can be deleted, filled or remeshed by hand. */
export function markErrorForEdit(partId: string, index: number) {
  const part = partById(partId);
  const g = partErrorGroups(partId)?.[index];
  if (!part || !g) return;
  const tris = trianglesOfGroup(part.mesh, g);
  if (!tris.length) return notify('info', 'No triangles touch this problem');
  setState((s) => ({
    triEdit: { partId, mesh: part.mesh, tris, verts: [] },
    repairTab: 'edit',
    selection: [partId],
    pickMode: null,
    preview: null,
    settings: { ...s.settings, triEdit: { ...s.settings.triEdit, mode: 'mark' } },
  }));
}

/** Hole loops (indices into the analysis loops) that lie on an open-edge problem. */
export function loopsOfGroup(partId: string, g: ErrorGroup): number[] {
  const part = partById(partId);
  const a = getState().analysis[partId];
  if (!part || !a || a.mesh !== part.mesh || !g.segs || (g.kind !== 'open' && g.kind !== 'crack')) return [];
  const q = 1e-5;
  const key = (x: number, y: number, z: number) => `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
  const keys = new Set<string>();
  for (let i = 0; i < g.segs.length; i += 3) keys.add(key(g.segs[i], g.segs[i + 1], g.segs[i + 2]));
  const p = part.mesh.positions;
  const out: number[] = [];
  a.report.loops.forEach((l, i) => {
    const v = l.vertices[0] * 3;
    if (keys.has(key(p[v], p[v + 1], p[v + 2]))) out.push(i);
  });
  return out;
}
