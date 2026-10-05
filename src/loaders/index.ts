import { registerLoader } from './registry';
import { stlLoader } from './stl';
import { objLoader } from './obj';
import { plyLoader } from './ply';
import { offLoader } from './off';
import { threeMfLoader } from './threemf';
import { amfLoader } from './amf';
import { gltfLoader } from './gltf';
import { stepLoader, igesLoader, brepLoader } from './occt';
import { rhinoLoader } from './rhino';

registerLoader(stlLoader);
registerLoader(objLoader);
registerLoader(plyLoader);
registerLoader(offLoader);
registerLoader(threeMfLoader);
registerLoader(amfLoader);
registerLoader(gltfLoader);
registerLoader(stepLoader);
registerLoader(igesLoader);
registerLoader(brepLoader);
registerLoader(rhinoLoader);

// Recognised but intentionally not importable: no open parser exists.
registerLoader({
  id: 'f3d',
  label: 'Fusion 360 archive',
  extensions: ['f3d', 'f3z'],
  unsupportedMessage:
    'Fusion 360 .f3d files use a proprietary format that cannot be read outside Fusion. In Fusion 360 use File → Export and choose STEP (.step) or 3MF, then drop that file here.',
});

export * from './registry';
export * from './types';
