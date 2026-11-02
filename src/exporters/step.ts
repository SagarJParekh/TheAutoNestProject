/**
 * STEP export (ISO 10303-21, AP214) of meshes as B-rep solids
 * (MANIFOLD_SOLID_BREP of planar ADVANCED_FACEs with shared edges): every
 * part becomes a product with a closed shell. Flat areas are merged into
 * single planar faces (with holes as inner loops), so prismatic parts come
 * out with clean faces; curved areas stay as flat facets.
 */
import type { ExportItem } from './index';

const enc = new TextEncoder();

/** STEP real: always with a decimal point. */
function num(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  if (Math.abs(v) < 1e-12) return '0.';
  const s = String(+v.toPrecision(12));
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return `${m.includes('.') ? m : `${m}.`}E${e}`;
  }
  return s.includes('.') ? s : `${s}.`;
}

const str = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;

interface Face {
  outer: number[];
  holes: number[][];
  /** unit normal of the face's plane */
  n: [number, number, number];
}

/** Weld the mesh and merge coplanar neighbouring triangles into polygon faces. */
function planarFaces(positions: ArrayLike<number>, indices: ArrayLike<number>): { pts: number[]; faces: Face[] } {
  // weld by position
  const map = new Map<string, number>();
  const pts: number[] = [];
  const remap = new Int32Array(positions.length / 3);
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = pts.length / 3;
      pts.push(x, y, z);
      map.set(k, id);
    }
    remap[v] = id;
  }
  const tri: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  const nt = tri.length / 3;
  const P = (i: number, k: number) => pts[i * 3 + k];
  const nrm = new Float64Array(nt * 3), off = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2);
    const vx = P(c, 0) - P(a, 0), vy = P(c, 1) - P(a, 1), vz = P(c, 2) - P(a, 2);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    nrm[t * 3] = nx;
    nrm[t * 3 + 1] = ny;
    nrm[t * 3 + 2] = nz;
    off[t] = nx * P(a, 0) + ny * P(a, 1) + nz * P(a, 2);
  }
  // directed edge -> triangle
  const ekey = (a: number, b: number) => a * 4294967296 + b;
  const owner = new Map<number, number>();
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) owner.set(ekey(tri[t * 3 + e], tri[t * 3 + ((e + 1) % 3)]), t);
  // size of the part, for the flatness tolerance
  let ext = 0;
  for (let i = 0; i < pts.length; i++) ext = Math.max(ext, Math.abs(pts[i]));
  const tol = Math.max(1e-6, ext * 1e-7);
  const region = new Int32Array(nt).fill(-1);
  const faces: Face[] = [];
  for (let s = 0; s < nt; s++) {
    if (region[s] >= 0) continue;
    // grow a flat region
    const members = [s];
    region[s] = s;
    for (let q = 0; q < members.length; q++) {
      const t = members[q];
      for (let e = 0; e < 3; e++) {
        const u = owner.get(ekey(tri[t * 3 + ((e + 1) % 3)], tri[t * 3 + e]));
        if (u === undefined || region[u] >= 0) continue;
        const d = nrm[u * 3] * nrm[s * 3] + nrm[u * 3 + 1] * nrm[s * 3 + 1] + nrm[u * 3 + 2] * nrm[s * 3 + 2];
        if (d < 1 - 1e-9) continue;
        let flat = true;
        for (let k = 0; k < 3 && flat; k++) {
          const v = tri[u * 3 + k];
          if (Math.abs(nrm[s * 3] * P(v, 0) + nrm[s * 3 + 1] * P(v, 1) + nrm[s * 3 + 2] * P(v, 2) - off[s]) > tol) flat = false;
        }
        if (!flat) continue;
        region[u] = s;
        members.push(u);
      }
    }
    const single = () =>
      members.forEach((t) => faces.push({ outer: [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]], holes: [], n: [nrm[t * 3], nrm[t * 3 + 1], nrm[t * 3 + 2]] }));
    if (members.length === 1) {
      single();
      continue;
    }
    // boundary loops of the region (edges whose twin lies outside it), in the triangles' direction
    const next = new Map<number, number[]>();
    let edges = 0;
    for (const t of members)
      for (let e = 0; e < 3; e++) {
        const a = tri[t * 3 + e], b = tri[t * 3 + ((e + 1) % 3)];
        const u = owner.get(ekey(b, a));
        if (u !== undefined && region[u] === s) continue;
        const l = next.get(a);
        if (l) l.push(b);
        else next.set(a, [b]);
        edges++;
      }
    const loops: number[][] = [];
    let ok = true;
    let used = 0;
    for (const [start] of next) {
      while ((next.get(start)?.length ?? 0) > 0) {
        const loop = [start];
        let cur = next.get(start)!.pop()!;
        used++;
        let guard = edges + 1;
        while (cur !== start && guard-- > 0) {
          loop.push(cur);
          const l = next.get(cur);
          if (!l || !l.length) {
            ok = false;
            break;
          }
          cur = l.pop()!;
          used++;
        }
        if (!ok || cur !== start) {
          ok = false;
          break;
        }
        loops.push(loop);
      }
      if (!ok) break;
    }
    if (!ok || used !== edges || !loops.length) {
      single();
      continue;
    }
    const nx = nrm[s * 3], ny = nrm[s * 3 + 1], nz = nrm[s * 3 + 2];
    const clean = loops;
    // signed area along the normal: the outer loop runs counter-clockwise (positive)
    const area = (loop: number[]) => {
      let ax = 0, ay = 0, az = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        ax += P(a, 1) * P(b, 2) - P(a, 2) * P(b, 1);
        ay += P(a, 2) * P(b, 0) - P(a, 0) * P(b, 2);
        az += P(a, 0) * P(b, 1) - P(a, 1) * P(b, 0);
      }
      return (ax * nx + ay * ny + az * nz) / 2;
    };
    const outers = clean.filter((l) => l.length >= 3 && area(l) > 0);
    const holes = clean.filter((l) => l.length >= 3 && area(l) < 0);
    if (outers.length !== 1 || clean.some((l) => l.length < 3)) {
      single();
      continue;
    }
    faces.push({ outer: outers[0], holes, n: [nx, ny, nz] });
  }
  dropStraightPoints(pts, faces);
  return { pts, faces };
}

