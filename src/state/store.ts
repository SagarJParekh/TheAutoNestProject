import { create } from 'zustand';
import type {
  AnalysisEntry, DisplayMode, FaceSelection, GizmoMode, Job, Notice, Part, PickMode, PlaneSettings, Preview,
  ToolId, ToolSettings, Transform,
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
  faceSelection: FaceSelection | null;
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
  faceSelection: null,
  preview: null,
  analysis: {},
  settings: {
    repair: { removeSmallShells: false, smallShellRatio: 0.01, weldTolerance: 0, fillHoles: true },
    hollow: { thickness: 2, quality: 'normal', drainDiameter: 4, drainHoles: [] },
    perforate: { pattern: 'round', size: 4, spacing: 2, margin: 2, depth: 0, angle: 0, angleTolerance: 2 },
    extrude: { distance: 5, angleTolerance: 2 },
    cut: { gap: 0 },
    highlight: { open: true, nonManifold: true, flipped: true, holeIndex: null },
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
