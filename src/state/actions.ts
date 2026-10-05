import { Quaternion, Vector3 } from 'three';
import type { MeshData, Vec3 } from '../geometry';
import { mirrorMesh } from '../geometry/transform';
import { pool, CancelledError } from '../workers/client';
import type { OpArgs, OpName, OpResult } from '../workers/ops';
import { getLoader, extensionOf } from '../loaders/registry';
import '../loaders/index';
import {
  commit, getState, notify, partById, selectedParts, setState, startJob, updateParts,
} from './store';
import { nextColor } from './palette';
import type { Part, Preview, ToolId } from './types';
import { meshEntry, updateMeshEntry } from './meshCache';
import {
  centeredPlane, eulerDegFromQuaternion, IDENTITY_TRANSFORM, matrixOf, planeFromSettings, quaternionOf, recenter, worldBounds, worldMesh,
} from './math';
import { viewerApi } from '../viewer/api';

let uid = 1;
export const newId = () => `p${Date.now().toString(36)}${(uid++).toString(36)}`;

// ---------------------------------------------------------------- worker jobs

/** Run a worker op with a progress entry in the status bar; resolves null if cancelled. */
export async function runJob<K extends OpName>(
  label: string,
  op: K,
  args: OpArgs<K>,
  opts: { silent?: boolean; quietErrors?: boolean } = {},
): Promise<OpResult<K> | null> {
  let cancelFn: (() => void) | undefined;
  const job = opts.silent ? null : startJob(label, () => cancelFn?.());
  const handle = pool.run(op, args, job?.progress);
  cancelFn = handle.cancel;
  try {
    return await handle.promise;
  } catch (e) {
    if (e instanceof CancelledError) {
      if (!opts.silent) notify('info', `${label} cancelled`);
      return null;
    }
    if (!opts.quietErrors) notify('error', `${label} failed: ${(e as Error).message}`);
    return null;
  } finally {
    job?.end();
  }
}

/** Build BVH + topology flags for a mesh in the background. */
export function prepareMesh(mesh: MeshData) {
  const e = meshEntry(mesh);
  if (e.preparing || e.bvh) return;
  e.preparing = true;
  const big = mesh.indices.length / 3 > 300000;
  runJob('Preparing mesh', 'prepare', { mesh }, { silent: !big, quietErrors: true }).then((r) => {
    if (!r) return updateMeshEntry(mesh, { preparing: false });
    updateMeshEntry(mesh, { bvh: r.bvh, watertight: r.watertight, preparing: false });
    setState((s) => ({ meshInfoVersion: s.meshInfoVersion + 1 }));
  });
}

export function requestEdges(mesh: MeshData) {
  const e = meshEntry(mesh);
  if (e.edges || e.edgesPending) return;
  e.edgesPending = true;
  runJob('Computing edges', 'featureEdges', { mesh, angle: 30 }, { silent: mesh.indices.length < 900000, quietErrors: true }).then(
    (r) => updateMeshEntry(mesh, { edges: r ?? new Float32Array(0), edgesPending: false }),
  );
}

// ---------------------------------------------------------------- parts

export function makePart(name: string, mesh: MeshData, position: Vec3, source?: string, color = nextColor()): Part {
  prepareMesh(mesh);
  return { id: newId(), name, color, visible: true, locked: false, mesh, transform: IDENTITY_TRANSFORM(position), source };
}

/** New part from a world-space mesh (recentred). */
export function partFromWorld(name: string, world: MeshData, color?: string, source?: string): Part {
  const { mesh, center } = recenter(world);
  return makePart(name, mesh, center, source, color);
}

const SIDE_FILES = new Set(['bin', 'png', 'jpg', 'jpeg', 'webp', 'ktx2']);
export const CAD_EXTENSIONS = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp']);

/** Original files of CAD imports, kept so parts can be re-tessellated at another quality. */
export const sourceFiles = new Map<string, File>();

