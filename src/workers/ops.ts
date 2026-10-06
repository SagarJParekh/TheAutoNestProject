/**
 * Worker operation handlers. Each handler is a plain async function that
 * receives serialisable arguments and returns a result plus the buffers to
 * transfer back. Kept separate from the worker entry so it is testable.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import * as G from '../geometry';
import type { MeshData, Plane, Vec3 } from '../geometry';
import { importFile, PreparedBody } from '../loaders/pipeline';
import type { CadQuality } from '../loaders/types';
import { exportMeshes, exportZip, ExportFormat, ExportItem, ExportOptions } from '../exporters';

export type Progress = (fraction: number, message?: string) => void;

/** Built-in fonts: id -> URL (set by the worker entry; Node tests read files directly). */
export const fontUrls: Record<string, string> = {};
const fontData = new Map<string, Promise<ArrayBuffer>>();
async function builtinFont(id: string): Promise<ArrayBuffer> {
  let p = fontData.get(id);
  if (!p) {
    const url = fontUrls[id];
    if (!url) throw new Error(`Unknown font ${id}`);
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Could not load font ${id}`);
      return r.arrayBuffer();
    });
    fontData.set(id, p);
    p.catch(() => fontData.delete(id));
  }
  return p;
}
type Result<T> = { result: T; transfer?: Transferable[] };

const meshBuffers = (m: MeshData): Transferable[] => [m.positions.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer];

export interface PrepareResult {
  bvh: { version?: number; roots: ArrayBuffer[]; index: null; indirectBuffer: Uint32Array | Uint16Array | null };
  watertight: boolean;
}

export interface CutArgs {
  mesh: MeshData;
  plane: Plane;
}

export const ops = {
  async import(args: { name: string; buffer: ArrayBuffer; siblings?: [string, ArrayBuffer][]; wasmUrls?: { occt?: string; rhino?: string }; cadQuality?: CadQuality }, progress: Progress): Promise<Result<{ bodies: PreparedBody[]; warnings: string[] }>> {
    const warnings: string[] = [];
    const bodies = await importFile(args.buffer, {
      fileName: args.name,
      onProgress: progress,
      siblings: args.siblings ? new Map(args.siblings) : undefined,
      wasmUrls: args.wasmUrls,
      cadQuality: args.cadQuality,
      warn: (m) => warnings.push(m),
    });
    return { result: { bodies, warnings }, transfer: bodies.flatMap((b) => meshBuffers(b.mesh)) };
  },

  /** BVH for picking/clipping (built with indirect so triangle order is preserved) + watertight flag. */
  async prepare(args: { mesh: MeshData }, progress: Progress): Promise<Result<PrepareResult>> {
    progress(0.1, 'Building BVH');
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(args.mesh.positions, 3));
    g.setIndex(new BufferAttribute(args.mesh.indices, 1));
    const bvh = new MeshBVH(g, { indirect: true, targetLeafSize: 10 } as never);
    const s = MeshBVH.serialize(bvh, { cloneBuffers: false });
    progress(0.7, 'Checking topology');
    const watertight = G.isWatertight(args.mesh);
    const transfer: Transferable[] = [...s.roots];
    if (s.indirectBuffer) transfer.push(s.indirectBuffer.buffer as ArrayBuffer);
    return { result: { bvh: { version: (s as { version?: number }).version, roots: s.roots, index: null, indirectBuffer: s.indirectBuffer }, watertight }, transfer };
  },

  async featureEdges(args: { mesh: MeshData; angle: number }): Promise<Result<Float32Array>> {
    const r = G.featureEdges(args.mesh, args.angle);
    return { result: r, transfer: [r.buffer as ArrayBuffer] };
  },

  async analyze(args: { mesh: MeshData }, progress: Progress): Promise<Result<G.AnalysisReport>> {
    progress(0.1, 'Analysing mesh');
    const report = G.analyzeMesh(args.mesh);
    const h = report.highlights;
    return {
      result: report,
      transfer: [h.openEdges, h.nonManifoldEdges, h.flippedTriangles, h.degenerateTriangles, h.duplicateTriangles].map(
        (a) => a.buffer as ArrayBuffer,
      ),
    };
  },

  async repair(args: { mesh: MeshData; options: G.RepairOptions }, progress: Progress): Promise<Result<{ mesh: MeshData; summary: G.RepairSummary }>> {
    const r = G.autoRepair(args.mesh, args.options, progress);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async fillHoles(args: { mesh: MeshData; which?: number[] }, progress: Progress): Promise<Result<{ mesh: MeshData; filled: number }>> {
    progress(0.2, 'Filling holes');
    const r = G.fillHoles(args.mesh, args.which);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async cut(args: CutArgs, progress: Progress): Promise<Result<{ above: MeshData; below: MeshData; method: string }>> {
    progress(0.1, 'Cutting');
    // Fast planar split with capping first; if a watertight input does not give
    // two watertight halves (e.g. tricky cap loops), fall back to exact manifold-3d.
    const closed = G.isWatertight(args.mesh);
    progress(0.3, 'Splitting');
    let r: { above: MeshData; below: MeshData } = G.cutMesh(args.mesh, args.plane, true);
    let method = closed ? 'planar split + cap (watertight)' : 'planar split + cap (input not watertight)';
    if (closed && !(G.isWatertight(r.above) && G.isWatertight(r.below))) {
      progress(0.6, 'Exact boolean split');
      const m = await G.splitByPlaneManifold(args.mesh, args.plane).catch(() => null);
      if (m) {
        r = m;
        method = 'exact (manifold-3d)';
      }
    }
    return { result: { ...r, method }, transfer: [...meshBuffers(r.above), ...meshBuffers(r.below)] };
  },

  async grow(args: { mesh: MeshData; seed: number; angle: number; smooth?: boolean }): Promise<Result<{ tris: Uint32Array; normal: Vec3; centroid: Vec3; area: number }>> {
    const tris = args.smooth ? G.growSmoothRegion(args.mesh, args.seed, args.angle) : G.growCoplanarRegion(args.mesh, args.seed, args.angle);
    const { normal, centroid, area } = G.regionNormal(args.mesh, tris);
    return { result: { tris, normal, centroid, area }, transfer: [tris.buffer as ArrayBuffer] };
  },

  async extrude(args: { mesh: MeshData; tris: Uint32Array; distance: number }, progress: Progress): Promise<Result<MeshData>> {
    progress(0.2, 'Extruding');
    const m = G.extrudeRegion(args.mesh, args.tris, args.distance);
    return { result: m, transfer: meshBuffers(m) };
  },

  async hollow(
    args: { mesh: MeshData; thickness: number; maxVoxels: number; drainHoles: G.DrainHole[]; drainDiameter: number },
    progress: Progress,
  ): Promise<Result<{ mesh: MeshData; voxelSize: number; drained: number }>> {
    if (!G.isWatertight(args.mesh)) throw new Error('Hollowing needs a watertight part. Run Repair first.');
    const r = G.hollowMesh(args.mesh, { thickness: args.thickness, maxVoxels: args.maxVoxels }, (f, m) => progress(f * 0.85, m));
    let mesh = r.mesh;
    if (args.drainHoles.length) {
      progress(0.9, 'Cutting drain holes');
      const cutters = G.drainHoleCutters(args.drainHoles, args.drainDiameter, args.thickness, r.voxelSize);
      mesh = await G.subtractMeshes(mesh, cutters);
    }
    return { result: { mesh, voxelSize: r.voxelSize, drained: args.drainHoles.length }, transfer: meshBuffers(mesh) };
  },

  async perforationPlan(args: { mesh: MeshData; tris: Uint32Array; params: G.PerforationParams }): Promise<Result<G.PerforationPlan>> {
    const plan = G.planPerforation(args.mesh, args.tris, args.params);
    return { result: plan, transfer: [plan.outlines.buffer as ArrayBuffer] };
  },

  async perforate(
    args: { mesh: MeshData; tris: Uint32Array; params: G.PerforationParams; keepPlugs?: boolean },
    progress: Progress,
  ): Promise<Result<{ mesh: MeshData; holes: number; plugs?: MeshData }>> {
    progress(0.1, 'Planning pattern');
    const plan = G.planPerforation(args.mesh, args.tris, args.params);
    if (plan.centers.length === 0) throw new Error('No holes fit in the selected region with these settings.');
    progress(0.3, `Building ${plan.centers.length} cutters`);
    const cutters = G.perforationCutters(args.mesh, plan, args.params.depth ?? 0, G.exitRatioOf(args.params));
    progress(0.5, 'Boolean subtraction');
    const mesh = await G.subtractMeshes(args.mesh, cutters);
    let plugs: MeshData | undefined;
    if (args.keepPlugs) {
      progress(0.8, 'Extracting plugs');
      plugs = await G.intersectWithUnion(args.mesh, cutters);
    }
    return { result: { mesh, holes: plan.centers.length, plugs }, transfer: [...meshBuffers(mesh), ...(plugs ? meshBuffers(plugs) : [])] };
  },

  async stitch(args: { mesh: MeshData; tolerance?: number }, progress: Progress): Promise<Result<G.StitchResult>> {
    progress(0.2, 'Stitching');
    const r = G.stitchBoundaries(args.mesh, args.tolerance);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async intersections(args: { mesh: MeshData }, progress: Progress): Promise<Result<G.IntersectionReport>> {
    progress(0.05, 'Building BVH');
    const r = G.findIntersections(args.mesh, 500000, progress);
    return { result: r, transfer: [r.intersecting.buffer, r.overlapping.buffer, r.overlapPairs.buffer] as ArrayBuffer[] };
  },

  async removeOverlaps(args: { mesh: MeshData }, progress: Progress): Promise<Result<{ mesh: MeshData; removed: number }>> {
    progress(0.1, 'Finding overlaps');
    const r = G.removeOverlappingTriangles(args.mesh, G.findIntersections(args.mesh, 500000, (f, m) => progress(f * 0.9, m)));
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async fixWinding(args: { mesh: MeshData }, progress: Progress): Promise<Result<{ mesh: MeshData; flipped: number }>> {
    progress(0.2, 'Orienting normals');
    const r = G.fixWinding(args.mesh);
    return { result: r, transfer: r.flipped ? meshBuffers(r.mesh) : [] };
  },

  async splitShells(args: { mesh: MeshData }, progress: Progress): Promise<Result<MeshData[]>> {
    progress(0.2, 'Splitting shells');
    const r = G.splitShells(args.mesh);
    return { result: r, transfer: r.length > 1 ? r.flatMap(meshBuffers) : [] };
  },

  async unifyShells(args: { mesh: MeshData }, progress: Progress): Promise<Result<{ mesh: MeshData; shells: number }>> {
    progress(0.2, 'Boolean union of shells');
    const r = await G.unifyShells(args.mesh);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async makeSolid(args: { mesh: MeshData; voxelSize?: number }, progress: Progress): Promise<Result<{ mesh: MeshData; voxelSize: number }>> {
    const h = args.voxelSize && args.voxelSize > 0 ? args.voxelSize : G.chooseSolidVoxel(args.mesh);
    const mesh = G.makeSolid(args.mesh, h, progress);
    return { result: { mesh, voxelSize: h }, transfer: meshBuffers(mesh) };
  },

  async boolean(args: { op: G.BooleanOp; base: MeshData; others: MeshData[] }, progress: Progress): Promise<Result<MeshData>> {
    progress(0.2, `Boolean ${args.op}`);
    const m = await G.booleanMeshes(args.op, args.base, args.others);
    return { result: m, transfer: meshBuffers(m) };
  },

  async props(
    args: { source: MeshData; tris: Uint32Array; target: MeshData; params: G.PropParams; towards?: Vec3 },
    progress: Progress,
  ): Promise<Result<G.PropPlan>> {
    progress(0.2, 'Placing props');
    const r = G.planProps(args.source, args.tris, args.target, args.params, args.towards);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async pointHoles(
    args: { mesh: MeshData; points: G.HolePoint[]; params: G.PerforationParams; keepPlugs?: boolean },
    progress: Progress,
  ): Promise<Result<{ mesh: MeshData; holes: number; plugs?: MeshData }>> {
    if (!args.points.length) throw new Error('Pick at least one hole location');
    progress(0.2, 'Building cutters');
    const cutters = G.pointHoleCutters(args.mesh, args.points, args.params);
    progress(0.4, 'Boolean subtraction');
    const mesh = await G.subtractMeshes(args.mesh, cutters);
    let plugs: MeshData | undefined;
    if (args.keepPlugs) {
      progress(0.8, 'Extracting plugs');
      plugs = await G.intersectWithUnion(args.mesh, cutters);
    }
    return { result: { mesh, holes: args.points.length, plugs }, transfer: [...meshBuffers(mesh), ...(plugs ? meshBuffers(plugs) : [])] };
  },

  async cleanTriangles(args: { mesh: MeshData; what: 'duplicates' | 'degenerate' }, progress: Progress): Promise<Result<{ mesh: MeshData; removed: number }>> {
    progress(0.3, args.what === 'duplicates' ? 'Removing duplicate triangles' : 'Removing degenerate triangles');
    const r = args.what === 'duplicates' ? G.removeDuplicateTriangles(args.mesh) : G.removeDegenerateTriangles(args.mesh);
    return { result: r, transfer: r.removed ? meshBuffers(r.mesh) : [] };
  },

  async fixNonManifold(args: { mesh: MeshData; fill: boolean }, progress: Progress): Promise<Result<{ mesh: MeshData; removed: number; edges: number; filled: number }>> {
    progress(0.2, 'Fixing non-manifold edges');
    const r = G.fixNonManifoldEdges(args.mesh);
    let mesh = r.mesh, filled = 0;
    if (args.fill && r.removed) {
      progress(0.7, 'Filling the openings');
      const f = G.fillHoles(mesh);
      mesh = G.fixWinding(f.mesh).mesh;
      filled = f.filled;
    }
    return { result: { mesh, removed: r.removed, edges: r.edges, filled }, transfer: meshBuffers(mesh) };
  },

  async fitFeature(args: { mesh: MeshData; seed: number; kind: 'cylinder' | 'sphere'; angle?: number }): Promise<Result<{ c: Vec3; axis?: Vec3; r: number; rms: number }>> {
    const region = G.growSmoothRegion(args.mesh, args.seed, args.angle ?? 20);
    if (args.kind === 'sphere') return { result: G.fitSphereRegion(args.mesh, region) };
    const f = G.fitCylinder(args.mesh, region);
    return { result: { c: f.c, axis: f.axis, r: f.r, rms: f.rms } };
  },

  async label(
    args: { mesh: MeshData; font: string | ArrayBuffer; params: G.LabelParams; point: Vec3; normal: Vec3 },
    progress: Progress,
  ): Promise<Result<{ mesh: MeshData; label: MeshData }>> {
    progress(0.1, 'Loading font');
    const font = typeof args.font === 'string' ? await builtinFont(args.font) : args.font;
    progress(0.3, args.params.mode === 'emboss' ? 'Embossing' : 'Engraving');
    const r = await G.applyLabel(args.mesh, font, args.params, args.point, args.normal);
    return { result: r, transfer: [...meshBuffers(r.mesh), ...meshBuffers(r.label)] };
  },

  async texture(args: { mesh: MeshData; tris: Uint32Array | null; params: G.TextureParams }, progress: Progress): Promise<Result<MeshData>> {
    const m = G.textureMesh(args.mesh, args.tris, args.params, progress);
    return { result: m, transfer: meshBuffers(m) };
  },

  async shellInfo(args: { mesh: MeshData }, progress: Progress): Promise<Result<{ shells: G.ShellInfo[]; shellOfTri: Uint32Array }>> {
    progress(0.2, 'Finding shells');
    const r = G.shellInfo(args.mesh);
    return { result: r, transfer: [r.shellOfTri.buffer as ArrayBuffer] };
  },

  async editShells(
    args: { mesh: MeshData; shellOfTri: Uint32Array; ids: number[]; action: 'keep' | 'delete' | 'merge' },
    progress: Progress,
  ): Promise<Result<MeshData>> {
    const ids = new Set(args.ids);
    progress(0.2, args.action === 'merge' ? 'Merging shells' : 'Updating shells');
    let m: MeshData;
    if (args.action === 'merge') m = await G.mergeShells(args.mesh, args.shellOfTri, ids);
    else {
      const keep = new Set<number>();
      let n = 0;
      for (let t = 0; t < args.shellOfTri.length; t++) if (args.shellOfTri[t] >= n) n = args.shellOfTri[t] + 1;
      for (let i = 0; i < n; i++) if (args.action === 'keep' ? ids.has(i) : !ids.has(i)) keep.add(i);
      m = G.keepShells(args.mesh, args.shellOfTri, keep);
    }
    return { result: m, transfer: meshBuffers(m) };
  },

  async fixOpenEdges(
    args: { mesh: MeshData; method: G.OpenEdgeMethod; maxPerimeter?: number; tolerance?: number },
    progress: Progress,
  ): Promise<Result<G.OpenEdgeResult>> {
    progress(0.2, 'Fixing open edges');
    const r = G.fixOpenEdges(args.mesh, args.method, { maxPerimeter: args.maxPerimeter, tolerance: args.tolerance });
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async lassoCut(
    args: { mesh: MeshData; outline: [number, number][]; camera: G.LassoCamera },
    progress: Progress,
  ): Promise<Result<{ inside: MeshData; outside: MeshData }>> {
    progress(0.2, 'Building lasso cutter');
    const cutter = await G.lassoCutter(args.outline, args.camera);
    progress(0.5, 'Splitting');
    const r = await G.lassoSplit(args.mesh, cutter);
    return { result: r, transfer: [...meshBuffers(r.inside), ...meshBuffers(r.outside)] };
  },

  async remesh(
    args: { mesh: MeshData; edgeLength: number; region?: Uint32Array | null; iterations?: number; featureAngle?: number },
    progress: Progress,
  ): Promise<Result<G.RemeshResult>> {
    const r = G.remeshMesh(args.mesh, { edgeLength: args.edgeLength, region: args.region, iterations: args.iterations, featureAngle: args.featureAngle }, progress);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async offset(args: { mesh: MeshData; distance: number; voxelSize?: number }, progress: Progress): Promise<Result<{ mesh: MeshData; voxelSize: number }>> {
    const r = G.offsetMesh(args.mesh, args.distance, { voxelSize: args.voxelSize || undefined }, progress);
    return { result: r, transfer: meshBuffers(r.mesh) };
  },

  async offsetRegion(args: { mesh: MeshData; tris: Uint32Array; distance: number }, progress: Progress): Promise<Result<MeshData>> {
    progress(0.3, 'Offsetting surface');
    const r = G.offsetRegion(args.mesh, args.tris, args.distance);
    return { result: r, transfer: meshBuffers(r) };
  },

  async blend(
    args: { mesh: MeshData; edges: [Vec3, Vec3][]; kind: 'fillet' | 'chamfer'; size: number },
    progress: Progress,
  ): Promise<Result<{ mesh: MeshData; edges: G.SharpEdge[] }>> {
    progress(0.1, 'Finding edges');
    const edges = args.edges.map(([a, b]) => G.findSharpEdge(args.mesh, a, b));
    // the same straight edge picked twice (e.g. two segments of one run) is blended once
    const uniq = edges.filter(
      (e, i) =>
        edges.findIndex((f) => Math.hypot(f.p0[0] - e.p0[0], f.p0[1] - e.p0[1], f.p0[2] - e.p0[2]) + Math.hypot(f.p1[0] - e.p1[0], f.p1[1] - e.p1[1], f.p1[2] - e.p1[2]) < 1e-6) === i,
    );
    progress(0.4, args.kind === 'fillet' ? 'Rounding edges' : 'Bevelling edges');
    const mesh = await G.blendEdges(args.mesh, uniq, args.kind, args.size);
    return { result: { mesh, edges: uniq }, transfer: meshBuffers(mesh) };
  },

  async export(
    args: { format: ExportFormat; items: ExportItem[]; zip: boolean; quality?: number; options?: ExportOptions },
    progress: Progress,
  ): Promise<Result<{ bytes: Uint8Array; trianglesBefore: number; trianglesAfter: number }>> {
    const ratio = args.quality ?? 1;
    let before = 0, after = 0;
    let items = args.items;
    if (ratio < 1) {
      const total = items.reduce((n, it) => n + it.mesh.indices.length, 0) || 1;
      let done = 0;
      items = items.map((it) => {
        const share = it.mesh.indices.length / total;
        const r = G.simplifyMesh(it.mesh, ratio, (f) => progress(0.05 + 0.75 * (done + f * share), 'Reducing triangles'));
        done += share;
        before += r.trianglesBefore;
        after += r.trianglesAfter;
        return { name: it.name, mesh: r.mesh };
      });
    } else {
      for (const it of items) before += it.mesh.indices.length / 3;
      after = before;
    }
    progress(0.85, 'Writing file');
    const bytes = args.zip ? exportZip(args.format, items, args.options) : exportMeshes(args.format, items, args.options);
    return { result: { bytes, trianglesBefore: before, trianglesAfter: after }, transfer: [bytes.buffer as ArrayBuffer] };
  },
};

export type Ops = typeof ops;
export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Parameters<Ops[K]>[0];
export type OpResult<K extends OpName> = Awaited<ReturnType<Ops[K]>>['result'];
