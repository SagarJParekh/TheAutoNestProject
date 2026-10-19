/**
 * Build Generation: parts are oriented (largest flat face down, optional
 * tilt), packed onto the chosen printer's platform and split into builds
 * (Build 1, Build 2, …) automatically whenever parts or settings change.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { pickSaveTarget, writeSaveTarget } from './save';
import { zipSync } from 'fflate';
import { applyMatrix, fitsPlatform, meshVolume, packBuilds, type MeshData, type PackItem, type Vec3 } from '../geometry';
import { commit, getState, notify, setState, startJob } from './store';
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

export function addBuildParts(items: { name: string; mesh: MeshData; color?: string; quantity?: number; lockRotation?: boolean }[]) {
  if (!items.length) return;
  const parts: BuildPart[] = items.map((it) => ({
    id: newId(),
    name: it.name,
    color: it.color ?? nextColor(),
    mesh: recenter(it.mesh).mesh,
    quantity: Math.max(1, Math.round(it.quantity ?? 1)),
    tilt: null,
    lockRotation: !!it.lockRotation,
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
  addBuildParts(src.map((p) => ({ name: p.name, mesh: worldMesh(p), color: p.color, lockRotation: p.lockRotation })));
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
  const before = bg();
  if (patch.printerId && printerById(patch.printerId).tech === 'powder' && printerById(before.printerId).tech !== 'powder' && !before.tilt.angle && !patch.tilt) {
    // powder bed: lay parts on their largest flat face, then tilt them 30°
    patch = { ...patch, tilt: { angle: 30, azimuth: 0 } };
  }
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

export async function regenerateBuilds(force = false) {
  const s0 = bg();
  if (!force && s0.manual && s0.builds.length) {
    // builds edited by hand: don't throw the edits away; the panel offers to re-arrange
    setBg({ stale: true });
    return;
  }
  const run = ++generation;
  if (!s0.parts.length) {
    setBg({ builds: [], unplaced: [], active: 0, busy: false });
    return;
  }
  setBg({ busy: true });
  const job = startJob('Generating builds');
  try {
    await generate(run, s0, job);
  } finally {
    job.end();
  }
}

async function generate(run: number, s0: BuildGenState, job: ReturnType<typeof startJob>) {
  // 1. "largest flat face down" orientation, cached per mesh
  const toOrient = s0.parts.filter((p) => s0.autoOrient && !p.lockRotation && !(p.orient && p.orient.mesh === p.mesh)).length;
  let oriented = 0;
  job.progress(0.05, toOrient ? `Orienting 0 / ${toOrient} parts` : 'Packing');
  const parts = await Promise.all(
    s0.parts.map(async (p) => {
      if (!s0.autoOrient || p.lockRotation || (p.orient && p.orient.mesh === p.mesh)) return p;
      const r = await runJob(`Orienting ${p.name}`, 'autoOrient', { mesh: p.mesh, quaternion: [0, 0, 0, 1], alignXY: true }, { silent: true });
      oriented++;
      job.progress(0.05 + 0.75 * (oriented / Math.max(1, toOrient)), `Orienting ${oriented} / ${toOrient} parts`);
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
  const powder = printer.tech === 'powder';
  // powder bed: build only up to the chosen height; parts keep the 3D clearance
  const volume: [number, number, number] = powder && s.maxHeight > 0 ? [printer.volume[0], printer.volume[1], Math.min(printer.volume[2], s.maxHeight)] : printer.volume;
  const gap = powder && s.nest3d ? Math.max(0.5, s.clearance3d) : s.gap;
  const fitParams = { volume, margin: s.margin, gap, zOffset: s.zOffset, allowRotate: s.allowRotate };
  const info = new Map<string, { q: Quaternion; min: Vector3; max: Vector3 }>();
  const items: PackItem[] = [];
  const autoTilts: Record<string, Tilt> = {};
  for (const p of parts) {
    if (p.lockRotation) {
      // locked orientation: exactly as it came from Mesh prep, only moved
      const q0 = new Quaternion();
      const b0 = rotatedBounds(p.mesh, q0);
      info.set(p.id, { q: q0, ...b0 });
      for (let c = 0; c < p.quantity; c++)
        items.push({ key: `${p.id}#${c}`, w: b0.max.x - b0.min.x, d: b0.max.y - b0.min.y, h: b0.max.z - b0.min.z, fixed: true });
      continue;
    }
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
  if (powder && s.nest3d) {
    // 3. powder bed: nest by the parts' shape anywhere in the volume (X, Y and Z)
    job.progress(0.82, 'Nesting in 3D');
    const nestParts = parts.map((p) => {
      const inf = info.get(p.id)!;
      const m = new Matrix4().makeRotationFromQuaternion(inf.q).elements;
      return { id: p.id, mesh: applyMatrix(p.mesh, m), count: p.quantity, fixed: !!p.lockRotation || !s.allowRotate };
    });
    const r = await runJob('Nesting in 3D', 'nest3d', {
      parts: nestParts,
      params: {
        volume,
        margin: s.margin,
        clearance: gap,
        zOffset: s.zOffset,
        maxHeight: 0,
        budget: { fast: 2.5e6, normal: 6e6, fine: 16e6 }[s.nestDetail ?? 'normal'],
        rotations: s.allowRotate,
        interlockFree: true,
      },
    });
    if (!r || run !== generation) return setBg({ busy: false });
    const builds: Build[] = r.builds.map((b, i) => ({
      name: `Build ${i + 1}`,
      height: b.height,
      utilization: b.utilization,
      placements: b.placements.map((pl): BuildPlacement => {
        const inf = info.get(pl.partId)!;
        const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (pl.turns * Math.PI) / 2).multiply(inf.q);
        return { key: pl.key, partId: pl.partId, copy: pl.copy, position: pl.t, quaternion: [q.x, q.y, q.z, q.w] };
      }),
    }));
    const unplaced = r.unplaced.map((u) => ({ partId: partOfKey(u.key), copy: Number(u.key.split('#')[1]), reason: u.reason }));
    setBg({ builds, unplaced, autoTilts, active: Math.min(s.active, Math.max(0, builds.length - 1)), busy: false, manual: false, stale: false, checks: null, nestVoxel: r.voxel });
    return;
  }
  job.progress(0.85, 'Packing builds');
  await new Promise((r) => setTimeout(r, 0)); // let the progress bar paint
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
  setBg({ builds, unplaced, autoTilts, active: Math.min(s.active, Math.max(0, builds.length - 1)), busy: false, manual: false, stale: false, checks: null });
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
      lockRotation: p.lockRotation,
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


/** Export one build (index) or every build ('all', zipped) as 3MF or STL, parts in their build positions. */
export async function exportBuilds(which: number | 'all', format: '3mf' | 'stl' = '3mf') {
  const s = bg();
  if (!s.builds.length) return notify('warning', 'There are no builds yet');
  const printer = currentPrinter(s);
  const safe = (t: string) => t.replace(/[^\w.-]+/g, '_');
  const indices = which === 'all' ? s.builds.map((_, i) => i) : [which];
  const fileName = (i: number) => `${safe(printer.name)}_${safe(s.builds[i].name)}.${format}`;
  // pick the location before the slow part (pickers only open straight after a click)
  const target = await pickSaveTarget(which === 'all' ? `${safe(printer.name)}_builds.zip` : fileName(which));
  if (!target) return;
  const files: Record<string, Uint8Array> = {};
  for (const i of indices) {
    const r = await runJob(`Exporting ${s.builds[i].name}`, 'export', { format, items: buildItems(s, i), zip: false });
    if (!r) return;
    files[fileName(i)] = r.bytes;
  }
  const where = await writeSaveTarget(target, (which === 'all' ? zipSync(files, { level: 0 }) : Object.values(files)[0]) as BlobPart);
  notify('success', `${which === 'all' ? `Exported ${indices.length} builds` : `Exported ${s.builds[which].name}`} to ${where}`);
}

