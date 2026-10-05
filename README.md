# AutoNest Mesh Prep

A browser-based 3D part viewer and mesh-prep tool for 3D printing. Everything runs client-side: files are parsed and processed in Web Workers and never leave the browser. Units are millimetres and Z is up.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # geometry, loader and history tests (vitest)
npm run build      # type-check + production build into dist/
```

## Features

| Area | What you get |
| --- | --- |
| Import | STL (binary/ASCII), OBJ, PLY, 3MF, AMF, 3DM, STEP/STP, IGES/IGS, BREP, GLB/GLTF, OFF. Drag-and-drop or file picker, many files at once. Multi-body files (3MF build items, STEP assemblies, OBJ `o` objects, multi-solid ASCII STL) become separate parts. A bad file shows its own error and doesn't stop the other files. |
| F3D | Recognised, not faked. The app asks you to export STEP or 3MF from Fusion 360. |
| Scene | Parts list (rename, visibility, colour picker, lock, duplicate, delete, multi-select with Ctrl/Shift). Every part gets a colour from a high-contrast palette. Orbit/pan/zoom, fit, top/front/side/iso views, perspective/orthographic, grid, axis gizmo. |
| Display | Shaded, shaded + feature edges, wireframe, x-ray. Back faces are tinted red, so inside-out regions are easy to spot. |
| Info | Bounding box, triangle count, volume, surface area and a watertight flag for the selected part. |
| Transform | Move/rotate gizmos plus numeric fields (simple arithmetic like `25.4*2` works), uniform or per-axis scale (% or target size), mirror X/Y/Z, drop to bed, centre on origin, lay flat by clicking a face. |
| Clip | Non-destructive section plane on X/Y/Z or a free orientation, with a slider. The section is capped with stencil caps and outlined using the BVH. |
| Cut | Splits a part along a plane into two closed, capped parts. You can set a gap to push the halves apart. |
| Repair | Analysis report: open edges, holes, non-manifold edges, flipped, degenerate and duplicate triangles, shells. Problems are highlighted in the viewport. Fill one hole or all of them. One-click auto repair shows a before/after summary. |
| Hollow | Inner wall from a voxel signed-distance field plus marching tetrahedra, so it never self-intersects. Drain holes are placed by clicking the surface. |
| Perforate | Pick a face, then choose round, hex or square holes, size, web spacing, border margin, depth (automatic through-wall or fixed) and rotation. The pattern is previewed on the face and applied as a manifold-3d boolean. |
| Extrude | Pick a face. The selection grows across neighbours within an angle tolerance. Extrude it out or in by ± mm; side walls are stitched so the part stays watertight. |
| General | Undo/redo for every change. Destructive tools show a preview with Apply/Cancel. Export selected or all parts as binary STL, 3MF or OBJ, as one file or one file per part in a ZIP. Keyboard shortcuts are listed under `?`. Progress bar and Cancel for every worker job. |

## Architecture

```
src/
  geometry/   Pure mesh functions (no UI, no DOM). Runs in workers, the main thread and Node.
  loaders/    Loader registry + one module per format, and the import pipeline (weld, recentre)
  exporters/  STL / 3MF / OBJ writers
  workers/    Worker entry, op handlers (ops.ts) and a cancellable worker pool (client.ts)
  state/      zustand store, undo/redo history, actions (tool logic that calls workers)
  viewer/     Imperative Three.js scene (rendering, picking, clipping caps, gizmos)
  ui/         React components (toolbar, parts panel, properties panels, dialogs)
tests/        vitest suites + fixture meshes
```

### Geometry module

`src/geometry` is a plain function API over an indexed mesh:

```ts
interface MeshData { positions: Float32Array; indices: Uint32Array }
```

Typed arrays transfer cheaply to and from workers. The main entry points are:

- `weldVertices`, `compactMesh`, `mergeMeshes`, `applyMatrix`, `mirrorMesh`, `dropToBed`, `centerOnOrigin`, `layFlatQuaternion`
- `measureMesh`, `meshVolume`, `meshArea`, `computeBounds`
- `buildTopology`, `findShells`, `analyzeMesh`, `isWatertight`
- `findBoundaryLoops`, `fillHoles`, `autoRepair`, `fixWinding`, `removeSmallShells`
- `cutMesh` (planar split with caps), `splitByPlaneManifold`, `subtractMeshes`, `unionMeshes` (manifold-3d)
- `growCoplanarRegion`, `extrudeRegion`
- `hollowMesh`, `drainHoleCutters`, `signedDistanceGrid`, `marchingTetrahedra`
- `planPerforation`, `perforationCutters`

A future automatic nesting module can import from `src/geometry` (and `measureMesh`/`computeBounds` for footprints) without touching the UI.

### Adding a file format

Create one module that exports a `LoaderModule` and register it in `src/loaders/index.ts`:

```ts
export const myLoader: LoaderModule = {
  id: 'xyz', label: 'XYZ mesh', extensions: ['xyz'],
  async load(buffer, ctx) { return [{ name: ctx.fileName, positions, indices }]; },
};
registerLoader(myLoader);
```

Loaders run inside the worker. They return bodies in millimetres, Z up. The pipeline welds bit-identical vertices so topology works, then recentres each body.

### Workers and cancel

The UI never parses or computes geometry on the main thread. `pool.run(op, args)` sends work to a small worker pool and streams progress to the status bar. Cancel terminates the worker, which is the only reliable way to stop a running WASM call, and a fresh one replaces it.

## Format notes

- **glTF/GLB** follows the spec: Y-up in metres, converted to Z-up millimetres (×1000). Draco and meshopt-compressed files are rejected with a message. A `.gltf` with external `.bin` files works when you drop all of them together.
- **3DM**: rhino3dm cannot tessellate NURBS itself, so Breps and Extrusions use the render meshes cached in the file. Objects without one are reported; save from Rhino with render meshes or export STEP.
- **STEP/IGES/BREP** are tessellated by OpenCascade (occt-import-js) in the worker. The 7.6 MB WASM is downloaded the first time you import a CAD file.
- **3MF/AMF** honour the `unit` attribute, plus 3MF build-item and component transforms.

## Performance

These numbers were measured with a 2,000,000-triangle STL in headless Chromium:

| Step | Time |
| --- | --- |
| Import | ≈3 s |
| Ready to pick (including the worker BVH build) | ≈5–6 s |
| Picking | ≈0.2 s |
| Analysis | ≈2 s |
| Planar cut | ≈0.6 s (in Node) |

Rendering uses flat shading from screen-space derivatives, so no normal buffer is stored. BVHs are built in workers with `indirect: true`, which keeps triangle order stable for face picking. Rendering is on demand.

Undo history shares the immutable mesh buffers between entries, and is trimmed to a memory budget (about 1.5 GB of unique buffers).
