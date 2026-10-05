/**
 * Actions for point picks, single props, point/tapered perforation, labels,
 * texturing, 2D arrays/arrangement and mirror copies.
 */
import { Matrix3, Matrix4, Vector3 } from 'three';
import { arrangeShelves, cylinderMesh, gridArrayOffsets, mirrorMesh, pointHoleOutlines } from '../geometry';
import type { Heightmap, MeshData, Vec3 } from '../geometry';
import { commit, getState, notify, partById, selectedParts, setState } from './store';
import type { FaceSelection, Part, PointPick, PointSlot } from './types';
import { IDENTITY_TRANSFORM, matrixOf, recenter, worldBounds, worldMesh } from './math';
import { newId, partFromWorld, prepareMesh, replaceWithWorldMeshes, runJob, setPreview } from './actions';
import { nextColor } from './palette';
import { viewerApi } from '../viewer/api';
import type { PickInfo } from '../viewer/Viewer';

// ---------------------------------------------------------------- point picks

export function startPointPick(slot: PointSlot) {
  const s = getState();
  const same = s.pickMode === 'point' && s.pointSlot === slot;
  // finishing hole placement keeps the hole preview; other picks restart their preview
  setState({ pickMode: same ? null : 'point', pointSlot: slot, ...(slot === 'perfPoint' ? {} : { preview: null }) });
}

function toLocal(part: Part, point: Vec3, normal: Vec3): PointPick {
  const m = matrixOf(part.transform);
  const inv = new Matrix4().copy(m).invert();
  const p = new Vector3(...point).applyMatrix4(inv);
  const n = new Vector3(...normal).applyMatrix3(new Matrix3().getNormalMatrix(inv)).normalize();
  return { partId: part.id, mesh: part.mesh, point: [p.x, p.y, p.z], normal: [n.x, n.y, n.z] };
}

/** World position of a point pick, or null if its part is gone or changed. */
export function worldPoint(pick: PointPick | undefined): { point: Vec3; normal: Vec3; part: Part } | null {
  if (!pick) return null;
  const part = partById(pick.partId);
  if (!part || part.mesh !== pick.mesh) return null;
  const m = matrixOf(part.transform);
  const p = new Vector3(...pick.point).applyMatrix4(m);
  const n = new Vector3(...pick.normal).applyMatrix3(new Matrix3().getNormalMatrix(m)).normalize();
  return { point: [p.x, p.y, p.z], normal: [n.x, n.y, n.z], part };
}

export function onPointPick(info: PickInfo) {
  const s = getState();
  const part = partById(info.partId);
  if (!part) return;
  const pick = toLocal(part, info.point, info.normal);
  if (s.pointSlot === 'perfPoint') {
    // stays armed so several holes can be placed
    setState({ perfPoints: [...s.perfPoints.filter((p) => p.mesh === part.mesh || p.partId !== part.id), pick], preview: null });
    return;
  }
  setState({ pointPicks: { ...s.pointPicks, [s.pointSlot]: pick }, pickMode: null, preview: null });
}

export function clearPointPick(slot: Exclude<PointSlot, 'perfPoint'>) {
  setState((s) => {
    const p = { ...s.pointPicks };
    delete p[slot];
    return { pointPicks: p, preview: null };
  });
}

// ---------------------------------------------------------------- single prop

