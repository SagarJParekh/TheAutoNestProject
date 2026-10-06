/**
 * Offset (global / local), fillet and chamfer.
 */
import { Matrix4, Vector3 } from 'three';
import type { Vec3 } from '../geometry';
import { getState, notify, partById, selectedParts, setState } from './store';
import { matrixOf, worldMesh } from './math';
import { partFromWorld, replaceLocalMesh, replaceWithWorldMeshes, requestEdges, runJob, setPreview } from './actions';
import { commit } from './store';
import { nextColor } from './palette';
import { viewerApi } from '../viewer/api';
import type { PickInfo } from '../viewer/Viewer';
import type { BlendEdgePick } from './types';

const avgScale = (s: Vec3) => (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2])) / 3 || 1;

// ---------------------------------------------------------------- offset

export async function previewOffset() {
  const s = getState();
  const st = s.settings.offset;
  if (!st.distance) return notify('warning', 'Enter a non-zero distance');
  if (st.mode === 'local') return previewLocalOffset();
  const part = selectedParts().find((p) => !p.locked);
  if (!part) return notify('warning', 'Select an unlocked part');
  const r = await runJob(`Offset ${st.distance > 0 ? '+' : ''}${st.distance} mm`, 'offset', { mesh: worldMesh(part), distance: st.distance, voxelSize: st.voxel || undefined });
  if (!r) return;
  const name = `${part.name} (offset ${st.distance > 0 ? '+' : ''}${st.distance} mm)`;
  const color = st.asCopy ? nextColor() : part.color;
  setPreview({
    tool: 'offset',
    label: `Offset ${st.distance > 0 ? 'out' : 'in'} by ${Math.abs(st.distance)} mm`,
    replaces: st.asCopy ? [] : [part.id],
    meshes: [{ name, mesh: r.mesh, color }],
    summary: [
      `Triangles: ${(part.mesh.indices.length / 3).toLocaleString()} → ${(r.mesh.indices.length / 3).toLocaleString()}`,
      `Voxel size ${r.voxelSize.toFixed(3)} mm (smaller = more detail, slower)`,
      st.asCopy ? 'Added as a new part' : 'Replaces the part',
    ],
    apply: () => {
      if (st.asCopy) {
        const p = partFromWorld(name, r.mesh, color, part.source);
        commit('Offset (copy)', [...getState().parts, p], { selection: [p.id] });
      } else replaceWithWorldMeshes('Offset', part.id, [{ name: part.name, mesh: r.mesh, color: part.color }]);
    },
  });
}

async function previewLocalOffset() {
  const s = getState();
  const st = s.settings.offset;
  const pick = s.facePicks.offset;
  const part = pick && partById(pick.partId);
  if (!pick || !part || part.mesh !== pick.mesh) return notify('warning', 'Pick the face to offset first');
  if (part.locked) return notify('warning', `${part.name} is locked`);
  const d = st.distance / avgScale(part.transform.scale);
  const r = await runJob('Offsetting face', 'offsetRegion', { mesh: part.mesh, tris: pick.tris, distance: d });
  if (!r) return;
  setPreview({
    tool: 'offset',
    label: `Offset face ${st.distance > 0 ? 'out' : 'in'} by ${Math.abs(st.distance)} mm`,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: worldMesh({ ...part, mesh: r }), color: part.color }],
    summary: [`${pick.tris.length.toLocaleString()} triangles moved along their normals`, 'Side walls connect the face to the rest of the part'],
    apply: () => {
      replaceLocalMesh('Offset face', part.id, r);
      setState((x) => {
        const f = { ...x.facePicks };
        delete f.offset;
        return { facePicks: f };
      });
    },
  });
}

// ---------------------------------------------------------------- fillet / chamfer

export function startSharpEdgePick() {
  const s = getState();
  const part = selectedParts().find((p) => !p.locked);
  if (!part && s.pickMode !== 'sharpEdge') return notify('warning', 'Select the part first');
  if (part) requestEdges(part.mesh);
  setState({ pickMode: s.pickMode === 'sharpEdge' ? null : 'sharpEdge', preview: null });
}

/** Click near a sharp edge: add it to (or remove it from) the edge list. */
export function onSharpEdgePick(info: PickInfo) {
  const part = partById(info.partId);
  const viewer = viewerApi.current?.viewer;
  if (!part || !viewer) return;
  requestEdges(part.mesh);
  const seg = viewer.snapEdge(part.id, info.faceIndex, info.point, info.clientX, info.clientY, 18);
  if (!seg) return;
  const inv = new Matrix4().copy(matrixOf(part.transform)).invert();
  const toLocal = (v: Vec3): Vec3 => {
    const q = new Vector3(...v).applyMatrix4(inv);
    return [q.x, q.y, q.z];
  };
  const a = toLocal(seg[0]), b = toLocal(seg[1]);
  const s = getState();
  // only one part at a time; picks on an old mesh are dropped
  const keep = s.blendEdges.filter((e) => e.partId === part.id && e.mesh === part.mesh);
  const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
  const i = keep.findIndex((e) => (near(e.a, a) && near(e.b, b)) || (near(e.a, b) && near(e.b, a)));
  const next: BlendEdgePick[] = i >= 0 ? keep.filter((_, j) => j !== i) : [...keep, { partId: part.id, mesh: part.mesh, a, b }];
  setState({ blendEdges: next, selection: [part.id], preview: null });
}

export function clearBlendEdges() {
  setState({ blendEdges: [], preview: null });
}

export function liveBlendEdges(): BlendEdgePick[] {
  const s = getState();
  return s.blendEdges.filter((e) => {
    const p = partById(e.partId);
    return p && p.mesh === e.mesh;
  });
}

export async function previewBlend() {
  const s = getState();
  const st = s.settings.blend;
  const picks = liveBlendEdges();
  if (!picks.length) return notify('warning', 'Pick the edges to round or bevel first');
  const part = partById(picks[0].partId)!;
  if (part.locked) return notify('warning', `${part.name} is locked`);
  const m = matrixOf(part.transform);
  const toWorld = (v: Vec3): Vec3 => {
    const q = new Vector3(...v).applyMatrix4(m);
    return [q.x, q.y, q.z];
  };
  const r = await runJob(st.kind === 'fillet' ? 'Fillet' : 'Chamfer', 'blend', {
    mesh: worldMesh(part),
    edges: picks.map((e) => [toWorld(e.a), toWorld(e.b)] as [Vec3, Vec3]),
    kind: st.kind,
    size: st.size,
  });
  if (!r) return;
  const convex = r.edges.filter((e) => e.convex).length;
  const label = `${st.kind === 'fillet' ? 'Fillet R' : 'Chamfer '}${st.size} mm on ${r.edges.length} edge${r.edges.length > 1 ? 's' : ''}`;
  setPreview({
    tool: 'offset',
    label,
    replaces: [part.id],
    meshes: [{ name: part.name, mesh: r.mesh, color: part.color }],
    summary: [
      `${convex} outside edge${convex === 1 ? '' : 's'} (material removed), ${r.edges.length - convex} inside edge${r.edges.length - convex === 1 ? '' : 's'} (material added)`,
      ...r.edges.slice(0, 6).map((e, i) => `Edge ${i + 1}: ${Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1], e.p1[2] - e.p0[2]).toFixed(2)} mm long, ${e.angle.toFixed(0)}° corner`),
    ],
    apply: () => {
      replaceWithWorldMeshes(label, part.id, [{ name: part.name, mesh: r.mesh, color: part.color }]);
      setState({ blendEdges: [] });
    },
  });
}
