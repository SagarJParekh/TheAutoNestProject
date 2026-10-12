import { MeshData, compactMesh, triangleCount, subsetTriangles, ProgressFn, noProgress, removeTriangles, flipTriangles } from './mesh';
import { weldVertices, defaultWeldTolerance } from './weld';
import { findDegenerateTriangles, findDuplicateTriangles, findFlippedTriangles, analyzeMesh } from './analysis';
import { fillHoles, findBoundaryLoops } from './holes';
import { buildTopology, findShells } from './topology';
import { stitchBoundaries } from './stitch';

export interface RepairOptions {
  /** weld distance in mm; undefined = automatic (tiny, relative to size) */
  weldTolerance?: number;
  removeDegenerate?: boolean;
  removeDuplicates?: boolean;
  fixWinding?: boolean;
  fillHoles?: boolean;
  /** close cracks by merging nearby boundary vertices and fixing T-junctions */
  stitch?: boolean;
  stitchTolerance?: number;
  /** resolve edges shared by more than two triangles (default on) */
  fixNonManifold?: boolean;
  /** remove floating shells smaller than `smallShellRatio` of the largest shell's volume */
  removeSmallShells?: boolean;
  smallShellRatio?: number;
  /** counts from an analysis already run on this mesh (skips re-analysis) */
  before?: RepairCounts;
}

export interface RepairCounts {
  triangles: number;
  vertices: number;
  openEdges: number;
  nonManifoldEdges: number;
  holes: number;
  flippedTriangles: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  shells: number;
  watertight: boolean;
}

export interface RepairSummary {
  weldedVertices: number;
  degenerateRemoved: number;
  duplicatesRemoved: number;
  trianglesFlipped: number;
  holesFilled: number;
  shellsRemoved: number;
  stitchedVertices: number;
  stitchedEdges: number;
  nonManifoldFixed: number;
  before: RepairCounts;
  after: RepairCounts;
}

export function repairCounts(mesh: MeshData): RepairCounts {
  const r = analyzeMesh(mesh);
  return {
    triangles: r.triangles,
    vertices: r.vertices,
    openEdges: r.openEdges,
    nonManifoldEdges: r.nonManifoldEdges,
    holes: r.holes,
    flippedTriangles: r.flippedTriangles,
    degenerateTriangles: r.degenerateTriangles,
    duplicateTriangles: r.duplicateTriangles,
    shells: r.shells,
    watertight: r.watertight,
  };
}

/** Make winding consistent and outward-facing. Returns number of triangles flipped. */
export function fixWinding(mesh: MeshData): { mesh: MeshData; flipped: number } {
  const flipped = findFlippedTriangles(mesh, buildTopology(mesh));
  return { mesh: flipTriangles(mesh, flipped), flipped: flipped.length };
}

/** Remove shells whose |volume| is below ratio × the largest shell's |volume|. */
export function removeSmallShells(mesh: MeshData, ratio = 0.01): { mesh: MeshData; removed: number } {
  const { shellOfTri, shellCount } = findShells(mesh);
  if (shellCount < 2) return { mesh, removed: 0 };
  const vol = new Float64Array(shellCount);
  const p = mesh.positions, idx = mesh.indices;
  const nt = triangleCount(mesh);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    vol[shellOfTri[t]] +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  let max = 0;
  for (let i = 0; i < shellCount; i++) max = Math.max(max, Math.abs(vol[i]));
  const keepShell = new Uint8Array(shellCount);
  let removed = 0;
  for (let i = 0; i < shellCount; i++) {
    keepShell[i] = Math.abs(vol[i]) >= ratio * max ? 1 : 0;
    if (!keepShell[i]) removed++;
  }
  if (removed === 0) return { mesh, removed: 0 };
  return { mesh: subsetTriangles(mesh, (t) => keepShell[shellOfTri[t]] === 1), removed };
}

