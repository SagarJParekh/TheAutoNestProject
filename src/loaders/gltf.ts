import type { ImportedBody, LoaderContext, LoaderModule } from './types';
import { ImportError } from './types';
import { decodeText } from './text';

/* eslint-disable @typescript-eslint/no-explicit-any */
type M4 = number[]; // column-major

const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: M4, b: M4): M4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let rr = 0; rr < 4; rr++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
      r[c * 4 + rr] = s;
    }
  return r;
}

function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]): M4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(json: any, buffers: Uint8Array[], index: number): ArrayLike<number> {
  const acc = json.accessors?.[index];
  if (!acc) throw new ImportError(`glTF accessor ${index} missing`);
  if (acc.sparse) throw new ImportError('Sparse glTF accessors are not supported');
  const nc = COMPONENTS[acc.type];
  const count = acc.count;
  if (acc.bufferView === undefined) return new Float32Array(count * nc);
  const bv = json.bufferViews[acc.bufferView];
  const buf = buffers[bv.buffer];
  const offset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const ct = acc.componentType;
  const size = ct === 5126 || ct === 5125 ? 4 : ct === 5123 || ct === 5122 ? 2 : 1;
  const stride = bv.byteStride ?? size * nc;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float64Array(count * nc);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < nc; k++) {
      const o = offset + i * stride + k * size;
      let v: number;
      switch (ct) {
        case 5126: v = dv.getFloat32(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5123: v = dv.getUint16(o, true); break;
        case 5122: v = dv.getInt16(o, true); break;
        case 5121: v = dv.getUint8(o); break;
        case 5120: v = dv.getInt8(o); break;
        default: throw new ImportError(`Unsupported glTF component type ${ct}`);
      }
      out[i * nc + k] = v;
    }
  }
  return out;
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const b64 = uri.slice(comma + 1);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Minimal glTF 2.0 / GLB geometry reader (worker-safe, no DOM). glTF is
 * Y-up in metres; geometry is converted to Z-up millimetres.
 */
export function parseGLTF(buffer: ArrayBuffer, ctx: Pick<LoaderContext, 'fileName' | 'siblings' | 'warn'>): ImportedBody[] {
  const bytes = new Uint8Array(buffer);
  let json: any;
  let bin: Uint8Array | undefined;
  const magic = new DataView(buffer).getUint32(0, true);
  if (magic === 0x46546c67) {
    const dv = new DataView(buffer);
    let o = 12;
    while (o < buffer.byteLength) {
      const len = dv.getUint32(o, true);
      const type = dv.getUint32(o + 4, true);
      const chunk = new Uint8Array(buffer, o + 8, len);
      if (type === 0x4e4f534a) json = JSON.parse(decodeText(chunk));
      else if (type === 0x004e4942) bin = chunk;
      o += 8 + len;
    }
  } else {
    try {
      json = JSON.parse(decodeText(bytes));
    } catch {
      throw new ImportError('Not a valid glTF file');
    }
  }
  if (!json?.asset) throw new ImportError('Not a valid glTF file (missing asset)');
  const required: string[] = json.extensionsRequired ?? [];
  const unsupported = required.filter((e) => /draco|meshopt|KHR_mesh_quantization/i.test(e));
  if (unsupported.length) throw new ImportError(`Compressed glTF (${unsupported.join(', ')}) is not supported. Export uncompressed.`);
  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: any) => {
    if (b.uri === undefined) {
      if (!bin) throw new ImportError('GLB binary chunk missing');
      return bin;
    }
    if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
    const name = decodeURIComponent(b.uri).split('/').pop()!;
    const sib = ctx.siblings?.get(name) ?? ctx.siblings?.get(name.toLowerCase());
    if (!sib) throw new ImportError(`glTF needs external buffer "${name}" — drop it together with the .gltf file`);
    return new Uint8Array(sib);
  });

  const bodies: ImportedBody[] = [];
  // Y-up metres -> Z-up millimetres
  const toZUp: M4 = [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1];
  const visit = (ni: number, parent: M4, depth: number) => {
    if (depth > 64) return;
    const node = json.nodes[ni];
    const local = node.matrix ?? trs(node.translation, node.rotation, node.scale);
    const world = mul(parent, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      const pos: number[] = [];
      const idx: number[] = [];
      for (const prim of mesh.primitives ?? []) {
        const mode = prim.mode ?? 4;
        if (mode !== 4 && mode !== 5 && mode !== 6) continue;
        if (prim.attributes?.POSITION === undefined) continue;
        const p = readAccessor(json, buffers, prim.attributes.POSITION);
        const base = pos.length / 3;
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i], y = p[i + 1], z = p[i + 2];
          pos.push(
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14],
          );
        }
        const n = p.length / 3;
        const ind = prim.indices !== undefined ? readAccessor(json, buffers, prim.indices) : Array.from({ length: n }, (_, i) => i);
        if (mode === 4) for (let i = 0; i + 2 < ind.length; i += 3) idx.push(base + ind[i], base + ind[i + 1], base + ind[i + 2]);
        else if (mode === 5)
          for (let i = 0; i + 2 < ind.length; i++)
            idx.push(...(i % 2 ? [ind[i + 1], ind[i], ind[i + 2]] : [ind[i], ind[i + 1], ind[i + 2]]).map((v) => base + v));
        else for (let i = 1; i + 1 < ind.length; i++) idx.push(base + ind[0], base + ind[i], base + ind[i + 1]);
      }
      if (idx.length) {
        // mirrored node transforms flip winding
        const det =
          world[0] * (world[5] * world[10] - world[9] * world[6]) -
          world[4] * (world[1] * world[10] - world[9] * world[2]) +
          world[8] * (world[1] * world[6] - world[5] * world[2]);
        if (det < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
        const positions = Float32Array.from(pos);
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i], y = positions[i + 1], z = positions[i + 2];
          positions[i] = x * toZUp[0];
          positions[i + 1] = -z * 1000;
          positions[i + 2] = y * 1000;
        }
        bodies.push({ name: node.name || mesh.name || `${ctx.fileName} ${bodies.length + 1}`, positions, indices: Uint32Array.from(idx) });
      }
    }
    for (const c of node.children ?? []) visit(c, world, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i);
  for (const r of roots) visit(r, I4, 0);
  if (!bodies.length) throw new ImportError('glTF contains no triangle meshes');
  return bodies;
}

export const gltfLoader: LoaderModule = {
  id: 'gltf',
  label: 'glTF / GLB',
  extensions: ['gltf', 'glb'],
  async load(buffer, ctx) {
    return parseGLTF(buffer, ctx);
  },
};