/**
 * Drop loop points in the middle of straight edges: only where exactly two
 * faces use the point and it lies on a straight line in both (so the edge they
 * share stays the same edge on both sides).
 */
function dropStraightPoints(pts: number[], faces: Face[]) {
  const P = (i: number, k: number) => pts[i * 3 + k];
  const loopsOf = new Map<number, { loop: number[]; i: number }[]>();
  const all = faces.flatMap((f) => [f.outer, ...f.holes]);
  for (const loop of all)
    loop.forEach((v, i) => {
      const l = loopsOf.get(v);
      if (l) l.push({ loop, i });
      else loopsOf.set(v, [{ loop, i }]);
    });
  const straight = (loop: number[], i: number) => {
    const v = loop[i], a = loop[(i - 1 + loop.length) % loop.length], b = loop[(i + 1) % loop.length];
    const ux = P(v, 0) - P(a, 0), uy = P(v, 1) - P(a, 1), uz = P(v, 2) - P(a, 2);
    const wx = P(b, 0) - P(v, 0), wy = P(b, 1) - P(v, 1), wz = P(b, 2) - P(v, 2);
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const dot = ux * wx + uy * wy + uz * wz;
    return dot > 0 && Math.hypot(cx, cy, cz) <= 1e-9 * Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz);
  };
  const drop = new Set<number>();
  for (const [v, uses] of loopsOf) if (uses.length === 2 && uses.every((u) => straight(u.loop, u.i))) drop.add(v);
  if (!drop.size) return;
  for (const f of faces) {
    const keep = (l: number[]) => {
      const r = l.filter((v) => !drop.has(v));
      return r.length >= 3 ? r : l;
    };
    f.outer = keep(f.outer);
    f.holes = f.holes.map(keep);
  }
}