/** One-click repair pipeline with a before/after summary. */
export function autoRepair(
  input: MeshData,
  options: RepairOptions = {},
  onProgress: ProgressFn = noProgress,
): { mesh: MeshData; summary: RepairSummary } {
  const opts = {
    removeDegenerate: true,
    removeDuplicates: true,
    fixWinding: true,
    fillHoles: true,
    stitch: true,
    fixNonManifold: true,
    removeSmallShells: false,
    smallShellRatio: 0.01,
    ...options,
  };
  onProgress(0, 'Analysing');
  const before = opts.before ?? repairCounts(input);
  let mesh = input;

  onProgress(0.15, 'Welding vertices');
  const tol = opts.weldTolerance ?? defaultWeldTolerance(mesh.positions);
  const w = weldVertices(mesh.positions, mesh.indices, tol);
  mesh = compactMesh(w.mesh);
  const weldedVertices = input.positions.length / 3 - mesh.positions.length / 3;

  let degenerateRemoved = 0;
  if (opts.removeDegenerate) {
    onProgress(0.3, 'Removing degenerate triangles');
    const d = findDegenerateTriangles(mesh);
    degenerateRemoved = d.length;
    mesh = removeTriangles(mesh, d);
  }
  let duplicatesRemoved = 0;
  if (opts.removeDuplicates) {
    onProgress(0.4, 'Removing duplicate triangles');
    // opposite copies are faces shared by two shells: keep them (the non-manifold step separates the shells)
    const d = findDuplicateTriangles(mesh, true);
    duplicatesRemoved = d.length;
    mesh = removeTriangles(mesh, d);
  }
  let stitchedVertices = 0, stitchedEdges = 0;
  if (opts.stitch) {
    onProgress(0.45, 'Stitching cracks');
    const r = stitchBoundaries(mesh, opts.stitchTolerance);
    mesh = r.mesh;
    stitchedVertices = r.mergedVertices;
    stitchedEdges = r.splitEdges;
  }
  let nonManifoldFixed = 0;
  if (opts.fixNonManifold) {
    onProgress(0.48, 'Fixing non-manifold edges');
    // auto repair never throws pieces away: only split, so every shell is kept
    const r = fixNonManifoldEdges(mesh, { removeLoose: false });
    if (r.edges) {
      mesh = r.mesh;
      nonManifoldFixed = r.edges;
    }
  }
  let trianglesFlipped = 0;
  if (opts.fixWinding) {
    onProgress(0.5, 'Fixing winding');
    const r = fixWinding(mesh);
    mesh = r.mesh;
    trianglesFlipped += r.flipped;
  }
  let holesFilled = 0;
  if (opts.fillHoles) {
    onProgress(0.65, 'Filling holes');
    const loops = findBoundaryLoops(mesh);
    if (loops.length) {
      const r = fillHoles(mesh, undefined, loops);
      mesh = r.mesh;
      holesFilled = r.filled;
      if (opts.fixWinding) {
        const f = fixWinding(mesh);
        mesh = f.mesh;
        trianglesFlipped += f.flipped;
      }
    }
  }
  let shellsRemoved = 0;
  if (opts.removeSmallShells) {
    onProgress(0.8, 'Removing small shells');
    const r = removeSmallShells(mesh, opts.smallShellRatio);
    mesh = r.mesh;
    shellsRemoved = r.removed;
  }
  mesh = compactMesh(mesh);
  onProgress(0.9, 'Verifying');
  const after = repairCounts(mesh);
  onProgress(1);
  return {
    mesh,
    summary: {
      weldedVertices: Math.max(0, weldedVertices),
      degenerateRemoved,
      duplicatesRemoved,
      trianglesFlipped,
      holesFilled,
      shellsRemoved,
      stitchedVertices,
      stitchedEdges,
      nonManifoldFixed,
      before,
      after,
    },
  };
}

/**
 * Make every edge used by at most two triangles, keeping as much of the
 * surface as possible.
 *
 * At each non-manifold edge the triangles are sorted by angle around the
 * edge and neighbouring, consistently oriented triangles are paired (pairs
 * that face the empty space between them win ties, so the outer skin is kept
 * over internal walls). Each pair then gets its own copy of the edge: the
 * vertices are split per connected fan, which also fixes non-manifold
 * (bow-tie) vertices. Solids that only touch along an edge come apart into
 * clean closed shells instead of losing triangles. Copies are nudged a
 * hair apart so a later weld doesn't join them again.
 *
 * Triangles left without a partner are open; small open pieces that contain
 * them (fins, internal walls, stray flaps) are removed. Holes left behind can
 * then be filled.
 */
