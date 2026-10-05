import type { OpArgs, OpName, OpResult } from './ops';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (f: number, m?: string) => void;
  worker: PooledWorker;
}

interface PooledWorker {
  worker: Worker;
  busy: number;
}

export interface JobHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}

const spawn = () => new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });

/**
 * Small worker pool. Each job runs on the least busy worker; cancelling a job
 * terminates its worker (the only way to stop a WASM loop) and replaces it.
 */
class WorkerPool {
  private workers: PooledWorker[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private size: number) {}

  private create(): PooledWorker {
    const pw: PooledWorker = { worker: spawn(), busy: 0 };
    pw.worker.onmessage = (ev) => this.onMessage(ev.data);
    pw.worker.onerror = (ev) => {
      // fail all jobs on this worker
      for (const [id, p] of this.pending) {
        if (p.worker === pw) {
          this.pending.delete(id);
          p.reject(new Error(ev.message || 'Worker crashed'));
        }
      }
      this.replace(pw);
    };
    return pw;
  }

  private replace(pw: PooledWorker) {
    pw.worker.terminate();
    const i = this.workers.indexOf(pw);
    if (i >= 0) this.workers.splice(i, 1);
  }

  private pick(): PooledWorker {
    if (this.workers.length < this.size) {
      const idle = this.workers.find((w) => w.busy === 0);
      if (idle) return idle;
      const w = this.create();
      this.workers.push(w);
      return w;
    }
    return this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  }

  private onMessage(msg: { id: number; type: string; fraction?: number; message?: string; result?: unknown }) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.onProgress?.(msg.fraction ?? 0, msg.message);
      return;
    }
    this.pending.delete(msg.id);
    p.worker.busy--;
    if (msg.type === 'done') p.resolve(msg.result);
    else p.reject(new Error(msg.message));
  }

  run<K extends OpName>(op: K, args: OpArgs<K>, onProgress?: (f: number, m?: string) => void, transfer: Transferable[] = []): JobHandle<OpResult<K>> {
    const id = this.nextId++;
    const pw = this.pick();
    pw.busy++;
    let rejectFn: (e: unknown) => void = () => {};
    const promise = new Promise<OpResult<K>>((resolve, reject) => {
      rejectFn = reject;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress, worker: pw });
      pw.worker.postMessage({ id, op, args }, transfer);
    });
    const cancel = () => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      // other jobs on the same worker are lost too: reject them
      for (const [oid, p] of this.pending) {
        if (p.worker === pw) {
          this.pending.delete(oid);
          p.reject(new CancelledError());
        }
      }
      this.replace(pw);
      rejectFn(new CancelledError());
    };
    return { promise, cancel };
  }
}

const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
export const pool = new WorkerPool(Math.max(2, Math.min(4, cores - 1)));
