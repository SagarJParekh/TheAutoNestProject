import type { MeshData, Vec3, AnalysisReport, BoundaryLoop, RepairSummary, PerforationParams, PerforationPlan } from '../geometry';

export interface Transform {
  /** mm */
  position: Vec3;
  /** Euler XYZ, degrees */
  rotation: Vec3;
  scale: Vec3;
}

export interface Part {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  /** local-space mesh; treated as immutable (replace, never mutate) */
  mesh: MeshData;
  transform: Transform;
  source?: string;
}

export type ToolId = 'transform' | 'clip' | 'cut' | 'repair' | 'hollow' | 'perforate' | 'extrude';
export type DisplayMode = 'shaded' | 'edges' | 'wireframe' | 'xray';
export type GizmoMode = 'translate' | 'rotate' | 'none';
export type ViewName = 'top' | 'front' | 'side' | 'iso' | 'bottom' | 'back';

export interface PlaneSettings {
  axis: 'x' | 'y' | 'z' | 'free';
  /** free orientation: azimuth around Z and elevation from the XY plane, degrees */
  azimuth: number;
  elevation: number;
  /** offset along the normal, mm (world) */
  offset: number;
  flip: boolean;
}

export interface Job {
  id: number;
  label: string;
  progress: number;
  message?: string;
  cancel?: () => void;
}

export interface Notice {
  id: number;
  kind: 'error' | 'warning' | 'info' | 'success';
  text: string;
}

export interface PreviewMesh {
  mesh: MeshData; // world space
  color: string;
  name: string;
}

export interface Preview {
  tool: ToolId;
  label: string;
  /** parts hidden/ghosted while the preview is shown */
  replaces: string[];
  meshes: PreviewMesh[];
  /** extra overlay segments (world space) */
  lines?: Float32Array;
  summary?: string[];
  /** called when the user presses Apply */
  apply: () => void;
}

export interface FaceSelection {
  partId: string;
  seed: number;
  /** triangle ids in the part's local mesh */
  tris: Uint32Array;
  /** local-space normal and centroid */
  normal: Vec3;
  centroid: Vec3;
  area: number;
}

export interface AnalysisEntry {
  mesh: MeshData;
  report: AnalysisReport & { loops: BoundaryLoop[] };
}

export interface DrainHolePick {
  point: Vec3; // world
  normal: Vec3; // world
}

export type PickMode = null | 'layflat' | 'face' | 'drain';

export interface ToolSettings {
  repair: { removeSmallShells: boolean; smallShellRatio: number; weldTolerance: number; fillHoles: boolean };
  hollow: { thickness: number; quality: 'draft' | 'normal' | 'fine'; drainDiameter: number; drainHoles: DrainHolePick[] };
  perforate: PerforationParams & { angleTolerance: number };
  extrude: { distance: number; angleTolerance: number };
  cut: { gap: number };
  highlight: { open: boolean; nonManifold: boolean; flipped: boolean; holeIndex: number | null };
}

export type { RepairSummary, PerforationPlan };
