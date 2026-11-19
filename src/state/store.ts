import { create } from 'zustand';
import type {
  AnalysisEntry, DisplayMode, FaceSelection, GizmoMode, IntersectionEntry, Job, Notice, Part, PickMode, PickSlot, PlaneSettings,
  Preview, RepairTab, ToolId, ToolSettings, Transform, PointPick, PointSlot, Measurement, MeasurePending, Heightmap, ShellView, TriEdit,
  BlendEdgePick, BuildGenState,
} from './types';
import type { ErrorGroup, MeshData, ThicknessResult } from '../geometry';
import { DEFAULT_JOINT } from '../geometry/joint';
import { DEFAULT_POLYCUT } from '../geometry/polycut';
import { SUPPORT_PRESETS } from '../geometry/supports';
import { DEFAULT_SHAPE } from '../geometry/shapes';
import { DEFAULT_LATTICE } from '../geometry/lattice';
import { DEFAULT_WRAP } from '../geometry/wrap';
import { DEFAULT_SOLIDIFY } from '../geometry/solidify';
import { DEFAULT_APPEARANCE, loadAppearance, type Appearance } from './theme';

export interface HistoryEntry {
  label: string;
  parts: Part[];
  /** the selections at that point (marked triangles, picked surfaces / planes, picked edges), restored with it */
  picks?: PickSnap;
  /** a selection step only (the parts did not change) */
  pickOnly?: boolean;
  /** when it was made (successive samples of one brush stroke make one step) */
  at?: number;
}

/** The selections kept in the undo history. */
export interface PickSnap {
  triEdit: AppState['triEdit'];
  faceSelection: AppState['faceSelection'];
  facePicks: AppState['facePicks'];
  blendEdges: AppState['blendEdges'];
}
const pickSnap = (s: AppState): PickSnap => ({ triEdit: s.triEdit, faceSelection: s.faceSelection, facePicks: s.facePicks, blendEdges: s.blendEdges });

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
  buildView?: { volume: [number, number, number]; margin: number; zOffset: number; hidePlatform?: boolean };
  /** set only on the view state: red markers (collision locations) */
  markers?: [number, number, number][] | null;
  /** set only on the view state: support touch points while editing supports (world positions, RGB colours) and a dragged one's new place */
  supportPoints?: {
    pos: Float32Array;
    col: Float32Array;
    ghost: [number, number, number] | null;
    /** adding supports: the point under the mouse and where its support would stand */
    hover?: { at: [number, number, number]; foot: [number, number, number] } | null;
  } | null;
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
  /** set only on the view state: objects whose id ends with this are not picked (supports while adding supports) */
  pickSkipSuffix?: string;
  /** set only on the view state: the move / rotate gizmo may carry several selected objects together */
  multiGizmo?: boolean;
  placeLocks?: Record<string, [boolean, boolean, boolean]> | null;
  repairTab: RepairTab;
  intersections: Record<string, IntersectionEntry>;
  pointSlot: PointSlot;
  pointPicks: Partial<Record<Exclude<PointSlot, 'perfPoint'>, PointPick>>;
  /** the label's outline (2D segments, mm) shown under the cursor while placing it */
  labelGhost: Float32Array | null;
  /** the section's contours (world segments), shown while indicating contours for a joint */
  contourLines: Float32Array | null;
  /** bumped whenever build supports were made (so the view updates); copies still waiting for theirs */
  supportTick: number;
  supportPending: number;
  /** Build generation: editing supports by hand (select / move / delete touch points, or add supports) */
  supportEdit: 'select' | 'add' | null;
  /** Build generation: the tab open in the left and right panels */
  buildLeftTab: 'parts' | 'printer' | 'nesting';
  buildRightTab: 'builds' | 'parts' | 'supports' | 'edit';
  /** Build generation: the platform (plate and grid) hidden in the view */
  buildHidePlatform: boolean;
  /** side panels collapsed to a thin bar */
  panelsCollapsed: { left: boolean; right: boolean };
  /** touch points selected while editing supports: copy key and touch point index */
  supportSel: { key: string; i: number }[];
  /** where a touch point being dragged would go (world) */
  supportGhost: [number, number, number] | null;
  /** adding supports: the reference point under the mouse and the foot of its support (world) */
  supportHover: { at: [number, number, number]; foot: [number, number, number] } | null;
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
  /** the Mark widget in the view is open: marked triangles are shown and can be marked in every tool */
  markBar: boolean;
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
  gizmo: 'none',
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
  labelGhost: null,
  contourLines: null,
  supportTick: 0,
  supportPending: 0,
  supportEdit: null,
  buildHidePlatform: false,
  buildLeftTab: 'parts',
  buildRightTab: 'builds',
  panelsCollapsed: (() => {
    try {
      return { left: false, right: false, ...JSON.parse(localStorage.getItem('autonest.panels') ?? '{}') };
    } catch {
      return { left: false, right: false };
    }
  })(),
  supportSel: [],
  supportGhost: null,
  supportHover: null,
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
  markBar: false,
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
    solidify: { ...DEFAULT_SOLIDIFY, source: 'faces', angleTolerance: 20, grow: 'smooth', keep: true, cutPart: false },
    vc: { scope: 'all', split: false, keepOriginal: true, spread: true },
    align: { mode: 'mate', offset: 0, center: true },
    props: { diameter: 2, spacing: 8, margin: 2, maxLength: 10000, embed: 0.5, merge: false, mode: 'single', shape: 'circle', thinEnds: true, tipDiameter: 1, tipLength: 0.5 },
    label: { text: 'LABEL', size: 8, depth: 1, mode: 'emboss', rotation: 0, sink: 0.5, letterSpacing: 0, lineSpacing: 1.25, font: 'sans-bold', conform: true },
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
    remesh: { edgeLength: 1, iterations: 5, featureAngle: 35, source: 'faces', angleTolerance: 20 },
    offset: { mode: 'global', distance: 1, voxel: 0, asCopy: false, smooth: true, angle: 20 },
    blend: { kind: 'fillet', size: 2 },
    cutMode: 'plane',
    joint: { ...DEFAULT_JOINT },
    cutSnap: true,
    polyCut: { ...DEFAULT_POLYCUT },
    polyRecolor: false,
    cutLine: null,
    supports: { ...SUPPORT_PRESETS.sla, skip: [] },
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
  const past = trimHistory([...s.past, { label, parts: s.parts, picks: pickSnap(s), at: Date.now() }], parts);
  const ids = new Set(parts.map((p) => p.id));
  setState({
    parts,
    past,
    future: [],
    selection: (extra.selection ?? s.selection).filter((id) => ids.has(id)),
    ...extra,
  });
}