/** Import any number of files; each runs as its own cancellable job. */
export async function importFiles(files: File[]) {
  const hasGltf = files.some((f) => extensionOf(f.name) === 'gltf');
  const wasEmpty = getState().parts.length === 0;
  const siblings: [string, ArrayBuffer][] = [];
  if (hasGltf) {
    for (const f of files) if (SIDE_FILES.has(extensionOf(f.name))) siblings.push([f.name, await f.arrayBuffer()]);
  }
  const tasks = files.map(async (file) => {
    const ext = extensionOf(file.name);
    if (hasGltf && SIDE_FILES.has(ext)) return;
    const loader = getLoader(file.name);
    if (!loader) {
      notify('error', `${file.name}: unsupported file type ".${ext}"`);
      return;
    }
    if (!loader.load) {
      notify('error', `${file.name}: ${loader.unsupportedMessage}`, 15000);
      return;
    }
    const buffer = await file.arrayBuffer();
    const cadQuality = getState().settings.importQuality;
    const r = await runJob(`Importing ${file.name}`, 'import', {
      name: file.name,
      buffer,
      siblings: ext === 'gltf' ? siblings : undefined,
      cadQuality,
    });
    if (!r) return;
    if (CAD_EXTENSIONS.has(ext)) sourceFiles.set(file.name, file);
    r.warnings.forEach((w) => notify('warning', w, 10000));
    const parts = r.bodies.map((b) => ({
      ...makePart(r.bodies.length > 1 ? b.name : b.name || file.name, b.mesh, b.center, file.name),
      importCenter: b.center,
    }));
    const s = getState();
    commit(`Import ${file.name}`, [...s.parts, ...parts], { selection: parts.map((p) => p.id) });
    const tris = parts.reduce((a, p) => a + p.mesh.indices.length / 3, 0);
    notify('success', `Imported ${file.name}: ${parts.length} part${parts.length > 1 ? 's' : ''}, ${tris.toLocaleString()} triangles`);
  });
  await Promise.all(tasks);
  if (wasEmpty && getState().parts.length) viewerApi.current?.fitView();
}

export function deleteParts(ids = getState().selection) {
  const s = getState();
  const del = new Set(ids.filter((id) => !partById(id)?.locked));
  if (!del.size) return;
  commit(del.size > 1 ? `Delete ${del.size} parts` : 'Delete part', s.parts.filter((p) => !del.has(p.id)), {
    selection: s.selection.filter((id) => !del.has(id)),
    preview: null,
    faceSelection: null,
  });
}

export function duplicateParts(ids = getState().selection) {
  const s = getState();
  const src = s.parts.filter((p) => ids.includes(p.id));
  if (!src.length) return;
  const copies = src.map((p) => {
    const b = worldBounds(p);
    const dx = b.max.x - b.min.x + 5;
    return {
      ...p,
      id: newId(),
      name: `${p.name} copy`,
      color: nextColor(),
      locked: false,
      transform: { ...p.transform, position: [p.transform.position[0] + dx, p.transform.position[1], p.transform.position[2]] as Vec3 },
    };
  });
  commit('Duplicate', [...s.parts, ...copies], { selection: copies.map((c) => c.id) });
}

export function renamePart(id: string, name: string) {
  updateParts('Rename', [id], (p) => ({ ...p, name }));
}
export function setPartColor(id: string, color: string) {
  updateParts('Change colour', [id], (p) => ({ ...p, color }));
}
export function toggleVisible(id: string) {
  updateParts('Toggle visibility', [id], (p) => ({ ...p, visible: !p.visible }));
}
export function toggleLocked(id: string) {
  updateParts('Toggle lock', [id], (p) => ({ ...p, locked: !p.locked }));
}

export function select(id: string | null, mode: 'set' | 'toggle' | 'add' = 'set') {
  const s = getState();
  if (!id) return setState({ selection: [] });
  if (mode === 'set') setState({ selection: [id] });
  else if (mode === 'toggle') setState({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] });
  else if (!s.selection.includes(id)) setState({ selection: [...s.selection, id] });
}