export function fixNonManifoldEdges(
  mesh: MeshData,
  opts: { removeLoose?: boolean } = {},
): { mesh: MeshData; removed: number; edges: number; split: number } {
  const removeLoose = opts.removeLoose ?? true;
  const topo = buildTopology(mesh);
  const p = mesh.positions, idx = mesh.indices;
  const nHE = idx.length, nt = nHE / 3;
  const next = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);
  // half-edges per edge (CSR)
  const cnt = new Uint32Array(topo.edgeCount + 1);
  for (let h = 0; h < nHE; h++) cnt[topo.halfEdgeEdge[h] + 1]++;
  for (let e = 0; e < topo.edgeCount; e++) cnt[e + 1] += cnt[e];
  const fillAt = cnt.slice(0, topo.edgeCount);
  const heOf = new Uint32Array(nHE);
  for (let h = 0; h < nHE; h++) heOf[fillAt[topo.halfEdgeEdge[h]]++] = h;

  // corners (= half-edge start) of the same vertex are joined across shared edges
  const parent = new Int32Array(nHE);
  for (let i = 0; i < nHE; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  // join two triangles across the edge of half-edges h1, h2
  const join = (h1: number, h2: number) => {
    const a1 = h1, b1 = next(h1), a2 = h2, b2 = next(h2);
    if (idx[a1] === idx[a2]) {
      union(a1, a2);
      union(b1, b2);
    } else {
      union(a1, b2);
      union(b1, a2);
    }
  };
  const area = (t: number) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };

  // patches: triangles connected across ordinary (two-triangle) edges
  const tp = new Int32Array(nt);
  for (let i = 0; i < nt; i++) tp[i] = i;
  const tfind = (x: number): number => {
    while (tp[x] !== x) {
      tp[x] = tp[tp[x]];
      x = tp[x];
    }
    return x;
  };
  for (let e = 0; e < topo.edgeCount; e++) {
    if (cnt[e + 1] - cnt[e] !== 2) continue;
    const r1 = tfind((heOf[cnt[e]] / 3) | 0), r2 = tfind((heOf[cnt[e] + 1] / 3) | 0);
    if (r1 !== r2) tp[r1] = r2;
  }
  const patchArea = new Float64Array(nt);
  for (let t = 0; t < nt; t++) patchArea[tfind(t)] += area(t);

  let edges = 0;
  const unpaired = new Uint8Array(nt);
  for (let e = 0; e < topo.edgeCount; e++) {
    const s0 = cnt[e], s1 = cnt[e + 1], m = s1 - s0;
    if (m === 2) join(heOf[s0], heOf[s0 + 1]);
    if (m <= 2) continue;
    edges++;
    // radial order around the edge a→b
    const va = topo.edgeV0[e], vb = topo.edgeV1[e];
    const ax = p[vb * 3] - p[va * 3], ay = p[vb * 3 + 1] - p[va * 3 + 1], az = p[vb * 3 + 2] - p[va * 3 + 2];
    const al = Math.hypot(ax, ay, az) || 1;
    const ux = ax / al, uy = ay / al, uz = az / al;
    // reference direction perpendicular to the edge
    let rx = Math.abs(ux) < 0.9 ? 1 : 0, ry = Math.abs(ux) < 0.9 ? 0 : 1, rz = 0;
    const d0 = rx * ux + ry * uy + rz * uz;
    rx -= d0 * ux; ry -= d0 * uy; rz -= d0 * uz;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const sx = uy * rz - uz * ry, sy = uz * rx - ux * rz, sz = ux * ry - uy * rx;
    const faces: { h: number; t: number; ang: number; dir: number }[] = [];
    for (let k = s0; k < s1; k++) {
      const h = heOf[k];
      const t = (h / 3) | 0;
      const c = idx[next(next(h))];
      const vx = p[c * 3] - p[va * 3], vy = p[c * 3 + 1] - p[va * 3 + 1], vz = p[c * 3 + 2] - p[va * 3 + 2];
      faces.push({ h, t, ang: Math.atan2(vx * sx + vy * sy + vz * sz, vx * rx + vy * ry + vz * rz), dir: idx[h] === va ? 1 : -1 });
    }
    faces.sort((f, g) => f.ang - g.ang);
    // try every way of pairing radial neighbours; best = most consistent pairs,
    // then pairs from the same patch (so the fans come apart when the vertices
    // are split), then the largest patches (outer skin over fins / walls)
    let best: [number, number][] = [], bestScore = -1;
    for (let st = 0; st < (m % 2 ? m : 2); st++) {
      const pairs: [number, number][] = [];
      let score = 0;
      for (let k = 0; k + 1 < m; k += 2) {
        const f = faces[(st + k) % m], g = faces[(st + k + 1) % m];
        if (f.dir === g.dir) continue;
        pairs.push([f.h, g.h]);
        // normal of a +1 face points towards increasing angle: into the wedge f→g
        const pf = tfind(f.t), pg = tfind(g.t);
        score += 1e12 + (pf === pg ? 1e9 : 0) + Math.min(1e8, patchArea[pf] + patchArea[pg]) + (f.dir === 1 ? 1 : 0);
      }
      if (score > bestScore) {
        bestScore = score;
        best = pairs;
      }
    }
    const used = new Set<number>();
    for (const [h1, h2] of best) {
      join(h1, h2);
      used.add(h1);
      used.add(h2);
    }
    for (const f of faces) if (!used.has(f.h)) unpaired[f.t] = 1;
  }

  // one vertex per corner group
  const vid = new Int32Array(nHE).fill(-1);
  const remap = new Int32Array(nHE);
  const srcOf: number[] = [];
  for (let h = 0; h < nHE; h++) {
    const r = find(h);
    if (vid[r] < 0) {
      vid[r] = srcOf.length;
      srcOf.push(idx[h]);
    }
    remap[h] = vid[r];
  }
  const nv = srcOf.length;
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) positions.set(p.subarray(srcOf[v] * 3, srcOf[v] * 3 + 3), v * 3);
  const indices = new Uint32Array(nHE);
  for (let h = 0; h < nHE; h++) indices[h] = remap[h];
  let used = 0;
  {
    const seen = new Uint8Array(p.length / 3);
    for (let h = 0; h < nHE; h++) if (!seen[idx[h]]) (seen[idx[h]] = 1), used++;
  }
  const split = nv - used;

  if (split > 0) {
    // nudge the extra copies of a split vertex towards their own triangles
    const copies = new Map<number, number[]>();
    for (let v = 0; v < nv; v++) {
      const l = copies.get(srcOf[v]);
      if (l) l.push(v);
      else copies.set(srcOf[v], [v]);
    }
    const cx = new Float64Array(nv * 3), cn = new Uint32Array(nv), minEdge = new Float64Array(nv).fill(Infinity);
    for (let t = 0; t < nt; t++) {
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      const gx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
      const gy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
      const gz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
      for (const v of [a, b, c]) {
        cx[v * 3] += gx; cx[v * 3 + 1] += gy; cx[v * 3 + 2] += gz;
        cn[v]++;
      }
      const len = (i: number, j: number) => Math.hypot(positions[i * 3] - positions[j * 3], positions[i * 3 + 1] - positions[j * 3 + 1], positions[i * 3 + 2] - positions[j * 3 + 2]);
      const lab = len(a, b), lbc = len(b, c), lca = len(c, a);
      minEdge[a] = Math.min(minEdge[a], lab, lca);
      minEdge[b] = Math.min(minEdge[b], lab, lbc);
      minEdge[c] = Math.min(minEdge[c], lbc, lca);
    }
    const eps = Math.max(defaultWeldTolerance(p) * 20, 2e-3);
    for (const list of copies.values()) {
      if (list.length < 2) continue;
      for (const v of list) {
        if (!cn[v]) continue;
        const dx = cx[v * 3] / cn[v] - positions[v * 3], dy = cx[v * 3 + 1] / cn[v] - positions[v * 3 + 1], dz = cx[v * 3 + 2] / cn[v] - positions[v * 3 + 2];
        const dl = Math.hypot(dx, dy, dz);
        if (!dl) continue;
        const step = Math.min(eps, minEdge[v] * 0.1);
        positions[v * 3] += (dx / dl) * step;
        positions[v * 3 + 1] += (dy / dl) * step;
        positions[v * 3 + 2] += (dz / dl) * step;
      }
    }
  }

  let out: MeshData = { positions, indices };
  // drop small open pieces that hold unpaired triangles (fins, internal walls)
  let removed = 0;
  if (removeLoose && unpaired.some((x) => x)) {
    const { shellOfTri, shellCount } = findShells(out);
    const size = new Uint32Array(shellCount), hasUnpaired = new Uint8Array(shellCount);
    for (let t = 0; t < nt; t++) {
      size[shellOfTri[t]]++;
      if (unpaired[t]) hasUnpaired[shellOfTri[t]] = 1;
    }
    const t2 = buildTopology(out);
    const open = new Uint8Array(shellCount);
    for (let e = 0; e < t2.edgeCount; e++) if (t2.edgeFaceCount[e] === 1) open[shellOfTri[(t2.edgeHE0[e] / 3) | 0]] = 1;
    const drop: number[] = [];
    for (let t = 0; t < nt; t++) {
      const sh = shellOfTri[t];
      if (hasUnpaired[sh] && open[sh] && size[sh] < nt * 0.5) drop.push(t);
    }
    if (drop.length) {
      removed = drop.length;
      out = removeTriangles(out, Uint32Array.from(drop));
    }
  }
  out = compactMesh(out);
  // edges that splitting could not resolve (a surface pinched onto itself): drop extra triangles
  const rest = removeLoose ? dropNonManifoldTriangles(out) : { mesh: out, removed: 0 };
  if (rest.removed) {
    out = rest.mesh;
    removed += rest.removed;
  }
  return { mesh: out, removed, edges, split };
}

