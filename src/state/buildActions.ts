/**
 * Build Generation: parts are oriented (largest flat face down, optional
 * tilt), packed onto the chosen printer's platform and split into builds
 * (Build 1, Build 2, …) automatically whenever parts or settings change.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { zipSync } from 'fflate';
import { applyMatrix, fitsPlatform, packBuilds, type MeshData, type PackItem, type Vec3 } from '../geometry';
import { commit, getState, notify, setState } from './store';
import { recenter, worldMesh } from './math';
import { makePart, newId, runJob } from './actions';
import { nextColor } from './palette';
import { printerById, type Printer } from './printers';
import type { Build, BuildGenState, BuildPart, BuildPlacement, Part, Tilt } from './types';
import { eulerDegFromQuaternion } from './math';

type Quat = [number, number, number, number];

const bg = () => getState().buildGen;
const setBg = (patch: Partial<BuildGenState>) => setState((s) => ({ buildGen: { ...s.buildGen, ...patch } }));

export function setWorkspace(workspace: 'prep' | 'build') {
  setState({ workspace, selection: [], pickMode: null, preview: null });
}

/** The printer in use, with the custom size applied for Custom printers. */
export function currentPrinter(s: BuildGenState = bg()): Printer {
  const p = printerById(s.printerId);
  return p.custom ? { ...p, volume: s.customVolumes[p.id] ?? p.volume } : p;
}

// ---------------------------------------------------------------- parts

export function addBuildParts(items: { name: string; mesh: MeshData; color?: string; quantity?: number }[]) {
  if (!items.length) return;
  const parts: BuildPart[] = items.map((it) => ({
    id: newId(),
    name: it.name,
    color: it.color ?? nextColor(),
    mesh: recenter(it.mesh).mesh,
    quantity: Math.max(1, Math.round(it.quantity ?? 1)),
    tilt: null,
  }));
  setBg({ parts: [...bg().parts, ...parts] });
  scheduleRegenerate();
}

/** Copy parts from the Prep workspace (selected ones, or all) as they are placed there. */
export function addPartsFromPrep() {
  const s = getState();
  const sel = s.parts.filter((p) => s.selection.includes(p.id));
  const src = (sel.length ? sel : s.parts).filter((p) => p.visible);
  if (!src.length) return notify('warning', 'There are no parts in the Prep workspace yet');
  addBuildParts(src.map((p) => ({ name: p.name, mesh: worldMesh(p), color: p.color })));
  notify('success', `Added ${src.length} part${src.length > 1 ? 's' : ''} from Prep`);
}

export function removeBuildPart(id: string) {
  setBg({ parts: bg().parts.filter((p) => p.id !== id) });
  setState((s) => ({ selection: s.selection.filter((k) => !k.startsWith(id + '#')) }));
  scheduleRegenerate();
}

export function clearBuildParts() {
  setBg({ parts: [], builds: [], unplaced: [], active: 0 });
  setState({ selection: [] });
}

export function setPartQuantity(id: string, quantity: number) {
  setBg({ parts: bg().parts.map((p) => (p.id === id ? { ...p, quantity: Math.max(1, Math.min(999, Math.round(quantity || 1))) } : p)) });
  scheduleRegenerate();
}

/** Tilt one part (null = follow the global tilt). */
export function setPartTilt(id: string, tilt: Tilt | null) {
  setBg({ parts: bg().parts.map((p) => (p.id === id ? { ...p, tilt } : p)) });
  scheduleRegenerate();
}

export function updateBuildSettings(patch: Partial<BuildGenState>) {
  setBg(patch);
  scheduleRegenerate();
}

export function setActiveBuild(i: number) {
  setBg({ active: i });
  setState({ selection: [] });
}

/** Part id of a placement key (or of a selected key). */
export const partOfKey = (key: string) => key.split('#')[0];

// ---------------------------------------------------------------- generation

let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

export function scheduleRegenerate(delay = 150) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void regenerateBuilds();
  }, delay);
}

export function tiltQuaternion(t: Tilt): Quaternion {
  const turn = t.turn ? new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (t.turn * Math.PI) / 180) : new Quaternion();
  if (!t.angle) return turn;
  const a = (t.azimuth * Math.PI) / 180;
  // lean the top towards the azimuth direction: rotate about the horizontal axis perpendicular to it
  const axis = new Vector3(-Math.sin(a), Math.cos(a), 0);
  return turn.multiply(new Quaternion().setFromAxisAngle(axis, (t.angle * Math.PI) / 180));
}

