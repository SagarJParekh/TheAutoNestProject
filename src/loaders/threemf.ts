import { unzipSync } from 'fflate';
import type { ImportedBody, LoaderModule } from './types';
import { ImportError } from './types';
import { decodeText, localName, parseAttributes, UNIT_TO_MM } from './text';

/** Row-vector affine transform as used by 3MF: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]. */
type T3 = number[];
const IDENT: T3 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(s?: string): T3 {
  if (!s) return IDENT;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENT;
}

/** a then b (row vectors: p' = (p*a)*b) */
function compose(a: T3, b: T3): T3 {
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
    }
  }
  return r;
}

interface ObjMesh {
  positions: Float32Array;
  indices: Uint32Array;
}
interface ObjDef {
  id: string;
  name?: string;
  mesh?: ObjMesh;
  components: { objectid: string; path?: string; transform: T3 }[];
}

function parseMesh(body: string): ObjMesh | undefined {
  const vs = body.indexOf('<vertices') >= 0 ? body : '';
  if (!vs) return undefined;
  const coords: number[] = [];
  const vRe = /<(?:\w+:)?vertex\b([^>]*)\/?>/g;
  const fast = /x\s*=\s*"([^"]*)"\s+y\s*=\s*"([^"]*)"\s+z\s*=\s*"([^"]*)"/;
  let m: RegExpExecArray | null;
  while ((m = vRe.exec(body))) {
    const f = fast.exec(m[1]);
    if (f) coords.push(+f[1], +f[2], +f[3]);
    else {
      const a = parseAttributes(m[1]);
      coords.push(+a.x, +a.y, +a.z);
    }
  }
  const idx: number[] = [];
  const tRe = /<(?:\w+:)?triangle\b([^>]*)\/?>/g;
  const tfast = /v1\s*=\s*"(\d+)"\s+v2\s*=\s*"(\d+)"\s+v3\s*=\s*"(\d+)"/;
  while ((m = tRe.exec(body))) {
    const f = tfast.exec(m[1]);
    if (f) idx.push(+f[1], +f[2], +f[3]);
    else {
      const a = parseAttributes(m[1]);
      idx.push(+a.v1, +a.v2, +a.v3);
    }
  }
  return { positions: Float32Array.from(coords), indices: Uint32Array.from(idx) };
}

function parseModel(xml: string) {
  const unitM = /<(?:\w+:)?model\b([^>]*)>/.exec(xml);
  const unit = unitM ? parseAttributes(unitM[1]).unit ?? 'millimeter' : 'millimeter';
  const scale = UNIT_TO_MM[unit] ?? 1;
  const objects = new Map<string, ObjDef>();
  const oRe = /<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g;
  let m: RegExpExecArray | null;
  while ((m = oRe.exec(xml))) {
    const a = parseAttributes(m[1]);
    const def: ObjDef = { id: a.id, name: a.name, components: [] };
    def.mesh = parseMesh(m[2]);
    const cRe = /<(?:\w+:)?component\b([^>]*)\/?>/g;
    let c: RegExpExecArray | null;
    while ((c = cRe.exec(m[2]))) {
      const ca = parseAttributes(c[1]);
      def.components.push({ objectid: ca.objectid, path: localName(ca, 'path'), transform: parseTransform(ca.transform) });
    }
    objects.set(def.id, def);
  }
  const items: { objectid: string; transform: T3; path?: string }[] = [];
  const bRe = /<(?:\w+:)?item\b([^>]*)\/?>/g;
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml);
  if (build) {
    while ((m = bRe.exec(build[1]))) {
      const a = parseAttributes(m[1]);
      items.push({ objectid: a.objectid, transform: parseTransform(a.transform), path: localName(a, 'path') });
    }
  }
  return { scale, objects, items };
}

export function parse3MF(buffer: ArrayBuffer, fallbackName: string): ImportedBody[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new ImportError('3MF is not a valid ZIP archive');
  }
  const norm = (p: string) => p.replace(/^\//, '');
  let rootPath = Object.keys(files).find((k) => /^3D\/3dmodel\.model$/i.test(k));
  const rels = files['_rels/.rels'];
  if (rels) {
    const m = /Target\s*=\s*"([^"]+\.model)"/i.exec(decodeText(rels));
    if (m && files[norm(m[1])]) rootPath = norm(m[1]);
  }
  if (!rootPath) rootPath = Object.keys(files).find((k) => k.toLowerCase().endsWith('.model'));
  if (!rootPath) throw new ImportError('3MF archive has no 3D model part');

  const models = new Map<string, ReturnType<typeof parseModel>>();
  const getModel = (path: string) => {
    const p = norm(path);
    let mdl = models.get(p);
    if (!mdl) {
      const data = files[p];
      if (!data) throw new ImportError(`3MF references missing part ${p}`);
      mdl = parseModel(decodeText(data));
      models.set(p, mdl);
    }
    return mdl;
  };
  const root = getModel(rootPath);
  const bodies: ImportedBody[] = [];

  const collect = (path: string, objectid: string, t: T3, outPos: number[], outIdx: number[], depth: number, names: string[]) => {
    if (depth > 32) throw new ImportError('3MF component nesting too deep');
    const mdl = getModel(path);
    const obj = mdl.objects.get(objectid);
    if (!obj) throw new ImportError(`3MF build references missing object ${objectid}`);
    if (obj.name) names.push(obj.name);
    if (obj.mesh && obj.mesh.indices.length) {
      const base = outPos.length / 3;
      const p = obj.mesh.positions;
      const s = mdl.scale;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        outPos.push(
          (x * t[0] + y * t[3] + z * t[6] + t[9]) * s,
          (x * t[1] + y * t[4] + z * t[7] + t[10]) * s,
          (x * t[2] + y * t[5] + z * t[8] + t[11]) * s,
        );
      }
      for (const v of obj.mesh.indices) outIdx.push(v + base);
    }
    for (const c of obj.components) collect(c.path ?? path, c.objectid, compose(c.transform, t), outPos, outIdx, depth + 1, names);
  };

  const items = root.items.length
    ? root.items
    : Array.from(root.objects.keys()).map((id) => ({ objectid: id, transform: IDENT, path: undefined }));
  let n = 0;
  for (const item of items) {
    const pos: number[] = [];
    const idx: number[] = [];
    const names: string[] = [];
    collect(item.path ?? rootPath, item.objectid, item.transform, pos, idx, 0, names);
    n++;
    if (idx.length === 0) continue;
    bodies.push({
      name: names[0] ?? `${fallbackName} ${n}`,
      positions: Float32Array.from(pos),
      indices: Uint32Array.from(idx),
    });
  }
  if (!bodies.length) throw new ImportError('3MF contains no meshes');
  return bodies;
}

export const threeMfLoader: LoaderModule = {
  id: '3mf',
  label: '3D Manufacturing Format',
  extensions: ['3mf'],
  async load(buffer, ctx) {
    return parse3MF(buffer, ctx.fileName.replace(/\.[^.]+$/, ''));
  },
};
