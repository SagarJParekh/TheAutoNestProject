/**
 * Build Generation: parts are oriented (largest flat face down, optional
 * tilt), packed onto the chosen printer's platform and split into builds
 * (Build 1, Build 2, …) automatically whenever parts or settings change.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { pickSaveTarget, writeSaveTarget } from './save';
import { zipSync } from 'fflate';
import { applyMatrix, chooseNestVoxel, computeBounds, mergeMeshes, turnPositions, type CageOptions, lockAlign, fitsPlatform, meshVolume, nestPlan, packBuilds, pickNest, compareNestResults, type NestPart, type NestParams, type NestPhase, type NestResult, type NestVariant, type NestVoxels, type MeshData, type PackItem, type Vec3 } from '../geometry';
import { commit, commitBuild, getState, notify, setBuildRestoreHook, setState, startJob } from './store';
import { recenter, worldMesh } from './math';
import { makePart, newId, prepareMesh, runJob, setTool } from './actions';
import { meshEntry } from './meshCache';
import { pool, CancelledError } from '../workers/client';
import { viewerApi } from '../viewer/api';
import { nextColor } from './palette';
import { printerById, type Printer } from './printers';
import type { Build, BuildGenState, BuildPart, BuildPlacement, CopyLock, Part, Tilt } from './types';
import { eulerDegFromQuaternion } from './math';

type Quat = [number, number, number, number];

const bg = () => getState().buildGen;
const setBg = (patch: Partial<BuildGenState>) => setState((s) => ({ buildGen: { ...s.buildGen, ...patch } }));

export function setWorkspace(workspace: 'prep' | 'build') {
  const was = getState().workspace;
  setState({ workspace, selection: [], pickMode: null, preview: null });
  if (workspace === 'build' && was !== 'build') fitBuildView();
}

/** Frame the printer volume and the parts in it (after the view has updated). */
export function fitBuildView() {
  setTimeout(() => {
    if (getState().workspace === 'build') viewerApi.current?.fitView();
  }, 50);
}

/** The printer in use, with the custom size applied for Custom printers. */
export function currentPrinter(s: BuildGenState = bg()): Printer {
  const p = printerById(s.printerId);
  return p.custom ? { ...p, volume: s.customVolumes[p.id] ?? p.volume } : p;
}

// ---------------------------------------------------------------- parts

type NewBuildPart = { name: string; mesh: MeshData; color?: string; quantity?: number; lockRotation?: boolean; watertight?: boolean; fromPrep?: string };

function newBuildPart(it: NewBuildPart): BuildPart {
  return {
    id: newId(),
    name: it.name,
    color: it.color ?? nextColor(),
    mesh: recenter(it.mesh).mesh,
    quantity: Math.max(1, Math.round(it.quantity ?? 1)),
    tilt: null,
    lockRotation: !!it.lockRotation,
    watertight: it.watertight,
    fromPrep: it.fromPrep,
  };
}

export function addBuildParts(items: NewBuildPart[]) {
  if (!items.length) return;
  const parts = items.map(newBuildPart);
  commitBuild(parts.length > 1 ? `Add ${parts.length} parts` : `Add ${parts[0].name}`, { parts: [...bg().parts, ...parts] });
  checkWatertight(parts);
  scheduleRegenerate();
}

/** Check in the background whether build parts are watertight (parts whose answer is not known yet). */
function checkWatertight(parts: BuildPart[]) {
  for (const p of parts) {
    if (p.watertight !== undefined) continue;
    void runJob(`Checking ${p.name}`, 'watertight', { mesh: p.mesh }, { silent: true, quietErrors: true }).then((w) => {
      if (w === null) return;
      // not an undo step: it only describes the mesh
      setBg({ parts: bg().parts.map((q) => (q.id === p.id && q.mesh === p.mesh ? { ...q, watertight: w } : q)) });
    });
  }
}

/**
 * Copy parts from the Prep workspace (selected ones, or all) as they are
 * placed there. A part that was sent before (or came from Build for a
 * repair) replaces its build part's mesh; quantity and settings are kept.
 */
export function addPartsFromPrep() {
  const s = getState();
  const sel = s.parts.filter((p) => s.selection.includes(p.id));
  const src = (sel.length ? sel : s.parts).filter((p) => p.visible);
  if (!src.length) return notify('warning', 'There are no parts in the Prep workspace yet');
  const items = src.map((p) => ({ name: p.name, mesh: worldMesh(p), color: p.color, lockRotation: p.lockRotation, watertight: meshEntry(p.mesh).watertight, fromPrep: p.id }));
  const linked = new Map(bg().parts.filter((b) => b.fromPrep).map((b) => [b.fromPrep!, b]));
  const updated: BuildPart[] = [];
  const added: BuildPart[] = [];
  const parts = bg().parts.slice();
  for (const it of items) {
    const old = linked.get(it.fromPrep);
    if (old) {
      const fresh = { ...newBuildPart(it), id: old.id, color: old.color, quantity: old.quantity, tilt: old.tilt, group: old.group, lockRotation: old.lockRotation };
      parts[parts.indexOf(old)] = fresh;
      updated.push(fresh);
    } else {
      const p = newBuildPart(it);
      parts.push(p);
      added.push(p);
    }
  }
  commitBuild(updated.length ? `Update ${updated.length + added.length} parts from Prep` : `Add ${added.length} parts`, { parts });
  checkWatertight([...updated, ...added]);
  scheduleRegenerate();
  const msg = [added.length && `added ${added.length}`, updated.length && `updated ${updated.length} (quantities kept)`].filter(Boolean).join(', ');
  notify('success', `Parts from Prep: ${msg}`);
}

/**
 * Open build parts in Mesh prep for repairing: their Prep originals are
 * selected (or copies are made there), with the Repair tool open. Sending
 * them back to Build replaces the build parts' meshes.
 */
