/**
 * Thin wrapper around manifold-3d (WASM) for exact booleans and plane splits.
 * Works in browsers, Web Workers and Node (tests).
 */
import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import { MeshData, Plane } from './mesh';

let wasmUrl: string | undefined;
let modPromise: Promise<ManifoldToplevel> | null = null;

/** Override the URL the .wasm binary is loaded from (needed under bundlers). */
export function configureManifold(opts: { wasmUrl?: string }) {
  wasmUrl = opts.wasmUrl;
}

export async function getManifold(): Promise<ManifoldToplevel> {
  if (!modPromise) {
    modPromise = (async () => {
      const { default: Module } = await import('manifold-3d');
      const m = await Module(wasmUrl ? { locateFile: () => wasmUrl! } : undefined);
      m.setup();
      return m;
    })();
  }
  return modPromise;
}

/** Convert to a Manifold; returns null if the mesh is not a valid closed 2-manifold. */
export async function toManifold(mesh: MeshData): Promise<Manifold | null> {
  const wasm = await getManifold();
  const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  m.merge();
  try {
    const man = new wasm.Manifold(m);
    if (man.status() !== 'NoError') {
      man.delete();
      return null;
    }
    return man;
  } catch {
    return null;
  }
}

export function fromManifold(man: Manifold): MeshData {
  const m = man.getMesh();
  const n = m.numProp;
  let positions: Float32Array;
  if (n === 3) positions = new Float32Array(m.vertProperties);
  else {
    const nv = m.vertProperties.length / n;
    positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      positions[i * 3] = m.vertProperties[i * n];
      positions[i * 3 + 1] = m.vertProperties[i * n + 1];
      positions[i * 3 + 2] = m.vertProperties[i * n + 2];
    }
  }
  return { positions, indices: new Uint32Array(m.triVerts) };
}

export async function isManifold(mesh: MeshData): Promise<boolean> {
  const m = await toManifold(mesh);
  if (!m) return false;
  m.delete();
  return true;
}

export class NotManifoldError extends Error {
  constructor(what = 'Mesh') {
    super(`${what} is not a closed manifold solid. Run Repair first.`);
  }
}

/** a − union(cutters). Throws NotManifoldError if any input is invalid. */
export async function subtractMeshes(a: MeshData, cutters: MeshData[]): Promise<MeshData> {
  const wasm = await getManifold();
  const base = await toManifold(a);
  if (!base) throw new NotManifoldError('Part');
  const tools: Manifold[] = [];
  try {
    for (const c of cutters) {
      const t = await toManifold(c);
      if (!t) throw new NotManifoldError('Cutting tool');
      tools.push(t);
    }
    if (tools.length === 0) return a;
    const all = wasm.Manifold.union(tools);
    const res = base.subtract(all);
    all.delete();
    const out = fromManifold(res);
    res.delete();
    return out;
  } finally {
    base.delete();
    tools.forEach((t) => t.delete());
  }
}

export async function unionMeshes(meshes: MeshData[]): Promise<MeshData> {
  const wasm = await getManifold();
  const ms: Manifold[] = [];
  try {
    for (const m of meshes) {
      const t = await toManifold(m);
      if (!t) throw new NotManifoldError();
      ms.push(t);
    }
    const u = wasm.Manifold.union(ms);
    const out = fromManifold(u);
    u.delete();
    return out;
  } finally {
    ms.forEach((m) => m.delete());
  }
}

/** Exact split; returns null if the mesh is not manifold. */
export async function splitByPlaneManifold(
  mesh: MeshData,
  plane: Plane,
): Promise<{ above: MeshData; below: MeshData } | null> {
  const man = await toManifold(mesh);
  if (!man) return null;
  try {
    const [a, b] = man.splitByPlane(plane.normal, plane.constant);
    const above = fromManifold(a);
    const below = fromManifold(b);
    a.delete();
    b.delete();
    return { above, below };
  } finally {
    man.delete();
  }
}

export type BooleanOp = 'union' | 'subtract' | 'intersect';

/** Boolean of a base mesh with one or more others (subtract/intersect apply each in turn). */
export async function booleanMeshes(op: BooleanOp, base: MeshData, others: MeshData[]): Promise<MeshData> {
  const wasm = await getManifold();
  const all: Manifold[] = [];
  try {
    const a = await toManifold(base);
    if (!a) throw new NotManifoldError('The first part');
    all.push(a);
    for (const o of others) {
      const m = await toManifold(o);
      if (!m) throw new NotManifoldError('One of the parts');
      all.push(m);
    }
    let res: Manifold;
    if (op === 'union') res = wasm.Manifold.union(all);
    else if (op === 'subtract') res = wasm.Manifold.difference(all);
    else {
      res = all[0];
      for (const m of all.slice(1)) {
        const next = res.intersect(m);
        if (!all.includes(res)) res.delete();
        res = next;
      }
    }
    const out = fromManifold(res);
    if (!all.includes(res)) res.delete();
    return out;
  } finally {
    all.forEach((m) => m.delete());
  }
}

/** base ∩ union(cutters): the material the cutters would remove (e.g. perforation plugs). */
export async function intersectWithUnion(base: MeshData, cutters: MeshData[]): Promise<MeshData> {
  const wasm = await getManifold();
  const a = await toManifold(base);
  if (!a) throw new NotManifoldError('Part');
  const tools: Manifold[] = [];
  try {
    for (const c of cutters) {
      const t = await toManifold(c);
      if (!t) throw new NotManifoldError('Cutting tool');
      tools.push(t);
    }
    const u = wasm.Manifold.union(tools);
    const r = a.intersect(u);
    u.delete();
    const out = fromManifold(r);
    r.delete();
    return out;
  } finally {
    a.delete();
    tools.forEach((t) => t.delete());
  }
}
