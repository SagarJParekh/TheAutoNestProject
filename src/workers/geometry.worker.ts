/// <reference lib="webworker" />
import manifoldWasm from 'manifold-3d/manifold.wasm?url';
import occtWasm from 'occt-import-js/dist/occt-import-js.wasm?url';
import rhinoWasm from 'rhino3dm/rhino3dm.wasm?url';
import { configureManifold } from '../geometry/manifold';
import sansUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url';
import sansBoldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url';
import monoUrl from 'dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf?url';
import serifUrl from 'dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf?url';
import { ops, OpName, fontUrls } from './ops';

Object.assign(fontUrls, { sans: sansUrl, 'sans-bold': sansBoldUrl, mono: monoUrl, serif: serifUrl });

configureManifold({ wasmUrl: manifoldWasm });

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (ev: MessageEvent<{ id: number; op: OpName; args: Record<string, unknown> }>) => {
  const { id, op, args } = ev.data;
  let last = 0;
  const progress = (fraction: number, message?: string) => {
    const now = performance.now();
    if (now - last < 50 && fraction < 1) return;
    last = now;
    self.postMessage({ id, type: 'progress', fraction, message });
  };
  try {
    const handler = ops[op] as (a: unknown, p: typeof progress) => Promise<{ result: unknown; transfer?: Transferable[] }>;
    if (!handler) throw new Error(`Unknown operation ${op}`);
    if (op === 'import') (args as { wasmUrls?: unknown }).wasmUrls = { occt: occtWasm, rhino: rhinoWasm };
    const { result, transfer } = await handler(args, progress);
    self.postMessage({ id, type: 'done', result }, dedupe(transfer ?? []));
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

function dedupe(t: Transferable[]): Transferable[] {
  return Array.from(new Set(t)).filter((b) => !(b instanceof ArrayBuffer) || b.byteLength > 0);
}
