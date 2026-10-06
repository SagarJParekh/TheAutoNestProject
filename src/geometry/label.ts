/**
 * 3D text labels: outlines from a TrueType/OpenType font (opentype.js),
 * turned into a manifold solid with manifold-3d's CrossSection (which
 * resolves overlapping glyph contours), placed on a surface point and
 * embossed (union) or engraved (subtract).
 */
import opentype from 'opentype.js';
import { MeshData, Vec3 } from './mesh';
import { applyMatrix } from './transform';
import { booleanMeshes, fromManifold, getManifold } from './manifold';
import { Vector3 } from 'three';
import { makeBVH } from './sdf';

export interface LabelParams {
  text: string;
  /** font size (em height) in mm */
  size: number;
  /** emboss height or engrave depth, mm */
  depth: number;
  mode: 'emboss' | 'engrave';
  /** rotation of the text around the surface normal, degrees */
  rotation: number;
  /** emboss only: how far the letters sink into the surface (helps on curved faces), mm */
  sink: number;
  /** extra spacing between letters, in em */
  letterSpacing?: number;
  /** curve flattening segments per Bézier */
  curveSegments?: number;
  /** bend the letters to follow the surface instead of a flat plane */
  conform?: boolean;
}

const fontCache = new WeakMap<ArrayBuffer, opentype.Font>();

export function loadFont(data: ArrayBuffer): opentype.Font {
  let f = fontCache.get(data);
  if (!f) {
    try {
      f = opentype.parse(data);
    } catch (e) {
      throw new Error(`Could not read the font file: ${(e as Error).message}`);
    }
    fontCache.set(data, f);
  }
  return f;
}

type Poly = [number, number][];

/**
 * Closed outline polygons for the text (y up, mm), centred on the origin.
 * Multiple lines are separated by "\n".
 */
export function textOutlines(fontData: ArrayBuffer, text: string, size: number, letterSpacing = 0, segments = 6): { polys: Poly[]; width: number; height: number } {
  const font = loadFont(fontData);
  const lines = text.split('\n');
  const lineHeight = size * 1.25;
  const polys: Poly[] = [];
  lines.forEach((line, li) => {
    if (!line.trim()) return;
    // manual layout: glyph by glyph with kerning (avoids GSUB feature processing)
    const scale = size / font.unitsPerEm;
    const glyphs = Array.from(line).map((ch) => font.charToGlyph(ch));
    const commands: opentype.PathCommand[] = [];
    let x = 0;
    glyphs.forEach((g, gi) => {
      commands.push(...g.getPath(x, li * lineHeight, size).commands);
      x += (g.advanceWidth ?? 0) * scale + letterSpacing * size;
      const next = glyphs[gi + 1];
      if (next) x += font.getKerningValue(g, next) * scale;
    });
    const width = x - letterSpacing * size;
    const path = { commands };
    let cur: Poly = [];
    let lx = 0, ly = 0;
    const push = (x: number, y: number) => {
      const p: [number, number] = [x - width / 2, -y];
      const last = cur[cur.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) cur.push(p);
      lx = x;
      ly = y;
    };
    const close = () => {
      if (cur.length > 2) {
        const a = cur[0], b = cur[cur.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) cur.pop();
        if (cur.length > 2) polys.push(cur);
      }
      cur = [];
    };
    for (const c of path.commands as (opentype.PathCommand & Record<string, number>)[]) {
      switch (c.type) {
        case 'M':
          close();
          push(c.x, c.y);
          break;
        case 'L':
          push(c.x, c.y);
          break;
        case 'Q': {
          const x0 = lx, y0 = ly;
          for (let i = 1; i <= segments; i++) {
            const t = i / segments, mt = 1 - t;
            push(mt * mt * x0 + 2 * mt * t * c.x1 + t * t * c.x, mt * mt * y0 + 2 * mt * t * c.y1 + t * t * c.y);
          }
          break;
        }
        case 'C': {
          const x0 = lx, y0 = ly;
          for (let i = 1; i <= segments; i++) {
            const t = i / segments, mt = 1 - t;
            push(
              mt * mt * mt * x0 + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t * t * t * c.x,
              mt * mt * mt * y0 + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t * t * t * c.y,
            );
          }
          break;
        }
        case 'Z':
          close();
          break;
      }
    }
    close();
  });
  if (!polys.length) throw new Error('The text has no printable characters in this font');
  // centre vertically too
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (const p of polys) for (const q of p) {
    q[0] -= cx;
    q[1] -= cy;
  }
  return { polys, width: maxX - minX, height: maxY - minY };
}