export async function previewSingleProp() {
  const s = getState();
  const st = s.settings.props;
  const a = worldPoint(s.pointPicks.propStart);
  if (!a) return notify('warning', 'Pick the point where the prop starts');
  const b = worldPoint(s.pointPicks.propEnd);
  let end: Vec3, hitPart: Part | null = null;
  if (b) {
    end = b.point;
    hitPart = b.part;
  } else {
    const n = a.normal;
    const hit = viewerApi.current?.viewer?.castRay([a.point[0] + n[0] * 0.02, a.point[1] + n[1] * 0.02, a.point[2] + n[2] * 0.02], n);
    if (!hit || hit.distance > st.maxLength) return notify('warning', `Nothing found within ${st.maxLength} mm along the surface normal; pick an end point instead`);
    end = hit.point;
    hitPart = partById(hit.partId) ?? null;
  }
  const d = new Vector3(...end).sub(new Vector3(...a.point));
  const len = d.length();
  if (len < 1e-3) return notify('warning', 'Start and end points are the same');
  d.normalize();
  const start: Vec3 = [a.point[0] - d.x * st.embed, a.point[1] - d.y * st.embed, a.point[2] - d.z * st.embed];
  const prop = cylinderMesh(start, [d.x, d.y, d.z], st.diameter / 2, len + 2 * st.embed, 24);
  const parts = hitPart && hitPart.id !== a.part.id ? [a.part, hitPart] : [a.part];
  setPreview({
    tool: 'repair',
    label: 'Single prop',
    replaces: [],
    meshes: [{ name: 'Prop', mesh: prop, color: '#ffd23f' }],
    summary: [
      `Length ${len.toFixed(2)} mm (+${st.embed} mm embedded at each end), Ø${st.diameter} mm`,
      st.merge ? `Apply merges the prop with ${parts.map((p) => p.name).join(' + ')}` : 'Apply adds the prop as a new part',
    ],
    apply: async () => {
      if (!st.merge) {
        const np = partFromWorld(`Prop (${a.part.name})`, prop, '#ffd23f');
        commit('Add prop', [...getState().parts, np], { selection: [np.id] });
        return;
      }
      if (parts.some((p) => p.locked)) return notify('warning', 'Unlock the parts to merge the prop into them');
      const [base, ...rest] = parts.map(worldMesh);
      const r = await runJob('Merging prop', 'boolean', { op: 'union', base, others: [...rest, prop] });
      if (!r) return;
      const ids = new Set(parts.map((p) => p.id));
      const np = partFromWorld(parts.map((p) => p.name).join(' + '), r, a.part.color);
      const kept = getState().parts.filter((p) => !ids.has(p.id));
      commit('Add prop (merged)', [...kept, np], { selection: [np.id], pointPicks: {} });
    },
  });
}

// ---------------------------------------------------------------- perforation at points

function perfParams() {
  const { angleTolerance: _a, mode: _m, ...params } = getState().settings.perforate;
  void _a;
  void _m;
  return params;
}

export function livePerfPoints(): { part: Part; points: { point: Vec3; normal: Vec3 }[] }[] {
  const groups = new Map<string, { part: Part; points: { point: Vec3; normal: Vec3 }[] }>();
  for (const pp of getState().perfPoints) {
    const w = worldPoint(pp);
    if (!w) continue;
    let g = groups.get(w.part.id);
    if (!g) groups.set(w.part.id, (g = { part: w.part, points: [] }));
    g.points.push({ point: w.point, normal: w.normal });
  }
  return [...groups.values()];
}

export function previewPointHoles() {
  const groups = livePerfPoints();
  if (!groups.length) return setPreview(null);
  const params = perfParams();
  const lines = pointHoleOutlines(groups.flatMap((g) => g.points), params);
  const n = groups.reduce((a, g) => a + g.points.length, 0);
  setPreview({
    tool: 'perforate',
    label: 'Hole locations',
    replaces: [],
    meshes: [],
    lines,
    summary: [
      `${n} hole${n > 1 ? 's' : ''} on ${groups.map((g) => g.part.name).join(', ')}`,
      params.exitSize ? `Tapered: ${params.size} → ${params.exitSize} mm` : `Straight, ${params.size} mm`,
      `Depth: ${params.depth ? params.depth + ' mm' : 'through wall (auto)'}`,
    ],
    apply: () => applyPointHoles(),
  });
}

export async function applyPointHoles() {
  const params = perfParams();
  for (const g of livePerfPoints()) {
    if (g.part.locked) {
      notify('warning', `${g.part.name} is locked`);
      continue;
    }
    const r = await runJob(`Cutting ${g.points.length} holes`, 'pointHoles', { mesh: worldMesh(g.part), points: g.points, params });
    if (!r) return;
    replaceWithWorldMeshes(`Perforate (${r.holes} holes)`, g.part.id, [{ name: g.part.name, mesh: r.mesh, color: g.part.color }]);
  }
  setState({ perfPoints: [] });
}

