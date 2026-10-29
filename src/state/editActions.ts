/**
 * Actions for the shell browser, open-edge fixes, manual triangle editing
 * and the lasso cut.
 */
import { Matrix4, Vector3 } from 'three';
import {
  addTriangle, bridgeEdges, brushSelect, openEdgeOfTriangle, buildTopology, compactMesh, deleteTriangles, estimateRemeshTriangles, growSelection, invertSelection, meanEdgeLength, shellOfTriangle,
  shrinkSelection, subsetTriangles, vertexTriangles,
} from '../geometry';
import type { VertexTriangles } from '../geometry';
import type { MeshData } from '../geometry';
import { commit, getState, notify, partById, selectedParts, setState } from './store';
import type { OpenEdgeMethod } from '../geometry';
import type { Part, ShellView } from './types';
import { matrixOf, worldMesh } from './math';
import { analyzePart, requestEdges, newId, partFromWorld, prepareMesh, replaceLocalMesh, replaceWithWorldMeshes, runJob, setPreview } from './actions';
import { nextColor } from './palette';
import { viewerApi } from '../viewer/api';
import type { PickInfo } from '../viewer/Viewer';
import { cutName } from './naming';
import { endLive, live } from './livePreview';

const firstEditable = (): Part | undefined => {
  const p = selectedParts().find((x) => !x.locked);
  if (!p) notify('warning', 'Select an unlocked part first');
  return p;
};

function invalidate(partId: string) {
  setState((s) => {
    const a = { ...s.analysis };
    const i = { ...s.intersections };
    delete a[partId];
    delete i[partId];
    return { analysis: a, intersections: i, shellView: s.shellView?.partId === partId ? null : s.shellView };
  });
}

function afterLocalChange(label: string, part: Part, mesh: MeshData) {
  // hidden shells stay hidden across edits (the shells are found again for the new mesh)
  const hidden = hiddenShellKeys(part);
  replaceLocalMesh(label, part.id, mesh);
  invalidate(part.id);
  analyzePart(part.id);
  if (hidden) void restoreHiddenShells(part.id, hidden);
}

const centroidKey = (p: Float32Array, idx: Uint32Array, t: number) => {
  const a = idx[t * 3] * 3,
    b = idx[t * 3 + 1] * 3,
    c = idx[t * 3 + 2] * 3;
  const r = (v: number) => Math.round(v * 1e4);
  return `${r(p[a] + p[b] + p[c])},${r(p[a + 1] + p[b + 1] + p[c + 1])},${r(p[a + 2] + p[b + 2] + p[c + 2])}`;
};

/** Centres of the triangles of a part's hidden shells (to find them again after an edit), or null. */
function hiddenShellKeys(part: Part): Set<string> | null {
  const sv = getState().shellView;
  if (!sv || sv.partId !== part.id || sv.mesh !== part.mesh || !sv.hidden?.length) return null;
  const hide = new Set(sv.hidden);
  const keys = new Set<string>();
  for (let t = 0; t < sv.shellOfTri.length; t++) if (hide.has(sv.shellOfTri[t])) keys.add(centroidKey(part.mesh.positions, part.mesh.indices, t));
  return keys;
}

async function restoreHiddenShells(partId: string, keys: Set<string>) {
  await loadShells(partId);
  const sv = liveShellView();
  const part = partById(partId);
  if (!sv || !part || sv.partId !== partId) return;
  // a shell stays hidden when most of its triangles were in hidden shells before
  const hit = new Map<number, number>();
  for (let t = 0; t < sv.shellOfTri.length; t++) if (keys.has(centroidKey(part.mesh.positions, part.mesh.indices, t))) hit.set(sv.shellOfTri[t], (hit.get(sv.shellOfTri[t]) ?? 0) + 1);
  const hidden = sv.shells.filter((sh) => (hit.get(sh.id) ?? 0) * 2 > sh.triangles).map((sh) => sh.id);
  if (hidden.length) patchShells({ hidden });
}

/** Mask of the triangles in hidden shells of a part (null when nothing is hidden). */
function hiddenTriMask(part: Part): Uint8Array | null {
  const sv = getState().shellView;
  if (!sv || sv.partId !== part.id || sv.mesh !== part.mesh || !sv.hidden?.length) return null;
  const hide = new Set(sv.hidden);
  const mask = new Uint8Array(sv.shellOfTri.length);
  for (let t = 0; t < mask.length; t++) if (hide.has(sv.shellOfTri[t])) mask[t] = 1;
  return mask;
}

