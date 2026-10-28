/**
 * Creating and lightweighting parts: basic shapes, lattice infill and
 * shrinkwrap. Each one shows a preview first; Apply makes it one undo step.
 */
import type { MeshData } from '../geometry';
import { LATTICES } from '../geometry/lattice';
import { mouldClearance } from '../geometry/mould';
import { arrangeBoxes } from '../geometry/arrange';
import type { Vec3 } from '../geometry';
import { SHAPES } from '../geometry/shapes';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { applyMatrix } from '../geometry/transform';
import { commit, getState, notify, selectedParts, updateParts } from './store';
import type { Part, Transform } from './types';
import { eulerDegFromQuaternion, quaternionOf, worldBounds, worldMesh } from './math';
import { partFromWorld, replaceWithWorldMeshes, runJob, setPreview } from './actions';
import { nextColor } from './palette';
import { SUFFIX, withSuffix } from './naming';

const mm = (v: number) => `${+v.toFixed(3)} mm`;
const tris = (m: MeshData) => (m.indices.length / 3).toLocaleString();
const firstEditable = () => selectedParts().find((p) => !p.locked);

/** Add new parts from world-space meshes as one undo step, selecting them. */
function addWorldParts(label: string, items: { name: string; mesh: MeshData; color?: string }[]) {
  const created = items.map((r) => partFromWorld(r.name, r.mesh, r.color));
  commit(label, [...getState().parts, ...created], { selection: created.map((c) => c.id) });
}

// ---------------------------------------------------------------- basic shapes

export async function previewShape() {
  const s = getState();
  const params = s.settings.shape;
  const m = await runJob('Creating shape', 'makeShape', { params });
  if (!m) return;
  // put it on the platform beside the visible parts so nothing overlaps
  const visible = s.parts.filter((p) => p.visible);
  let dx = 0;
  if (visible.length) {
    let maxX = -Infinity;
    for (const p of visible) maxX = Math.max(maxX, worldBounds(p).max.x);
    let minX = Infinity;
    for (let i = 0; i < m.positions.length; i += 3) minX = Math.min(minX, m.positions[i]);
    dx = maxX + 10 - minX;
  }
  const mesh = dx ? { positions: m.positions.map((v, i) => (i % 3 === 0 ? v + dx : v)), indices: m.indices } : m;
  const label = SHAPES.find((x) => x.value === params.kind)?.label ?? params.kind;
  const name = label.replace(/ \(.*\)| \/.*/, '');
  const color = nextColor();
  setPreview({
    tool: 'shapes',
    label: `New ${name.toLowerCase()}`,
    replaces: [],
    meshes: [{ name, mesh, color }],
    summary: [`${label}`, `Triangles: ${tris(mesh)}`, 'Placed on the platform beside the other parts; move it with Transform.'],
    apply: () => addWorldParts(`Add ${name.toLowerCase()}`, [{ name, mesh, color }]),
  });
}

// ---------------------------------------------------------------- lattice

export async function previewLattice() {
  const part = firstEditable();
  if (!part) return notify('warning', 'Select an unlocked part to lightweight');
  const params = getState().settings.lattice;
  const r = await runJob(`Lattice for ${part.name}`, 'lattice', { mesh: worldMesh(part), params });
  if (!r) return;
  const saved = r.before > 0 ? (1 - r.after / r.before) * 100 : 0;
  const type = LATTICES.find((l) => l.value === params.type)?.label ?? params.type;
  setPreview({
    tool: 'lattice',
    label: `${type} lattice`,
    xray: true,
    replaces: [part.id],
    meshes: [{ name: withSuffix(part.name, SUFFIX.lattice), mesh: r.mesh, color: part.color }],
    summary: [
      `${type}: cell ${mm(params.cell)}, walls ${mm(params.thickness)}, skin ${mm(params.skin)}`,
      `Volume: ${(r.before / 1000).toFixed(2)} → ${(r.after / 1000).toFixed(2)} cm³ (${saved.toFixed(0)}% lighter)`,
      `Voxel size: ${mm(r.voxelSize)}`,
      `Triangles: ${tris(r.mesh)}`,
      ...(params.skin > 0 ? ['The lattice is closed inside the skin: add drain holes (Hollow / Perforate) to get powder or resin out.'] : []),
    ],
    apply: () => replaceWithWorldMeshes(`${type} lattice`, part.id, [{ name: withSuffix(part.name, SUFFIX.lattice), mesh: r.mesh, color: part.color }]),
  });
}