export function removePerfPoint(i: number) {
  setState((s) => ({ perfPoints: s.perfPoints.filter((_, j) => j !== i), preview: null }));
}

// ---------------------------------------------------------------- labels

export async function previewLabel() {
  const s = getState();
  const w = worldPoint(s.pointPicks.label);
  if (!w) return notify('warning', 'Click “Place label…” and pick a point on the part');
  if (w.part.locked) return notify('warning', `${w.part.name} is locked`);
  const { font, ...params } = s.settings.label;
  const fontArg = font === 'custom' ? s.customFont?.data : font;
  if (!fontArg) return notify('warning', 'Load a font file first');
  const r = await runJob(params.mode === 'emboss' ? 'Embossing label' : 'Engraving label', 'label', {
    mesh: worldMesh(w.part),
    font: fontArg instanceof ArrayBuffer ? fontArg.slice(0) : fontArg,
    params,
    point: w.point,
    normal: w.normal,
  });
  if (!r) return;
  setPreview({
    tool: 'label',
    label: `${params.mode === 'emboss' ? 'Emboss' : 'Engrave'} “${params.text.replace(/\n/g, ' ')}”`,
    replaces: [w.part.id],
    meshes: [{ name: w.part.name, mesh: r.mesh, color: w.part.color }],
    summary: [`Size ${params.size} mm, ${params.mode === 'emboss' ? 'height' : 'depth'} ${params.depth} mm`, `Rotation ${params.rotation}°`],
    apply: () => {
      replaceWithWorldMeshes(params.mode === 'emboss' ? 'Emboss label' : 'Engrave label', w.part.id, [{ name: w.part.name, mesh: r.mesh, color: w.part.color }]);
      setState({ pointPicks: { ...getState().pointPicks, label: undefined } });
    },
  });
}

export async function loadCustomFont(file: File) {
  const data = await file.arrayBuffer();
  setState((s) => ({ customFont: { name: file.name, data }, settings: { ...s.settings, label: { ...s.settings.label, font: 'custom' } } }));
  notify('success', `Font ${file.name} loaded`);
}

// ---------------------------------------------------------------- texture

export async function loadHeightmap(file: File) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const w = Math.max(2, Math.round(bmp.width * scale)), h = Math.max(2, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    const map: Heightmap = { width: w, height: h, data };
    setState((s) => ({ heightmap: { name: file.name, map }, settings: { ...s.settings, texture: { ...s.settings.texture, pattern: 'image' } } }));
  } catch {
    notify('error', `Could not read image ${file.name}`);
  }
}

export async function previewTexture() {
  const s = getState();
  const st = s.settings.texture;
  let part: Part | undefined;
  let tris: Uint32Array | null = null;
  if (st.scope === 'face') {
    const fs: FaceSelection | undefined = s.facePicks.texture;
    part = fs ? partById(fs.partId) : undefined;
    if (!fs || !part || part.mesh !== fs.mesh) return notify('warning', 'Pick the face to texture first');
    tris = fs.tris;
  } else {
    part = selectedParts()[0];
    if (!part) return notify('warning', 'Select a part to texture');
  }
  if (part.locked) return notify('warning', `${part.name} is locked`);
  if (st.pattern === 'image' && !s.heightmap) return notify('warning', 'Load a heightmap image first');
  const { scope: _s, smooth: _m, angleTolerance: _a, ...params } = st;
  void _s;
  void _m;
  void _a;
  const r = await runJob('Applying texture', 'texture', {
    mesh: worldMesh(part),
    tris,
    params: { ...params, heightmap: st.pattern === 'image' ? s.heightmap?.map : undefined },
  });
  if (!r) return;
  const p = part;
  setPreview({
    tool: 'texture',
    label: `Texture: ${st.pattern}`,
    replaces: [p.id],
    meshes: [{ name: p.name, mesh: r, color: p.color }],
    summary: [
      `Period ${st.period} mm, depth ${st.depth} mm`,
      `Triangles: ${(p.mesh.indices.length / 3).toLocaleString()} → ${(r.indices.length / 3).toLocaleString()}`,
    ],
    apply: () => replaceWithWorldMeshes('Texture', p.id, [{ name: p.name, mesh: r, color: p.color }]),
  });
}