// ---------------------------------------------------------------- shells

export async function loadShells(partId?: string) {
  const part = partId ? partById(partId) : selectedParts()[0];
  if (!part) return;
  const r = await runJob(`Finding shells in ${part.name}`, 'shellInfo', { mesh: part.mesh }, { silent: part.mesh.indices.length < 1_500_000 });
  if (!r) return;
  setState({ shellView: { partId: part.id, mesh: part.mesh, shells: r.shells, shellOfTri: r.shellOfTri, selected: [], hover: null, isolate: false } });
}

/** The shell view if it still matches the part's current mesh. */
export function liveShellView(): ShellView | null {
  const sv = getState().shellView;
  if (!sv) return null;
  const p = partById(sv.partId);
  return p && p.mesh === sv.mesh ? sv : null;
}

function patchShells(patch: Partial<ShellView>) {
  const sv = getState().shellView;
  if (sv) setState({ shellView: { ...sv, ...patch } });
}

export function toggleShell(id: number, additive: boolean) {
  const sv = liveShellView();
  if (!sv) return;
  const has = sv.selected.includes(id);
  const selected = additive ? (has ? sv.selected.filter((x) => x !== id) : [...sv.selected, id]) : has && sv.selected.length === 1 ? [] : [id];
  patchShells({ selected });
}

export function hoverShell(id: number | null) {
  if (getState().shellView?.hover !== id) patchShells({ hover: id });
}

export function selectShells(which: 'all' | 'none' | 'open' | 'small' | 'invert') {
  const sv = liveShellView();
  if (!sv) return;
  const maxVol = Math.max(0, ...sv.shells.map((s) => s.volume));
  const ids =
    which === 'all' ? sv.shells.map((s) => s.id)
    : which === 'none' ? []
    : which === 'open' ? sv.shells.filter((s) => !s.closed).map((s) => s.id)
    : which === 'small' ? sv.shells.filter((s) => s.volume < maxVol * 0.01).map((s) => s.id)
    : sv.shells.filter((s) => !sv.selected.includes(s.id)).map((s) => s.id);
  patchShells({ selected: ids });
}

/** Hide the selected shells in the viewport (they can't be picked while hidden). */
export function hideSelectedShells() {
  const sv = liveShellView();
  if (!sv || !sv.selected.length) return;
  patchShells({ hidden: [...new Set([...(sv.hidden ?? []), ...sv.selected])], selected: [], isolate: false });
}

export function showAllShells() {
  if (liveShellView()?.hidden?.length) patchShells({ hidden: [] });
}

/** Zoom the view to the selected shells (or all shells when none are selected). */
export function zoomToShells() {
  const sv = liveShellView();
  const part = sv && partById(sv.partId);
  if (!sv || !part) return;
  const ids = new Set(sv.selected.length ? sv.selected : sv.shells.map((s) => s.id));
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const m = matrixOf(part.transform);
  for (const sh of sv.shells) {
    if (!ids.has(sh.id)) continue;
    for (let c = 0; c < 8; c++) {
      const v = new Vector3(c & 1 ? sh.max[0] : sh.min[0], c & 2 ? sh.max[1] : sh.min[1], c & 4 ? sh.max[2] : sh.min[2]).applyMatrix4(m);
      min.min(v);
      max.max(v);
    }
  }
  if (min.x <= max.x) viewerApi.current?.viewer?.frameBox(min, max);
}

export function toggleIsolate() {
  const sv = liveShellView();
  if (sv) patchShells({ isolate: !sv.isolate });
}