/** Orthonormal frame on a surface point: x = text right, y = text up, z = surface normal. */
export function labelFrame(point: Vec3, normal: Vec3, rotationDeg = 0, upHint?: Vec3): number[] {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  let up: Vec3 = upHint ?? (Math.abs(n[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1]);
  const d = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];
  up = [up[0] - n[0] * d, up[1] - n[1] * d, up[2] - n[2] * d];
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  up = [up[0] / ul, up[1] / ul, up[2] / ul];
  let r: Vec3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const a = (rotationDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r2: Vec3 = [r[0] * ca + up[0] * sa, r[1] * ca + up[1] * sa, r[2] * ca + up[2] * sa];
  const u2: Vec3 = [-r[0] * sa + up[0] * ca, -r[1] * sa + up[1] * ca, -r[2] * sa + up[2] * ca];
  r = r2;
  return [r[0], r[1], r[2], 0, u2[0], u2[1], u2[2], 0, n[0], n[1], n[2], 0, point[0], point[1], point[2], 1];
}

/** The text as a closed solid placed on the surface (not yet combined with the part). */
export async function labelSolid(
  fontData: ArrayBuffer,
  params: LabelParams,
  point: Vec3,
  normal: Vec3,
  upHint?: Vec3,
  surface?: MeshData,
): Promise<MeshData> {
  if (!params.text.trim()) throw new Error('Enter some text');
  if (!(params.size > 0) || !(params.depth > 0)) throw new Error('Size and depth must be positive');
  const { polys } = textOutlines(fontData, params.text, params.size, params.letterSpacing ?? 0, params.curveSegments ?? 6);
  const wasm = await getManifold();
  const cs = new wasm.CrossSection(polys, 'NonZero');
  const z0 = params.mode === 'emboss' ? -Math.max(0, params.sink) : -params.depth;
  const z1 = params.mode === 'emboss' ? params.depth : 0.5;
  let solid = cs.extrude(z1 - z0);
  cs.delete();
  if (params.conform && surface) {
    // fine triangles so the letters can bend with the surface
    const refined = solid.refineToLength(Math.max(0.15, Math.min(params.size / 12, 1)));
    solid.delete();
    solid = refined;
  }
  const local = fromManifold(solid);
  solid.delete();
  for (let i = 2; i < local.positions.length; i += 3) local.positions[i] += z0;
  const frame = labelFrame(point, normal, params.rotation, upHint);
  if (params.conform && surface) return conformToSurface(local, frame, surface);
  return applyMatrix(local, frame);
}

/**
 * Wrap a label solid (local x/y on the label plane, z = height) onto a
 * surface like a decal: x and y are measured as distances along the surface
 * (walking from the label point and staying on the surface), and the height
 * is applied along the surface normal there. Letters keep their size on
 * curved parts instead of stretching as a straight projection would.
 */
export function conformToSurface(local: MeshData, frame: number[], surface: MeshData, step?: number): MeshData {
  const bvh = makeBVH(surface);
  const gi = bvh.geometry.index!.array as ArrayLike<number>;
  const gp = bvh.geometry.attributes.position.array as ArrayLike<number>;
  const R = new Vector3(frame[0], frame[1], frame[2]);
  const N = new Vector3(frame[8], frame[9], frame[10]);
  const O = new Vector3(frame[12], frame[13], frame[14]);
  const p = local.positions;
  let minX = Infinity, maxX = -Infinity, maxAbsY = 0;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]);
    maxX = Math.max(maxX, p[i]);
    maxAbsY = Math.max(maxAbsY, Math.abs(p[i + 1]));
  }
  const ds = step ?? Math.max(0.05, Math.min(0.5, (maxX - minX + 2 * maxAbsY) / 400));
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  // smooth normals for the letter heights: per corner, the area-weighted average of the faces
  // around that vertex that meet the current face at less than ~40° (sharp edges stay sharp)
  const nf = gi.length / 3;
  const fnrm = new Float32Array(nf * 3), farea = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = gi[f * 3] * 3, b = gi[f * 3 + 1] * 3, c = gi[f * 3 + 2] * 3;
    const ux = gp[b] - gp[a], uy = gp[b + 1] - gp[a + 1], uz = gp[b + 2] - gp[a + 2];
    const vx = gp[c] - gp[a], vy = gp[c + 1] - gp[a + 1], vz = gp[c + 2] - gp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fnrm[f * 3] = nx / l; fnrm[f * 3 + 1] = ny / l; fnrm[f * 3 + 2] = nz / l;
    farea[f] = l;
  }
  const nv = gp.length / 3;
  const vfStart = new Uint32Array(nv + 1);
  for (let i = 0; i < gi.length; i++) vfStart[gi[i] + 1]++;
  for (let v = 0; v < nv; v++) vfStart[v + 1] += vfStart[v];
  const vfList = new Uint32Array(gi.length);
  {
    const fill = vfStart.slice(0, nv);
    for (let i = 0; i < gi.length; i++) vfList[fill[gi[i]]++] = (i / 3) | 0;
  }
  const COS_CREASE = Math.cos((40 * Math.PI) / 180);
  const cornerNormal = (v: number, f: number, out: number[]) => {
    const fx = fnrm[f * 3], fy = fnrm[f * 3 + 1], fz = fnrm[f * 3 + 2];
    let x = 0, y = 0, z = 0;
    for (let i = vfStart[v]; i < vfStart[v + 1]; i++) {
      const g = vfList[i];
      const gx = fnrm[g * 3], gy = fnrm[g * 3 + 1], gz = fnrm[g * 3 + 2];
      if (gx * fx + gy * fy + gz * fz < COS_CREASE) continue;
      x += gx * farea[g]; y += gy * farea[g]; z += gz * farea[g];
    }
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
  };
  const na = [0, 0, 0], nb = [0, 0, 0], nc = [0, 0, 0];
  const smoothNormal = (f: number, pt: Vector3, ref: Vector3, out: Vector3) => {
    const ia = gi[f * 3] * 3, ib = gi[f * 3 + 1] * 3, ic = gi[f * 3 + 2] * 3;
    // barycentric coordinates of pt in the face
    const ax = gp[ia], ay = gp[ia + 1], az = gp[ia + 2];
    const e0x = gp[ib] - ax, e0y = gp[ib + 1] - ay, e0z = gp[ib + 2] - az;
    const e1x = gp[ic] - ax, e1y = gp[ic + 1] - ay, e1z = gp[ic + 2] - az;
    const px = pt.x - ax, py = pt.y - ay, pz = pt.z - az;
    const d00 = e0x * e0x + e0y * e0y + e0z * e0z, d01 = e0x * e1x + e0y * e1y + e0z * e1z, d11 = e1x * e1x + e1y * e1y + e1z * e1z;
    const d20 = px * e0x + py * e0y + pz * e0z, d21 = px * e1x + py * e1y + pz * e1z;
    const den = d00 * d11 - d01 * d01 || 1;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
    cornerNormal(ia / 3, f, na);
    cornerNormal(ib / 3, f, nb);
    cornerNormal(ic / 3, f, nc);
    out.set(u * na[0] + v * nb[0] + w * nc[0], u * na[1] + v * nb[1] + w * nc[1], u * na[2] + v * nb[2] + w * nc[2]);
    if (out.lengthSq() < 1e-12) return faceNormal(f, ref, out);
    out.normalize();
    if (out.dot(ref) < 0) out.negate();
    return out;
  };
  const faceNormal = (f: number, ref: Vector3, out: Vector3) => {
    const a = gi[f * 3] * 3, b = gi[f * 3 + 1] * 3, c = gi[f * 3 + 2] * 3;
    const ux = gp[b] - gp[a], uy = gp[b + 1] - gp[a + 1], uz = gp[b + 2] - gp[a + 2];
    const vx = gp[c] - gp[a], vy = gp[c + 1] - gp[a + 1], vz = gp[c + 2] - gp[a + 2];
    out.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
    if (out.dot(ref) < 0) out.negate();
    return out;
  };
  /** move `pos` by `len` along `dir` on the surface; updates pos, dir (kept tangent) and n in place */
  const walk = (pos: Vector3, dir: Vector3, n: Vector3, len: number) => {
    let left = len;
    const q = new Vector3();
    while (left > 1e-9) {
      const d = Math.min(ds, left);
      q.copy(pos).addScaledVector(dir, d);
      const r = bvh.closestPointToPoint(q, hit);
      if (!r) break;
      pos.copy(r.point);
      smoothNormal(r.faceIndex, r.point, n, n);
      // keep walking in the same direction, re-tangent to the new facet
      dir.addScaledVector(n, -dir.dot(n));
      if (dir.lengthSq() < 1e-12) break;
      dir.normalize();
      left -= d;
    }
  };
  // start on the surface below the label point
  const start = bvh.closestPointToPoint(O, hit);
  const p0 = start ? start.point.clone() : O.clone();
  const n0 = start ? smoothNormal(start.faceIndex, start.point, N, new Vector3()) : N.clone();
  const t0 = R.clone().addScaledVector(n0, -R.dot(n0)).normalize();
  // spine along x (y = 0), sampled every ds in both directions
  type Sample = { pos: Vector3; n: Vector3; t: Vector3 };
  const spine = (sign: number, len: number): Sample[] => {
    const out: Sample[] = [{ pos: p0.clone(), n: n0.clone(), t: t0.clone() }];
    const pos = p0.clone(), n = n0.clone(), dir = t0.clone().multiplyScalar(sign);
    for (let s = ds; s < len + ds; s += ds) {
      walk(pos, dir, n, ds);
      out.push({ pos: pos.clone(), n: n.clone(), t: dir.clone().multiplyScalar(sign) });
    }
    return out;
  };
  const plus = spine(1, Math.max(0, maxX)), minus = spine(-1, Math.max(0, -minX));
  const sampleAt = (x: number): Sample => {
    const arr = x >= 0 ? plus : minus;
    const f = Math.abs(x) / ds;
    const i = Math.min(arr.length - 2, Math.floor(f));
    if (i < 0) return arr[0];
    const a = arr[i], b = arr[i + 1], w = Math.min(1, f - i);
    return {
      pos: a.pos.clone().lerp(b.pos, w),
      n: a.n.clone().lerp(b.n, w).normalize(),
      t: a.t.clone().lerp(b.t, w).normalize(),
    };
  };
  const cache = new Map<string, { pos: Vector3; n: Vector3 }>();
  const place = (x: number, y: number) => {
    const key = `${x.toFixed(5)},${y.toFixed(5)}`;
    let r = cache.get(key);
    if (r) return r;
    const s = sampleAt(x);
    const pos = s.pos.clone(), n = s.n.clone();
    if (Math.abs(y) > 1e-9) {
      const dir = new Vector3().crossVectors(n, s.t).normalize().multiplyScalar(Math.sign(y));
      walk(pos, dir, n, Math.abs(y));
    }
    r = { pos, n };
    cache.set(key, r);
    return r;
  };
  const out = new Float32Array(p.length);
  const q = new Vector3();
  for (let i = 0; i < p.length; i += 3) {
    const r = place(p[i], p[i + 1]);
    q.copy(r.pos).addScaledVector(r.n, p[i + 2]);
    out[i] = q.x; out[i + 1] = q.y; out[i + 2] = q.z;
  }
  return { positions: out, indices: local.indices };
}

/** Emboss or engrave text on a part (world-space mesh). */
export async function applyLabel(
  mesh: MeshData,
  fontData: ArrayBuffer,
  params: LabelParams,
  point: Vec3,
  normal: Vec3,
  upHint?: Vec3,
): Promise<{ mesh: MeshData; label: MeshData }> {
  const label = await labelSolid(fontData, params, point, normal, upHint, params.conform ? mesh : undefined);
  const out = await booleanMeshes(params.mode === 'emboss' ? 'union' : 'subtract', mesh, [label]);
  return { mesh: out, label };
}
