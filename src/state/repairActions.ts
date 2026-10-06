/**
 * Extended repair actions: stitching, overlaps, normals, shells, booleans,
 * face-based alignment and prop generation. All heavy work runs in workers;
 * destructive changes go through the preview → Apply flow.
 */
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { alignMatrix, flipMesh, flipTriangles, mergeMeshes } from '../geometry';
import type { MeshData, Vec3 } from '../geometry';
import { commit, getState, notify, partById, selectedParts, setState } from './store';
import type { FaceSelection, Part, PickSlot } from './types';
import { eulerDegFromQuaternion, matrixOf, worldMesh } from './math';
import { partFromWorld, prepareMesh, replaceLocalMesh, replaceWithWorldMeshes, runJob, setPreview, analyzePart } from './actions';
import { nextColor } from './palette';

type Slot = Exclude<PickSlot, 'primary'>;

const editableSelection = () => selectedParts().filter((p) => !p.locked);
const firstEditable = () => {
  const p = editableSelection()[0];
  if (!p) notify('warning', 'Select an unlocked part first');
  return p;
};

function invalidateAnalysis(partId: string) {
  setState((s) => {
    const a = { ...s.analysis };
    const i = { ...s.intersections };
    delete a[partId];
    delete i[partId];
    return { analysis: a, intersections: i };
  });
}

// ---------------------------------------------------------------- face picks

/** Start picking a face for one of the repair slots. */
export function startPick(slot: PickSlot) {
  const s = getState();
  const same = s.pickMode === 'face' && s.pickSlot === slot;
  setState({ pickMode: same ? null : 'face', pickSlot: slot, preview: null });
}

export async function pickFaceFor(slot: Slot, partId: string, faceIndex: number) {
  const p = partById(partId);
  if (!p) return;
  const tex = getState().settings.texture;
  const off = getState().settings.offset;
  const grow =
    slot === 'texture'
      ? { angle: tex.angleTolerance, smooth: tex.smooth }
      : slot === 'offset'
        ? { angle: off.smooth ? off.angle : 2, smooth: off.smooth }
        : { angle: 2, smooth: false };
  const r = await runJob('Selecting face', 'grow', { mesh: p.mesh, seed: faceIndex, ...grow }, { silent: p.mesh.indices.length < 600000 });
  if (!r) return;
  const pick: FaceSelection = { partId, seed: faceIndex, tris: r.tris, normal: r.normal, centroid: r.centroid, area: r.area, mesh: p.mesh };
  setState((s) => ({ facePicks: { ...s.facePicks, [slot]: pick }, pickMode: null, preview: null }));
}

export function clearPick(slot: Slot) {
  setState((s) => {
    const f = { ...s.facePicks };
    delete f[slot];
    return { facePicks: f, preview: null };
  });
}

/** World-space centroid and normal of a pick, using the part's current transform. */
export function worldFace(pick: FaceSelection): { point: Vec3; normal: Vec3 } | null {
  const p = partById(pick.partId);
  if (!p) return null;
  const m = matrixOf(p.transform);
  const c = new Vector3(...pick.centroid).applyMatrix4(m);
  const n = new Vector3(...pick.normal).applyMatrix3(new Matrix3().getNormalMatrix(m)).normalize();
  return { point: [c.x, c.y, c.z], normal: [n.x, n.y, n.z] };
}

/** A pick is stale if its part's mesh changed since it was made. */
function livePick(slot: Slot): { pick: FaceSelection; part: Part } | null {
  const pick = getState().facePicks[slot];
  if (!pick) return null;
  const part = partById(pick.partId);
  if (!part || part.mesh !== pick.mesh) return null;
  return { pick, part };
}

// ---------------------------------------------------------------- fix tab

export async function previewStitch() {
  const part = firstEditable();
  if (!part) return;
  const tol = getState().settings.stitch.tolerance;
  const r = await runJob(`Stitching ${part.name}`, 'stitch', { mesh: part.mesh, tolerance: tol > 0 ? tol : undefined });
  if (!r) return;
  if (r.mergedVertices === 0 && r.splitEdges === 0) return notify('info', 'Nothing to stitch within that tolerance');
  setPreview({
    tool: 'repair',
    label: 'Stitch triangles',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r.mesh }), color: part.color }],
    summary: [
      `Boundary vertices merged: ${r.mergedVertices}`,
      `T-junction edges split: ${r.splitEdges}`,
      `Open edges: ${r.openEdgesBefore} → ${r.openEdgesAfter}`,
    ],
    apply: () => {
      replaceLocalMesh('Stitch', part.id, r.mesh);
      invalidateAnalysis(part.id);
      analyzePart(part.id);
    },
  });
}