export async function shellAction(action: 'delete' | 'keep' | 'merge' | 'extract') {
  const sv = liveShellView();
  const part = sv && partById(sv.partId);
  if (!sv || !part) return notify('warning', 'Load the shells of a part first');
  if (part.locked) return notify('warning', `${part.name} is locked`);
  if (!sv.selected.length) return notify('warning', 'Select one or more shells');
  if (action === 'merge' && sv.selected.length < 2) return notify('warning', 'Select at least two shells to merge');
  if (action === 'delete' && sv.selected.length === sv.shells.length) return notify('warning', 'That would delete the whole part; delete the part instead');
  const ids = sv.selected;
  if (action === 'extract') {
    // selected shells become a new part, the rest stays
    const sel = await runJob('Extracting shells', 'editShells', { mesh: part.mesh, shellOfTri: sv.shellOfTri, ids, action: 'keep' });
    if (!sel) return;
    const rest = await runJob('Extracting shells', 'editShells', { mesh: part.mesh, shellOfTri: sv.shellOfTri, ids, action: 'delete' });
    if (!rest) return;
    const m = matrixOf(part.transform).elements;
    const toWorld = (mesh: MeshData) => worldMesh({ ...part, mesh });
    void m;
    const results = [
      { name: part.name, mesh: toWorld(rest), color: part.color },
      { name: `${part.name} shells`, mesh: toWorld(sel), color: nextColor() },
    ].filter((r) => r.mesh.indices.length);
    replaceWithWorldMeshes(`Extract ${ids.length} shell${ids.length > 1 ? 's' : ''}`, part.id, results);
    setState({ shellView: null });
    return;
  }
  const r = await runJob(
    action === 'merge' ? 'Merging shells' : action === 'keep' ? 'Keeping shells' : 'Deleting shells',
    'editShells',
    { mesh: part.mesh, shellOfTri: sv.shellOfTri, ids, action },
  );
  if (!r) return;
  const label = action === 'merge' ? `Merge ${ids.length} shells` : action === 'keep' ? `Keep ${ids.length} shell${ids.length > 1 ? 's' : ''}` : `Delete ${ids.length} shell${ids.length > 1 ? 's' : ''}`;
  setPreview({
    tool: 'repair',
    label,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r }), color: part.color }],
    summary: [`Triangles: ${(part.mesh.indices.length / 3).toLocaleString()} → ${(r.indices.length / 3).toLocaleString()}`],
    apply: () => {
      afterLocalChange(label, part, r);
      loadShells(part.id);
    },
  });
}

// ---------------------------------------------------------------- open edges

export async function previewFixOpenEdges(method: OpenEdgeMethod) {
  const part = firstEditable();
  if (!part) return;
  const st = getState().settings;
  const r = await runJob('Fixing open edges', 'fixOpenEdges', {
    mesh: part.mesh,
    method,
    maxPerimeter: st.openEdges.maxPerimeter,
    tolerance: st.stitch.tolerance > 0 ? st.stitch.tolerance : undefined,
  });
  if (!r) return;
  if (r.openBefore === r.openAfter && !r.removed) return notify('info', 'Nothing changed with this method');
  const label = method === 'stitchFill' ? 'Stitch & fill open edges' : method === 'fillSmall' ? `Fill holes ≤ ${st.openEdges.maxPerimeter} mm` : 'Remove dangling triangles';
  setPreview({
    tool: 'repair',
    label,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r.mesh }), color: part.color }],
    summary: [
      `Open edges: ${r.openBefore.toLocaleString()} → ${r.openAfter.toLocaleString()}`,
      ...(r.stitched ? [`Stitched: ${r.stitched}`] : []),
      ...(r.filled ? [`Holes filled: ${r.filled}`] : []),
      ...(r.removed ? [`Triangles removed: ${r.removed}`] : []),
    ],
    apply: () => afterLocalChange(label, part, r.mesh),
  });
}

// ---------------------------------------------------------------- triangle edit

function liveTriEdit(partId: string) {
  const te = getState().triEdit;
  const part = partById(partId);
  if (!part) return null;
  return te && te.partId === partId && te.mesh === part.mesh ? te : { partId, mesh: part.mesh, tris: [], verts: [] };
}

export function startTriPick(mode: 'triangle' | 'vertex' | 'brush' | 'window' | 'edge') {
  const s = getState();
  const same = s.pickMode === mode;
  setState({ pickMode: same ? null : mode, preview: null });
}

const vtCache = new WeakMap<MeshData, VertexTriangles>();
const vtOf = (mesh: MeshData) => {
  let v = vtCache.get(mesh);
  if (!v) vtCache.set(mesh, (v = vertexTriangles(mesh)));
  return v;
};

