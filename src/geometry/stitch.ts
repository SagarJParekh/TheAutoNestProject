import { MeshData, IndexBuffer, compactMesh, triangleCount, computeBounds, boundsDiagonal, removeTriangles } from './mesh';
import { buildTopology, heFrom, heTo } from './topology';
import { findDegenerateTriangles } from './analysis';

export interface StitchResult {
  mesh: MeshData;
  /** boundary vertices merged into a neighbour */
  mergedVertices: number;
  /** boundary edges split at a nearby vertex (T-junctions) */
  splitEdges: number;
  openEdgesBefore: number;
  openEdgesAfter: number;
}

export function defaultStitchTolerance(mesh: MeshData): number {
  return Math.max(1e-4, boundsDiagonal(computeBounds(mesh.positions)) * 1e-4);
}

function openEdgeCount(mesh: MeshData): number {
  const t = buildTopology(mesh);
  let n = 0;
  for (let e = 0; e < t.edgeCount; e++) if (t.edgeFaceCount[e] === 1) n++;
  return n;
}

/**
 * Close cracks between triangles: merges open-boundary vertices that lie
 * within `tolerance` of each other and splits open edges at boundary vertices
 * lying on them (T-junctions). Only boundary geometry is touched.
 */
export function stitchBoundaries(input: MeshData, tolerance = defaultStitchTolerance(input)): StitchResult {
  const openEdgesBefore = openEdgeCount(input);
  let mesh = input;
  let mergedVertices = 0;
  let splitEdges = 0;
  for (let pass = 0; pass < 3; pass++) {
    const m = mergeBoundaryVertices(mesh, tolerance);
    mesh = m.mesh;
    mergedVertices += m.merged;
    const s = splitTJunctions(mesh, tolerance);
    mesh = s.mesh;
    splitEdges += s.split;
    if (m.merged === 0 && s.split === 0) break;
  }
  mesh = removeTriangles(mesh, findDegenerateTriangles(mesh));
  mesh = compactMesh(mesh);
  return { mesh, mergedVertices, splitEdges, openEdgesBefore, openEdgesAfter: openEdgeCount(mesh) };
}

function boundaryVertices(mesh: MeshData): { verts: number[]; topo: ReturnType<typeof buildTopology> } {
  const topo = buildTopology(mesh);
  const flag = new Uint8Array(mesh.positions.length / 3);
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    flag[topo.edgeV0[e]] = 1;
    flag[topo.edgeV1[e]] = 1;
  }
  const verts: number[] = [];
  for (let v = 0; v < flag.length; v++) if (flag[v]) verts.push(v);
  return { verts, topo };
}

function mergeBoundaryVertices(mesh: MeshData, tol: number): { mesh: MeshData; merged: number } {
  const { verts } = boundaryVertices(mesh);
  if (verts.length < 2) return { mesh, merged: 0 };
  const p = mesh.positions;
  const inv = 1 / tol;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const remap = new Int32Array(p.length / 3).fill(-1);
  let merged = 0;
  const tol2 = tol * tol;
  for (const v of verts) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let target = -1;
    for (let dx = -1; dx <= 1 && target < 0; dx++)
      for (let dy = -1; dy <= 1 && target < 0; dy++)
        for (let dz = -1; dz <= 1 && target < 0; dz++) {
          const list = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const w of list) {
            const ex = p[w * 3] - x, ey = p[w * 3 + 1] - y, ez = p[w * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              target = w;
              break;
            }
          }
        }
    if (target >= 0) {
      remap[v] = target;
      merged++;
    } else {
      const k = key(cx, cy, cz);
      const list = grid.get(k);
      if (list) list.push(v);
      else grid.set(k, [v]);
    }
  }
  if (!merged) return { mesh, merged: 0 };
  const idx = mesh.indices.slice();
  for (let i = 0; i < idx.length; i++) if (remap[idx[i]] >= 0) idx[i] = remap[idx[i]];
  return { mesh: { positions: p, indices: idx }, merged };
}

function splitTJunctions(mesh: MeshData, tol: number): { mesh: MeshData; split: number } {
  const { verts, topo } = boundaryVertices(mesh);
  if (verts.length < 3) return { mesh, split: 0 };
  const p = mesh.positions;
  // spatial hash of boundary vertices, cell ~ average boundary edge length
  let sum = 0, cnt = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    const a = topo.edgeV0[e] * 3, b = topo.edgeV1[e] * 3;
    sum += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    cnt++;
  }
  const cell = Math.max(tol * 2, sum / Math.max(1, cnt));
  const inv = 1 / cell;
  const grid = new Map<string, number[]>();
  for (const v of verts) {
    const k = `${Math.floor(p[v * 3] * inv)},${Math.floor(p[v * 3 + 1] * inv)},${Math.floor(p[v * 3 + 2] * inv)}`;
    const l = grid.get(k);
    if (l) l.push(v);
    else grid.set(k, [v]);
  }
  const nt = triangleCount(mesh);
  const splitOf = new Map<number, { k: number; verts: { v: number; t: number }[] }>(); // tri -> edge slot + splits
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    const h = topo.edgeHE0[e];
    const tri = (h / 3) | 0;
    if (splitOf.has(tri)) continue; // one edge per triangle per pass
    const a = heFrom(mesh, h), b = heTo(mesh, h);
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const dx = p[b * 3] - ax, dy = p[b * 3 + 1] - ay, dz = p[b * 3 + 2] - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 === 0) continue;
    const found: { v: number; t: number }[] = [];
    const x0 = Math.floor((Math.min(ax, ax + dx) - tol) * inv), x1 = Math.floor((Math.max(ax, ax + dx) + tol) * inv);
    const y0 = Math.floor((Math.min(ay, ay + dy) - tol) * inv), y1 = Math.floor((Math.max(ay, ay + dy) + tol) * inv);
    const z0 = Math.floor((Math.min(az, az + dz) - tol) * inv), z1 = Math.floor((Math.max(az, az + dz) + tol) * inv);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++)
        for (let gz = z0; gz <= z1; gz++) {
          const list = grid.get(`${gx},${gy},${gz}`);
          if (!list) continue;
          for (const v of list) {
            if (v === a || v === b) continue;
            const vx = p[v * 3] - ax, vy = p[v * 3 + 1] - ay, vz = p[v * 3 + 2] - az;
            const t = (vx * dx + vy * dy + vz * dz) / l2;
            if (t <= 1e-3 || t >= 1 - 1e-3) continue;
            const ex = vx - dx * t, ey = vy - dy * t, ez = vz - dz * t;
            if (ex * ex + ey * ey + ez * ez <= tol * tol) found.push({ v, t });
          }
        }
    if (found.length) {
      found.sort((u, w) => u.t - w.t);
      splitOf.set(tri, { k: h - tri * 3, verts: found });
    }
  }
  if (!splitOf.size) return { mesh, split: 0 };
  const out = new IndexBuffer(mesh.indices.length + splitOf.size * 6);
  const idx = mesh.indices;
  let split = 0;
  for (let t = 0; t < nt; t++) {
    const s = splitOf.get(t);
    if (!s) {
      out.push3(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
      continue;
    }
    const a = idx[t * 3 + s.k], b = idx[t * 3 + ((s.k + 1) % 3)], c = idx[t * 3 + ((s.k + 2) % 3)];
    const chain = [a, ...s.verts.map((x) => x.v), b];
    for (let i = 0; i + 1 < chain.length; i++) out.push3(chain[i], chain[i + 1], c);
    split++;
  }
  return { mesh: { positions: p, indices: out.toArray() }, split };
}