export async function checkIntersections(partId: string) {
  const p = partById(partId);
  if (!p) return;
  const report = await runJob(`Checking overlaps in ${p.name}`, 'intersections', { mesh: p.mesh });
  if (!report) return;
  setState((s) => ({ intersections: { ...s.intersections, [partId]: { mesh: p.mesh, report } } }));
  if (!report.intersecting.length && !report.overlapping.length) notify('success', `${p.name}: no intersecting or overlapping triangles`);
}

export async function previewRemoveOverlaps() {
  const part = firstEditable();
  if (!part) return;
  const r = await runJob('Removing overlapping triangles', 'removeOverlaps', { mesh: part.mesh });
  if (!r) return;
  if (!r.removed) return notify('info', 'No coplanar overlapping triangles found');
  setPreview({
    tool: 'repair',
    label: 'Remove overlapping triangles',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r.mesh }), color: part.color }],
    summary: [`Triangles removed: ${r.removed}`, 'Removing a doubled surface can open holes; run Stitch / Fill holes afterwards if needed.'],
    apply: () => {
      replaceLocalMesh('Remove overlapping triangles', part.id, r.mesh);
      invalidateAnalysis(part.id);
      analyzePart(part.id);
    },
  });
}

export async function unifyNormals() {
  const part = firstEditable();
  if (!part) return;
  const r = await runJob('Orienting normals', 'fixWinding', { mesh: part.mesh });
  if (!r) return;
  if (!r.flipped) return notify('info', 'Normals are already consistent and outward-facing');
  replaceLocalMesh('Unify normals', part.id, r.mesh);
  invalidateAnalysis(part.id);
  notify('success', `Flipped ${r.flipped.toLocaleString()} triangles to face outward`);
}

export function flipAllNormals() {
  const parts = editableSelection();
  if (!parts.length) return notify('warning', 'Select an unlocked part first');
  const parts2 = getState().parts.map((p) => {
    if (!parts.includes(p)) return p;
    const mesh = flipMesh(p.mesh);
    prepareMesh(mesh);
    return { ...p, mesh };
  });
  commit('Flip normals', parts2);
  parts.forEach((p) => invalidateAnalysis(p.id));
}

export function flipPickedFaces() {
  const live = livePick('flip');
  if (!live) return notify('warning', 'Pick the faces to flip first');
  const mesh = flipTriangles(live.part.mesh, live.pick.tris);
  replaceLocalMesh('Flip selected faces', live.part.id, mesh);
  invalidateAnalysis(live.part.id);
  clearPick('flip');
}

// ---------------------------------------------------------------- combine tab

export async function splitShellsToParts() {
  const part = firstEditable();
  if (!part) return;
  const shells = await runJob('Splitting shells', 'splitShells', { mesh: worldMesh(part) });
  if (!shells) return;
  if (shells.length < 2) return notify('info', `${part.name} has a single shell`);
  replaceWithWorldMeshes(
    `Split into ${shells.length} parts`,
    part.id,
    shells.map((m, i) => ({ name: `${part.name} ${i + 1}`, mesh: m, color: i === 0 ? part.color : nextColor() })),
  );
  notify('success', `Split ${part.name} into ${shells.length} parts`);
}

export async function previewUnifyShells() {
  const part = firstEditable();
  if (!part) return;
  const r = await runJob('Unifying shells', 'unifyShells', { mesh: worldMesh(part) });
  if (!r) return;
  setPreview({
    tool: 'repair',
    label: 'Unify shells (boolean union)',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: r.mesh, color: part.color }],
    summary: [`Shells merged: ${r.shells} → 1`, `Triangles: ${(r.mesh.indices.length / 3).toLocaleString()}`],
    apply: () => replaceWithWorldMeshes('Unify shells', part.id, [{ name: part.name, mesh: r.mesh, color: part.color }]),
  });
}