export function selectRange(id: string) {
  const s = getState();
  const last = s.selection[s.selection.length - 1];
  const ia = s.parts.findIndex((p) => p.id === last);
  const ib = s.parts.findIndex((p) => p.id === id);
  if (ia < 0 || ib < 0) return select(id);
  const [a, b] = ia < ib ? [ia, ib] : [ib, ia];
  setState({ selection: s.parts.slice(a, b + 1).map((p) => p.id) });
}

export function selectAll() {
  setState({ selection: getState().parts.map((p) => p.id) });
}

const editable = () => selectedParts().filter((p) => !p.locked);

// ---------------------------------------------------------------- transforms

export function dropToBed(ids = editable().map((p) => p.id)) {
  if (!ids.length) return;
  updateParts('Drop to bed', ids, (p) => {
    const b = worldBounds(p);
    const pos = [...p.transform.position] as Vec3;
    pos[2] -= b.min.z;
    return { ...p, transform: { ...p.transform, position: pos } };
  });
}

export function centerOnOrigin(ids = editable().map((p) => p.id)) {
  if (!ids.length) return;
  updateParts('Centre on origin', ids, (p) => {
    const b = worldBounds(p);
    const pos = [...p.transform.position] as Vec3;
    pos[0] -= (b.min.x + b.max.x) / 2;
    pos[1] -= (b.min.y + b.max.y) / 2;
    return { ...p, transform: { ...p.transform, position: pos } };
  });
}

/** Mirror across the world axis through the part's bounding-box centre (baked into the mesh). */
export function mirrorParts(axis: 0 | 1 | 2, ids = editable().map((p) => p.id)) {
  if (!ids.length) return;
  updateParts(`Mirror ${'XYZ'[axis]}`, ids, (p) => {
    const w = mirrorMesh(worldMesh(p), axis);
    const { mesh, center } = recenter(w);
    prepareMesh(mesh);
    return { ...p, mesh, transform: IDENTITY_TRANSFORM(center) };
  });
}

/** Rotate a part so the given world-space normal points down, then drop it to the bed. */
export function layFlat(id: string, worldNormal: Vec3) {
  const p = partById(id);
  if (!p || p.locked) return;
  const n = new Vector3(...worldNormal).normalize();
  const q = new Quaternion().setFromUnitVectors(n, new Vector3(0, 0, -1));
  const rot = q.multiply(quaternionOf(p.transform));
  const rotation = eulerDegFromQuaternion(rot);
  const next: Part = { ...p, transform: { ...p.transform, rotation } };
  const b = worldBounds(next);
  next.transform.position = [p.transform.position[0], p.transform.position[1], p.transform.position[2] - b.min.z];
  commit('Lay flat', getState().parts.map((x) => (x.id === id ? next : x)), { pickMode: null });
}

// ---------------------------------------------------------------- previews

export function setPreview(preview: Preview | null) {
  setState({ preview });
}

export function applyPreview() {
  const p = getState().preview;
  if (!p) return;
  p.apply();
  setState({ preview: null });
}

export function cancelPreview() {
  setState({ preview: null });
}

export function setTool(tool: ToolId) {
  const s = getState();
  if (s.tool === tool) return;
  const extra: Partial<typeof s> = {};
  if (tool === 'cut') {
    const target = selectedParts().filter((p) => !p.locked);
    if (target.length) extra.cutPlane = centeredPlane(s.cutPlane, target.slice(0, 1));
  }
  if (tool === 'measure') {
    // edge snapping uses the feature edges computed for display
    for (const p of s.parts) requestEdges(p.mesh);
    extra.measurePending = { entities: [], points: [] };
  }
  if (tool === 'clip' && !s.clipEnabled) {
    const sel = selectedParts();
    extra.clip = centeredPlane(s.clip, sel.length ? sel : s.parts);
  }
  setState({
    tool,
    preview: null,
    pickMode: null,
    pickSlot: 'primary',
    faceSelection: tool === 'extrude' || tool === 'perforate' ? s.faceSelection : null,
    ...extra,
  });
}

