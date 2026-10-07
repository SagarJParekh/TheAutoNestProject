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
  | 'transform' | 'clip' | 'cut' | 'repair' | 'hollow' | 'perforate' | 'extrude' | 'measure' | 'label' | 'texture' | 'align' | 'props'
  | 'dimensions' | 'report' | 'offset' | 'build';

/** An edge picked for fillet / chamfer, stored in the part's local space. */
export interface BlendEdgePick {
  partId: string;
  mesh: MeshData;
  a: Vec3;
  b: Vec3;
}

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
  /** bridge: open edges (in their triangle's direction) on each side */
  bridgeA?: [number, number][];
  bridgeB?: [number, number][];
}
export type DisplayMode = 'shaded' | 'edges' | 'wireframe' | 'xray';
export type GizmoMode = 'translate' | 'rotate' | 'place' | 'none';
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

export type PickMode = null | 'layflat' | 'face' | 'drain' | 'point' | 'measure' | 'triangle' | 'vertex' | 'brush' | 'window' | 'edge' | 'sharpEdge';

/** How a click / drag marks triangles in Repair → Edit. */
export type MarkTool = 'triangle' | 'plane' | 'surface' | 'shell' | 'brush' | 'window';

/** Which face slot a 'face' pick fills: the extrude/perforate selection or one of the repair picks. */
export type PickSlot = 'primary' | 'alignSource' | 'alignTarget' | 'propsA' | 'propsB' | 'flip' | 'texture' | 'offset';

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
  normals: {
    show: boolean;
    /** colour of normal hairs on correctly oriented (outward) triangles */
    outColor: string;
    /** colour of normal hairs on inverted (inward) triangles */
    inColor: string;
    /** colour all parts by orientation: front faces / back faces */
    orientation: boolean;
    frontColor: string;
    backColor: string;
  };
  solid: { voxelSize: number };
  boolean: { op: BooleanOp };
  align: { mode: 'mate' | 'flush'; offset: number; center: boolean };
  props: PropParams & { merge: boolean; mode: 'single' | 'array' };
  label: Omit<LabelParams, 'curveSegments'> & { font: string };
  texture: Omit<TextureParams, 'heightmap'> & { scope: 'face' | 'part'; smooth: boolean; angleTolerance: number };
  arrange: { autoAlignXY: boolean; bedWidth: number; bedDepth: number; bedHeight: number; axes: ('x' | 'y' | 'z')[]; gap: number; cols: number; rows: number; mirrorCopy: boolean };
  measure: { mode: MeasureMode; pickAs: MeasurePickAs; ortho: boolean };
  importQuality: 'draft' | 'normal' | 'fine' | 'ultra';
  align2: { location: 'center' | 'left' | 'right' | 'front' | 'back'; axis: 'x' | 'y' | 'both'; beside: boolean; distance: number };
  perforateExtra: { keepPlugs: boolean };
  openEdges: { maxPerimeter: number };
  triEdit: {
    mode: 'mark' | 'create' | 'bridge';
    /** which side of the bridge the next picked edge goes to */
    bridgeSide: 'A' | 'B';
    markTool: MarkTool;
    /** max crease between neighbours for "mark surface", degrees */
    angle: number;
    /** normal tolerance for "mark plane", degrees */
    planeAngle: number;
    /** brush radius, mm */
    brushRadius: number;
    /** window marking also takes hidden triangles behind the visible surface */
    windowThrough: boolean;
  };
  remesh: { edgeLength: number; iterations: number; featureAngle: number };
  offset: {
    mode: 'global' | 'local';
    /** mm; positive grows the part / pushes the surface out */
    distance: number;
    /** global: voxel size in mm, 0 = automatic */
    voxel: number;
    /** global: keep the original and add the offset as a new part */
    asCopy: boolean;
    /** local: grow the picked face across smooth curvature */
    smooth: boolean;
    angle: number;
  };
  blend: { kind: 'fillet' | 'chamfer'; size: number };
  cutMode: 'plane' | 'lasso' | 'polyline';
}

export type { RepairSummary, PerforationPlan, BooleanOp, Heightmap, MEntity };

// ---------------------------------------------------------------- build generation

/** Tilt of a part on the platform: lean by `angle` degrees towards `azimuth` (0 = +X, 90 = +Y). */
export interface Tilt {
  angle: number;
  azimuth: number;
}

export interface BuildPart {
  id: string;
  name: string;
  color: string;
  /** mesh centred on its bounding box, in its original orientation */
  mesh: MeshData;
  quantity: number;
  /** per-part tilt; null = use the global tilt */
  tilt: Tilt | null;
  /** cached "largest flat face down" orientation for this mesh */
  orient?: { mesh: MeshData; q: [number, number, number, number] };
}

export interface BuildPlacement {
  /** partId#copy */
  key: string;
  partId: string;
  copy: number;
  position: Vec3;
  quaternion: [number, number, number, number];
}

export interface Build {
  name: string;
  placements: BuildPlacement[];
  /** tallest point above the platform, mm */
  height: number;
  /** platform area covered, 0..1 */
  utilization: number;
}

export interface BuildGenState {
  printerId: string;
  /** sizes entered for the Custom printers, by printer id */
  customVolumes: Record<string, [number, number, number]>;
  margin: number;
  gap: number;
  zOffset: number;
  groupHeights: boolean;
  heightTolerance: number;
  autoOrient: boolean;
  allowRotate: boolean;
  stack: boolean;
  tilt: Tilt;
  parts: BuildPart[];
  builds: Build[];
  unplaced: { partId: string; copy: number; reason: string }[];
  active: number;
  busy: boolean;
}