/** Add triangles to (or remove them from) the marked set of a part. */
function applyMarks(part: Part, tris: ArrayLike<number>, remove: boolean) {
  const te = liveTriEdit(part.id)!;
  const nt = part.mesh.indices.length / 3;
  const mask = new Uint8Array(nt);
  for (const t of te.tris) mask[t] = 1;
  for (let i = 0; i < tris.length; i++) mask[tris[i]] = remove ? 0 : 1;
  // triangles of hidden shells are never marked
  const hidden = hiddenTriMask(part);
  const out: number[] = [];
  for (let t = 0; t < nt; t++) if (mask[t] && !hidden?.[t]) out.push(t);
  setState({ triEdit: { ...te, tris: out, verts: [] }, selection: [part.id] });
}

function setMarks(part: Part, tris: ArrayLike<number>) {
  const te = liveTriEdit(part.id)!;
  const hidden = hiddenTriMask(part);
  const list = hidden ? Array.from(tris).filter((t) => !hidden[t]) : Array.from(tris);
  setState({ triEdit: { ...te, tris: list, verts: [] }, selection: [part.id] });
}

/**
 * Hide shells while editing triangles: the shells of the marked triangles
 * (`marked`), or every shell except those (`others`). Hidden shells cannot be
 * picked or marked, and stay hidden across edits until Show all.
 */
export async function hideShellsForEdit(which: 'marked' | 'others') {
  const m = markedPart();
  const part = m?.part ?? selectedParts()[0];
  if (!part) return notify('warning', 'Select a part first');
  if (!m || !m.te.tris.length) return notify('warning', 'Mark a triangle of each shell first (the Shell tool marks a whole shell)');
  let sv = liveShellView();
  if (!sv || sv.partId !== part.id) {
    await loadShells(part.id);
    sv = liveShellView();
  }
  if (!sv || sv.partId !== part.id) return;
  const ofMarked = new Set(m.te.tris.map((t) => sv!.shellOfTri[t]));
  const hide = which === 'marked' ? [...ofMarked] : sv.shells.map((x) => x.id).filter((id) => !ofMarked.has(id));
  patchShells({ hidden: [...new Set([...(sv.hidden ?? []), ...hide])], selected: [], isolate: false });
  // marks on hidden shells go away
  setMarks(part, which === 'marked' ? [] : m.te.tris);
}

/** Click with the triangle / plane / surface / shell mark tools. Ctrl-click unmarks. */
export async function onTrianglePick(info: PickInfo) {
  const part = partById(info.partId);
  if (!part) return;
  const te = liveTriEdit(part.id)!;
  const st = getState().settings.triEdit;
  const already = te.tris.includes(info.faceIndex);
  let add: ArrayLike<number> = [info.faceIndex];
  if (st.markTool === 'plane' || st.markTool === 'surface') {
    const smooth = st.markTool === 'surface';
    const r = await runJob('Marking', 'grow', { mesh: part.mesh, seed: info.faceIndex, angle: smooth ? st.angle : st.planeAngle, smooth }, { silent: true });
    if (!r) return;
    add = r.tris;
  } else if (st.markTool === 'shell') {
    add = shellOfTriangle(part.mesh, info.faceIndex, vtOf(part.mesh));
  }
  applyMarks(part, add, info.ctrl || already);
}

/** Brush stroke sample: mark (or with Ctrl, unmark) triangles near the hit point. */
export function onBrush(info: PickInfo, erase: boolean) {
  const part = partById(info.partId);
  if (!part) return;
  const te = getState().triEdit;
  if (te && te.partId !== part.id && te.tris.length) return; // one part at a time
  const r = getState().settings.triEdit.brushRadius;
  const inv = new Matrix4().copy(matrixOf(part.transform)).invert();
  const c = new Vector3(...info.point).applyMatrix4(inv);
  // brush radius is in world mm; convert to the part's local scale
  const sc = part.transform.scale;
  const local = r / Math.max(1e-9, (Math.abs(sc[0]) + Math.abs(sc[1]) + Math.abs(sc[2])) / 3);
  applyMarks(part, brushSelect(part.mesh, info.faceIndex, [c.x, c.y, c.z], local, vtOf(part.mesh)), erase);
}