export async function previewMakeSolid() {
  const part = firstEditable();
  if (!part) return;
  const v = getState().settings.solid.voxelSize;
  const r = await runJob('Rebuilding solid', 'makeSolid', { mesh: worldMesh(part), voxelSize: v > 0 ? v : undefined });
  if (!r) return;
  setPreview({
    tool: 'repair',
    label: 'Make solid (voxel remesh)',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: r.mesh, color: part.color }],
    summary: [
      `Voxel size: ${r.voxelSize.toFixed(3)} mm (detail finer than this is smoothed)`,
      `Triangles: ${(part.mesh.indices.length / 3).toLocaleString()} → ${(r.mesh.indices.length / 3).toLocaleString()}`,
      'Result is a single watertight solid; overlaps and internal faces are removed.',
    ],
    apply: () => replaceWithWorldMeshes('Make solid', part.id, [{ name: part.name, mesh: r.mesh, color: part.color }]),
  });
}

/** Selected parts in the order they were selected (the first one is the base). */
export function booleanOperands(): Part[] {
  const s = getState();
  return s.selection.map((id) => s.parts.find((p) => p.id === id)).filter((p): p is Part => !!p);
}

export async function previewBoolean() {
  const ops = booleanOperands();
  if (ops.length < 2) return notify('warning', 'Select two or more parts (the first selected is the base)');
  if (ops.some((p) => p.locked)) return notify('warning', 'Unlock the parts first');
  const op = getState().settings.boolean.op;
  const [base, ...others] = ops;
  const r = await runJob(`Boolean ${op}`, 'boolean', { op, base: worldMesh(base), others: others.map(worldMesh) });
  if (!r) return;
  if (r.indices.length === 0) return notify('warning', `The ${op} result is empty`);
  const name = `${base.name} (${op})`;
  setPreview({
    tool: 'repair',
    label: `Boolean ${op}`,
    replaces: ops.map((p) => p.id),
    meshes: [{ name, mesh: r, color: base.color }],
    summary: [`Base: ${base.name}`, `With: ${others.map((p) => p.name).join(', ')}`, `Triangles: ${(r.indices.length / 3).toLocaleString()}`],
    apply: () => replaceParts(`Boolean ${op}`, ops.map((p) => p.id), [{ name, mesh: r, color: base.color }]),
  });
}

/** Combine selected parts into one part without a boolean (shells stay separate). */
export function mergeSelectedParts() {
  const ops = booleanOperands().filter((p) => !p.locked);
  if (ops.length < 2) return notify('warning', 'Select two or more unlocked parts');
  const merged = mergeMeshes(ops.map(worldMesh));
  replaceParts('Merge parts', ops.map((p) => p.id), [{ name: `${ops[0].name} (merged)`, mesh: merged, color: ops[0].color }]);
}

/** Replace several parts with new world-space meshes as one undo step. */
function replaceParts(label: string, ids: string[], results: { name: string; mesh: MeshData; color?: string }[]) {
  const s = getState();
  const set = new Set(ids);
  const created = results.map((r) => partFromWorld(r.name, r.mesh, r.color));
  const first = s.parts.findIndex((p) => set.has(p.id));
  const kept = s.parts.filter((p) => !set.has(p.id));
  const at = Math.max(0, Math.min(first, kept.length));
  commit(label, [...kept.slice(0, at), ...created, ...kept.slice(at)], { selection: created.map((c) => c.id), facePicks: {} });
}

// ---------------------------------------------------------------- align tab

function alignDelta(): { part: Part; delta: Matrix4 } | null {
  const src = livePick('alignSource');
  const tgt = livePick('alignTarget');
  if (!src || !tgt) {
    notify('warning', 'Pick a face on the part to move, then a face to align it to');
    return null;
  }
  if (src.part.id === tgt.part.id) {
    notify('warning', 'The two faces must be on different parts');
    return null;
  }
  if (src.part.locked) {
    notify('warning', `${src.part.name} is locked`);
    return null;
  }
  const a = worldFace(src.pick)!, b = worldFace(tgt.pick)!;
  const opts = getState().settings.align;
  return { part: src.part, delta: new Matrix4().fromArray(alignMatrix(a, b, opts)) };
}