/** Copy a build into the Prep workspace (parts at their build positions) for further editing. */
export function openBuildInPrep(i: number) {
  const s = bg();
  const b = s.builds[i];
  if (!b) return;
  const locked = new Set(s.parts.filter((p) => p.lockRotation).map((p) => p.id));
  const parts = buildDisplayParts(s, i).map((p) => ({
    ...makePart(p.name, p.mesh, p.transform.position as Vec3, undefined, p.color),
    transform: p.transform,
    lockRotation: locked.has(partOfKey(p.id)),
  }));
  setWorkspace('prep');
  commit(`Open ${b.name} in Prep`, [...getState().parts, ...parts], { selection: parts.map((p) => p.id) });
}

export type { Quat };

/** Mesh prep → Build generation: copy the selected (or all) parts and open the build unit. */
export function sendPartsToBuild() {
  const s = getState();
  if (!s.parts.some((p) => p.visible)) return notify('warning', 'There are no parts to send');
  addPartsFromPrep();
  setWorkspace('build');
}

// ---------------------------------------------------------------- selection and tilt of several parts

/** Ids of the build parts that are selected (a selection holds placement keys "partId#copy"). */
export function selectedBuildPartIds(selection = getState().selection): string[] {
  const ids = new Set(bg().parts.map((p) => p.id));
  return [...new Set(selection.map(partOfKey))].filter((id) => ids.has(id));
}