// ---------------------------------------------------------------- shrinkwrap

export async function previewShrinkwrap() {
  const part = firstEditable();
  if (!part) return notify('warning', 'Select an unlocked part to wrap');
  const { keep, ...params } = getState().settings.wrap;
  const r = await runJob(`Shrinkwrapping ${part.name}`, 'shrinkwrap', { mesh: worldMesh(part), params });
  if (!r) return;
  const name = keep ? `${part.name} (wrap)` : part.name;
  const color = keep ? nextColor() : part.color;
  setPreview({
    tool: 'wrap',
    label: 'Shrinkwrap',
    replaces: keep ? [] : [part.id],
    meshes: [{ name, mesh: r.mesh, color }],
    summary: [
      `Gaps closed up to ${mm(params.gap)}, offset ${mm(params.offset)}`,
      `Voxel size: ${mm(r.voxelSize)} (detail finer than this is smoothed)`,
      `Triangles: ${tris(part.mesh)} → ${tris(r.mesh)}`,
      'Result: one watertight solid (inside filled).',
    ],
    apply: () =>
      keep ? addWorldParts('Shrinkwrap', [{ name, mesh: r.mesh, color }]) : replaceWithWorldMeshes('Shrinkwrap', part.id, [{ name, mesh: r.mesh, color }]),
  });
}

// ---------------------------------------------------------------- minimum box

/**
 * Turn the selected parts so their smallest-volume box lines up with X / Y / Z
 * (longest side along X, shortest along Z), each about its box centre.
 */
export async function previewMinBox(among?: Part[]) {
  const all = (among ?? selectedParts()).filter((p) => !p.locked);
  const parts = all.filter((p) => !p.lockRotation);
  if (!parts.length) return notify('warning', all.length ? 'The selected parts have their orientation locked' : 'Select the parts to orient');
  const moves: { part: Part; transform: Transform; mesh: MeshData; line: string }[] = [];
  for (const part of parts) {
    const r = await runJob(`Minimum box of ${part.name}`, 'minBox', { mesh: worldMesh(part) });
    if (!r) return;
    // rotation taking the box axes onto X, Y, Z, about the box centre
    const R = new Matrix4().makeBasis(new Vector3(...r.axes[0]), new Vector3(...r.axes[1]), new Vector3(...r.axes[2])).transpose();
    const c = new Vector3(...r.center);
    const M = new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(R).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    const q = new Quaternion().setFromRotationMatrix(R).multiply(quaternionOf(part.transform));
    const pos = new Vector3(...part.transform.position).applyMatrix4(M);
    const transform: Transform = { ...part.transform, position: [pos.x, pos.y, pos.z], rotation: eulerDegFromQuaternion(q) };
    const saved = r.aabbVolume > 0 ? (1 - r.volume / r.aabbVolume) * 100 : 0;
    moves.push({
      part,
      transform,
      mesh: applyMatrix(worldMesh(part), M.elements),
      line: `${part.name}: ${r.size.map((v) => v.toFixed(2)).join(' × ')} mm${saved > 0.5 ? ` (box ${saved.toFixed(0)}% smaller)` : ' (already at its smallest)'}`,
    });
  }
  setPreview({
    tool: 'dimensions',
    label: 'Orient to minimum box',
    replaces: moves.map((m) => m.part.id),
    meshes: moves.map((m) => ({ name: m.part.name, mesh: m.mesh, color: m.part.color })),
    summary: [...moves.map((m) => m.line), 'Longest side along X, shortest along Z; each part turns about its box centre.'],
    apply: () => {
      const byId = new Map(moves.map((m) => [m.part.id, m.transform]));
      updateParts('Orient to minimum box', [...byId.keys()], (p) => ({ ...p, transform: byId.get(p.id) ?? p.transform }));
    },
  });
}

// ---------------------------------------------------------------- VC module (vacuum casting moulds)

/** Parts the VC module works on: all visible unlocked parts, or the selected ones. */
export function vcParts(): Part[] {
  const s = getState();
  return (s.settings.vc.scope === 'all' ? s.parts.filter((p) => p.visible) : selectedParts()).filter((p) => !p.locked);
}