/** Fallback: at each remaining non-manifold edge keep the best consistent pair, remove the others. */
function dropNonManifoldTriangles(mesh: MeshData): { mesh: MeshData; removed: number } {
  let cur = mesh;
  let removed = 0;
  for (let pass = 0; pass < 4; pass++) {
    const topo = buildTopology(cur);
    const bad = new Map<number, number[]>();
    for (let e = 0; e < topo.edgeCount; e++) if (topo.edgeFaceCount[e] > 2) bad.set(e, []);
    if (!bad.size) break;
    for (let h = 0; h < topo.halfEdgeEdge.length; h++) {
      const list = bad.get(topo.halfEdgeEdge[h]);
      if (list) list.push(h);
    }
    const p = cur.positions, idx = cur.indices;
    const area = (t: number) => {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    const drop = new Set<number>();
    for (const hs of bad.values()) {
      const live = hs.filter((h) => !drop.has((h / 3) | 0));
      if (live.length <= 2) continue;
      let best: [number, number] | null = null, bestScore = -1;
      for (let i = 0; i < live.length; i++)
        for (let j = i + 1; j < live.length; j++) {
          const ti = (live[i] / 3) | 0, tj = (live[j] / 3) | 0;
          const consistent = idx[live[i]] !== idx[live[j]];
          const score = (consistent ? 1e12 : 0) + area(ti) + area(tj);
          if (score > bestScore) {
            bestScore = score;
            best = [ti, tj];
          }
        }
      for (const h of live) {
        const t = (h / 3) | 0;
        if (best && t !== best[0] && t !== best[1]) drop.add(t);
      }
    }
    if (!drop.size) break;
    removed += drop.size;
    cur = removeTriangles(cur, Uint32Array.from(drop));
  }
  return { mesh: cur, removed };
}

/** Remove triangles that repeat an earlier triangle's three vertices. */
export function removeDuplicateTriangles(mesh: MeshData): { mesh: MeshData; removed: number } {
  const d = findDuplicateTriangles(mesh);
  return { mesh: removeTriangles(mesh, d), removed: d.length };
}

/** Remove zero-area / collapsed triangles. */
export function removeDegenerateTriangles(mesh: MeshData): { mesh: MeshData; removed: number } {
  const d = findDegenerateTriangles(mesh);
  return { mesh: removeTriangles(mesh, d), removed: d.length };
}