/** Click on a part (viewport or list): replace the selection, or with Ctrl / Shift toggle it. */
export function selectBuildPart(partId: string | null, toggle = false) {
  if (!partId) return toggle ? undefined : setState({ selection: [] });
  if ((getState().buildEdit ?? 'select') !== 'select') {
    // editing by hand: select the very copy that was clicked
    const cur = getState().selection;
    return setState({ selection: !toggle ? [partId] : cur.includes(partId) ? cur.filter((k) => k !== partId) : [...cur, partId] });
  }
  const key = `${partOfKey(partId)}#0`;
  const cur = selectedBuildPartIds();
  if (!toggle) return setState({ selection: [key] });
  const id = partOfKey(partId);
  setState({ selection: cur.includes(id) ? cur.filter((x) => x !== id).map((x) => `${x}#0`) : [...cur.map((x) => `${x}#0`), key] });
}

export function selectAllBuildParts() {
  setState({ selection: bg().parts.map((p) => `${p.id}#0`) });
}

/** Give several parts their own tilt (null = follow the tilt for all parts again). */
export function setTiltFor(ids: string[], tilt: Tilt | null) {
  const lockedIds = new Set(bg().parts.filter((p) => p.lockRotation).map((p) => p.id));
  if (tilt && ids.some((id) => lockedIds.has(id))) notify('info', 'Parts with a locked orientation are not tilted');
  ids = ids.filter((id) => !lockedIds.has(id));
  if (!ids.length) return;
  const set = new Set(ids);
  setBg({ parts: bg().parts.map((p) => (set.has(p.id) ? { ...p, tilt } : p)) });
  scheduleRegenerate();
}

/** Lock or unlock the orientation of build parts. */
export function setBuildRotationLock(ids: string[], lock: boolean) {
  const set = new Set(ids);
  setBg({ parts: bg().parts.map((p) => (set.has(p.id) ? { ...p, lockRotation: lock, tilt: lock ? null : p.tilt } : p)) });
  scheduleRegenerate();
}

// ---------------------------------------------------------------- packing density

const volCache = new WeakMap<MeshData, number>();
function partVolume(mesh: MeshData): number {
  let v = volCache.get(mesh);
  if (v === undefined) volCache.set(mesh, (v = Math.abs(meshVolume(mesh))));
  return v;
}

export interface BuildDensity {
  /** total volume of the parts on the build, mm³ */
  partsVolume: number;
  /** full printer build volume X × Y × Z, mm³ */
  fullVolume: number;
  /** parts volume / full build volume, 0..1 */
  full: number;
  /** height used for the reduced volume: tallest part + allowance, capped at the printer height, mm */
  usedHeight: number;
  /** X × Y × usedHeight, mm³ */
  usedVolume: number;
  /** parts volume / reduced volume, 0..1 */
  used: number;
}

/**
 * Packing density of a build: the parts' volume against the printer's whole
 * build volume, and against the volume up to the tallest part plus an
 * allowance (what the printer actually has to build through).
 */
export function buildDensity(i: number, s: BuildGenState = bg()): BuildDensity | null {
  const b = s.builds[i];
  if (!b) return null;
  const [X, Y, Z] = currentPrinter(s).volume;
  const byId = new Map(s.parts.map((p) => [p.id, p]));
  let partsVolume = 0;
  for (const pl of b.placements) {
    const p = byId.get(pl.partId);
    if (p) partsVolume += partVolume(p.mesh);
  }
  const fullVolume = X * Y * Z;
  const usedHeight = Math.min(Z, b.height + (s.densityAllowance ?? 5));
  const usedVolume = X * Y * usedHeight;
  return {
    partsVolume,
    fullVolume,
    full: fullVolume > 0 ? partsVolume / fullVolume : 0,
    usedHeight,
    usedVolume,
    used: usedVolume > 0 ? partsVolume / usedVolume : 0,
  };
}

