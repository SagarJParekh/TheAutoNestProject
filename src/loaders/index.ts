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

registerLoader({
  id: 'parasolid',
  label: 'Parasolid',
  extensions: ['x_t', 'x_b', 'xmt_txt', 'xmt_bin'],
  unsupportedMessage:
    'Parasolid (.x_t / .x_b) is a closed Siemens format: no open-source reader exists, so it cannot be opened in the browser. In your CAD system (NX, Solid Edge, SolidWorks, Onshape…) export the part as STEP (.step / .stp) — it keeps the exact geometry — and drop that file here.',
});
registerLoader({
  id: 'prt',
  label: 'NX / Creo part',
  extensions: ['prt', 'asm'],
  unsupportedMessage:
    '.prt files are native Siemens NX or PTC Creo parts; their formats are closed and cannot be read outside those programs. In NX use File → Export → STEP, in Creo File → Save As → STEP, and drop the .step file here.',
});

export * from './registry';
export * from './types';