// ---------------------------------------------------------------- 2D array / arrange / mirror copy

export function arrayParts() {
  const s = getState();
  const src = selectedParts().filter((p) => !p.locked);
  if (src.length !== 1) return notify('warning', 'Select exactly one part to array');
  const p = src[0];
  const { cols, rows, gap } = s.settings.arrange;
  if (cols * rows < 2) return notify('warning', 'Use at least 2 copies (columns × rows)');
  if (cols * rows > 500) return notify('warning', 'At most 500 copies');
  const b = worldBounds(p);
  const offs = gridArrayOffsets(cols, rows, b.max.x - b.min.x + gap, b.max.y - b.min.y + gap);
  const copies = offs.map(([dx, dy], i) => ({
    ...p,
    id: newId(),
    name: `${p.name} ${i + 2}`,
    transform: { ...p.transform, position: [p.transform.position[0] + dx, p.transform.position[1] + dy, p.transform.position[2]] as Vec3 },
  }));
  commit(`Array ${cols}×${rows}`, [...s.parts, ...copies], { selection: [p.id, ...copies.map((c) => c.id)] });
}

export function arrangeOnBed() {
  const s = getState();
  const sel = selectedParts();
  const parts = (sel.length > 1 ? sel : s.parts).filter((p) => !p.locked && p.visible);
  if (!parts.length) return notify('warning', 'Nothing to arrange');
  const boxes = new Map(parts.map((p) => [p.id, worldBounds(p)]));
  const { placements, width, depth } = arrangeShelves(
    parts.map((p) => {
      const b = boxes.get(p.id)!;
      return { id: p.id, w: b.max.x - b.min.x, d: b.max.y - b.min.y };
    }),
    s.settings.arrange.bedWidth,
    s.settings.arrange.gap,
  );
  const at = new Map(placements.map((pl) => [pl.id, pl]));
  commit(
    'Arrange on bed',
    s.parts.map((p) => {
      const pl = at.get(p.id);
      if (!pl) return p;
      const b = boxes.get(p.id)!;
      const pos = p.transform.position;
      return { ...p, transform: { ...p.transform, position: [pos[0] + pl.x - b.min.x, pos[1] + pl.y - b.min.y, pos[2] - b.min.z] as Vec3 } };
    }),
  );
  viewerApi.current?.fitView();
  notify('info', `Arranged ${parts.length} parts in ${width.toFixed(0)} × ${depth.toFixed(0)} mm`);
}

/** Mirrored copies placed next to the originals along the mirror axis. */
export function mirrorCopies(axis: 0 | 1 | 2) {
  const s = getState();
  const src = selectedParts();
  if (!src.length) return notify('warning', 'Select a part to mirror');
  const gap = s.settings.arrange.gap;
  const copies = src.map((p) => {
    const b = worldBounds(p);
    const size = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z][axis];
    const mirrored = mirrorMesh(worldMesh(p), axis);
    const { mesh, center } = recenter(mirrored);
    if (axis !== 2) center[axis] += size + gap;
    else center[0] += b.max.x - b.min.x + gap; // a Z mirror goes beside the original
    prepareMesh(mesh as MeshData);
    return { ...p, id: newId(), name: `${p.name} (mirror)`, color: nextColor(), locked: false, mesh, transform: IDENTITY_TRANSFORM(center) };
  });
  commit(`Mirror copy ${'XYZ'[axis]}`, [...s.parts, ...copies], { selection: copies.map((c) => c.id) });
}