/** Axis-aligned bounds of a mesh rotated by q (about its own origin). */
function rotatedBounds(mesh: MeshData, q: Quaternion): { min: Vector3; max: Vector3 } {
  const m = new Matrix4().makeRotationFromQuaternion(q).elements;
  const p = mesh.positions;
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z, wy = m[1] * x + m[5] * y + m[9] * z, wz = m[2] * x + m[6] * y + m[10] * z;
    if (wx < min.x) min.x = wx;
    if (wy < min.y) min.y = wy;
    if (wz < min.z) min.z = wz;
    if (wx > max.x) max.x = wx;
    if (wy > max.y) max.y = wy;
    if (wz > max.z) max.z = wz;
  }
  return { min, max };
}

const AUTO_TILT_ANGLES = [15, 30, 45, 60, 75, 90];
const AUTO_TILT_DIRECTIONS = [0, 90, 180, 270, 45, 135, 225, 315];

/**
 * Make a part fit the printer: first try turning it flat on the platform (15°
 * steps, e.g. corner to corner), then the smallest tilt (15° steps, 8
 * directions); among fitting directions at that angle the lowest one wins.
 */
export function findFittingTilt(
  mesh: MeshData,
  base: Quaternion,
  fit: Parameters<typeof fitsPlatform>[3],
): { tilt: Tilt; q: Quaternion; bounds: { min: Vector3; max: Vector3 } } | null {
  for (let turn = 15; turn < 90; turn += 15) {
    const tilt = { angle: 0, azimuth: 0, turn };
    const q = tiltQuaternion(tilt).multiply(base);
    const b = rotatedBounds(mesh, q);
    if (fitsPlatform(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, fit)) return { tilt, q, bounds: b };
  }
  for (const angle of AUTO_TILT_ANGLES) {
    let best: { tilt: Tilt; q: Quaternion; bounds: { min: Vector3; max: Vector3 }; h: number } | null = null;
    for (const azimuth of AUTO_TILT_DIRECTIONS) {
      const tilt = { angle, azimuth };
      const q = tiltQuaternion(tilt).multiply(base);
      const b = rotatedBounds(mesh, q);
      const w = b.max.x - b.min.x, d = b.max.y - b.min.y, h = b.max.z - b.min.z;
      if (fitsPlatform(w, d, h, fit) && (!best || h < best.h - 1e-6)) best = { tilt, q, bounds: b, h };
    }
    if (best) return best;
  }
  return null;
}

export async function regenerateBuilds() {
  const run = ++generation;
  const s0 = bg();
  if (!s0.parts.length) {
    setBg({ builds: [], unplaced: [], active: 0, busy: false });
    return;
  }
  setBg({ busy: true });
  // 1. "largest flat face down" orientation, cached per mesh
  const parts = await Promise.all(
    s0.parts.map(async (p) => {
      if (!s0.autoOrient || (p.orient && p.orient.mesh === p.mesh)) return p;
      const r = await runJob(`Orienting ${p.name}`, 'autoOrient', { mesh: p.mesh, quaternion: [0, 0, 0, 1], alignXY: true }, { silent: true });
      return r ? { ...p, orient: { mesh: p.mesh, q: r.quaternion } } : p;
    }),
  );
  if (run !== generation) return;
  // keep the cached orientations (without overwriting edits made meanwhile)
  setState((s) => ({
    buildGen: { ...s.buildGen, parts: s.buildGen.parts.map((p) => parts.find((q) => q.id === p.id && q.mesh === p.mesh) ?? p) },
  }));
  const s = bg();
  // 2. final rotation and box size of each part; parts that are too tall or too big get tilted automatically
  const printer = currentPrinter(s);
  const fitParams = { volume: printer.volume, margin: s.margin, gap: s.gap, zOffset: s.zOffset, allowRotate: s.allowRotate };
  const info = new Map<string, { q: Quaternion; min: Vector3; max: Vector3 }>();
  const items: PackItem[] = [];
  const autoTilts: Record<string, Tilt> = {};
  for (const p of parts) {
    const base = s.autoOrient && p.orient ? new Quaternion(...p.orient.q) : new Quaternion();
    let q = tiltQuaternion(p.tilt ?? s.tilt).multiply(base);
    let b = rotatedBounds(p.mesh, q);
    if (s.autoTilt && !fitsPlatform(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, fitParams)) {
      const found = findFittingTilt(p.mesh, base, fitParams);
      if (found) {
        q = found.q;
        b = found.bounds;
        autoTilts[p.id] = found.tilt;
      }
    }
    info.set(p.id, { q, ...b });
    for (let c = 0; c < p.quantity; c++) items.push({ key: `${p.id}#${c}`, w: b.max.x - b.min.x, d: b.max.y - b.min.y, h: b.max.z - b.min.z });
  }
  // 3. pack: fill each build completely before starting the next
  const result = packBuilds(items, { ...fitParams, stack: printer.tech === 'powder' && s.stack });
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  const builds: Build[] = result.builds.map((b, i) => ({
    name: `Build ${i + 1}`,
    height: b.height,
    utilization: b.utilization,
    placements: b.items.map((it): BuildPlacement => {
      const partId = partOfKey(it.key);
      const inf = info.get(partId)!;
      let q = inf.q, min = inf.min;
      if (it.rotated) {
        // 90° about Z: (x, y) -> (-y, x)
        q = turn.clone().multiply(inf.q);
        min = new Vector3(-inf.max.y, inf.min.x, inf.min.z);
      }
      return {
        key: it.key,
        partId,
        copy: Number(it.key.split('#')[1]),
        position: [it.x - min.x, it.y - min.y, it.z - min.z],
        quaternion: [q.x, q.y, q.z, q.w],
      };
    }),
  }));
  const unplaced = result.unplaced.map((u) => ({ partId: partOfKey(u.key), copy: Number(u.key.split('#')[1]), reason: u.reason }));
  setBg({ builds, unplaced, autoTilts, active: Math.min(s.active, Math.max(0, builds.length - 1)), busy: false });
}

