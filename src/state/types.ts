import type {
  MeshData, Vec3, AnalysisReport, RepairSummary, PerforationParams, PerforationPlan, IntersectionReport, BooleanOp, PropParams,
  LabelParams, TextureParams, Heightmap, MEntity, JointParams, ShapeParams, LatticeParams, WrapParams,
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
  /** where the file came from, as far as the browser tells: folder path inside a dropped / chosen folder + file name */
  sourcePath?: string;
  /** when the part was imported (ms since epoch) */
  importedAt?: number;
  /** bounding-box centre of the body in the source file (used to keep placement when re-importing) */
  importCenter?: Vec3;
  /** orientation locked: the part can be moved in X / Y / Z but never rotated (Mesh prep and Build generation) */
  lockRotation?: boolean;
  /** repaired in Mesh prep: saved (exported) as name_repaired */
  repaired?: boolean;
}

export type ToolId =
  | 'transform' | 'clip' | 'cut' | 'repair' | 'hollow' | 'perforate' | 'extrude' | 'measure' | 'label' | 'texture' | 'align' | 'props'
  | 'dimensions' | 'report' | 'offset' | 'build' | 'boolean' | 'lattice' | 'shapes' | 'wrap' | 'vc';

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
  /** shells hidden in the viewport */
  hidden?: number[];
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
  /** X / Y / Z cut rows, any combination of them; used unless `angled` */
  rows?: Record<'x' | 'y' | 'z', AxisRow>;
  /** one plane at any angle (axis or free, with tilt) instead of the X / Y / Z rows */
  angled?: boolean;
  /** section clip with several planes: cut away only the corner where they all meet (default), or keep only what lies inside all of them */
  combine?: 'corner' | 'common';
  /** clip / cut all parts or only the selected ones */
  scope?: 'all' | 'selected';
}

/** One axis row of the cut / clip panel: on or off, position along the axis (mm) and which side is kept (flip = keep the upper side). */
export interface AxisRow {
  on: boolean;
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
  /** show the preview see-through (x-ray), for edits that change the inside of a part */
  xray?: boolean;
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
  /** multi-face picks: each picked face (its triangles) and the triangle clicked for it */
  groups?: Uint32Array[];
  seeds?: number[];
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
  /** offset: where the user dragged the label, in screen pixels from the measured point (none = beside the parts) */
  label: { pos: Vec3; text: string; offset?: [number, number] };
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
  /** parts it was taken on: deleting one of them removes the measurement */
  partIds?: string[];
}

export interface MeasurePending {
  entities: { entity: MEntity; label: string }[];
  /** points collected for a 3-point circle / 3-point angle */
  points: Vec3[];
}

export type RepairTab = 'fix' | 'shells' | 'edit';

export interface IntersectionEntry {
  mesh: MeshData;
  report: IntersectionReport;
}

export interface ToolSettings {
  repair: { removeSmallShells: boolean; smallShellRatio: number; weldTolerance: number; fillHoles: boolean; stitch: boolean };
  hollow: {
    thickness: number;
    quality: 'draft' | 'normal' | 'fine';
    drainDiameter: number;
    /** hole size where it reaches the cavity, mm (0 = same as the diameter: straight hole) */
    drainExit: number;
    /** keep the cut-out plugs as a separate part */
    keepPlugs: boolean;
    drainHoles: DrainHolePick[];
  };
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
  shape: ShapeParams;
  lattice: LatticeParams;
  wrap: WrapParams & { keep: boolean };
  /** VC module: which parts, split the mould in two halves, keep the master parts */
  vc: { scope: 'all' | 'selected'; split: boolean; keepOriginal: boolean; spread: boolean };
  align: { mode: 'mate' | 'flush'; offset: number; center: boolean };
  props: PropParams & { merge: boolean; mode: 'single' | 'array' };
  label: Omit<LabelParams, 'curveSegments'> & { font: string };
  texture: Omit<TextureParams, 'heightmap'> & { scope: 'face' | 'part'; smooth: boolean; angleTolerance: number };
  arrange: { autoAlignXY: boolean; axes: ('x' | 'y')[]; gap: number; cols: number; rows: number; mirrorCopy: boolean };
  measure: { mode: MeasureMode; pickAs: MeasurePickAs; ortho: boolean };
  /** Dimensions tab: what is drawn on the selected parts */
  dimensions: { showDims: boolean; showName: boolean; showPath: boolean };
  /** Measure tool: wall thickness analysis */
  thickness: {
    show: boolean;
    /** heat map of all thicknesses, or only the areas thinner than the limit */
    view: 'heat' | 'thin';
    /** areas thinner than this are flagged, mm */
    limit: number;
    /** colour scale range, mm (0 = automatic from the part) */
    scaleMin: number;
    scaleMax: number;
  };
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
  cutMode: 'plane' | 'lasso' | 'polyline' | 'joint';
  /** joint cut (lap / tongue joints) along the cut plane */
  joint: JointParams;
  /** drawn cut lines snap their points to the part's corners and sharp edges */
  cutSnap: boolean;
}

