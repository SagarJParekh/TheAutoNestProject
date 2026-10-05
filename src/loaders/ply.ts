import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import type { LoaderModule } from './types';
import { ImportError } from './types';

export const plyLoader: LoaderModule = {
  id: 'ply',
  label: 'Stanford PLY',
  extensions: ['ply'],
  async load(buffer, ctx) {
    let geom;
    try {
      geom = new PLYLoader().parse(buffer);
    } catch (e) {
      throw new ImportError(`Could not parse PLY: ${(e as Error).message}`);
    }
    const pos = geom.getAttribute('position');
    if (!pos || pos.count === 0) throw new ImportError('PLY contains no vertices');
    const positions = new Float32Array(pos.array as ArrayLike<number>);
    const index = geom.getIndex();
    if (!index && pos.count % 3 !== 0) throw new ImportError('PLY contains no faces (point clouds are not supported)');
    const indices = index ? new Uint32Array(index.array as ArrayLike<number>) : undefined;
    if (indices && indices.length === 0) throw new ImportError('PLY contains no faces (point clouds are not supported)');
    return [{ name: ctx.fileName.replace(/\.[^.]+$/, ''), positions, indices }];
  },
};
