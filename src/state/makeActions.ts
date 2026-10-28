/**
 * Creating and lightweighting parts: basic shapes, lattice infill and
 * shrinkwrap. Each one shows a preview first; Apply makes it one undo step.
 */
import type { MeshData } from '../geometry';
import { LATTICES } from '../geometry/lattice';
import { SHAPES } from '../geometry/shapes';
import { commit, getState, notify, selectedParts } from './store';
import { worldBounds, worldMesh } from './math';
import { partFromWorld, replaceWithWorldMeshes, runJob, setPreview } from './actions';
import { nextColor } from './palette';

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
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: r.mesh, color: part.color }],
    summary: [
      `${type}: cell ${mm(params.cell)}, walls ${mm(params.thickness)}, skin ${mm(params.skin)}`,
      `Volume: ${(r.before / 1000).toFixed(2)} → ${(r.after / 1000).toFixed(2)} cm³ (${saved.toFixed(0)}% lighter)`,
      `Voxel size: ${mm(r.voxelSize)}`,
      `Triangles: ${tris(r.mesh)}`,
      ...(params.skin > 0 ? ['The lattice is closed inside the skin: add drain holes (Hollow / Perforate) to get powder or resin out.'] : []),
    ],
    apply: () => replaceWithWorldMeshes(`${type} lattice`, part.id, [{ name: part.name, mesh: r.mesh, color: part.color }]),
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