/** Replace one part by new world-space meshes as a single undo step. */
export function replaceWithWorldMeshes(label: string, partId: string, results: { name: string; mesh: MeshData; color?: string }[]) {
  const s = getState();
  const old = s.parts.find((p) => p.id === partId);
  if (!old) return;
  const created = results.map((r, i) => {
    const np = partFromWorld(r.name, r.mesh, r.color ?? (i === 0 ? old.color : undefined), old.source);
    return np;
  });
  const idx = s.parts.findIndex((p) => p.id === partId);
  const parts = [...s.parts.slice(0, idx), ...created, ...s.parts.slice(idx + 1)];
  commit(label, parts, { selection: created.map((c) => c.id), faceSelection: null });
}

/** Replace a part's local mesh keeping its transform (repairs). */
export function replaceLocalMesh(label: string, partId: string, mesh: MeshData) {
  prepareMesh(mesh);
  updateParts(label, [partId], (p) => ({ ...p, mesh }));
}

// ---------------------------------------------------------------- cut

export async function previewCut() {
  const s = getState();
  const part = editable()[0];
  if (!part) return notify('warning', 'Select an unlocked part to cut');
  const plane = planeFromSettings(s.cutPlane);
  const world = worldMesh(part);
  const r = await runJob('Cutting', 'cut', { mesh: world, plane });
  if (!r) return;
  const gap = s.settings.cut.gap;
  const shift = (m: MeshData, d: number): MeshData => {
    if (!d) return m;
    const p = m.positions.slice();
    for (let i = 0; i < p.length; i += 3) {
      p[i] += plane.normal[0] * d;
      p[i + 1] += plane.normal[1] * d;
      p[i + 2] += plane.normal[2] * d;
    }
    return { positions: p, indices: m.indices };
  };
  const pieces = [
    { name: `${part.name} A`, mesh: shift(r.above, gap / 2), color: part.color },
    { name: `${part.name} B`, mesh: shift(r.below, -gap / 2), color: nextColor() },
  ].filter((x) => x.mesh.indices.length > 0);
  if (pieces.length < 2) {
    notify('warning', 'The plane does not intersect the part');
    return;
  }
  setPreview({
    tool: 'cut',
    label: 'Cut',
    replaces: [part.id],
    meshes: pieces,
    summary: [`Method: ${r.method}`, ...pieces.map((p) => `${p.name}: ${(p.mesh.indices.length / 3).toLocaleString()} triangles`)],
    apply: () => replaceWithWorldMeshes('Cut', part.id, pieces),
  });
}

// ---------------------------------------------------------------- repair

export async function analyzePart(id: string) {
  const p = partById(id);
  if (!p) return;
  const report = await runJob(`Analysing ${p.name}`, 'analyze', { mesh: p.mesh });
  if (!report) return;
  updateMeshEntry(p.mesh, { watertight: report.watertight });
  setState((s) => ({ analysis: { ...s.analysis, [id]: { mesh: p.mesh, report } }, meshInfoVersion: s.meshInfoVersion + 1 }));
}