export type { RepairSummary, PerforationPlan, BooleanOp, Heightmap, MEntity };

// ---------------------------------------------------------------- build generation

/** Tilt of a part on the platform: lean by `angle` degrees towards `azimuth` (0 = +X, 90 = +Y). */
export interface Tilt {
  angle: number;
  azimuth: number;
  /** extra turn about Z (degrees), used by the automatic fit (e.g. corner to corner on the platform) */
  turn?: number;
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
  /** orientation locked: kept exactly as it came from Mesh prep (no flat-face turn, tilt or 90° turns) */
  lockRotation?: boolean;
  /** cached "largest flat face down" orientation for this mesh */
  orient?: { mesh: MeshData; q: [number, number, number, number]; rule?: 'flat' | 'powder' };
  /** assembly group: all parts of a group get the same orientation (taken from the largest one) */
  group?: string;
  /** closed, consistently oriented surface (undefined while being checked) */
  watertight?: boolean;
  /** the Mesh prep part it came from: sending that part again replaces this one's mesh (e.g. after a repair) */
  fromPrep?: string;
  /** has props to break off (cup, bowl): other parts may be nested inside it */
  breakaway?: boolean;
  /** a cage (sinter box) with parts inside: the settings it was made with and the parts it holds (to take them out again) */
  cage?: { options: import('../geometry').CageOptions; contents: BuildPart[] };
  /** lighter copy for the view when a build would show very many triangles (never used for nesting or export) */
  display?: { for: MeshData; tris: number; mesh: MeshData };
}

/** A copy fixed by the user: locked translation / rotation axes and where it was when locked (or last edited). */
export interface CopyLock {
  /** translation locked along X, Y, Z */
  t: [boolean, boolean, boolean];
  /** rotation locked about X, Y, Z */
  r: [boolean, boolean, boolean];
  build: number;
  position: Vec3;
  quaternion: [number, number, number, number];
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
  /** quick layout of parts that are not nested yet (just to see them; Start nesting arranges them properly) */
  preview?: boolean;
}

export interface BuildGenState {
  printerId: string;
  /** sizes entered for the Custom printers, by printer id */
  customVolumes: Record<string, [number, number, number]>;
  margin: number;
  gap: number;
  zOffset: number;
  /** packing density: height allowance above the tallest part, mm */
  densityAllowance?: number;
  /** powder bed: nest parts by their shape in X, Y and Z (instead of boxes on the platform) */
  nest3d: boolean;
  /** powder bed: minimum distance between parts, mm (0.5 and up) */
  clearance3d: number;
  /** build up to this height above the platform, mm (0 = the printer's full height) */
  maxHeight: number;
  /** 3D nesting resolution */
  nestDetail: 'fast' | 'normal' | 'fine';
  /** stop nesting after this many minutes and keep the best builds found (0 = no limit) */
  nestTimeLimit?: number;
  /** SLA / DLP: layer thickness of SLC exports, mm */
  slcLayer?: number;
  /** set once the per-technology spacing defaults (1 mm on powder beds) apply; older saved sessions lack it */
  spacingDefaults?: number;
  /** powder printers: orientation by best packing (flat face down or on a side, whichever packs best; default) or by the SLS / MJF rules */
  powderOrient?: 'packing' | 'rules';
  /** cage (sinter box) settings: bar thickness, bar width, gap between bars, mm */
  cageSettings?: import('../geometry').CageOptions;
  /** copies locked by the user, by placement key: nesting keeps them (on their locked axes) and arranges the rest around them */
  locks?: Record<string, CopyLock>;
  /** hidden in the view: part ids (every copy) or placement keys (one copy) */
  hidden?: string[];
  /** arrange copies of a part in a regular pattern where that costs no packing density */
  symmetric: boolean;
  /** nest again automatically after every change (otherwise only on Start nesting) */
  autoNest: boolean;
  /** voxel size used by the last 3D nesting, mm */
  nestVoxel?: number;
  /** nesting is still trying more ways: the builds shown are the best found so far */
  improving?: { done: number; total: number } | null;
  /** builds were edited by hand: automatic re-arranging is paused */
  manual?: boolean;
  /** settings changed while edits were kept: re-arranging would apply them */
  stale?: boolean;
  /** results of the last collision / interlock check */
  checks?: { build: number; collisions?: import('../geometry').Collision[]; stuck?: string[]; showOnly: boolean } | null;
  /** tilt parts automatically when they are too tall or too big for the platform */
  autoTilt: boolean;
  /** tilts chosen automatically in the last generation, by part id */
  autoTilts: Record<string, Tilt>;
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