export function repairBuildPartsInPrep(ids: string[]) {
  const s = getState();
  const targets = bg().parts.filter((p) => ids.includes(p.id));
  if (!targets.length) return;
  const prepIds = new Set(s.parts.map((p) => p.id));
  const created: Part[] = [];
  const links = new Map<string, string>();
  for (const b of targets) {
    if (b.fromPrep && prepIds.has(b.fromPrep)) continue;
    const box = computeBounds(b.mesh.positions);
    const part = makePart(b.name, b.mesh, [0, 0, -box.min[2]], undefined, b.color);
    created.push(part);
    links.set(b.id, part.id);
  }
  if (created.length) {
    commit(`Bring ${created.length} part${created.length > 1 ? 's' : ''} from Build`, [...s.parts, ...created]);
    setBg({ parts: bg().parts.map((p) => (links.has(p.id) ? { ...p, fromPrep: links.get(p.id) } : p)) });
  }
  const sel = targets.map((b) => links.get(b.id) ?? b.fromPrep!);
  setWorkspace('prep');
  setTool('repair');
  setState({ selection: sel });
  notify('info', `Repair ${sel.length > 1 ? 'these parts' : 'this part'}, then press Send to Build: the build parts are updated, their quantities kept`);
}

export function removeBuildPart(id: string) {
  commitBuild(`Remove ${bg().parts.find((p) => p.id === id)?.name ?? 'part'}`, { parts: bg().parts.filter((p) => p.id !== id) });
  setState((s) => ({ selection: s.selection.filter((k) => !k.startsWith(id + '#')) }));
  scheduleRegenerate();
}

export function clearBuildParts() {
  commitBuild('Clear parts', { parts: [], builds: [], unplaced: [], active: 0 });
  setState({ selection: [] });
}

export function setPartQuantity(id: string, quantity: number) {
  commitBuild('Quantity', { parts: bg().parts.map((p) => (p.id === id ? { ...p, quantity: Math.max(1, Math.min(999, Math.round(quantity || 1))) } : p)) });
  scheduleRegenerate();
}

/** Tilt one part (null = follow the global tilt). */
export function setPartTilt(id: string, tilt: Tilt | null) {
  commitBuild('Tilt', { parts: bg().parts.map((p) => (p.id === id ? { ...p, tilt } : p)) });
  scheduleRegenerate();
}

export function updateBuildSettings(patch: Partial<BuildGenState>) {
  const before = bg();
  if (patch.printerId && printerById(patch.printerId).tech === 'powder' && printerById(before.printerId).tech !== 'powder' && before.tilt.angle === 30 && !patch.tilt) {
    // powder bed: the SLS / MJF orientation rules replace the old "flat face down + 30°" default
    patch = { ...patch, tilt: { angle: 0, azimuth: 0 } };
  }
  commitBuild('Build settings', patch);
  // switching automatic nesting off changes nothing to arrange
  if (Object.keys(patch).length === 1 && patch.autoNest === false) return;
  scheduleRegenerate();
}

export function setActiveBuild(i: number) {
  setBg({ active: i });
  setState({ selection: [] });
}

/** Part id of a placement key (or of a selected key). */
export const partOfKey = (key: string) => key.split('#')[0];

// ---------------------------------------------------------------- light display copies

/** triangles the view should draw for a whole build at most (more makes graphics cards give up) */
const VIEW_TRIANGLE_BUDGET = 6e6;

/**
 * When the parts × quantities come to more triangles than the view can draw
 * smoothly, heavy parts get a lighter display copy (made in a worker).
 */
let displayRun = 0;
export async function updateDisplayMeshes() {
  const run = ++displayRun;
  const parts = bg().parts;
  const tris = (p: BuildPart) => p.mesh.indices.length / 3;
  const total = parts.reduce((a, p) => a + tris(p) * p.quantity, 0);
  const f = total > VIEW_TRIANGLE_BUDGET ? VIEW_TRIANGLE_BUDGET / total : 1;
  await Promise.all(
    parts.map(async (p) => {
      const want = f < 1 && tris(p) > 40000 ? Math.max(20000, Math.round(tris(p) * f)) : 0;
      if (!want) {
        // full detail in the view: give it a picking tree like Prep parts have
        prepareMesh(p.mesh);
        if (p.display) setBg({ parts: bg().parts.map((q) => (q.id === p.id ? { ...q, display: undefined } : q)) });
        return;
      }
      if (p.display?.for === p.mesh && Math.abs(p.display.tris - want) / want < 0.3) return;
      const mesh = await runJob(`Preparing the view of ${p.name}`, 'displayMesh', { mesh: p.mesh, tris: want }, { silent: true, quietErrors: true });
      if (!mesh || run !== displayRun) return;
      prepareMesh(mesh);
      // not an undo step: it only changes how the part is drawn
      setBg({ parts: bg().parts.map((q) => (q.id === p.id && q.mesh === p.mesh ? { ...q, display: { for: p.mesh, tris: want, mesh } } : q)) });
    }),
  );
}

// ---------------------------------------------------------------- generation

let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
// undo / redo in Build generation: a nesting still running would overwrite the restored state
setBuildRestoreHook(() => {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
});

export function scheduleRegenerate(delay = 150) {
  void updateDisplayMeshes();
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
  if (!force && s0.parts.length && (s0.manual || !s0.autoNest)) {
    // builds edited by hand, or nesting only on request: keep the builds (minus removed parts and copies)
    // and let the panel offer Start nesting / Re-arrange
    const qty = new Map(s0.parts.map((p) => [p.id, p.quantity]));
    const kept = s0.builds
      .filter((b) => !b.preview)
      .map((b) => ({ ...b, placements: b.placements.filter((pl) => pl.copy < (qty.get(pl.partId) ?? 0)) }))
      .filter((b) => b.placements.length);
    const unplaced = s0.unplaced.filter((u) => u.copy < (qty.get(u.partId) ?? 0));
    // copies not in a nested build yet are shown in a quick layout (not nested)
    const placed = new Set([...kept.flatMap((b) => b.placements.map((pl) => pl.key)), ...unplaced.map((u) => `${u.partId}#${u.copy}`)]);
    const missing = s0.parts.flatMap((p) => Array.from({ length: p.quantity }, (_, c) => c).filter((c) => !placed.has(`${p.id}#${c}`)).map((c) => ({ part: p, copy: c })));
    const builds = [...kept, ...previewBuilds(missing, s0)].map((b, i) => ({ ...b, name: b.preview ? `Build ${i + 1} (not nested)` : `Build ${i + 1}` }));
    const wasEmpty = !s0.builds.length;
    setBg({ stale: true, builds, unplaced, active: Math.min(s0.active, Math.max(0, builds.length - 1)) });
    if (wasEmpty && builds.length) fitBuildView();
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
  } catch (e) {
    // never leave the builds 'busy' with nothing running
    notify('error', `Generating builds failed: ${(e as Error).message}`);
    setState((st) => ({ nestLog: [...st.nestLog, `Generating builds failed: ${(e as Error).message}`] }));
  } finally {
    job.end();
    if (run === generation && bg().busy) setBg({ busy: false, improving: null });
  }
}

