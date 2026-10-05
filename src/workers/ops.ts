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
import { exportMeshes, exportZip, ExportFormat, ExportItem } from '../exporters';

export type Progress = (fraction: number, message?: string) => void;
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
  async import(args: { name: string; buffer: ArrayBuffer; siblings?: [string, ArrayBuffer][]; wasmUrls?: { occt?: string; rhino?: string } }, progress: Progress): Promise<Result<{ bodies: PreparedBody[]; warnings: string[] }>> {
    const warnings: string[] = [];
    const bodies = await importFile(args.buffer, {
      fileName: args.name,
      onProgress: progress,
      siblings: args.siblings ? new Map(args.siblings) : undefined,
      wasmUrls: args.wasmUrls,
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

  async grow(args: { mesh: MeshData; seed: number; angle: number }): Promise<Result<{ tris: Uint32Array; normal: Vec3; centroid: Vec3; area: number }>> {
    const tris = G.growCoplanarRegion(args.mesh, args.seed, args.angle);
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

  async perforate(args: { mesh: MeshData; tris: Uint32Array; params: G.PerforationParams }, progress: Progress): Promise<Result<{ mesh: MeshData; holes: number }>> {
    progress(0.1, 'Planning pattern');
    const plan = G.planPerforation(args.mesh, args.tris, args.params);
    if (plan.centers.length === 0) throw new Error('No holes fit in the selected region with these settings.');
    progress(0.3, `Building ${plan.centers.length} cutters`);
    const cutters = G.perforationCutters(args.mesh, plan, args.params.depth ?? 0);
    progress(0.5, 'Boolean subtraction');
    const mesh = await G.subtractMeshes(args.mesh, cutters);
    return { result: { mesh, holes: plan.centers.length }, transfer: meshBuffers(mesh) };
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

  async export(args: { format: ExportFormat; items: ExportItem[]; zip: boolean }, progress: Progress): Promise<Result<Uint8Array>> {
    progress(0.2, 'Writing file');
    const bytes = args.zip ? exportZip(args.format, args.items) : exportMeshes(args.format, args.items);
    return { result: bytes, transfer: [bytes.buffer as ArrayBuffer] };
  },
};

export type Ops = typeof ops;
export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Parameters<Ops[K]>[0];
export type OpResult<K extends OpName> = Awaited<ReturnType<Ops[K]>>['result'];
