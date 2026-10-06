import { create } from 'zustand';
import type {
  AnalysisEntry, DisplayMode, FaceSelection, GizmoMode, IntersectionEntry, Job, Notice, Part, PickMode, PickSlot, PlaneSettings,
  Preview, RepairTab, ToolId, ToolSettings, Transform, PointPick, PointSlot, Measurement, MeasurePending, Heightmap, ShellView, TriEdit,
  BlendEdgePick,
} from './types';
import type { MeshData } from '../geometry';

export interface HistoryEntry {
  label: string;
  parts: Part[];
}

export interface AppState {
  parts: Part[];
  past: HistoryEntry[];
  future: HistoryEntry[];
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

const defaultPlane = (axis: PlaneSettings['axis']): PlaneSettings => ({ axis, azimuth: 30, elevation: 20, offset: 0, flip: false });

export const useStore = create<AppState>(() => ({
  parts: [],
  past: [],
  future: [],
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
  showSearch: false,
  preview: null,
  analysis: {},
  settings: {
    repair: { removeSmallShells: false, smallShellRatio: 0.01, weldTolerance: 0, fillHoles: true, stitch: true },
    hollow: { thickness: 2, quality: 'normal', drainDiameter: 4, drainHoles: [] },
    perforate: { pattern: 'round', size: 4, spacing: 2, margin: 2, depth: 0, angle: 0, angleTolerance: 2, mode: 'array', exitSize: 0 },
    extrude: { distance: 5, angleTolerance: 2 },
    cut: { gap: 0 },
    highlight: { open: true, nonManifold: true, flipped: true, holeIndex: null },
    stitch: { tolerance: 0 },
    normals: { show: false, outColor: '#22c55e', inColor: '#ff3b4e', orientation: false, frontColor: '#3fa7ff', backColor: '#ff3b4e' },
    solid: { voxelSize: 0 },
    boolean: { op: 'union' },
    align: { mode: 'mate', offset: 0, center: true },
    props: { diameter: 2, spacing: 8, margin: 2, maxLength: 50, embed: 0.5, merge: false, mode: 'single' },
    label: { text: 'LABEL', size: 8, depth: 1, mode: 'emboss', rotation: 0, sink: 0.5, letterSpacing: 0, font: 'sans-bold', conform: true },
    texture: {
      pattern: 'knurl', period: 2, depth: 0.4, angle: 0, projection: 'planar', invert: false, resolution: 0,
      scope: 'face', smooth: false, angleTolerance: 2, imageFit: 'fit',
    },
    arrange: { bedWidth: 220, bedDepth: 220, bedHeight: 250, axes: ['x', 'y'], gap: 5, cols: 2, rows: 2, mirrorCopy: false },
    measure: { mode: 'distance', pickAs: 'point', ortho: true },
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
const HISTORY_BYTES = 1.5e9;
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

export function undo() {
  const s = getState();
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
export function notify(kind: Notice['kind'], text: string, ttl = kind === 'error' ? 9000 : 4000) {
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