/**
 * A quick look at parts that are not nested yet: their boxes side by side on
 * the platform (in their current orientation), filling as many platforms as
 * needed. Nothing like a real nesting; Start nesting replaces it.
 */
function previewBuilds(copies: { part: BuildPart; copy: number }[], s: BuildGenState): Build[] {
  if (!copies.length) return [];
  const printer = currentPrinter(s);
  const rule = orientRule(s);
  const qOf = new Map<string, Quaternion>();
  const boxOf = new Map<string, { min: Vector3; max: Vector3 }>();
  for (const { part } of copies) {
    if (qOf.has(part.id)) continue;
    const q = s.autoOrient && !part.lockRotation && part.orient?.mesh === part.mesh && (part.orient.rule ?? 'flat') === rule ? new Quaternion(...part.orient.q) : new Quaternion();
    qOf.set(part.id, q);
    boxOf.set(part.id, rotatedBounds(part.mesh, q));
  }
  const items: PackItem[] = copies.map(({ part, copy }) => {
    const b = boxOf.get(part.id)!;
    return { key: `${part.id}#${copy}`, w: b.max.x - b.min.x, d: b.max.y - b.min.y, h: b.max.z - b.min.z, fixed: true };
  });
  const r = packBuilds(items, { volume: printer.volume, margin: s.margin, gap: 2, zOffset: s.zOffset, allowRotate: false, stack: true });
  const byKey = new Map(copies.map((c) => [`${c.part.id}#${c.copy}`, c]));
  const builds: Build[] = r.builds.map((b) => ({
    name: '',
    height: b.height,
    utilization: b.utilization,
    preview: true,
    placements: b.items.map((it): BuildPlacement => {
      const { part, copy } = byKey.get(it.key)!;
      const q = qOf.get(part.id)!;
      const min = boxOf.get(part.id)!.min;
      return { key: it.key, partId: part.id, copy, position: [it.x - min.x, it.y - min.y, it.z - min.z], quaternion: [q.x, q.y, q.z, q.w] };
    }),
  }));
  // too big for the printer: one per platform, at the middle, so it can still be seen
  for (const u of r.unplaced) {
    const { part, copy } = byKey.get(u.key)!;
    const q = qOf.get(part.id)!;
    const b = boxOf.get(part.id)!;
    builds.push({
      name: '',
      height: b.max.z - b.min.z,
      utilization: 0,
      preview: true,
      placements: [{ key: u.key, partId: part.id, copy, position: [-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, s.zOffset - b.min.z], quaternion: [q.x, q.y, q.z, q.w] }],
    });
  }
  return builds;
}

/**
 * How many nesting jobs fit in this computer's memory at once: every job
 * holds the parts' voxels (four turns) and its build grids. Browsers report
 * the memory roughly (Chrome up to 8 GB; others not at all: 4 GB assumed).
 */