/** Window (rectangle) marking in client coordinates. */
export function onWindowMark(x0: number, y0: number, x1: number, y1: number, erase: boolean) {
  const s = getState();
  const viewer = viewerApi.current?.viewer;
  const part = partById(s.triEdit?.partId ?? s.selection[0] ?? '');
  if (!viewer || !part) return notify('warning', 'Select the part to mark first');
  const tris = viewer.trianglesInRect(part.id, x0, y0, x1, y1, s.settings.triEdit.windowThrough);
  if (!tris.length) return;
  applyMarks(part, tris, erase);
}

function markedPart() {
  const te = getState().triEdit;
  const part = te && partById(te.partId);
  if (!te || !part || part.mesh !== te.mesh) return null;
  return { te, part };
}

export function growMarked(rings = 1) {
  const m = markedPart();
  if (!m || !m.te.tris.length) return notify('warning', 'Mark some triangles first');
  setMarks(m.part, growSelection(m.part.mesh, m.te.tris, rings, vtOf(m.part.mesh)));
}

export function shrinkMarked() {
  const m = markedPart();
  if (!m || !m.te.tris.length) return notify('warning', 'Mark some triangles first');
  setMarks(m.part, shrinkSelection(m.part.mesh, m.te.tris, vtOf(m.part.mesh)));
}

export function invertMarked() {
  const m = markedPart();
  const part = m?.part ?? selectedParts()[0];
  if (!part) return notify('warning', 'Select a part first');
  setMarks(part, invertSelection(part.mesh.indices.length / 3, m?.te.tris ?? []));
}

/** Mark every triangle of the selected part. */
export function markAll() {
  const part = markedPart()?.part ?? selectedParts()[0];
  if (!part) return notify('warning', 'Select a part first');
  setMarks(part, invertSelection(part.mesh.indices.length / 3, []));
}

/** Copy the marked triangles into a new part. */
export function extractMarked() {
  const m = markedPart();
  if (!m || !m.te.tris.length) return notify('warning', 'Mark some triangles first');
  const set = new Set(m.te.tris);
  const mesh = compactMesh(subsetTriangles(m.part.mesh, (t) => set.has(t)));
  prepareMesh(mesh);
  const s = getState();
  const copy: Part = { ...m.part, id: newId(), name: `${m.part.name} (marked)`, color: nextColor(), mesh, locked: false };
  commit('Extract marked triangles', [...s.parts, copy], { selection: [copy.id] });
  setState({ triEdit: null });
}

/** Average edge length of the part (or of the marked area), a good starting remesh size. */
export function suggestedEdgeLength(scope: 'part' | 'marked'): number {
  const m = markedPart();
  const part = m?.part ?? selectedParts()[0];
  if (!part) return 1;
  const region = scope === 'marked' && m?.te.tris.length ? m.te.tris : null;
  const sc = part.transform.scale;
  const k = (Math.abs(sc[0]) + Math.abs(sc[1]) + Math.abs(sc[2])) / 3;
  return meanEdgeLength(part.mesh, region) * k;
}

/** Preview an isotropic remesh of the whole part or of the marked triangles. */
export async function previewRemesh(scope: 'part' | 'marked') {
  const m = markedPart();
  const part = scope === 'marked' ? m?.part : (selectedParts().find((p) => !p.locked) ?? undefined);
  if (!part) return notify('warning', scope === 'marked' ? 'Mark the triangles to remesh first' : 'Select an unlocked part first');
  if (part.locked) return notify('warning', `${part.name} is locked`);
  if (scope === 'marked' && !m?.te.tris.length) return notify('warning', 'Mark the triangles to remesh first');
  const st = getState().settings.remesh;
  const sc = part.transform.scale;
  const k = (Math.abs(sc[0]) + Math.abs(sc[1]) + Math.abs(sc[2])) / 3 || 1;
  // estimate before starting: very small edges on big parts would never finish
  const region = scope === 'marked' ? Uint32Array.from(m!.te.tris) : null;
  const area = regionArea(part.mesh, region) * k * k;
  const estimate = estimateRemeshTriangles(area, st.edgeLength);
  if (estimate > 6_000_000) return notify('warning', `About ${estimate.toLocaleString()} triangles at ${st.edgeLength} mm; use a larger edge length`);
  const r = await runJob(scope === 'marked' ? 'Remeshing marked area' : 'Remeshing part', 'remesh', {
    mesh: part.mesh,
    edgeLength: st.edgeLength / k,
    region,
    iterations: st.iterations,
    featureAngle: st.featureAngle,
  });
  if (!r) return;
  const label = scope === 'marked' ? `Remesh ${m!.te.tris.length.toLocaleString()} marked triangles` : `Remesh ${part.name}`;
  setPreview({
    tool: 'repair',
    label,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r.mesh }), color: part.color }],
    summary: [`Triangles: ${r.trianglesBefore.toLocaleString()} → ${r.trianglesAfter.toLocaleString()}`, `Target edge length: ${st.edgeLength} mm`],
    apply: () => {
      afterLocalChange(label, part, r.mesh);
      setState({ triEdit: null });
    },
  });
}