/** Change the height allowance used for the packing density (no regeneration needed). */
export function setDensityAllowance(mm: number) {
  setState((st) => ({ buildGen: { ...st.buildGen, densityAllowance: Math.max(0, mm) } }));
}

// ---------------------------------------------------------------- manual editing and checks

/** Move / turn placed parts of the active build by hand (keys = placement keys). */
export function editPlacements(changes: { key: string; position?: Vec3; quaternion?: Quat }[]) {
  const s = bg();
  const b = s.builds[s.active];
  if (!b || !changes.length) return;
  const by = new Map(changes.map((c) => [c.key, c]));
  const placements = b.placements.map((pl) => {
    const c = by.get(pl.key);
    return c ? { ...pl, position: c.position ?? pl.position, quaternion: c.quaternion ?? pl.quaternion } : pl;
  });
  // new height of the build
  const byId = new Map(s.parts.map((p) => [p.id, p]));
  let height = 0;
  for (const pl of placements) {
    const p = byId.get(pl.partId);
    if (!p) continue;
    const m = new Matrix4().compose(new Vector3(...pl.position), new Quaternion(...pl.quaternion), new Vector3(1, 1, 1)).elements;
    const pos = p.mesh.positions;
    for (let i = 0; i < pos.length; i += 3) height = Math.max(height, m[2] * pos[i] + m[6] * pos[i + 1] + m[10] * pos[i + 2] + m[14]);
  }
  const builds = s.builds.map((x, i) => (i === s.active ? { ...x, placements, height } : x));
  setBg({ builds, manual: true, checks: null });
}

/** Throw away hand edits and arrange everything again with the current settings. */
export function rearrangeBuilds() {
  setBg({ manual: false, stale: false });
  void regenerateBuilds(true);
}

function activeItems(s: BuildGenState) {
  const b = s.builds[s.active];
  if (!b) return [];
  return buildItems(s, s.active).map((it, i) => ({ key: b.placements[i].key, mesh: it.mesh }));
}

/** Check the active build for parts that cross, sit inside each other or are closer than the clearance. */
export async function checkCollisions() {
  const s = bg();
  const items = activeItems(s);
  if (!items.length) return notify('warning', 'There is no build to check');
  const clearance = currentPrinter(s).tech === 'powder' && s.nest3d ? Math.max(0.5, s.clearance3d) : s.gap;
  const r = await runJob('Checking collisions', 'collisions', { items, clearance: Math.max(0, clearance - 0.01) });
  if (!r) return;
  setBg({ checks: { build: s.active, collisions: r, showOnly: r.length > 0 } });
  if (!r.length) notify('success', `${s.builds[s.active].name}: no collisions, every gap is at least ${clearance} mm`);
  else notify('warning', `${s.builds[s.active].name}: ${r.length} collision${r.length > 1 ? 's' : ''} found — showing only those parts`);
}

/** Test the active build for parts hooked into each other (can every part slide out, one after the other?). */
export async function checkInterlocking() {
  const s = bg();
  const items = activeItems(s);
  if (!items.length) return notify('warning', 'There is no build to test');
  const r = await runJob('Testing for interlocking', 'interlockTest', { items, volume: currentPrinter(s).volume });
  if (!r) return;
  setBg({ checks: { build: s.active, stuck: r.stuck, showOnly: r.stuck.length > 0 } });
  if (!r.stuck.length) notify('success', `${s.builds[s.active].name}: no interlocking — every part can be taken out`);
  else notify('warning', `${s.builds[s.active].name}: ${r.stuck.length} part${r.stuck.length > 1 ? 's are' : ' is'} interlocked — showing only those parts`);
}

export function clearChecks() {
  setBg({ checks: null });
}

export function setChecksShowOnly(showOnly: boolean) {
  const c = bg().checks;
  if (c) setBg({ checks: { ...c, showOnly } });
}