/**
 * A mould block around every part (clearance 20 / 30 / 50 mm by size, on all
 * six sides) with the part as its cavity, optionally split in two halves.
 */
export async function previewMoulds() {
  const parts = vcParts();
  if (!parts.length) return notify('warning', getState().settings.vc.scope === 'all' ? 'There are no parts' : 'Select the parts to make moulds for');
  const { split, keepOriginal, spread } = getState().settings.vc;
  // space the parts out first so their mould blocks (10 mm apart) do not overlap
  const shiftOf = new Map<string, Vec3>();
  if (spread && parts.length > 1) {
    const items = parts.map((p) => {
      const b = worldBounds(p);
      const size: Vec3 = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
      const c = mouldClearance(size);
      return { id: p.id, size: size.map((v) => v + 2 * c) as Vec3, from: [b.min.x - c, b.min.y - c, b.min.z - c] as Vec3 };
    });
    const { placements } = arrangeBoxes(items.map(({ id, size }) => ({ id, size })), ['x', 'y'], [Infinity, Infinity, Infinity], 10);
    // keep the group where the first part was
    const at = new Map(placements.map((pl) => [pl.id, pl.min]));
    const first = items[0], f = at.get(first.id)!;
    for (const it of items) {
      const m = at.get(it.id)!;
      shiftOf.set(it.id, [m[0] - f[0] + first.from[0] - it.from[0], m[1] - f[1] + first.from[1] - it.from[1], 0]);
    }
  }
  const moved = (part: Part): Part => {
    const d = shiftOf.get(part.id);
    if (!d || (!d[0] && !d[1])) return part;
    const p = part.transform.position;
    return { ...part, transform: { ...part.transform, position: [p[0] + d[0], p[1] + d[1], p[2] + d[2]] } };
  };
  const made: { part: Part; pieces: { name: string; mesh: MeshData; color: string }[]; line: string }[] = [];
  for (const part of parts.map(moved)) {
    const r = await runJob(`Mould for ${part.name}`, 'mould', { mesh: worldMesh(part), split });
    if (!r) return;
    const color = nextColor();
    const names = r.pieces.length === 2 ? ['mould_bottom', 'mould_top'] : ['mould'];
    made.push({
      part,
      pieces: r.pieces.map((mesh, i) => ({ name: `${part.name}_${names[i]}`, mesh, color })),
      line: `${part.name}: ${r.partSize.map((v) => v.toFixed(1)).join(' × ')} mm → clearance ${r.clearance} mm, mould ${r.mouldSize.map((v) => v.toFixed(1)).join(' × ')} mm`,
    });
  }
  const pieces = made.flatMap((m) => m.pieces);
  setPreview({
    tool: 'vc',
    label: `VC mould${made.length > 1 ? 's' : ''}`,
    xray: true,
    // moved master parts are shown at their new place in the preview
    replaces: keepOriginal ? made.filter((m) => shiftOf.has(m.part.id)).map((m) => m.part.id) : made.map((m) => m.part.id),
    meshes: [...(keepOriginal ? made.filter((m) => shiftOf.has(m.part.id)).map((m) => ({ name: m.part.name, mesh: worldMesh(m.part), color: m.part.color })) : []), ...pieces],
    summary: [
      ...made.map((m) => m.line),
      ...(shiftOf.size ? ['Parts spaced out so the mould blocks are 10 mm apart.'] : []),
      split ? 'Each mould is split in two halves at the part’s mid-height (parting plane).' : 'One mould block per part; the part is the cavity.',
      keepOriginal ? 'The master parts are kept.' : 'The master parts are replaced by their moulds.',
    ],
    apply: () => {
      const s = getState();
      const gone = keepOriginal ? new Set<string>() : new Set(made.map((m) => m.part.id));
      const created = pieces.map((p) => partFromWorld(p.name, p.mesh, p.color));
      const placed = new Map(made.map((m) => [m.part.id, m.part]));
      commit(`VC mould${made.length > 1 ? 's' : ''}`, [...s.parts.filter((p) => !gone.has(p.id)).map((p) => placed.get(p.id) ?? p), ...created], { selection: created.map((c) => c.id) });
    },
  });
}