/**
 * Change a selection (marked triangles, a picked surface / plane / edge) as an
 * undoable step: Ctrl+Z takes back the last pick before any edit of the parts.
 * The samples of one brush stroke (`stroke`) are one step.
 */
export function commitPicks(label: string, patch: Partial<AppState>, opts: { stroke?: boolean } = {}) {
  const s = getState();
  if (s.workspace === 'build') return setState(patch);
  const now = Date.now();
  const last = s.past[s.past.length - 1];
  // samples of one brush stroke (`stroke`) arrive a few ms apart: they make one step
  if (opts.stroke && last?.pickOnly && last.label === label && now - (last.at ?? 0) < 400) {
    // same stroke: keep the step's starting point, just move its time on
    setState({ ...patch, past: [...s.past.slice(0, -1), { ...last, at: now }], future: [] });
    return;
  }
  setState({ ...patch, past: trimHistory([...s.past, { label, parts: s.parts, picks: pickSnap(s), pickOnly: true, at: now }], s.parts), future: [] });
}

/** Undo / redo several steps at once: to just before the `index`-th past step (history list). */
export function jumpHistory(steps: number) {
  for (let i = 0; i < Math.abs(steps); i++) (steps < 0 ? undo : redo)(true);
  const s = getState();
  const at = undoLabel(s);
  notify('info', steps < 0 ? `Undone ${-steps} step${steps < -1 ? 's' : ''}${at ? ` (now after: ${at})` : ''}` : `Redone ${steps} step${steps > 1 ? 's' : ''}`);
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

function buildUndo(quiet = false) {
  const s = getState();
  const prev = s.buildPast[s.buildPast.length - 1];
  if (!prev) return;
  setState({ buildPast: s.buildPast.slice(0, -1), buildFuture: [{ label: prev.label, gen: buildSnapshot(s.buildGen) }, ...s.buildFuture] });
  restoreBuild(prev.gen);
  if (!quiet) notify('info', `Undo: ${prev.label}`);
}

function buildRedo(quiet = false) {
  const s = getState();
  const next = s.buildFuture[0];
  if (!next) return;
  setState({ buildPast: [...s.buildPast, { label: next.label, gen: buildSnapshot(s.buildGen) }], buildFuture: s.buildFuture.slice(1) });
  restoreBuild(next.gen);
  if (!quiet) notify('info', `Redo: ${next.label}`);
}

/** Label of the step Undo / Redo would take back in the workspace in use, or null. */
export function undoLabel(s: AppState, redoStep = false): string | null {
  if (s.workspace === 'build') return (redoStep ? s.buildFuture[0] : s.buildPast[s.buildPast.length - 1])?.label ?? null;
  return (redoStep ? s.future[0] : s.past[s.past.length - 1])?.label ?? null;
}

export function undo(quiet = false) {
  const s = getState();
  if (s.workspace === 'build') return buildUndo(quiet);
  const prev = s.past[s.past.length - 1];
  if (!prev) return;
  const ids = new Set(prev.parts.map((p) => p.id));
  setState({
    parts: prev.parts,
    past: s.past.slice(0, -1),
    future: [{ label: prev.label, parts: s.parts, picks: pickSnap(s), pickOnly: prev.pickOnly }, ...s.future],
    selection: s.selection.filter((id) => ids.has(id)),
    preview: null,
    // the selections as they were before that step (older steps without them: nothing picked)
    ...(prev.picks ?? { faceSelection: null }),
  });
  if (!quiet) notify('info', `Undo: ${prev.label}`);
}

export function redo(quiet = false) {
  const s = getState();
  if (s.workspace === 'build') return buildRedo(quiet);
  const next = s.future[0];
  if (!next) return;
  const ids = new Set(next.parts.map((p) => p.id));
  setState({
    parts: next.parts,
    past: [...s.past, { label: next.label, parts: s.parts, picks: pickSnap(s), pickOnly: next.pickOnly, at: Date.now() }],
    future: s.future.slice(1),
    selection: s.selection.filter((id) => ids.has(id)),
    preview: null,
    ...(next.picks ?? { faceSelection: null }),
  });
  if (!quiet) notify('info', `Redo: ${next.label}`);
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