/** Write the parts as one STEP file (one product per part). */
export function exportSTEP(items: ExportItem[]): Uint8Array {
  const lines: string[] = [];
  let id = 0;
  const add = (e: string) => {
    lines.push(`#${++id}=${e};`);
    return id;
  };
  const now = new Date().toISOString().slice(0, 19);
  const ac = add(`APPLICATION_CONTEXT('automotive design')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ac})`);
  const pc = add(`PRODUCT_CONTEXT('',#${ac},'mechanical')`);
  const pdc = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ac},'design')`);
  const lu = add(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
  const au = add(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
  const su = add(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lu},'distance_accuracy_value','confusion accuracy')`);
  const ctx = add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) REPRESENTATION_CONTEXT('Context3D','3D context'))`,
  );
  const o = add(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const zd = add(`DIRECTION('',(0.,0.,1.))`);
  const xd = add(`DIRECTION('',(1.,0.,0.))`);
  const axis = add(`AXIS2_PLACEMENT_3D('',#${o},#${zd},#${xd})`);
  for (const it of items) {
    const { pts, faces } = planarFaces(it.mesh.positions, it.mesh.indices);
    if (!faces.length) continue;
    const P = (i: number, k: number) => pts[i * 3 + k];
    const cp = new Map<number, number>();
    const vp = new Map<number, number>();
    const point = (v: number) => {
      let r = cp.get(v);
      if (r === undefined) cp.set(v, (r = add(`CARTESIAN_POINT('',(${num(P(v, 0))},${num(P(v, 1))},${num(P(v, 2))}))`)));
      return r;
    };
    const vertex = (v: number) => {
      let r = vp.get(v);
      if (r === undefined) vp.set(v, (r = add(`VERTEX_POINT('',#${point(v)})`)));
      return r;
    };
    // one edge per pair of points, used forwards by one face and backwards by the other
    const edges = new Map<string, { id: number; from: number }>();
    const edge = (a: number, b: number) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let e = edges.get(k);
      if (!e) {
        const dx = P(b, 0) - P(a, 0), dy = P(b, 1) - P(a, 1), dz = P(b, 2) - P(a, 2);
        const len = Math.hypot(dx, dy, dz) || 1;
        const dir = add(`DIRECTION('',(${num(dx / len)},${num(dy / len)},${num(dz / len)}))`);
        const vec = add(`VECTOR('',#${dir},${num(len)})`);
        const line = add(`LINE('',#${point(a)},#${vec})`);
        e = { id: add(`EDGE_CURVE('',#${vertex(a)},#${vertex(b)},#${line},.T.)`), from: a };
        edges.set(k, e);
      }
      return add(`ORIENTED_EDGE('',*,*,#${e.id},${e.from === a ? '.T.' : '.F.'})`);
    };
    const faceIds: number[] = [];
    for (const f of faces) {
      const loop = (l: number[]) => add(`EDGE_LOOP('',(${l.map((v, i) => `#${edge(v, l[(i + 1) % l.length])}`).join(',')}))`);
      const bounds = [add(`FACE_OUTER_BOUND('',#${loop(f.outer)},.T.)`), ...f.holes.map((h) => add(`FACE_BOUND('',#${loop(h)},.T.)`))];
      // plane through the first point, normal out of the solid, reference along the first edge
      const a0 = f.outer[0], a1 = f.outer[1];
      let rx = P(a1, 0) - P(a0, 0), ry = P(a1, 1) - P(a0, 1), rz = P(a1, 2) - P(a0, 2);
      const d = rx * f.n[0] + ry * f.n[1] + rz * f.n[2];
      rx -= d * f.n[0];
      ry -= d * f.n[1];
      rz -= d * f.n[2];
      const rl = Math.hypot(rx, ry, rz) || 1;
      const zdir = add(`DIRECTION('',(${num(f.n[0])},${num(f.n[1])},${num(f.n[2])}))`);
      const xdir = add(`DIRECTION('',(${num(rx / rl)},${num(ry / rl)},${num(rz / rl)}))`);
      const place = add(`AXIS2_PLACEMENT_3D('',#${point(a0)},#${zdir},#${xdir})`);
      const plane = add(`PLANE('',#${place})`);
      faceIds.push(add(`ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${plane},.T.)`));
    }
    const shell = add(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`);
    const brep = add(`MANIFOLD_SOLID_BREP(${str(it.name)},#${shell})`);
    const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(it.name)},(#${brep},#${axis}),#${ctx})`);
    const prod = add(`PRODUCT(${str(it.name)},${str(it.name)},'',(#${pc}))`);
    add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
    const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
    const pd = add(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
    const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
    add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  }
  const head =
    `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('AutoNest solid export'),'2;1');\n` +
    `FILE_NAME(${str(items.length === 1 ? items[0].name : 'parts')},'${now}',(''),(''),'AutoNest','AutoNest','');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`;
  return enc.encode(head + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n');
}

export { planarFaces };