export async function previewRepair() {
  const part = editable()[0];
  if (!part) return notify('warning', 'Select an unlocked part to repair');
  const st = getState().settings.repair;
  const a = getState().analysis[part.id];
  const rep = a && a.mesh === part.mesh ? a.report : null;
  const before = rep
    ? {
        triangles: rep.triangles, vertices: rep.vertices, openEdges: rep.openEdges, nonManifoldEdges: rep.nonManifoldEdges,
        holes: rep.holes, flippedTriangles: rep.flippedTriangles, degenerateTriangles: rep.degenerateTriangles,
        duplicateTriangles: rep.duplicateTriangles, shells: rep.shells, watertight: rep.watertight,
      }
    : undefined;
  const r = await runJob(`Repairing ${part.name}`, 'repair', {
    mesh: part.mesh,
    options: {
      before,
      removeSmallShells: st.removeSmallShells,
      smallShellRatio: st.smallShellRatio,
      weldTolerance: st.weldTolerance > 0 ? st.weldTolerance : undefined,
      fillHoles: st.fillHoles,
      stitch: st.stitch,
      stitchTolerance: getState().settings.stitch.tolerance > 0 ? getState().settings.stitch.tolerance : undefined,
    },
  });
  if (!r) return;
  const m = r.summary;
  const line = (label: string, a: number | boolean, b: number | boolean) => `${label}: ${fmtVal(a)} → ${fmtVal(b)}`;
  const summary = [
    `Welded vertices: ${m.weldedVertices.toLocaleString()}`,
    `Degenerate removed: ${m.degenerateRemoved}`,
    `Duplicates removed: ${m.duplicatesRemoved}`,
    `Triangles flipped: ${m.trianglesFlipped}`,
    `Holes filled: ${m.holesFilled}`,
    `Stitched: ${m.stitchedVertices} vertices, ${m.stitchedEdges} T-junctions`,
    `Shells removed: ${m.shellsRemoved}`,
    '—',
    line('Open edges', m.before.openEdges, m.after.openEdges),
    line('Non-manifold edges', m.before.nonManifoldEdges, m.after.nonManifoldEdges),
    line('Flipped triangles', m.before.flippedTriangles, m.after.flippedTriangles),
    line('Shells', m.before.shells, m.after.shells),
    line('Triangles', m.before.triangles, m.after.triangles),
    line('Watertight', m.before.watertight, m.after.watertight),
  ];
  setPreview({
    tool: 'repair',
    label: 'Auto repair',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMeshFor(part, r.mesh), color: part.color }],
    summary,
    apply: () => {
      replaceLocalMesh('Auto repair', part.id, r.mesh);
      setState((s) => {
        const a = { ...s.analysis };
        delete a[part.id];
        return { analysis: a };
      });
      analyzePart(part.id);
    },
  });
}

function fmtVal(v: number | boolean) {
  return typeof v === 'boolean' ? (v ? 'yes' : 'no') : v.toLocaleString();
}

function worldMeshFor(part: Part, local: MeshData): MeshData {
  return worldMesh({ ...part, mesh: local });
}

export async function previewFillHoles(which?: number[]) {
  const part = editable()[0];
  if (!part) return;
  const r = await runJob('Filling holes', 'fillHoles', { mesh: part.mesh, which });
  if (!r) return;
  setPreview({
    tool: 'repair',
    label: which ? `Fill ${which.length} hole${which.length > 1 ? 's' : ''}` : 'Fill all holes',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMeshFor(part, r.mesh), color: part.color }],
    summary: [`Holes filled: ${r.filled}`, `Triangles: ${(part.mesh.indices.length / 3).toLocaleString()} → ${(r.mesh.indices.length / 3).toLocaleString()}`],
    apply: () => {
      replaceLocalMesh(which ? 'Fill hole' : 'Fill all holes', part.id, r.mesh);
      analyzePart(part.id);
    },
  });
}

// ---------------------------------------------------------------- face selection

export async function pickFace(partId: string, faceIndex: number) {
  const s = getState();
  const p = partById(partId);
  if (!p) return;
  const angle = s.tool === 'perforate' ? s.settings.perforate.angleTolerance : s.settings.extrude.angleTolerance;
  const r = await runJob('Selecting face', 'grow', { mesh: p.mesh, seed: faceIndex, angle }, { silent: p.mesh.indices.length < 600000 });
  if (!r) return;
  setState({
    faceSelection: { partId, seed: faceIndex, tris: r.tris, normal: r.normal, centroid: r.centroid, area: r.area },
    selection: [partId],
    pickMode: null,
    preview: null,
  });
}

/** Re-grow the current selection after the angle tolerance changed. */
export async function regrowFace() {
  const fs = getState().faceSelection;
  if (fs) await pickFace(fs.partId, fs.seed);
}

