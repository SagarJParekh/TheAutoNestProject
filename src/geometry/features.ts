import { MeshData, triangleCount } from './mesh';
import { buildTopology, Topology } from './topology';

/**
 * Line segments (xyz xyz) for "feature" edges: open/non-manifold edges and
 * edges whose dihedral angle exceeds `angleDeg`. Used for the
 * shaded-with-edges display mode.
 */
export function featureEdges(mesh: MeshData, angleDeg = 30, topo: Topology = buildTopology(mesh)): Float32Array {
  const nt = triangleCount(mesh);
  const normals = new Float32Array(nt * 3);
  const p = mesh.positions, idx = mesh.indices;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l;
  }
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const sel = new Uint8Array(topo.edgeCount);
  let count = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 2) {
      sel[e] = 1;
      count++;
      continue;
    }
    const t0 = (topo.edgeHE0[e] / 3) | 0, t1 = (topo.edgeHE1[e] / 3) | 0;
    const d = normals[t0 * 3] * normals[t1 * 3] + normals[t0 * 3 + 1] * normals[t1 * 3 + 1] + normals[t0 * 3 + 2] * normals[t1 * 3 + 2];
    if (d < cosT) {
      sel[e] = 1;
      count++;
    }
  }
  const out = new Float32Array(count * 6);
  let o = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (!sel[e]) continue;
    const a = topo.edgeV0[e] * 3, b = topo.edgeV1[e] * 3;
    out[o++] = p[a]; out[o++] = p[a + 1]; out[o++] = p[a + 2];
    out[o++] = p[b]; out[o++] = p[b + 1]; out[o++] = p[b + 2];
  }
  return out;
}