function regionArea(mesh: MeshData, region: ArrayLike<number> | null): number {
  const p = mesh.positions, idx = mesh.indices;
  let a = 0;
  const n = region ? region.length : idx.length / 3;
  for (let i = 0; i < n; i++) {
    const t = region ? region[i] : i;
    const o0 = idx[t * 3] * 3, o1 = idx[t * 3 + 1] * 3, o2 = idx[t * 3 + 2] * 3;
    const ux = p[o1] - p[o0], uy = p[o1 + 1] - p[o0 + 1], uz = p[o1 + 2] - p[o0 + 2];
    const vx = p[o2] - p[o0], vy = p[o2 + 1] - p[o0 + 1], vz = p[o2 + 2] - p[o0 + 2];
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return a;
}

export function clearTriSelection() {
  const te = getState().triEdit;
  if (te) setState({ triEdit: { ...te, tris: [], verts: [] } });
}

export function deleteSelectedTriangles() {
  const te = getState().triEdit;
  const part = te && partById(te.partId);
  if (!te || !part || part.mesh !== te.mesh || !te.tris.length) return notify('warning', 'Click triangles to select them first');
  if (part.locked) return notify('warning', `${part.name} is locked`);
  const mesh = deleteTriangles(part.mesh, te.tris);
  afterLocalChange(`Delete ${te.tris.length} triangle${te.tris.length > 1 ? 's' : ''}`, part, mesh);
  setState({ triEdit: null });
}

/** Nearest vertex (local index) of the clicked triangle. */
function nearestVertex(part: Part, tri: number, worldPoint: [number, number, number]): number {
  const inv = new Matrix4().copy(matrixOf(part.transform)).invert();
  const p = new Vector3(...worldPoint).applyMatrix4(inv);
  let best = part.mesh.indices[tri * 3], bd = Infinity;
  for (let k = 0; k < 3; k++) {
    const v = part.mesh.indices[tri * 3 + k];
    const d = p.distanceToSquared(new Vector3(part.mesh.positions[v * 3], part.mesh.positions[v * 3 + 1], part.mesh.positions[v * 3 + 2]));
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/** Vertex pick: the closest vertex on screen to the click, falling back to the clicked triangle's nearest corner. */
export function onVertexPick(info: PickInfo | null, clientX: number, clientY: number) {
  const partId = info?.partId ?? getState().triEdit?.partId ?? getState().selection[0];
  const part = partId ? partById(partId) : undefined;
  if (!part) return;
  if (part.locked) return notify('warning', `${part.name} is locked`);
  const te = liveTriEdit(part.id)!;
  const screenV = viewerApi.current?.viewer?.nearestVertexScreen(part.id, clientX, clientY) ?? -1;
  const v = screenV >= 0 ? screenV : info ? nearestVertex(part, info.faceIndex, info.point) : -1;
  if (v < 0) return;
  if (te.verts.includes(v)) return;
  const verts = [...te.verts, v];
  if (verts.length < 3) return setState({ triEdit: { ...te, verts }, selection: [part.id] });
  try {
    const mesh = addTriangle(part.mesh, verts[0], verts[1], verts[2]);
    prepareMesh(mesh);
    afterLocalChange('Create triangle', part, mesh);
    setState({ triEdit: { partId: part.id, mesh, tris: [], verts: [] } });
  } catch (e) {
    notify('warning', (e as Error).message);
    setState({ triEdit: { ...te, verts: [] } });
  }
}

// ---------------------------------------------------------------- lasso cut

export function startLasso() {
  const s = getState();
  if (!selectedParts().some((p) => !p.locked)) return notify('warning', 'Select the part to cut first');
  setState({ lassoMode: !s.lassoMode, preview: null });
}

/** Called by the viewer with the lasso outline in client (screen) coordinates. */
export async function onLassoDone(points: [number, number][]) {
  setState({ lassoMode: false });
  if (points.length < 3) return;
  await cutWithOutline(points, 'Lasso cut');
}

export function startPolyline() {
  const s = getState();
  const part = selectedParts().find((p) => !p.locked);
  if (!part) return notify('warning', 'Select the part to cut first');
  // sharp edges for snapping the line to the part
  requestEdges(part.mesh);
  setState({ polyMode: !s.polyMode, lassoMode: false, preview: null });
}

/** Called by the viewer when a polyline for the cut has been drawn. */
export async function onPolylineDone(points: [number, number][], closed = false) {
  setState({ polyMode: false });
  if (closed) {
    // the line came back to its start: cut out the enclosed shape (through the part, along the view)
    if (points.length < 3) return notify('warning', 'A closed shape needs at least three points');
    return keepCutLine(points, true);
  }
  if (points.length < 2) return notify('warning', 'Click at least two points');
  keepCutLine(points, false);
}

/** Keep the drawn line (in the view it was drawn in) and show the cut, live while its options change. */
function keepCutLine(points: [number, number][], closed: boolean) {
  const viewer = viewerApi.current?.viewer;
  const part = selectedParts().find((p) => !p.locked);
  if (!viewer || !part) return;
  const cam = viewer.lassoCamera(points, part.id);
  if (!cam) return;
  const s = getState();
  // teeth go on the longest segment of a fresh line until another is indicated
  const segs = closed ? points.length : points.length - 1;
  let longest = 1, best = -1;
  for (let i = 0; i < segs; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) (best = l), (longest = i + 1);
  }
  const keepSeg = s.settings.polyCut.segment > 0 ? longest : 0;
  setState({ settings: { ...s.settings, cutLine: { points: cam.outline, closed, camera: cam.camera, unit: cam.unit }, polyCut: { ...s.settings.polyCut, segment: keepSeg } } });
  void live(previewPolyCut);
}

export function clearCutLine() {
  endLive();
  setState({ settings: { ...getState().settings, cutLine: null }, preview: null });
}

/** Preview the Draw line cut with the kept line and the current teeth / rounding / depth / clearance. */
export async function previewPolyCut() {
  const s = getState();
  const line = s.settings.cutLine;
  const part = selectedParts().find((p) => !p.locked);
  if (!line || !part) return;
  const label = line.closed ? 'Shape cut' : 'Line cut';
  const r = await runJob(label, 'polyCut', { mesh: worldMesh(part), points: line.points, closed: line.closed, camera: line.camera, unit: line.unit, params: s.settings.polyCut });
  if (!r) return;
  const pieces = [
    { name: cutName(part.name, 1), mesh: r.inside, color: s.settings.polyRecolor ? nextColor() : part.color },
    { name: cutName(part.name, 2), mesh: r.outside, color: part.color },
  ].filter((p) => p.mesh.indices.length);
  if (pieces.length < 2) {
    setPreview(null);
    return notify('warning', pieces.length ? (line.closed ? 'The shape does not cross the part' : 'The line must cross the whole part') : 'Nothing was cut');
  }
  const p = s.settings.polyCut;
  const segs = line.closed ? line.points.length : line.points.length - 1;
  setPreview({
    tool: 'cut',
    label,
    replaces: [part.id],
    // the first piece is tinted while previewing, so the two sides can be told apart
    meshes: s.settings.polyRecolor ? pieces : [{ ...pieces[0], color: '#d0507a' }, pieces[1]],
    lines: r.lines,
    xray: true,
    summary: [
      `${label}: ${segs} segment${segs === 1 ? '' : 's'}`,
      ...(p.segment > 0 && p.segment <= segs ? [`Teeth: ${r.teeth} ${p.type} on segment ${p.segment} · size ${p.size} % · offset ${p.offset} %${p.roundTeeth ? ` · rounded ${p.teethRadius} mm` : ''}`] : ['No teeth (indicate a segment to add them)']),
      ...(p.roundPolyline ? [`Line corners rounded: ${p.polylineRadius} mm`] : []),
      ...(p.depthOn ? [`Cutting depth: ${p.depth} mm from the front`] : []),
      ...(p.clearanceOn ? [`Clearance: ${p.clearance} mm`] : []),
      ...pieces.map((x) => `${x.name}: ${(x.mesh.indices.length / 3).toLocaleString()} triangles`),
    ],
    apply: () => {
      replaceWithWorldMeshes(label, part.id, pieces);
      setState({ settings: { ...getState().settings, cutLine: null } });
    },
  });
}

async function cutWithOutline(outline: [number, number][], label: string) {
  const viewer = viewerApi.current?.viewer;
  const part = selectedParts().find((p) => !p.locked);
  if (!viewer || !part) return;
  const cam = viewer.lassoCamera(outline, part.id);
  if (!cam) return;
  const r = await runJob(label, 'lassoCut', { mesh: worldMesh(part), outline: cam.outline, camera: cam.camera });
  if (!r) return;
  const pieces = [
    { name: cutName(part.name, 1), mesh: r.inside, color: nextColor() },
    { name: cutName(part.name, 2), mesh: r.outside, color: part.color },
  ].filter((p) => p.mesh.indices.length);
  if (pieces.length < 2)
    return notify('warning', pieces.length ? (label === 'Line cut' ? 'The line must cross the whole part' : label === 'Shape cut' ? 'The shape does not cross the part' : 'The lasso does not cross the part') : 'Nothing was cut');
  setPreview({
    tool: 'cut',
    label,
    replaces: [part.id],
    meshes: pieces,
    summary: pieces.map((p) => `${p.name}: ${(p.mesh.indices.length / 3).toLocaleString()} triangles`),
    apply: () => replaceWithWorldMeshes(label, part.id, pieces),
  });
  void partFromWorld;
  void commit;
}

// ---------------------------------------------------------------- bridge

const topoCache = new WeakMap<MeshData, ReturnType<typeof buildTopology>>();
const topoOf = (mesh: MeshData) => {
  let t = topoCache.get(mesh);
  if (!t) topoCache.set(mesh, (t = buildTopology(mesh)));
  return t;
};

/** Click near an open edge: add it to (or remove it from) the current bridge side. */
export function onBridgeEdgePick(info: PickInfo) {
  const part = partById(info.partId);
  if (!part) return;
  const te = liveTriEdit(part.id)!;
  const inv = new Matrix4().copy(matrixOf(part.transform)).invert();
  const lp = new Vector3(...info.point).applyMatrix4(inv);
  const edge = openEdgeOfTriangle(part.mesh, info.faceIndex, [lp.x, lp.y, lp.z], topoOf(part.mesh));
  if (!edge) return notify('info', 'Click right next to an open edge (a border of the surface)');
  const side = getState().settings.triEdit.bridgeSide;
  const same = (e: [number, number]) => e[0] === edge[0] && e[1] === edge[1];
  let A = te.bridgeA ?? [], B = te.bridgeB ?? [];
  if (A.some(same)) A = A.filter((e) => !same(e));
  else if (B.some(same)) B = B.filter((e) => !same(e));
  else if (side === 'A') A = [...A, edge];
  else B = [...B, edge];
  setState({ triEdit: { ...te, bridgeA: A, bridgeB: B }, selection: [part.id] });
}

export function clearBridge() {
  const te = getState().triEdit;
  if (te) setState({ triEdit: { ...te, bridgeA: [], bridgeB: [] } });
}

export function createBridge() {
  const te = getState().triEdit;
  const part = te && partById(te.partId);
  if (!te || !part || part.mesh !== te.mesh) return notify('warning', 'Pick the edges on both sides first');
  if (!te.bridgeA?.length || !te.bridgeB?.length) return notify('warning', 'Pick at least one open edge on side A and one on side B');
  if (part.locked) return notify('warning', `${part.name} is locked`);
  try {
    const r = bridgeEdges(part.mesh, te.bridgeA, te.bridgeB);
    prepareMesh(r.mesh);
    afterLocalChange(`Bridge (${r.added} triangles)`, part, r.mesh);
    setState({ triEdit: { partId: part.id, mesh: r.mesh, tris: [], verts: [], bridgeA: [], bridgeB: [] } });
    setState((s) => ({ settings: { ...s.settings, triEdit: { ...s.settings.triEdit, bridgeSide: 'A' } } }));
    notify('success', `Bridged with ${r.added} triangles`);
  } catch (e) {
    notify('warning', (e as Error).message);
  }
}
