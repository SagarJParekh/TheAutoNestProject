import { create } from 'zustand';
import type {
  AnalysisEntry, DisplayMode, FaceSelection, GizmoMode, IntersectionEntry, Job, Notice, Part, PickMode, PickSlot, PlaneSettings,
  Preview, RepairTab, ToolId, ToolSettings, Transform, PointPick, PointSlot, Measurement, MeasurePending, Heightmap, ShellView, TriEdit,
  BlendEdgePick, BuildGenState,
} from './types';
import type { ErrorGroup, MeshData, ThicknessResult } from '../geometry';
import { DEFAULT_JOINT } from '../geometry/joint';
import { DEFAULT_SHAPE } from '../geometry/shapes';
import { DEFAULT_LATTICE } from '../geometry/lattice';
import { DEFAULT_WRAP } from '../geometry/wrap';
import { DEFAULT_APPEARANCE, loadAppearance, type Appearance } from './theme';

export interface HistoryEntry {
  label: string;
  parts: Part[];
}

/** A Build generation undo step: the whole build state before the change. */
export interface BuildHistoryEntry {
  label: string;
  gen: BuildGenState;
}

export interface AppState {
  parts: Part[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Build generation has its own history (Undo / Redo follow the workspace in use) */
  buildPast: BuildHistoryEntry[];
  buildFuture: BuildHistoryEntry[];
  selection: string[];

  tool: ToolId;
  gizmo: GizmoMode;
  display: DisplayMode;
  orthographic: boolean;
  showGrid: boolean;
  clipEnabled: boolean;
  clip: PlaneSettings;
  cutPlane: PlaneSettings;
  pickMode: PickMode;
  pickSlot: PickSlot;
  faceSelection: FaceSelection | null;
  /** face picks used by the repair tabs (normals, align, props) */
  facePicks: Partial<Record<Exclude<PickSlot, 'primary'>, FaceSelection>>;
  /** edges picked for fillet / chamfer */
  blendEdges: BlendEdgePick[];
  /** interface theme and viewport background (remembered per browser) */
  appearance: Appearance;
  /** which unit is shown: mesh preparation or build generation */
  workspace: 'prep' | 'build';
  buildGen: BuildGenState;
  /** set only on the view state handed to the viewer in the build workspace */
  buildView?: { volume: [number, number, number]; margin: number; zOffset: number };
  /** set only on the view state: red markers (collision locations) */
  markers?: [number, number, number][] | null;
  /** Build generation: how the mouse edits parts (select only, move gizmo, rotate gizmo, drag on the platform) */
  buildEdit: 'select' | 'move' | 'rotate' | 'drag';
  /** Build generation view: cut the build at a height (show what is below, or above with `above`) */
  buildClip: { on: boolean; z: number; above: boolean };
  /** Build generation: clicks select single copies instead of every copy of a part */
  buildPickCopies: boolean;
  /** a Build generation session saved in the browser, waiting to be restored or discarded */
  savedBuildSession: { savedAt: number; parts: number; copies: number } | null;
  /** what the last nesting did (times, grids, memory, errors), to look at or copy when something goes wrong */
  nestLog: string[];
  /** snapping of the move / rotate gizmos and of pick & place (both workspaces) */
  snap: { on: boolean; move: number; rotate: number };
  /** view only (Build generation): locked axes of the copy under the gizmo, and per part id for pick & place */
  gizmoLocks?: { t: [boolean, boolean, boolean]; r: [boolean, boolean, boolean] } | null;
  placeLocks?: Record<string, [boolean, boolean, boolean]> | null;
  repairTab: RepairTab;
  intersections: Record<string, IntersectionEntry>;
  pointSlot: PointSlot;
  pointPicks: Partial<Record<Exclude<PointSlot, 'perfPoint'>, PointPick>>;
  perfPoints: PointPick[];
  measurements: Measurement[];
  measurePending: MeasurePending;
  customFont: { name: string; data: ArrayBuffer } | null;
  heightmap: { name: string; map: Heightmap } | null;
  zoomWindow: boolean;
  /** viewer is in lasso-drawing mode (cut tool) */
  lassoMode: boolean;
  /** viewer is drawing a polyline for a cut */
  polyMode: boolean;
  shellView: ShellView | null;
  triEdit: TriEdit | null;
  /** wall thickness analysis per part (Measure tool) */
  thickness: Record<string, { mesh: MeshData; result: ThicknessResult }>;
  /** problem cluster the repair tool is zoomed to */
  errorFocus: { partId: string; mesh: MeshData; index: number; group: ErrorGroup } | null;
  showSearch: boolean;
  preview: Preview | null;
  analysis: Record<string, AnalysisEntry>;
  settings: ToolSettings;
  jobs: Job[];
  notices: Notice[];
  /** derived per-mesh info computed in workers */
  meshInfo: WeakMap<MeshData, { watertight?: boolean }>;
  meshInfoVersion: number;
  showShortcuts: boolean;
  showExport: boolean;
}

const defaultPlane = (axis: PlaneSettings['axis']): PlaneSettings => ({
  axis, azimuth: 30, elevation: 20, offset: 0, flip: false,
  rows: { x: { on: false, offset: 0, flip: false }, y: { on: false, offset: 0, flip: false }, z: { on: true, offset: 0, flip: false } },
  scope: 'all',
});

export const useStore = create<AppState>(() => ({
  parts: [],
  past: [],
  future: [],
  buildPast: [],
  buildFuture: [],
  selection: [],
  tool: 'transform',
  gizmo: 'translate',
  display: 'shaded',
  orthographic: false,
  showGrid: true,
  clipEnabled: false,
  clip: defaultPlane('z'),
  cutPlane: defaultPlane('z'),
  pickMode: null,
  pickSlot: 'primary',
  faceSelection: null,
  facePicks: {},
  blendEdges: [],
  appearance: typeof localStorage === 'undefined' ? DEFAULT_APPEARANCE : loadAppearance(),
  workspace: 'prep',
  buildGen: {
    printerId: 'form3l',
    customVolumes: {},
    margin: 5,
    spacingDefaults: 1,
    gap: 3,
    zOffset: 5,
    densityAllowance: 5,
    nest3d: true,
    clearance3d: 1,
    maxHeight: 0,
    nestDetail: 'normal',
    nestTimeLimit: 10,
    symmetric: true,
    autoNest: false,
    autoTilt: true,
    autoTilts: {},
    autoOrient: true,
    allowRotate: true,
    stack: false,
    tilt: { angle: 0, azimuth: 0 },
    parts: [],
    builds: [],
    unplaced: [],
    active: 0,
    busy: false,
  },
  repairTab: 'fix',
  intersections: {},
  pointSlot: 'label',
  pointPicks: {},
  perfPoints: [],
  measurements: [],
  measurePending: { entities: [], points: [] },
  customFont: null,
  heightmap: null,
  zoomWindow: false,
  lassoMode: false,
  polyMode: false,
  shellView: null,
  triEdit: null,
  errorFocus: null,
  thickness: {},
  buildEdit: 'select',
  buildClip: { on: false, z: 50, above: false },
  buildPickCopies: false,
  snap: { on: false, move: 1, rotate: 15 },
  nestLog: [],
  savedBuildSession: null,
  showSearch: false,
  preview: null,
  analysis: {},
  settings: {
    repair: { removeSmallShells: false, smallShellRatio: 0.01, weldTolerance: 0, fillHoles: true, stitch: true },
    hollow: { thickness: 2, quality: 'normal', drainDiameter: 4, drainExit: 0, keepPlugs: false, drainHoles: [] },
    perforate: { pattern: 'round', size: 4, spacing: 2, margin: 2, depth: 0, angle: 0, angleTolerance: 2, mode: 'array', exitSize: 0 },
    extrude: { distance: 5, angleTolerance: 2 },
    cut: { gap: 0 },
    highlight: { open: true, nonManifold: true, flipped: true, holeIndex: null },
    stitch: { tolerance: 0 },
    normals: { show: false, outColor: '#22c55e', inColor: '#ff3b4e', orientation: false, frontColor: '#3fa7ff', backColor: '#ff3b4e' },
    solid: { voxelSize: 0 },
    boolean: { op: 'union' },
    shape: { ...DEFAULT_SHAPE },
    lattice: { ...DEFAULT_LATTICE },
    wrap: { ...DEFAULT_WRAP, keep: false },
    align: { mode: 'mate', offset: 0, center: true },
    props: { diameter: 2, spacing: 8, margin: 2, maxLength: 10000, embed: 0.5, merge: false, mode: 'single', shape: 'circle', thinEnds: true, tipDiameter: 1, tipLength: 0.5 },
    label: { text: 'LABEL', size: 8, depth: 1, mode: 'emboss', rotation: 0, sink: 0.5, letterSpacing: 0, font: 'sans-bold', conform: true },
    texture: {
      pattern: 'knurl', period: 2, depth: 0.4, angle: 0, projection: 'planar', invert: false, resolution: 0,
      scope: 'face', smooth: false, angleTolerance: 2, imageFit: 'fit',
    },
    arrange: { autoAlignXY: true, axes: ['x', 'y'], gap: 5, cols: 2, rows: 2, mirrorCopy: false },
    measure: { mode: 'distance', pickAs: 'point', ortho: true },
    dimensions: { showDims: true, showName: true, showPath: true },
    thickness: { show: true, view: 'heat', limit: 1, scaleMin: 0, scaleMax: 0 },
    importQuality: (() => {
      try {
        const q = localStorage.getItem('autonest.importQuality');
        if (q === 'draft' || q === 'normal' || q === 'fine' || q === 'ultra') return q;
      } catch {
        /* storage unavailable */
      }
      return 'fine';
    })(),
    align2: { location: 'center', axis: 'both', beside: false, distance: 5 },
    perforateExtra: { keepPlugs: false },
    openEdges: { maxPerimeter: 20 },
    triEdit: { mode: 'mark', bridgeSide: 'A', markTool: 'triangle', angle: 20, planeAngle: 2, brushRadius: 3, windowThrough: false },
    remesh: { edgeLength: 1, iterations: 5, featureAngle: 35 },
    offset: { mode: 'global', distance: 1, voxel: 0, asCopy: false, smooth: true, angle: 20 },
    blend: { kind: 'fillet', size: 2 },
    cutMode: 'plane',
    joint: { ...DEFAULT_JOINT },
    cutSnap: true,
  },
  jobs: [],
  notices: [],
  meshInfo: new WeakMap(),
  meshInfoVersion: 0,
  showShortcuts: false,
  showExport: false,
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

// ---------------------------------------------------------------- history

/** Rough memory budget for undo history (unique mesh buffers). */
// up to 1.5 GB, less on computers with little memory (browsers report it roughly; 4 GB assumed when they don't)
const DEVICE_GB = (typeof navigator !== 'undefined' && (navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 4;
const HISTORY_BYTES = Math.min(1.5e9, DEVICE_GB * 1e9 * 0.12);
const HISTORY_MAX = 100;

function meshBytes(parts: Part[], seen: Set<MeshData>): number {
  let b = 0;
  for (const p of parts) {
    if (seen.has(p.mesh)) continue;
    seen.add(p.mesh);
    b += p.mesh.positions.byteLength + p.mesh.indices.byteLength;
  }
  return b;
}

function trimHistory(past: HistoryEntry[], current: Part[]): HistoryEntry[] {
  let out = past.slice(-HISTORY_MAX);
  for (;;) {
    const seen = new Set<MeshData>();
    let total = meshBytes(current, seen);
    for (const e of out) total += meshBytes(e.parts, seen);
    if (total <= HISTORY_BYTES || out.length <= 1) return out;
    out = out.slice(1);
  }
}

/** Replace the part list as one undoable step. */
export function commit(label: string, parts: Part[], extra: Partial<AppState> = {}) {
  const s = getState();
  // parts with a locked orientation keep their rotation whatever the edit (moves still apply)
  const before = new Map(s.parts.map((p) => [p.id, p]));
  parts = parts.map((p) => {
    const old = before.get(p.id);
    if (!old || !old.lockRotation || !p.lockRotation || old.mesh !== p.mesh) return p;
    const r0 = old.transform.rotation, r1 = p.transform.rotation;
    return r0[0] === r1[0] && r0[1] === r1[1] && r0[2] === r1[2] ? p : { ...p, transform: { ...p.transform, rotation: r0 } };
  });
  const past = trimHistory([...s.past, { label, parts: s.parts }], parts);
  const ids = new Set(parts.map((p) => p.id));
  setState({
    parts,
    past,
    future: [],
    selection: (extra.selection ?? s.selection).filter((id) => ids.has(id)),
    ...extra,
  });
}

// ---------------------------------------------------------------- build history

const BUILD_HISTORY_MAX = 60;
/** Called after a build undo / redo (Build generation drops nesting still running). */
let onBuildRestore: () => void = () => {};
export function setBuildRestoreHook(fn: () => void) {
  onBuildRestore = fn;
}
/** what is kept in a build undo step (no running state, no check results) */
const buildSnapshot = (g: BuildGenState): BuildGenState => ({ ...g, busy: false, checks: null });

/** Change the build state as one undoable step (Undo goes back to `before` if given, else to the current state). */
export function commitBuild(label: string, patch: Partial<BuildGenState>, before?: BuildGenState) {
  const s = getState();
  setState({
    buildGen: { ...s.buildGen, ...patch },
    // `before`: the state to go back to, when intermediate results were shown in between
    buildPast: [...s.buildPast, { label, gen: buildSnapshot(before ?? s.buildGen) }].slice(-BUILD_HISTORY_MAX),
    buildFuture: [],
  });
}

function restoreBuild(gen: BuildGenState) {
  const s = getState();
  const keys = new Set(gen.builds[gen.active]?.placements.map((p) => p.key) ?? []);
  const ids = new Set(gen.parts.map((p) => p.id));
  setState({ buildGen: { ...gen, busy: false, checks: null }, selection: s.selection.filter((k) => keys.has(k) || ids.has(k.split('#')[0])) });
  onBuildRestore();
}

function buildUndo() {
  const s = getState();
  const prev = s.buildPast[s.buildPast.length - 1];
  if (!prev) return;
  setState({ buildPast: s.buildPast.slice(0, -1), buildFuture: [{ label: prev.label, gen: buildSnapshot(s.buildGen) }, ...s.buildFuture] });
  restoreBuild(prev.gen);
  notify('info', `Undo: ${prev.label}`);
}

function buildRedo() {
  const s = getState();
  const next = s.buildFuture[0];
  if (!next) return;
  setState({ buildPast: [...s.buildPast, { label: next.label, gen: buildSnapshot(s.buildGen) }], buildFuture: s.buildFuture.slice(1) });
  restoreBuild(next.gen);
  notify('info', `Redo: ${next.label}`);
}

/** Label of the step Undo / Redo would take back in the workspace in use, or null. */
export function undoLabel(s: AppState, redoStep = false): string | null {
  if (s.workspace === 'build') return (redoStep ? s.buildFuture[0] : s.buildPast[s.buildPast.length - 1])?.label ?? null;
  return (redoStep ? s.future[0] : s.past[s.past.length - 1])?.label ?? null;
}

export function undo() {
  const s = getState();
  if (s.workspace === 'build') return buildUndo();
  const prev = s.past[s.past.length - 1];
  if (!prev) return;
  const ids = new Set(prev.parts.map((p) => p.id));
  setState({
    parts: prev.parts,
    past: s.past.slice(0, -1),
    future: [{ label: prev.label, parts: s.parts }, ...s.future],
    selection: s.selection.filter((id) => ids.has(id)),
    preview: null,
    faceSelection: null,
  });
  notify('info', `Undo: ${prev.label}`);
}

export function redo() {
  const s = getState();
  if (s.workspace === 'build') return buildRedo();
  const next = s.future[0];
  if (!next) return;
  const ids = new Set(next.parts.map((p) => p.id));
  setState({
    parts: next.parts,
    past: [...s.past, { label: next.label, parts: s.parts }],
    future: s.future.slice(1),
    selection: s.selection.filter((id) => ids.has(id)),
    preview: null,
    faceSelection: null,
  });
  notify('info', `Redo: ${next.label}`);
}

export function updateParts(label: string, ids: string[], fn: (p: Part) => Part) {
  const set = new Set(ids);
  const parts = getState().parts.map((p) => (set.has(p.id) ? fn(p) : p));
  commit(label, parts);
}

export function setTransform(id: string, t: Partial<Transform>, label = 'Transform') {
  updateParts(label, [id], (p) => ({ ...p, transform: { ...p.transform, ...t } }));
}

// ---------------------------------------------------------------- notices & jobs

let noticeId = 1;
/** set while a live preview re-runs, so half-typed values don't flood the screen with warnings */
export const noticeGate = { quiet: false };

export function notify(kind: Notice['kind'], text: string, ttl = kind === 'error' ? 9000 : 4000) {
  if (noticeGate.quiet && (kind === 'warning' || kind === 'info')) return;
  const id = noticeId++;
  setState((s) => {
    const list = [...s.notices, { id, kind, text }];
    // evict the oldest non-error notices first so errors stay visible
    while (list.length > 6) {
      const i = list.findIndex((n) => n.kind !== 'error');
      list.splice(i >= 0 ? i : 0, 1);
    }
    return { notices: list };
  });
  if (ttl > 0) setTimeout(() => dismissNotice(id), ttl);
}
export function dismissNotice(id: number) {
  setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

let jobId = 1;
export function startJob(label: string, cancel?: () => void): { id: number; progress: (f: number, m?: string) => void; end: () => void } {
  const id = jobId++;
  setState((s) => ({ jobs: [...s.jobs, { id, label, progress: 0, cancel }] }));
  return {
    id,
    progress: (f, m) => setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, progress: f, message: m ?? j.message } : j)) })),
    end: () => setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  };
}

export function selectedParts(): Part[] {
  const s = getState();
  const set = new Set(s.selection);
  return s.parts.filter((p) => set.has(p.id));
}

export function partById(id: string): Part | undefined {
  return getState().parts.find((p) => p.id === id);
}