function nestingJobsThatFit(voxels: NestVoxels[], params: Omit<NestParams, 'budget' | 'variants'>, h: number): number {
  const gb = (typeof navigator !== 'undefined' && (navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 4;
  const budget = gb * 1e9 * 0.35;
  const cells = voxels.reduce((a, v) => a + v.nx * v.ny * v.nz, 0);
  const biggest = Math.max(1, ...voxels.map((v) => (v.nx + 8) * (v.ny + 8) * (v.nz + 8)));
  const [VX, VY, VZ] = params.volume;
  const gx = (VX - 2 * params.margin) / h,
    gy = (VY - 2 * params.margin) / h,
    gz = (VZ - params.zOffset) / h;
  // voxels in + shapes of four turns (runs, surfaces, line maps): about 12 bytes a cell (measured); dilation of the
  // biggest part; two builds of grids + line maps; the worker itself
  const perBuild = (gx * gy * gz) / 4 + 2 * 16 * (gx + 2 * gz) * (gy + gz) * 0.5;
  const perJob = cells * 12 + biggest * 6 + 2 * perBuild + 150e6;
  return Math.max(1, Math.floor(budget / perJob));
}

/** Stops the nesting that is running, keeping the best builds found so far (null when none runs). */
let stopNestingFn: (() => void) | null = null;
export function stopNesting() {
  stopNestingFn?.();
}

/**
 * Nest with a plan under one progress card, phase after phase: every part is
 * voxelized once per voxel size (in parallel workers, when that grid is
 * first needed) and the voxels are shared by all jobs on that grid; every
 * variant is a job, as many at a time as there are workers. A refine phase
 * retries the best variants so far on its grid. `onBest` gets each result
 * that is denser than the ones before. Cancel / Stop, or the time limit,
 * keeps the best so far.
 */
async function runNesting(
  parts: NestPart[],
  plan: NestPhase[],
  params: Omit<NestParams, 'budget' | 'variants'>,
  onBest: (r: NestResult, done: number, total: number) => void,
  timeLimitMin = 0,
): Promise<NestResult | null> {
  const hOf = (budget: number) => chooseNestVoxel({ ...params, budget });
  // --- log (shown in the Builds panel, can be copied)
  const t0 = performance.now();
  const lines: string[] = [];
  const log = (msg: string) => {
    lines.push(`${((performance.now() - t0) / 1000).toFixed(1).padStart(7)} s  ${msg}`);
    setState({ nestLog: [...lines] });
  };
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : null;
  log(`Start: ${parts.length} part kinds, ${parts.reduce((a, p) => a + p.count, 0)} copies, ${parts.reduce((a, p) => a + p.mesh.indices.length / 3, 0).toLocaleString()} triangles`);
  log(`Computer: ${nav?.hardwareConcurrency ?? '?'} cores, ${nav?.deviceMemory ? `about ${nav.deviceMemory} GB` : 'memory not reported'}; ${pool.capacity} workers`);
  log(`Volume ${params.volume.join(' × ')} mm, clearance ${params.clearance} mm, time limit ${timeLimitMin || 'none'} min`);

  // a quick coarse run first: there is a build to show within about a minute, whatever happens later
  if (plan[0].budget > 20e6) plan = [{ budget: 12e6, variants: [{ order: 'volume', pattern: false }] }, ...plan];

  let handles: { cancel: () => void }[] = [];
  let stopped = false;
  let timedOut = false;
  let best: NestResult | null = null;
  const stop = () => {
    stopped = true;
    handles.forEach((h) => h.cancel());
  };
  stopNestingFn = stop;
  const job = startJob('Nesting in 3D', stop);
  // the time limit never ends a nesting that has nothing to show yet: then it stops at the first build
  const timer =
    timeLimitMin > 0
      ? setTimeout(() => {
          timedOut = true;
          if (best) stop();
          else log('Time limit reached; going on until the first build is finished');
        }, timeLimitMin * 60_000)
      : null;
  const total = plan.reduce((a, ph) => a + (ph.refine ?? ph.variants.length), 0);
  let done = 0;
  let failed = 0;
  const results: { variant: NestVariant; h: number; r: NestResult }[] = [];
  const seen = new Set<string>();
  const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
  // voxels per grid, made when first needed (one job per part)
  // every orientation of every part: the part's own (0) and its alternatives
  const sources = parts.flatMap((part, pi) => [
    { pi, o: 0, mesh: part.mesh },
    ...(part.lock ? [] : (part.alts ?? []).map((a, i) => ({ pi, o: i + 1, mesh: a.mesh }))),
  ]);
  const voxelCache = new Map<number, Promise<NestVoxels[][]>>();
  const voxelsFor = (h: number) => {
    let v = voxelCache.get(h);
    if (!v) {
      let vdone = 0;
      log(`Voxelizing ${parts.length} parts (${sources.length} orientations) at ${h.toFixed(3)} mm`);
      const vhandles = sources.map((src) =>
        pool.run('nestVoxels', { mesh: src.mesh, h, align: parts[src.pi].lock ? lockAlign(params, parts[src.pi].lock!.at) : undefined, solidBox: parts[src.pi].solidBox }),
      );
      handles = [...handles, ...vhandles];
      v = Promise.all(
        vhandles.map((x) =>
          x.promise.then((r) => {
            vdone++;
            job.progress(done / total, `Voxelizing ${vdone} / ${sources.length} (${h.toFixed(2)} mm grid)`);
            return r;
          }),
        ),
      ).then((flat) => {
        // per part: [own orientation, alternatives…]
        const per: NestVoxels[][] = parts.map(() => []);
        flat.forEach((r, i) => (per[sources[i].pi][sources[i].o] = r));
        return per;
      });
      v.then((r) => log(`Voxels ready at ${h.toFixed(3)} mm (${(r.flat().reduce((a, x) => a + x.nx * x.ny * x.nz, 0) / 1e6).toFixed(1)} M cells)`)).catch(() => {});
      voxelCache.set(h, v);
    }
    return v;
  };
  const finish = (r: NestResult, variant: NestVariant, h: number) => {
    done++;
    results.push({ variant, h, r });
    log(`Done: ${variant.order}${variant.pattern ? ' + pattern' : ''} at ${h.toFixed(3)} mm → ${r.builds.length} build${r.builds.length === 1 ? '' : 's'}, last ${r.builds.at(-1)?.height.toFixed(0) ?? '-'} mm, ${r.unplaced.length} left out`);
    const better = pickNest(best, r);
    if (better !== best) {
      best = better;
      try {
        onBest(best!, done, total);
      } catch (e) {
        log(`Showing the builds failed: ${(e as Error).message}`);
      }
    }
    if (timedOut && !stopped) {
      log('Time limit: stopping now that there is a build');
      stop();
    }
  };
  try {
    for (const ph of plan) {
      if (stopped) break;
      const h0 = hOf(ph.budget);
      // refine: the best variants so far, again on this grid
      const wanted = ph.refine
        ? [...results]
            .sort((a, b) => compareNestResults(a.r, b.r))
            .map((x) => x.variant)
            .filter((v, i, all) => all.findIndex((w) => w.order === v.order && w.pattern === v.pattern) === i)
            .slice(0, ph.refine)
        : ph.variants;
      const tasks = wanted
        .filter((v) => {
          const key = `${h0.toFixed(9)}:${v.order}:${v.pattern}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((variant) => ({ variant, budget: ph.budget, attempt: 0 }));
      done += (ph.refine ?? ph.variants.length) - tasks.length;
      if (!tasks.length) continue;
      let voxels0: NestVoxels[][];
      try {
        voxels0 = await voxelsFor(h0);
      } catch (e) {
        if (e instanceof CancelledError || stopped) throw e;
        log(`Voxelizing at ${h0.toFixed(3)} mm failed (${(e as Error).message}); trying a coarser grid`);
        // the whole phase on a coarser grid
        for (const t of tasks) t.budget = Math.max(4e6, ph.budget / 3);
        voxels0 = await voxelsFor(hOf(tasks[0].budget));
      }
      const progress = new Map<number, number>();
      const show = (m?: string) =>
        job.progress(
          (done + [...progress.values()].reduce((a, b) => a + b, 0)) / total,
          `${m ?? 'Nesting'} · way ${Math.min(done + 1, total)} of ${total}${best ? ' · best so far shown' : ''}`,
        );
      // as many at a time as the workers and this computer's memory allow; a failed job goes again on a coarser grid, alone
      const queue = [...tasks];
      let limit = Math.min(tasks.length, pool.capacity, nestingJobsThatFit(voxels0.flat(), params, h0));
      log(`Phase: ${tasks.length} way${tasks.length > 1 ? 's' : ''} at ${h0.toFixed(3)} mm, ${limit} at a time`);
      let id = 0;
      const worker = async (slot: number) => {
        while (queue.length && !stopped && slot < limit) {
          const t = queue.shift()!;
          const me = id++;
          const h = hOf(t.budget);
          try {
            const voxels = await voxelsFor(h);
            const jobParts = parts.map((p, pi) => ({
              ...p,
              mesh: empty,
              voxels: voxels[pi][0],
              alts: p.lock ? undefined : p.alts?.map((_, i) => ({ mesh: empty, voxels: voxels[pi][i + 1] })),
            }));
            const handle = pool.run('nest3d', { parts: jobParts, params: { ...params, budget: t.budget, voxel: h, variants: [t.variant] } }, (f, m) => {
              progress.set(me, f);
              show(m);
            });
            handles = [...handles, handle];
            const r = await handle.promise;
            progress.delete(me);
            finish(r, t.variant, h);
            show();
          } catch (e) {
            progress.delete(me);
            if (e instanceof CancelledError || stopped) return;
            const why = (e as Error).message || String(e);
            if (t.attempt === 0 && t.budget > 4e6) {
              log(`Failed: ${t.variant.order} at ${h.toFixed(3)} mm (${why}); again on a coarser grid, one job at a time`);
              limit = 1;
              queue.unshift({ ...t, budget: Math.max(4e6, t.budget / 3), attempt: 1 });
              if (slot !== 0) return;
            } else {
              failed++;
              done++;
              log(`Failed again: ${t.variant.order} at ${h.toFixed(3)} mm (${why}); skipped`);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: limit }, (_, slot) => worker(slot)));
      // a job that failed while slot 0 had already finished waits in the queue
      while (queue.length && !stopped) await worker(0);
      // voxels of this phase are not needed any more
      voxelCache.clear();
    }
    if (stopped && best) {
      log(timedOut ? 'Ended: time limit, best builds kept' : 'Ended: stopped, best builds kept');
      notify('info', `${timedOut ? `Time limit of ${timeLimitMin} min reached` : 'Nesting stopped'}: keeping the best builds found (${done} of ${total} ways tried)`);
    } else if (stopped) {
      log('Ended: cancelled before any build was finished');
      notify('info', 'Nesting cancelled');
    } else if (!best) {
      log('Ended: every way failed');
      notify('error', 'Nesting could not finish on this computer (see the nesting log in the Builds panel: Copy it and send it on). Try Fast, fewer parts at a time, or close other tabs.');
    } else {
      log(`Ended: finished${failed ? `, ${failed} way${failed > 1 ? 's' : ''} failed and skipped` : ''}`);
      if (failed) notify('warning', `Nesting finished; ${failed} of ${total} ways failed on this computer and were skipped (see the nesting log)`);
    }
    return best;
  } catch (e) {
    handles.forEach((h) => h.cancel());
    if (!(e instanceof CancelledError)) {
      log(`Ended with an error: ${(e as Error).message}`);
      notify('error', `Nesting failed: ${(e as Error).message}${best ? ' (the best builds found are kept)' : ''}`);
    } else if (!best) notify('info', 'Nesting cancelled');
    return best;
  } finally {
    if (timer) clearTimeout(timer);
    if (stopNestingFn === stop) stopNestingFn = null;
    job.end();
  }
}

async function generate(run: number, s0: BuildGenState, job: ReturnType<typeof startJob>) {
  // 1. orientation, cached per mesh: powder bed by the SLS / MJF rules, other printers largest flat face down
  const rule = orientRule(s0);
  const cached = (p: BuildPart) => !!p.orient && p.orient.mesh === p.mesh && (p.orient.rule ?? 'flat') === rule;
  const toOrient = s0.parts.filter((p) => s0.autoOrient && !p.lockRotation && !cached(p)).length;
  let oriented = 0;
  job.progress(0.05, toOrient ? `Orienting 0 / ${toOrient} parts` : 'Packing');
  const parts = await Promise.all(
    s0.parts.map(async (p) => {
      if (!s0.autoOrient || p.lockRotation || cached(p)) return p;
      const q =
        rule === 'powder'
          ? (await runJob(`Orienting ${p.name}`, 'powderOrient', { mesh: p.mesh }, { silent: true }))?.quaternion
          : (await runJob(`Orienting ${p.name}`, 'autoOrient', { mesh: p.mesh, quaternion: [0, 0, 0, 1], alignXY: true }, { silent: true }))?.quaternion;
      oriented++;
      job.progress(0.05 + 0.75 * (oriented / Math.max(1, toOrient)), `Orienting ${oriented} / ${toOrient} parts`);
      return q ? { ...p, orient: { mesh: p.mesh, q, rule } } : p;
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
  const info = new Map<string, { q: Quaternion; min: Vector3; max: Vector3; alts?: Quaternion[] }>();
  // best packing (powder): a part may also lie on either of its two sides, whichever packs best
  const sides = powder && s.nest3d && s.autoOrient && s.allowRotate && s.powderOrient !== 'rules';
  const sideTurns = [new Vector3(1, 0, 0), new Vector3(0, 1, 0)].map((ax) => new Quaternion().setFromAxisAngle(ax, Math.PI / 2));
  const items: PackItem[] = [];
  const autoTilts: Record<string, Tilt> = {};
  // assembly groups: every member takes the orientation of the group's largest part
  const leadOf = new Map<string, BuildPart>();
  for (const p of parts)
    if (p.group) {
      const l = leadOf.get(p.group);
      if (!l || partVolume(p.mesh) > partVolume(l.mesh)) leadOf.set(p.group, p);
    }
  const lead = (p: BuildPart) => (p.group ? leadOf.get(p.group)! : p);
  const ordered = [...parts].sort((a, b) => Number(lead(a) !== a) - Number(lead(b) !== b));
  for (const p of ordered) {
    const l = lead(p);
    if (l !== p) {
      const q = info.get(l.id)!.q;
      const b = rotatedBounds(p.mesh, q);
      info.set(p.id, { q, ...b });
      if (autoTilts[l.id]) autoTilts[p.id] = autoTilts[l.id];
      for (let c = 0; c < p.quantity; c++)
        items.push({ key: `${p.id}#${c}`, w: b.max.x - b.min.x, d: b.max.y - b.min.y, h: b.max.z - b.min.z, fixed: !!l.lockRotation || undefined });
      continue;
    }
    if (p.lockRotation) {
      // locked orientation: exactly as it came from Mesh prep, only moved
      const q0 = new Quaternion();
      const b0 = rotatedBounds(p.mesh, q0);
      info.set(p.id, { q: q0, ...b0 });
      for (let c = 0; c < p.quantity; c++)
        items.push({ key: `${p.id}#${c}`, w: b0.max.x - b0.min.x, d: b0.max.y - b0.min.y, h: b0.max.z - b0.min.z, fixed: true });
      continue;
    }
    const base = s.autoOrient && p.orient && (p.orient.rule ?? 'flat') === rule ? new Quaternion(...p.orient.q) : new Quaternion();
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
    // other orientations (not for assembly groups, which share one orientation, nor parts tilted to fit)
    const tiltQ = tiltQuaternion(p.tilt ?? s.tilt);
    const alts = sides && !p.group && !autoTilts[p.id] ? sideTurns.map((r) => tiltQ.clone().multiply(r.clone().multiply(base))) : undefined;
    info.set(p.id, { q, ...b, alts });
    for (let c = 0; c < p.quantity; c++) items.push({ key: `${p.id}#${c}`, w: b.max.x - b.min.x, d: b.max.y - b.min.y, h: b.max.z - b.min.z });
  }
  if (powder && s.nest3d) {
    // 3. powder bed: nest by the parts' shape anywhere in the volume (X, Y and Z)
    job.progress(0.82, 'Nesting in 3D');
    // copies locked by the user go in as their own parts, in their locked place / rotation
    const locks = s.locks ?? {};
    const lockQ = (L: CopyLock) => (L.r.some(Boolean) ? new Quaternion(...L.quaternion) : null);
    const nestParts: NestPart[] = [];
    for (const p of parts) {
      const inf = info.get(p.id)!;
      const copies = Array.from({ length: p.quantity }, (_, c) => c);
      const free = copies.filter((c) => !locks[`${p.id}#${c}`]);
      if (free.length) {
        const m = new Matrix4().makeRotationFromQuaternion(inf.q).elements;
        const alts = inf.alts?.map((qa) => ({ mesh: applyMatrix(p.mesh, new Matrix4().makeRotationFromQuaternion(qa).elements) }));
        nestParts.push({ id: p.id, mesh: applyMatrix(p.mesh, m), alts, count: free.length, copies: free, fixed: !!lead(p).lockRotation || !s.allowRotate, breakaway: !!p.breakaway, solidBox: !!p.cage });
      }
      for (const c of copies) {
        const L = locks[`${p.id}#${c}`];
        if (!L) continue;
        const m = new Matrix4().makeRotationFromQuaternion(lockQ(L) ?? inf.q).elements;
        const at = L.t.map((on, i) => (on ? L.position[i] : null)) as [number | null, number | null, number | null];
        nestParts.push({ id: p.id, mesh: applyMatrix(p.mesh, m), count: 1, copies: [c], fixed: true, lock: { build: L.build, at }, breakaway: !!p.breakaway, solidBox: !!p.cage });
      }
    }
    const params = {
      volume,
      margin: s.margin,
      clearance: gap,
      zOffset: s.zOffset,
      maxHeight: 0,
      rotations: s.allowRotate,
      interlockFree: true,
    };
    // several ways of nesting side by side (one per worker); the densest is kept
    const plan = nestPlan(s.nestDetail ?? 'normal', s.symmetric !== false && nestParts.some((p) => p.count > 1));
    const before = bg();
    const toState = (r: NestResult) => {
      const builds: Build[] = r.builds.map((b, i) => ({
        name: `Build ${i + 1}`,
        height: b.height,
        utilization: b.utilization,
        placements: b.placements.map((pl): BuildPlacement => {
          const inf = info.get(pl.partId)!;
          const L = pl.locked ? locks[pl.key] : undefined;
          const qo = pl.orient && inf.alts?.[pl.orient - 1] ? inf.alts[pl.orient - 1] : inf.q;
          const q = (L && lockQ(L)) || new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (pl.turns * Math.PI) / 2).multiply(qo);
          return { key: pl.key, partId: pl.partId, copy: pl.copy, position: pl.t, quaternion: [q.x, q.y, q.z, q.w] };
        }),
      }));
      const unplaced = r.unplaced.map((u) => ({ partId: partOfKey(u.key), copy: Number(u.key.split('#')[1]), reason: u.reason }));
      // locked copies: remember where they ended up (free axes may have moved)
      const newLocks: Record<string, CopyLock> = {};
      builds.forEach((b, bi) =>
        b.placements.forEach((pl) => {
          const L = locks[pl.key];
          if (L) newLocks[pl.key] = { ...L, build: bi, position: pl.position, quaternion: pl.quaternion };
        }),
      );
      for (const [k, L] of Object.entries(locks)) if (!newLocks[k] && bg().parts.some((p) => p.id === partOfKey(k) && Number(k.split('#')[1]) < p.quantity)) newLocks[k] = L;
      return { locks: newLocks, builds, unplaced, autoTilts, active: Math.min(s.active, Math.max(0, builds.length - 1)), manual: false, stale: false, checks: null, nestVoxel: r.voxel };
    };
    // the best builds so far are shown while more ways are tried
    const r = await runNesting(
      nestParts,
      plan,
      params,
      (best, done, total) => {
        if (run === generation && done < total) setBg({ ...toState(best), improving: { done, total } });
      },
      s.nestTimeLimit ?? 10,
    );
    if (!r || run !== generation) return setBg({ busy: false, improving: null });
    commitBuild('Nesting', { ...toState(r), busy: false, improving: null }, before);
    fitBuildView();
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
  commitBuild('Arrange builds', { builds, unplaced, autoTilts, active: Math.min(s.active, Math.max(0, builds.length - 1)), busy: false, manual: false, stale: false, checks: null });
}

// ---------------------------------------------------------------- display / export

/** Parts placed in a build, as regular parts (shared meshes) for the viewer and exports. */
export function buildDisplayParts(s: BuildGenState, buildIndex = s.active, forView = false): Part[] {
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
      mesh: forView && p.display?.for === p.mesh ? p.display.mesh : p.mesh,
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
/** Do clicks select single copies (editing by hand, or chosen), not every copy of a part? */
export function pickingCopies(s = getState()): boolean {
  return (s.buildEdit ?? 'select') !== 'select' || s.buildPickCopies;
}

export function selectBuildPart(partId: string | null, toggle = false) {
  if (!partId) return toggle ? undefined : setState({ selection: [] });
  if (pickingCopies()) {
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
  if (pickingCopies()) setState({ selection: (bg().builds[bg().active]?.placements ?? []).map((p) => p.key) });
  else setState({ selection: bg().parts.map((p) => `${p.id}#0`) });
}

// ---------------------------------------------------------------- hiding

/** Is a placement (key) hidden, by itself or with its whole part? */
export function isHiddenKey(s: BuildGenState, key: string): boolean {
  const h = s.hidden;
  return !!h?.length && (h.includes(key) || h.includes(partOfKey(key)));
}

/** Hide the selected parts (whole parts, or single copies when picking copies). */
export function hideBuildSelection() {
  const sel = getState().selection;
  if (!sel.length) return notify('info', 'Select the parts to hide first');
  const add = pickingCopies() ? sel : selectedBuildPartIds(sel);
  setBg({ hidden: [...new Set([...(bg().hidden ?? []), ...add])] });
  setState({ selection: [] });
}

/** Show or hide every copy of a part. */
export function toggleBuildPartHidden(id: string) {
  const h = bg().hidden ?? [];
  const hidden = h.includes(id) || h.some((k) => partOfKey(k) === id);
  setBg({ hidden: hidden ? h.filter((k) => partOfKey(k) !== id) : [...h, id] });
}

export function showAllBuildParts() {
  setBg({ hidden: [] });
}

/** Give several parts their own tilt (null = follow the tilt for all parts again). */
export function setTiltFor(ids: string[], tilt: Tilt | null) {
  const lockedIds = new Set(bg().parts.filter((p) => p.lockRotation).map((p) => p.id));
  if (tilt && ids.some((id) => lockedIds.has(id))) notify('info', 'Parts with a locked orientation are not tilted');
  ids = ids.filter((id) => !lockedIds.has(id));
  if (!ids.length) return;
  const set = new Set(ids);
  commitBuild('Tilt', { parts: bg().parts.map((p) => (set.has(p.id) ? { ...p, tilt } : p)) });
  scheduleRegenerate();
}

/** Lock or unlock the orientation of build parts. */
/**
 * Base orientation rule: largest flat face down (also the start of "best
 * packing" on powder printers, which adds the two sides), or the SLS / MJF
 * rules.
 */
export function orientRule(s: BuildGenState): 'powder' | 'flat' {
  return printerById(s.printerId).tech === 'powder' && s.powderOrient === 'rules' ? 'powder' : 'flat';
}

/** default cage: 1 mm thick bars, 3 mm wide, 5 mm apart */
export const DEFAULT_CAGE: CageOptions = { thickness: 1, barWidth: 3, gap: 5 };

/**
 * Put parts (all their copies) in a cage so they are not lost in the powder:
 * they are oriented like for nesting, packed tightly (with the clearance
 * between them), and a lattice box is built around them at the clearance.
 * The cage with its contents becomes one part (nested as its whole box).
 */
export async function cageBuildParts(ids: string[]) {
  const s = bg();
  const targets = s.parts.filter((p) => ids.includes(p.id) && !p.cage);
  if (!targets.length) return notify('warning', 'Select the parts to put in a cage');
  const o = s.cageSettings ?? DEFAULT_CAGE;
  const clearance = Math.max(0.5, s.clearance3d);
  const powder = currentPrinter(s).tech === 'powder';
  void powder;
  const rule = orientRule(s);
  const job = startJob('Making a cage');
  try {
    // 1. orientation (as the nesting would)
    job.progress(0.05, 'Orienting the parts');
    const oriented = await Promise.all(
      targets.map(async (p) => {
        let q: [number, number, number, number] | undefined;
        if (p.lockRotation || !s.autoOrient) q = [0, 0, 0, 1];
        else if (p.orient?.mesh === p.mesh && (p.orient.rule ?? 'flat') === rule) q = p.orient.q;
        else
          q =
            rule === 'powder'
              ? (await runJob(`Orienting ${p.name}`, 'powderOrient', { mesh: p.mesh }, { silent: true }))?.quaternion
              : (await runJob(`Orienting ${p.name}`, 'autoOrient', { mesh: p.mesh, quaternion: [0, 0, 0, 1], alignXY: true }, { silent: true }))?.quaternion;
        const m = new Matrix4().makeRotationFromQuaternion(new Quaternion(...(q ?? [0, 0, 0, 1])));
        return { part: p, mesh: applyMatrix(p.mesh, m.elements) };
      }),
    );
    // 2. pack the copies tightly into a roughly cubic block
    job.progress(0.3, 'Packing the parts');
    let boxVol = 0,
      maxXY = 0,
      maxZ = 0;
    for (const { part, mesh } of oriented) {
      const b = computeBounds(mesh.positions);
      const d = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      boxVol += (d[0] + clearance) * (d[1] + clearance) * (d[2] + clearance) * part.quantity;
      maxXY = Math.max(maxXY, Math.hypot(d[0], d[1]));
      maxZ = Math.max(maxZ, d[2]);
    }
    let side = Math.max(maxXY + 2, Math.cbrt(boxVol * 1.6));
    let r: NestResult | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await runJob(
        'Packing the parts for the cage',
        'nest3d',
        {
          parts: oriented.map(({ part, mesh }) => ({ id: part.id, mesh, count: part.quantity })),
          params: { volume: [side, side, Math.max(side * 3, maxZ + 2)], margin: 0, clearance, zOffset: 0, maxHeight: 0, rotations: true, interlockFree: false, budget: 6e6, variants: [{ order: 'volume', pattern: false }] },
        },
        { silent: true },
      );
      if (r && !r.unplaced.length && r.builds.length === 1) break;
      side *= 1.4;
    }
    if (!r || r.unplaced.length || r.builds.length !== 1) return notify('error', 'The parts could not be packed for a cage');
    // 3. the parts where they were packed, and the cage around them at the clearance
    const meshOf = new Map(oriented.map((x) => [x.part.id, x.mesh]));
    const contents = r.builds[0].placements.map((pl) => {
      const m = meshOf.get(pl.partId)!;
      const pos = turnPositions(m.positions, pl.turns);
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] += pl.t[0];
        pos[i + 1] += pl.t[1];
        pos[i + 2] += pl.t[2];
      }
      return { positions: pos, indices: m.indices };
    });
    const inner = computeBounds(mergeMeshes(contents).positions);
    job.progress(0.7, 'Building the cage');
    const cage = await runJob(
      'Building the cage',
      'buildCage',
      {
        min: [inner.min[0] - clearance, inner.min[1] - clearance, inner.min[2] - clearance],
        max: [inner.max[0] + clearance, inner.max[1] + clearance, inner.max[2] + clearance],
        options: o,
      },
      { silent: true },
    );
    if (!cage) return;
    const names = targets.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name));
    const copies = targets.reduce((a, p) => a + p.quantity, 0);
    const cagePart: BuildPart = {
      ...newBuildPart({ name: `Cage: ${names.join(', ')}`.slice(0, 80), mesh: mergeMeshes([cage, ...contents]), lockRotation: true, watertight: true }),
      cage: { options: o, contents: targets },
    };
    const gone = new Set(targets.map((p) => p.id));
    commitBuild(`Put ${copies} part${copies > 1 ? 's' : ''} in a cage`, { parts: [...bg().parts.filter((p) => !gone.has(p.id)), cagePart] });
    setState({ selection: [`${cagePart.id}#0`] });
    notify('success', `Cage made around ${copies} part${copies > 1 ? 's' : ''}: it is nested as one part`);
    scheduleRegenerate();
  } finally {
    job.end();
  }
}

/** Take the parts out of a cage again (the cage goes away). */
export function uncageBuildPart(id: string) {
  const cage = bg().parts.find((p) => p.id === id && p.cage);
  if (!cage) return;
  commitBuild('Remove cage', { parts: [...bg().parts.filter((p) => p.id !== id), ...cage.cage!.contents] });
  setState({ selection: [] });
  scheduleRegenerate();
}

export function setCageSettings(patch: Partial<CageOptions>) {
  setBg({ cageSettings: { ...(bg().cageSettings ?? DEFAULT_CAGE), ...patch } });
}

/** Parts with breakaway props (cups, bowls): other parts may be nested inside them, the props are broken off later. */
export function setBreakaway(ids: string[], on: boolean) {
  const set = new Set(ids);
  commitBuild(on ? 'Let parts nest inside' : 'Normal interlock rule', { parts: bg().parts.map((p) => (set.has(p.id) ? { ...p, breakaway: on || undefined } : p)) });
  scheduleRegenerate();
}

/** Join parts into an assembly group: they all get the same orientation, so mating faces print at the same angle. */
export function groupBuildParts(ids: string[]) {
  if (ids.length < 2) return notify('warning', 'Select two or more parts that are assembled together');
  const set = new Set(ids);
  // joining parts that are already grouped merges their groups
  const groups = new Set(bg().parts.filter((p) => set.has(p.id) && p.group).map((p) => p.group!));
  const group = newId();
  commitBuild('Group as assembly', { parts: bg().parts.map((p) => (set.has(p.id) || (p.group && groups.has(p.group)) ? { ...p, group, tilt: null } : p)) });
  notify('success', `${ids.length} parts grouped as an assembly: they keep the same orientation`);
  scheduleRegenerate();
}

export function ungroupBuildParts(ids: string[]) {
  const groups = new Set(bg().parts.filter((p) => ids.includes(p.id) && p.group).map((p) => p.group!));
  commitBuild('Ungroup', { parts: bg().parts.map((p) => (p.group && groups.has(p.group) ? { ...p, group: undefined } : p)) });
  scheduleRegenerate();
}

/** Short labels (A1, A2, …) for the assembly groups, in list order. */
export function groupLabels(parts: BuildPart[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of parts) if (p.group && !out.has(p.group)) out.set(p.group, `A${out.size + 1}`);
  return out;
}

export function setBuildRotationLock(ids: string[], lock: boolean) {
  const set = new Set(ids);
  commitBuild(lock ? 'Lock orientation' : 'Unlock orientation', { parts: bg().parts.map((p) => (set.has(p.id) ? { ...p, lockRotation: lock, tilt: lock ? null : p.tilt } : p)) });
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
  const locks = { ...(s.locks ?? {}) };
  const placements = b.placements.map((pl) => {
    const c = by.get(pl.key);
    if (!c) return pl;
    let position = c.position ?? pl.position;
    let quaternion = c.quaternion ?? pl.quaternion;
    const L = locks[pl.key];
    if (L) {
      // locked axes stay where they are
      position = position.map((v, i) => (L.t[i] ? pl.position[i] : v)) as Vec3;
      if (L.r.every(Boolean)) quaternion = pl.quaternion;
      locks[pl.key] = { ...L, position, quaternion };
    }
    return { ...pl, position, quaternion };
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
  commitBuild('Edit by hand', { builds, locks, manual: true, checks: null });
}

/**
 * Lock (or unlock) translation / rotation axes of copies in the active build:
 * `keys` are placement keys; axes set to true lock, false unlock, undefined
 * keep. A copy with no locked axis left is unlocked.
 */
export function setCopyLocks(keys: string[], t: (boolean | undefined)[], r: (boolean | undefined)[]) {
  const s = bg();
  const b = s.builds[s.active];
  if (!b || !keys.length) return;
  const locks = { ...(s.locks ?? {}) };
  for (const pl of b.placements) {
    if (!keys.includes(pl.key)) continue;
    const old = locks[pl.key];
    const lt = [0, 1, 2].map((i) => t[i] ?? old?.t[i] ?? false) as [boolean, boolean, boolean];
    const lr = [0, 1, 2].map((i) => r[i] ?? old?.r[i] ?? false) as [boolean, boolean, boolean];
    if (!lt.some(Boolean) && !lr.some(Boolean)) delete locks[pl.key];
    else locks[pl.key] = { t: lt, r: lr, build: s.active, position: pl.position, quaternion: pl.quaternion };
  }
  const any = [...t, ...r].some(Boolean);
  commitBuild(any ? `Lock ${keys.length} cop${keys.length > 1 ? 'ies' : 'y'}` : `Unlock ${keys.length} cop${keys.length > 1 ? 'ies' : 'y'}`, { locks });
}

/** Placement keys the lock controls act on: the selected copies, or every copy of the selected parts in the active build. */
export function lockTargets(st = getState()): string[] {
  const b = st.buildGen.builds[st.buildGen.active];
  if (!b) return [];
  if (pickingCopies(st)) return st.selection.filter((k) => b.placements.some((p) => p.key === k));
  const ids = new Set(selectedBuildPartIds(st.selection));
  return b.placements.filter((p) => ids.has(p.partId)).map((p) => p.key);
}

/** Start nesting: arrange all parts now (replaces hand edits). */
export function rearrangeBuilds() {
  setBg({ manual: false, stale: false });
  void regenerateBuilds(true);
}

function activeItems(s: BuildGenState) {
  const b = s.builds[s.active];
  if (!b) return [];
  const breakaway = new Set(s.parts.filter((p) => p.breakaway).map((p) => p.id));
  return buildItems(s, s.active).map((it, i) => ({ key: b.placements[i].key, mesh: it.mesh, breakaway: breakaway.has(b.placements[i].partId) }));
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
