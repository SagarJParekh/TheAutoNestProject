import type {
  MeshData, Vec3, AnalysisReport, RepairSummary, PerforationParams, PerforationPlan, IntersectionReport, BooleanOp, PropParams,
  LabelParams, TextureParams, Heightmap, MEntity,
} from '../geometry';

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
  /** bounding-box centre of the body in the source file (used to keep placement when re-importing) */
  importCenter?: Vec3;
}

export type ToolId =
  | 'transform' | 'clip' | 'cut' | 'repair' | 'hollow' | 'perforate' | 'extrude' | 'measure' | 'label' | 'texture' | 'align' | 'props';

/** Shell browser state for one part (shell ids index `shells`). */
export interface ShellView {
  partId: string;
  mesh: MeshData;
  shells: import('../geometry').ShellInfo[];
  shellOfTri: Uint32Array;
  selected: number[];
  hover: number | null;
  /** show only the selected shells in the viewport */
  isolate: boolean;
}

/** Manual triangle editing: selected triangles to delete, or vertices picked for a new triangle. */
export interface TriEdit {
  partId: string;
  mesh: MeshData;
  tris: number[];
  verts: number[];
}
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
  /** tilt of an axis plane about its two perpendicular world axes, degrees */
  tiltA?: number;
  tiltB?: number;
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
  /** the mesh the triangle ids refer to (a pick goes stale when the part's mesh changes) */
  mesh?: MeshData;
}

export interface AnalysisEntry {
  mesh: MeshData;
  report: AnalysisReport;
}

export interface DrainHolePick {
  point: Vec3; // world
  normal: Vec3; // world
}

export type PickMode = null | 'layflat' | 'face' | 'drain' | 'point' | 'measure' | 'triangle' | 'vertex';

/** Which face slot a 'face' pick fills: the extrude/perforate selection or one of the repair picks. */
export type PickSlot = 'primary' | 'alignSource' | 'alignTarget' | 'propsA' | 'propsB' | 'flip' | 'texture';

/** A point picked on a part surface, stored in the part's local space so it follows the part. */
export interface PointPick {
  partId: string;
  mesh: MeshData;
  point: Vec3;
  normal: Vec3;
}

export type PointSlot = 'label' | 'propStart' | 'propEnd' | 'perfPoint';

export type MeasureMode = 'distance' | 'angle' | 'diameter' | 'thickness';
export type MeasurePickAs = 'point' | 'edge' | 'surface' | 'circle' | 'circle3' | 'sphere';

export interface MeasureDraw {
  points: Vec3[];
  segments: [Vec3, Vec3][];
  circles: { c: Vec3; n: Vec3; r: number }[];
  label: { pos: Vec3; text: string };
}

export interface Measurement {
  id: number;
  mode: MeasureMode;
  title: string;
  value: number;
  unit: 'mm' | '°';
  extras: { label: string; value: number; unit: 'mm' | '°' }[];
  note?: string;
  draw: MeasureDraw;
}

export interface MeasurePending {
  entities: { entity: MEntity; label: string }[];
  /** points collected for a 3-point circle / 3-point angle */
  points: Vec3[];
}

export type RepairTab = 'fix' | 'shells' | 'combine' | 'edit';

export interface IntersectionEntry {
  mesh: MeshData;
  report: IntersectionReport;
}

export interface ToolSettings {
  repair: { removeSmallShells: boolean; smallShellRatio: number; weldTolerance: number; fillHoles: boolean; stitch: boolean };
  hollow: { thickness: number; quality: 'draft' | 'normal' | 'fine'; drainDiameter: number; drainHoles: DrainHolePick[] };
  perforate: PerforationParams & { angleTolerance: number; mode: 'array' | 'points' };
  extrude: { distance: number; angleTolerance: number };
  cut: { gap: number };
  highlight: { open: boolean; nonManifold: boolean; flipped: boolean; holeIndex: number | null };
  stitch: { tolerance: number };
  normals: { show: boolean };
  solid: { voxelSize: number };
  boolean: { op: BooleanOp };
  align: { mode: 'mate' | 'flush'; offset: number; center: boolean };
  props: PropParams & { merge: boolean; mode: 'single' | 'array' };
  label: Omit<LabelParams, 'curveSegments'> & { font: string };
  texture: Omit<TextureParams, 'heightmap'> & { scope: 'face' | 'part'; smooth: boolean; angleTolerance: number };
  arrange: { bedWidth: number; gap: number; cols: number; rows: number; mirrorCopy: boolean };
  measure: { mode: MeasureMode; pickAs: MeasurePickAs; ortho: boolean };
  importQuality: 'draft' | 'normal' | 'fine' | 'ultra';
  align2: { location: 'center' | 'left' | 'right' | 'front' | 'back'; axis: 'x' | 'y' | 'both'; beside: boolean; distance: number };
  perforateExtra: { keepPlugs: boolean };
  openEdges: { maxPerimeter: number };
  triEdit: { mode: 'delete' | 'create'; smooth: boolean; angle: number };
  cutMode: 'plane' | 'lasso';
}

export type { RepairSummary, PerforationPlan, BooleanOp, Heightmap, MEntity };