// ---------------------------------------------------------------- display / export

/** Parts placed in a build, as regular parts (shared meshes) for the viewer and exports. */
export function buildDisplayParts(s: BuildGenState, buildIndex = s.active): Part[] {
  const b = s.builds[buildIndex];
  if (!b) return [];
  const byId = new Map(s.parts.map((p) => [p.id, p]));
  const out: Part[] = [];
  for (const pl of b.placements) {
    const p = byId.get(pl.partId);
    if (!p) continue;
    out.push({
      id: pl.key,
      name: p.quantity > 1 ? `${p.name} (${pl.copy + 1})` : p.name,
      color: p.color,
      visible: true,
      locked: false,
      mesh: p.mesh,
      transform: { position: pl.position, rotation: eulerDegFromQuaternion(new Quaternion(...pl.quaternion)), scale: [1, 1, 1] },
    });
  }
  return out;
}

function placedWorldMesh(mesh: MeshData, pl: BuildPlacement): MeshData {
  const m = new Matrix4().compose(new Vector3(...pl.position), new Quaternion(...pl.quaternion), new Vector3(1, 1, 1));
  return applyMatrix(mesh, m.elements);
}

function buildItems(s: BuildGenState, i: number) {
  const byId = new Map(s.parts.map((p) => [p.id, p]));
  return s.builds[i].placements.flatMap((pl) => {
    const p = byId.get(pl.partId);
    return p ? [{ name: p.quantity > 1 ? `${p.name}_${pl.copy + 1}` : p.name, mesh: placedWorldMesh(p.mesh, pl) }] : [];
  });
}

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Export one build (index) or every build ('all', zipped) as 3MF or STL, parts in their build positions. */
export async function exportBuilds(which: number | 'all', format: '3mf' | 'stl' = '3mf') {
  const s = bg();
  if (!s.builds.length) return notify('warning', 'There are no builds yet');
  const printer = currentPrinter(s);
  const safe = (t: string) => t.replace(/[^\w.-]+/g, '_');
  const indices = which === 'all' ? s.builds.map((_, i) => i) : [which];
  const files: Record<string, Uint8Array> = {};
  for (const i of indices) {
    const r = await runJob(`Exporting ${s.builds[i].name}`, 'export', { format, items: buildItems(s, i), zip: false });
    if (!r) return;
    files[`${safe(printer.name)}_${safe(s.builds[i].name)}.${format}`] = r.bytes;
  }
  if (which === 'all') download(zipSync(files, { level: 0 }), `${safe(printer.name)}_builds.zip`);
  else download(Object.values(files)[0], Object.keys(files)[0]);
  notify('success', which === 'all' ? `Exported ${indices.length} builds` : `Exported ${s.builds[which].name}`);
}

/** Copy a build into the Prep workspace (parts at their build positions) for further editing. */
export function openBuildInPrep(i: number) {
  const s = bg();
  const b = s.builds[i];
  if (!b) return;
  const parts = buildDisplayParts(s, i).map((p) => ({ ...makePart(p.name, p.mesh, p.transform.position as Vec3, undefined, p.color), transform: p.transform }));
  setWorkspace('prep');
  commit(`Open ${b.name} in Prep`, [...getState().parts, ...parts], { selection: parts.map((p) => p.id) });
}

export type { Quat };
