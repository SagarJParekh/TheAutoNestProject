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
export async function labelSolid(fontData: ArrayBuffer, params: LabelParams, point: Vec3, normal: Vec3, upHint?: Vec3): Promise<MeshData> {
  if (!params.text.trim()) throw new Error('Enter some text');
  if (!(params.size > 0) || !(params.depth > 0)) throw new Error('Size and depth must be positive');
  const { polys } = textOutlines(fontData, params.text, params.size, params.letterSpacing ?? 0, params.curveSegments ?? 6);
  const wasm = await getManifold();
  const cs = new wasm.CrossSection(polys, 'NonZero');
  const z0 = params.mode === 'emboss' ? -Math.max(0, params.sink) : -params.depth;
  const z1 = params.mode === 'emboss' ? params.depth : 0.5;
  const solid = cs.extrude(z1 - z0);
  cs.delete();
  const local = fromManifold(solid);
  solid.delete();
  for (let i = 2; i < local.positions.length; i += 3) local.positions[i] += z0;
  return applyMatrix(local, labelFrame(point, normal, params.rotation, upHint));
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
  const label = await labelSolid(fontData, params, point, normal, upHint);
  const out = await booleanMeshes(params.mode === 'emboss' ? 'union' : 'subtract', mesh, [label]);
  return { mesh: out, label };
}