export async function previewExtrude() {
  const s = getState();
  const fs = s.faceSelection;
  if (!fs) return;
  const part = partById(fs.partId);
  if (!part || part.locked) return;
  const d = s.settings.extrude.distance;
  if (!d) return setPreview(null);
  const r = await runJob('Extruding', 'extrude', { mesh: worldMesh(part), tris: fs.tris, distance: d }, { silent: part.mesh.indices.length < 300000 });
  if (!r) return;
  setPreview({
    tool: 'extrude',
    label: `Extrude ${d > 0 ? '+' : ''}${d} mm`,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: r, color: part.color }],
    summary: [`Region: ${fs.tris.length.toLocaleString()} triangles, ${fs.area.toFixed(1)} mm²`, `Distance: ${d} mm`],
    apply: () => replaceWithWorldMeshes('Extrude', part.id, [{ name: part.name, mesh: r, color: part.color }]),
  });
}

export async function previewPerforationPattern() {
  const s = getState();
  const fs = s.faceSelection;
  if (!fs) return;
  const part = partById(fs.partId);
  if (!part) return;
  const { angleTolerance: _a, ...params } = s.settings.perforate;
  void _a;
  const plan = await runJob('Planning pattern', 'perforationPlan', { mesh: worldMesh(part), tris: fs.tris, params }, { silent: true });
  if (!plan) return;
  setPreview({
    tool: 'perforate',
    label: 'Perforation pattern',
    replaces: [],
    meshes: [],
    lines: plan.outlines,
    summary: [`${plan.centers.length} holes${plan.truncated ? ' (limit reached)' : ''}`, `Depth: ${params.depth ? params.depth + ' mm' : 'through wall (auto)'}`],
    apply: () => applyPerforation(),
  });
}

export async function applyPerforation() {
  const s = getState();
  const fs = s.faceSelection;
  if (!fs) return;
  const part = partById(fs.partId);
  if (!part || part.locked) return;
  const { angleTolerance: _a, ...params } = s.settings.perforate;
  void _a;
  const keepPlugs = s.settings.perforateExtra.keepPlugs;
  const r = await runJob('Perforating', 'perforate', { mesh: worldMesh(part), tris: fs.tris, params, keepPlugs });
  if (!r) return;
  replaceWithWorldMeshes(`Perforate (${r.holes} holes)`, part.id, [
    { name: part.name, mesh: r.mesh, color: part.color },
    ...(r.plugs && r.plugs.indices.length ? [{ name: `${part.name} plugs`, mesh: r.plugs }] : []),
  ]);
  notify('success', `Cut ${r.holes} holes${r.plugs ? ' (plugs kept as a separate part)' : ''}`);
}

// ---------------------------------------------------------------- hollow

const VOXELS = { draft: 2e6, normal: 6e6, fine: 16e6 };

export async function previewHollow() {
  const s = getState();
  const part = editable()[0];
  if (!part) return notify('warning', 'Select an unlocked part to hollow');
  const h = s.settings.hollow;
  const r = await runJob(`Hollowing ${part.name}`, 'hollow', {
    mesh: worldMesh(part),
    thickness: h.thickness,
    maxVoxels: VOXELS[h.quality],
    drainHoles: h.drainHoles,
    drainDiameter: h.drainDiameter,
  });
  if (!r) return;
  setPreview({
    tool: 'hollow',
    label: `Hollow ${h.thickness} mm`,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: r.mesh, color: part.color }],
    summary: [
      `Wall: ${h.thickness} mm (voxel ${r.voxelSize.toFixed(2)} mm)`,
      `Drain holes: ${r.drained}`,
      `Triangles: ${(r.mesh.indices.length / 3).toLocaleString()}`,
      'Tip: enable Clip to inspect the cavity.',
    ],
    apply: () => {
      replaceWithWorldMeshes('Hollow', part.id, [{ name: part.name, mesh: r.mesh, color: part.color }]);
      setState((st) => ({ settings: { ...st.settings, hollow: { ...st.settings.hollow, drainHoles: [] } } }));
    },
  });
}

// ---------------------------------------------------------------- export