export function previewAlign() {
  const r = alignDelta();
  if (!r) return;
  const { part, delta } = r;
  const world = delta.clone().multiply(matrixOf(part.transform));
  const moved = worldMesh(part);
  const pos = moved.positions.slice();
  const e = delta.elements;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    pos[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    pos[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    pos[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const o = getState().settings.align;
  setPreview({
    tool: 'repair',
    label: `Align ${part.name}`,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: { positions: pos, indices: moved.indices }, color: part.color }],
    summary: [`Mode: ${o.mode === 'mate' ? 'mate (face to face)' : 'flush (same direction)'}`, `Offset: ${o.offset} mm`, `Centre faces: ${o.center ? 'yes' : 'no'}`],
    apply: () => {
      const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
      world.decompose(p, q, sc);
      const cur = partById(part.id);
      if (!cur) return;
      commit('Align parts', getState().parts.map((x) =>
        x.id === part.id
          ? { ...x, transform: { position: [p.x, p.y, p.z] as Vec3, rotation: eulerDegFromQuaternion(q), scale: [sc.x, sc.y, sc.z] as Vec3 } }
          : x,
      ));
    },
  });
}

// ---------------------------------------------------------------- props tab

export async function previewProps() {
  const a = livePick('propsA');
  const b = livePick('propsB');
  if (!a || !b) return notify('warning', 'Pick the start face and the face (or shell) to prop against');
  const st = getState().settings.props;
  const { merge, ...params } = st;
  const towards = worldFace(b.pick)!.point;
  const plan = await runJob('Generating props', 'props', {
    source: worldMesh(a.part),
    tris: a.pick.tris,
    target: worldMesh(b.part),
    params,
    towards,
  });
  if (!plan) return;
  if (!plan.props.length) return notify('warning', `No props fit: ${plan.skipped} positions found no surface within ${st.maxLength} mm`);
  const parts = a.part.id === b.part.id ? [a.part] : [a.part, b.part];
  setPreview({
    tool: 'repair',
    label: `${plan.props.length} props`,
    replaces: [],
    meshes: [{ name: 'Props', mesh: plan.mesh, color: '#ffd23f' }],
    summary: [
      `Props: ${plan.props.length} × Ø${st.diameter} mm${plan.skipped ? ` (${plan.skipped} positions skipped)` : ''}`,
      `Embedded ${st.embed} mm into each face`,
      merge ? `Apply merges props with ${parts.map((p) => p.name).join(' + ')} into one solid` : 'Apply adds the props as a new part',
    ],
    apply: async () => {
      if (!merge) {
        const np = partFromWorld(`Props (${a.part.name})`, plan.mesh, '#ffd23f');
        commit('Add props', [...getState().parts, np], { selection: [np.id] });
        return;
      }
      if (parts.some((p) => p.locked)) return notify('warning', 'Unlock the parts to merge props into them');
      const [base, ...rest] = parts.map(worldMesh);
      const r = await runJob('Merging props', 'boolean', { op: 'union', base, others: [...rest, plan.mesh] });
      if (!r) return;
      replaceParts('Add props (merged)', parts.map((p) => p.id), [{ name: parts.map((p) => p.name).join(' + '), mesh: r, color: a.part.color }]);
    },
  });
}

// ---------------------------------------------------------------- single-purpose cleanups

export async function previewCleanTriangles(what: 'duplicates' | 'degenerate') {
  const part = firstEditable();
  if (!part) return;
  const r = await runJob(what === 'duplicates' ? 'Removing duplicate triangles' : 'Removing degenerate triangles', 'cleanTriangles', { mesh: part.mesh, what });
  if (!r) return;
  if (!r.removed) return notify('info', `No ${what} triangles found`);
  setPreview({
    tool: 'repair',
    label: what === 'duplicates' ? 'Remove duplicate triangles' : 'Remove degenerate triangles',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r.mesh }), color: part.color }],
    summary: [`Triangles removed: ${r.removed.toLocaleString()}`],
    apply: () => {
      replaceLocalMesh(what === 'duplicates' ? 'Remove duplicate triangles' : 'Remove degenerate triangles', part.id, r.mesh);
      invalidateAnalysis(part.id);
      analyzePart(part.id);
    },
  });
}

export async function previewFixNonManifold(fill = true) {
  const part = firstEditable();
  if (!part) return;
  const r = await runJob('Fixing non-manifold edges', 'fixNonManifold', { mesh: part.mesh, fill });
  if (!r) return;
  if (!r.removed) return notify('info', 'No non-manifold edges found');
  setPreview({
    tool: 'repair',
    label: 'Fix non-manifold edges',
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r.mesh }), color: part.color }],
    summary: [
      `Non-manifold edges: ${r.edges.toLocaleString()}`,
      `Extra triangles removed: ${r.removed.toLocaleString()}`,
      `Openings filled: ${r.filled}`,
    ],
    apply: () => {
      replaceLocalMesh('Fix non-manifold edges', part.id, r.mesh);
      invalidateAnalysis(part.id);
      analyzePart(part.id);
    },
  });
}
