import { MeshData, Vec3, FloatBuffer, IndexBuffer, compactMesh, triangleCount } from './mesh';
import { buildTopology, heFrom, heTo, Topology } from './topology';
import { regionBoundaryHalfEdges, regionNormal } from './select';

/**
 * Extrude a region of triangles along a direction (default: the region's
 * average normal) by `distance` mm. Negative distances push the region in.
 * Side walls are stitched along the region border so a watertight input
 * stays watertight.
 */
export function extrudeRegion(
  mesh: MeshData,
  regionTris: ArrayLike<number>,
  distance: number,
  direction?: Vec3,
  topo: Topology = buildTopology(mesh),
): MeshData {
  if (regionTris.length === 0 || distance === 0) return mesh;
  const dir = direction ?? regionNormal(mesh, regionTris).normal;
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const ox = (dir[0] / dl) * distance, oy = (dir[1] / dl) * distance, oz = (dir[2] / dl) * distance;
  const nt = triangleCount(mesh);
  const inRegion = new Uint8Array(nt);
  for (let i = 0; i < regionTris.length; i++) inRegion[regionTris[i]] = 1;

  const p = mesh.positions;
  const pos = new FloatBuffer(p.length + regionTris.length * 9);
  pos.data.set(p);
  pos.length = p.length;
  const moved = new Map<number, number>();
  const mv = (v: number): number => {
    let id = moved.get(v);
    if (id === undefined) {
      id = pos.push3(p[v * 3] + ox, p[v * 3 + 1] + oy, p[v * 3 + 2] + oz);
      moved.set(v, id);
    }
    return id;
  };

  const out = new IndexBuffer(mesh.indices.length + regionTris.length * 6);
  const idx = mesh.indices;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (inRegion[t]) out.push3(mv(a), mv(b), mv(c));
    else out.push3(a, b, c);
  }
  // side walls: for border half-edge a->b of the region: quad a, b, b', a'
  for (const h of regionBoundaryHalfEdges(mesh, regionTris, topo)) {
    const a = heFrom(mesh, h), b = heTo(mesh, h);
    const a2 = mv(a), b2 = mv(b);
    out.push3(a, b, b2);
    out.push3(a, b2, a2);
  }
  return compactMesh({ positions: pos.toArray(), indices: out.toArray() });
}
