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
| Scene | Parts list (rename, visibility, colour picker, lock, duplicate, delete, multi-select with Ctrl/Shift). Every part gets a colour from a high-contrast palette. Orbit/pan/zoom, fit, **zoom to a dragged area** (`Z`), top/front/side/iso views, perspective/orthographic, grid, axis gizmo. |
| Display | Shaded, shaded + feature edges, wireframe, x-ray. Back faces are tinted red, so inside-out regions are easy to spot. |
| Info | Bounding box, triangle count, volume, surface area and a watertight flag for the selected part. |
| Transform | Move/rotate gizmos plus numeric fields (simple arithmetic like `25.4*2` works), uniform or per-axis scale (% or target size), mirror X/Y/Z (in place or as a copy beside the original), drop to bed, centre on origin, lay flat by clicking a face. **2D array** (columns × rows with a gap) and **arrange on bed** along any combination of **X, Y and Z**: one axis makes a line, two axes make rows that wrap at the bed size, and all three fill X, then Y, then stack layers in Z (bed X/Y/Z sizes, gap, warning when the layout is larger than the bed). |
| Clip | Non-destructive section plane on X/Y/Z or a free orientation, with a slider. The section is capped with stencil caps and outlined using the BVH. |
| Cut | **Plane**: split a part along a plane (X/Y/Z with tilt angles about the other two axes, or free orientation) into two closed, capped parts; optional gap. **Lasso**: drag a freehand outline in the viewport; everything inside it along the line of sight becomes one piece and the rest another (manifold-3d boolean). |
| Repair → Fix | **Fix open edges**: stitch & fill, fill holes up to a perimeter, or remove dangling triangles. Analysis report: open edges, holes, non-manifold edges, flipped, degenerate and duplicate triangles, shells, with viewport highlights. Fill one hole or all of them. One-click auto repair with a before/after summary. **Stitch** closes cracks (merges nearby open-edge vertices, splits T-junctions). **Overlapping triangles** finds self-intersecting and coplanar doubled triangles (BVH self-test) and removes doubled surfaces. **Normals**: show normal hairs, unify outward, flip all, flip picked faces. |
| Repair → Shells | Browse the shells of a part (triangles, volume, closed/open). Hover to highlight, select (all / open / small / invert), show only the selection, and **delete**, **keep only**, **merge** (union) or **extract** shells to a new part. |
| Repair → Combine | Split shells into parts, unify overlapping shells with an exact boolean, or **make solid**: a voxel remesh that turns overlapping, self-intersecting or leaky shells into one watertight solid. Boolean union, subtract and intersect between selected parts (the first selected is the base), or merge parts without a boolean. |
| Repair → Edit | Delete triangles (click to select, optionally the whole smooth area) and create triangles by clicking three vertices. New triangles are wound to match their neighbours. |
| Align | Pick a face on the part to move and a face on a target part. **Mate** (face to face) or **flush** (same direction), with an offset and optional centring. Only the transform changes. |
| Props | **Single prop**: pick a start point and optionally an end point; without an end point it runs along the surface normal to the first surface hit. **Array**: pick a start face and a target face (another part, or another shell of the same part); props are laid out on a grid (diameter, spacing, margin, max length, embed depth). Props are added as a new part or unioned into one solid. |
| Hollow | Inner wall from a voxel signed-distance field plus marching tetrahedra, so it never self-intersects. Drain holes are placed by clicking the surface. |
| Perforate | **Array on a face** (round, hex or square holes; size, web spacing, border margin, rotation) or **single holes** at picked points. Depth is automatic through the wall or fixed. An exit size makes **tapered holes**, with a different size at each end. The pattern is previewed and applied as a manifold-3d boolean. |
| Extrude | Pick a face. The selection grows across neighbours within an angle tolerance. Extrude it out or in by ± mm; side walls are stitched so the part stays watertight. |
| Measure | **Distance** between points (vertex snap), edges (feature-edge snap), surfaces, circles (fitted to a round surface, or through 3 points) and spheres, in any combination. Results include ΔX/ΔY/ΔZ, angle, edge-to-edge and axial gaps. **Angle** from 3 points or between edges, surfaces and axes. **Diameter** of a direct circle, a 3-point circle or a sphere. **Thickness** straight through the wall. Results are labelled in the viewport and listed in the panel. |
| Label | Emboss or engrave text at a picked point: built-in DejaVu fonts or your own .ttf/.otf; size, height/depth, rotation, letter spacing, multi-line. Outlines become a manifold solid and are combined by a boolean, so the part stays watertight. |
| Texture | Displacement textures on a picked face (flat, or grown across smooth curved surfaces) or a whole part: diamond knurl, ribs, waffle, dots, hex tiles, noise, or an image heightmap. Planar, seamless cylindrical or triplanar projection. The area is subdivided with conforming splits, so the mesh stays watertight. |
| General | Undo/redo for every change. Destructive tools show a preview with Apply/Cancel. Export selected or all parts as STL (binary or ASCII), 3MF or OBJ, as one file or one file per part in a ZIP. **Export quality**: Original, High (75%), Medium (50%), Low (25%), Draft (10%) or a custom percentage of triangles, reduced by quadric edge collapse that keeps the mesh watertight and its shape within 0.5% of the part size; coordinate precision for text formats; estimated triangle count and file size. Keyboard shortcuts are listed under `?`. **Search** every function with Ctrl+K or `/`. Progress bar and Cancel for every worker job. |

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
- `findBoundaryLoops`, `fillHoles`, `autoRepair`, `fixWinding`, `removeSmallShells`, `stitchBoundaries`, `findIntersections`, `removeOverlappingTriangles`
- `splitShells`, `unifyShells`, `makeSolid`, `booleanMeshes`, `alignMatrix`, `planProps`
- `measureDistance`, `angleBetween`, `angle3`, `circleFrom3Points`, `fitCylinder`, `fitSphereRegion`
- `pointHoleCutters` (tapered holes), `applyLabel`, `textureMesh`, `arrangeShelves`, `arrangeBoxes` (X/Y/Z layout), `gridArrayOffsets`, `simplifyMesh`
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
- **STEP/IGES/BREP** are tessellated by OpenCascade (occt-import-js) in the worker at the **CAD quality** chosen in the toolbar (Draft / Normal / Fine / Ultra; Fine is the default). Parts from a CAD file can be **re-imported** at another quality from the Info panel; names, colours and placement are kept. The 7.6 MB WASM is downloaded the first time you import a CAD file.
- **3MF/AMF** honour the `unit` attribute, plus 3MF build-item and component transforms.

## Performance

Models up to about 12 million triangles are supported. A 12M-triangle STL (600 MB) imported in about 45 s and was ready to pick in about 70 s in headless Chromium with software rendering; a plane cut took 13 s. Larger models still load, with a warning.


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