export async function exportParts(format: 'stl' | '3mf' | 'obj', scope: 'selected' | 'all', zip: boolean) {
  const s = getState();
  const parts = scope === 'all' ? s.parts : selectedParts();
  if (!parts.length) return notify('warning', 'Nothing to export');
  const items = parts.map((p) => ({ name: p.name, mesh: worldMesh(p) }));
  const bytes = await runJob('Exporting', 'export', { format, items, zip });
  if (!bytes) return;
  const base = parts.length === 1 ? parts[0].name.replace(/[^\w.-]+/g, '_') : 'parts';
  const name = zip ? `${base}-${format}.zip` : `${base}.${format}`;
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify('success', `Exported ${parts.length} part${parts.length > 1 ? 's' : ''} as ${name}`);
}

export { matrixOf };

/**
 * Re-tessellate every part that came from a CAD file at the current import
 * quality, keeping names, colours, visibility, locks and placement.
 */
export async function reimportSource(source: string) {
  const file = sourceFiles.get(source);
  if (!file) return notify('warning', `The original file ${source} is no longer available; open it again`);
  const cadQuality = getState().settings.importQuality;
  const r = await runJob(`Re-importing ${source} (${cadQuality})`, 'import', { name: file.name, buffer: await file.arrayBuffer(), cadQuality });
  if (!r) return;
  r.warnings.forEach((w) => notify('warning', w, 10000));
  const s = getState();
  const old = s.parts.filter((p) => p.source === source);
  const unused = [...old];
  const replaced = new Map<string, Part>();
  const created: Part[] = [];
  r.bodies.forEach((b, i) => {
    const name = r.bodies.length > 1 ? b.name : b.name || file.name;
    const k = unused.findIndex((p) => p.name === name || p.name.startsWith(name));
    const match = k >= 0 ? unused.splice(k, 1)[0] : unused.length && r.bodies.length === old.length ? unused.splice(0, 1)[0] : undefined;
    prepareMesh(b.mesh);
    if (match) {
      const ic = match.importCenter ?? b.center;
      const pos = match.transform.position;
      const np: Part = {
        ...match,
        mesh: b.mesh,
        importCenter: b.center,
        transform: { ...match.transform, position: [pos[0] + b.center[0] - ic[0], pos[1] + b.center[1] - ic[1], pos[2] + b.center[2] - ic[2]] },
      };
      replaced.set(match.id, np);
    } else {
      created.push({ ...makePart(name, b.mesh, b.center, source), importCenter: b.center });
    }
    void i;
  });
  const gone = new Set(unused.map((p) => p.id));
  const parts = s.parts.filter((p) => !gone.has(p.id)).map((p) => replaced.get(p.id) ?? p);
  commit(`Re-import ${source}`, [...parts, ...created]);
  const tris = [...replaced.values(), ...created].reduce((a, p) => a + p.mesh.indices.length / 3, 0);
  notify('success', `Re-imported ${source} at ${cadQuality} quality: ${tris.toLocaleString()} triangles`);
}

export function setImportQuality(q: 'draft' | 'normal' | 'fine' | 'ultra') {
  setState((s) => ({ settings: { ...s.settings, importQuality: q } }));
  try {
    localStorage.setItem('autonest.importQuality', q);
  } catch {
    /* storage unavailable */
  }
}

/** Leave the current tool: drop its preview, picks and pending state, back to Transform. */
export function cancelTool() {
  const s = getState();
  const tool = s.tool;
  setState({
    preview: null,
    pickMode: null,
    pickSlot: 'primary',
    zoomWindow: false,
    faceSelection: tool === 'extrude' || tool === 'perforate' ? null : s.faceSelection,
    facePicks: tool === 'repair' || tool === 'texture' ? {} : s.facePicks,
    pointPicks: tool === 'repair' || tool === 'label' ? {} : s.pointPicks,
    perfPoints: tool === 'perforate' ? [] : s.perfPoints,
    measurePending: { entities: [], points: [] },
    settings: tool === 'hollow' ? { ...s.settings, hollow: { ...s.settings.hollow, drainHoles: [] } } : s.settings,
    tool: 'transform',
  });
}
