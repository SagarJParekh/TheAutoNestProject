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
| Scene | Under the parts list: **Repair all / Repair selected** (auto repair of many parts at once, one preview and one undo step; also in Repair → Fix) and **Send to Build** (copies the selected or all parts to Build generation and opens it). **Hide others / Show all** above the parts list (`Shift+V` toggles). Parts list (rename, visibility, colour picker, lock, **lock orientation**, duplicate, delete, multi-select with Ctrl/Shift) with a bottle status icon per part: empty red bottle = not print ready (not watertight), green bottle filled ¾ = watertight and print ready, yellow striped bottle = watertight and print ready but made of several shells. Selected parts are all drawn in one selection colour (pale blue by default, changeable in the theme menu). **Lock orientation** (row button or Transform panel) fixes a part's rotation: it can still be moved in X, Y and Z, but rotate, mirror, lay flat, face align, auto arrange, build orientation and tilt leave it alone (in Mesh prep and Build generation). **Live preview**: after the first Preview, changing that tool's settings or picks updates the preview by itself (marked LIVE); nothing changes until Apply. Every running operation shows a progress card with Cancel over the viewport. Every part gets a colour from a high-contrast palette. Mouse: left click selects, left drag draws a selection box (left→right selects parts fully inside, right→left also selects parts it touches, Shift/Ctrl adds), middle drag pans, right drag rotates the view (around the part under the cursor when the drag starts on a part, otherwise around the grid / view centre; a small ring marks the rotation centre), wheel zooms. fit, **zoom to a dragged area** (`Z`), top/front/side/iso views, perspective/orthographic, grid, axis gizmo. |
| Display | Shaded, shaded + feature edges, wireframe, x-ray. Back faces are tinted red, so inside-out regions are easy to spot. |
| Info | Bounding box, triangle count, volume, surface area and a watertight flag for the selected part. |
| Dimensions | A separate tab (`I`): the exact bounding box of each selected part is drawn on the part with X / Y / Z dimension lines and labels (only while this tab is open), and the panel lists everything about it: size, min/max/centre, volume (mm³ and cm³), surface area, box fill ratio, triangles, vertices, shells, watertight, placement and source. Toggles for the **dimensions**, the **part name** and the **part path** drawn on the part; the panel lists the name, the file / path it was imported from (browsers only reveal the file name, plus the folder path when a folder is dropped) and when it was imported. |
| Report | A separate tab (`N`): a table of all (or the selected) parts with Part Name, Quantity (left blank), Volume (mm³) and X / Y / Z (mm). **Copy for Excel** puts just the part rows (no headings) on the clipboard, ready to paste under your own headings; **Download CSV** saves the table with headings. |
| Transform | **Pick and place** (`Y`, hand button): drag parts with the mouse across the bed (Shift-drag moves up/down, Ctrl snaps to 1 mm). Move/rotate gizmos plus numeric fields (simple arithmetic like `25.4*2` works), uniform or per-axis scale (% or target size), mirror X/Y/Z (in place or as a copy beside the original), drop to bed, centre on origin, lay flat by clicking a face. **Auto arrange** and **Arrange** (keeps orientation): choose the direction **X**, **Y** or **X + Y**. Auto arrange first lays every part (selected, or all) on its largest flat face it can stand on and turns its footprint to line up with X / Y. X or Y makes one line of parts; X + Y spreads them over both directions in a compact, roughly square grid. No bed or grid size is used in Mesh prep (the build volume is only used in Build generation). **2D array** (columns × rows with a gap). |
| Clip & Cut | One tool (`C` / `X`) with two tabs. **Clip**: non-destructive section plane on X/Y/Z or a free orientation, with a slider. The section is capped with stencil caps and outlined using the BVH. While the clip is on, a small **Section clip** card stays in the viewport in every other tool to move it, change its plane, flip it or turn it off; **Cut the part at this plane** hands the clip plane to the Cut tab. |
| ↳ Cut tab | **Plane**: split a part along a plane (X/Y/Z with tilt angles about the other two axes, or free orientation) into two closed, capped parts; optional gap. **Draw line**: click points to draw straight segments across the part (steps, zig-zags, notches; Shift snaps to 15°, Backspace removes a point, double-click or Enter finishes); the part is split along that line through the view direction. Clicking the first point again **closes the shape** and cuts the enclosed area out as its own piece. **Snap** (on by default, Alt to skip): points jump to the part's corners and sharp edges under the cursor. **Lasso**: drag a freehand outline in the viewport; everything inside it along the line of sight becomes one piece and the rest another (manifold-3d boolean). |
| Repair → Fix | **Problems to fix**: everything the analysis still finds (after auto repair too) is grouped into connected clusters (each hole, crack, run of non-manifold edges, patch of flipped / degenerate / intersecting triangles). Click one, or step with ◀ ▶, and the view zooms to it and outlines it; **Mark** selects its triangles in the Edit tab to delete, fill, bridge or remesh by hand, and holes etc. have a one-click fix. The highlights and a compact ◀ ▶ navigator stay on in the Shells, Combine and Edit tabs. Open edges (holes / open surfaces), **stitchable cracks** and non-manifold edges are drawn as thick lines in colours picked to contrast with the part and with each other; the analysis legend shows the same colours. **Fix open edges**: stitch & fill, fill holes up to a perimeter, or remove dangling triangles. Analysis report: open edges, holes, non-manifold edges, flipped, degenerate and duplicate triangles, doubled walls, shells, with viewport highlights. **Duplicate triangles** are found by position (with the weld tolerance), so copies with their own vertices count too (a shell exported twice, merged parts, CAD float noise); Remove keeps one of each and also removes stray inside-out copies. Opposite-facing pairs where two shells meet are listed separately as **doubled walls**: kept by default (two clean closed shells), or removed on both sides to join the shells into one solid. Fill one hole or all of them. One-click auto repair with a before/after summary; it never deletes shells (opposite-facing doubled faces where two shells meet are kept, and non-manifold edges are only split there). **Non-manifold edges** are resolved by sorting the triangles around each edge, pairing consistently oriented neighbours from the same surface and splitting the vertices, so solids touching along an edge or face come apart into clean closed shells without losing triangles; loose fins and internal walls are removed (also part of auto repair). **Stitch** closes cracks (merges nearby open-edge vertices, splits T-junctions). **Overlapping triangles** finds self-intersecting and coplanar doubled triangles (BVH self-test) and removes doubled surfaces. **Normals**: normal arrows with separate colours for outward and inward (inverted) triangles, optional colouring of all triangles by orientation (normal vs inverted, colours selectable), unify outward, flip all, flip picked faces. |
| Repair → Shells | Browse the shells of a part (triangles, volume, closed/open). Hover to highlight, select (all / open / small / invert), show only the selection, **hide the selected shells** / show all, **zoom to the selected shells**, and **delete**, **keep only**, **merge** (union) or **extract** shells to a new part. |
| Repair → Combine | Split shells into parts, unify overlapping shells with an exact boolean, or **make solid**: a voxel remesh that turns overlapping, self-intersecting or leaky shells into one watertight solid. Boolean union, subtract and intersect between selected parts (the first selected is the base), or merge parts without a boolean. |
| Repair → Edit | **Mark** triangles with the triangle, plane, surface (up to sharp edges), shell, brush (paint, with radius) or window (rectangle, visible only or through) tools; Ctrl unmarks. **Grow**, shrink, invert, all, clear, extract to a new part, delete marked, **remesh marked**. Create triangles by clicking three vertices (wound to match their neighbours). **Bridge**: pick one open edge, or a run of neighbouring open edges, on each of two sides and fill the gap between them with a strip of triangles. **Remesh** the whole part or the marked area: isotropic remeshing to a target edge length that keeps sharp edges, open borders and the border of the marked area. **Shells** while editing: **Hide marked** / **Show only marked** shells (mark a shell with the Shell tool) and **Show all**; hidden shells (also those hidden in the Shells tab) cannot be picked or marked and stay hidden across edits, so one shell can be edited and the rest fixed later. |
| Align | Pick a face on the part to move and a face on a target part. **Mate** (face to face) or **flush** (same direction), with an offset and optional centring. Only the transform changes. |
| Props | **Single prop**: pick a start point, after which the end point pick starts by itself (Esc skips it); without an end point it runs along the surface normal to the first surface hit. **Array**: pick a start face and a target face (another part, or another shell of the same part); props are laid out on a grid (diameter, spacing, margin, embed depth; props reach up to 10,000 mm). Cross-section **circle, square, hexagon or triangle**, and optional **thinner start and end points** (end width and length) so props break off cleanly. Props are added as a new part or unioned into one solid. |
| Hollow | Inner wall from a voxel signed-distance field plus marching tetrahedra, so it never self-intersects. Drain holes are placed by clicking the surface, with a diameter and an **exit size** (a different exit size makes tapered holes) and **retain plugs** (the cut-out pieces become a separate part). |
| Perforate | **Array on a face** (round, hex or square holes; size, web spacing, border margin, rotation) or **single holes** at picked points. Depth is automatic through the wall or fixed. An exit size makes **tapered holes**, with a different size at each end. The pattern is previewed and applied as a manifold-3d boolean. |
| Extrude | Pick one or more faces (click a picked face again to drop it). Each selection grows across neighbours within an angle tolerance. Extrude out or in by ± mm, each face along its own normal; side walls are stitched so the part stays watertight. |
| Offset & fillet | New tab (`U`). **Global offset** grows or shrinks (negative distance) the whole part by a distance, also for parts with holes (inside is found by a three-axis vote) (signed distance field, never self-intersects, outside corners rounded like a true offset; optionally as a new part). **Local offset** moves one or more picked faces (all highlighted) (flat or curved; click several, click again to drop one) along their normals with side walls. **Fillet** (radius) and **chamfer** (distance) on picked sharp, straight edges between flat faces: exact profiles applied with a boolean, material removed on outside edges and added on inside edges. |
| Measure | **Distance** between points (vertex snap), edges (feature-edge snap), surfaces, circles (fitted to a round surface, or through 3 points) and spheres, in any combination. Results include ΔX/ΔY/ΔZ, angle, edge-to-edge and axial gaps. **Angle** from 3 points or between edges, surfaces and axes. **Diameter** of a direct circle, a 3-point circle or a sphere. **Thickness** straight through the wall. Results are labelled in the viewport and listed in the panel. **Thickness analysis** (whole part): a heat map of the wall thickness (distance straight into the part to the opposite wall; red thin → blue thick, colour range automatic or set by hand), or only the planes and surfaces **thinner than a limit** (pink), with the thinnest / thickest / average thickness and the area below the limit. |
| Label | Emboss or engrave text at a picked point, either **following the surface** (wrapped over cylinders and other curved faces, letters keep their size) or on a flat plane: built-in DejaVu fonts or your own .ttf/.otf; size, height/depth, rotation, letter spacing, multi-line. Outlines become a manifold solid and are combined by a boolean, so the part stays watertight. |
| Texture | Displacement textures on a picked face (flat, or grown across smooth curved surfaces) or a whole part: diamond knurl, ribs, waffle, dots, hex tiles, noise, or an image heightmap. Planar, seamless cylindrical or triplanar projection. The area is subdivided with conforming splits, so the mesh stays watertight. |
| General | **Theme** (palette button in the toolbar): dark or light interface, and the 3D viewport background (dark, graphite or midnight gradients, blueprint, black, light grey, sky gradient, white, or any custom colour); remembered in the browser. Two-row toolbar: file, edit and view controls on top, every tool below. Undo/redo for every change. Destructive tools show a preview with Apply/Cancel. Export selected or all parts as STL (binary or ASCII), 3MF or OBJ, as one file or one file per part in a ZIP. **Export quality**: Original, High (75%), Medium (50%), Low (25%), Draft (10%) or a custom percentage of triangles, reduced by quadric edge collapse that keeps the mesh watertight and its shape within 0.5% of the part size; coordinate precision for text formats; estimated triangle count and file size. Keyboard shortcuts are listed under `?`. **Search** every function with Ctrl+K or `/`. Progress bar and Cancel for every worker job. |

## Build generation

A separate unit (switch **Mesh prep / Build generation** at the top left). Pick a technology and printer:

| Technology | Printers (build volume X × Y × Z, mm) |
| --- | --- |
| SLA / DLP | Eplus 800×800×320 · Magform 600×600×400 · Form 3 145×145×185 · Form 3L 335×200×300 · Form 4 200×125×210 · Form 4L 353×196×353 · Vayu Core 211×118×300 · Vayu Rise 302×161×380 · YouSu 211×118×240 · Custom |
| DMLS | M2 245×245×300 · MLab 100R 90×90×80 · MLab 200R 100×100×100 · Custom |
| HP MJF / SLS | HP MJF 5200 380×284×380 · Fuse 1+ 165×165×300 (rules to be confirmed) · Custom |

Add files (or take parts from Mesh prep) — they show up straight away in a quick layout marked *not nested* —, set the quantities, then press **Start nesting** (nothing is arranged on import, so you can add more parts and change quantities first; after a change the builds are marked as out of date until you nest again). Tick **Nest automatically after every change** to re-arrange on every change instead. Nesting:

- every part is put down on its largest flat face (SLA / DLP, DMLS) or, for **HP MJF / SLS, oriented by the usual powder-bed rules**: no large flat surface parallel to the platform (surfaces flatter than 30° to the layers are avoided), smooth change of the area per layer (no sudden jumps in cross-section), not needlessly tall, footprint lined up with X / Y — optionally tilted: **all parts** or only the **selected parts** (15°, 30°, 45° or a custom angle, in a chosen direction); select parts by clicking them in the view or the list (Ctrl / Shift-click for several, click empty space to clear);
- parts are packed in X and Y only (never stacked for SLA / DLP and DMLS; powder-bed printers can optionally stack in Z), with clearance between parts, a margin at the platform edges and a distance from the platform;
- each build is filled completely before the next one is started (Build 1, Build 2, …); parts are placed tallest first, so similar heights end up together, and when everything fits one platform it stays one build;
- parts that are too tall or too big for the printer are turned corner to corner or tilted automatically (smallest angle first) until they fit;
- quantities per part, parts that cannot fit the printer are listed with the reason;
- each build is shown in the printer's volume; export one build or all builds (3MF or STL, parts in place), or open a build in Mesh prep.
- **HP MJF / SLS (powder bed)**: **3D nesting by part shape** — parts are voxelized (surface + inside, closed cavities filled) and packed into each other's free space anywhere in X, Y and Z, not as bounding boxes. Placed parts are grown by the **clearance** (default 1 mm, 0.5 mm and up), so surfaces always stay at least that far apart. **No interlocking**: a part is only placed where it can slide straight out past the parts placed before it — along ±X, ±Y, ±Z, or along a line leaning 27° or 45° towards ±X / ±Y (up or down), so parts can sit deep inside tilted cups and trays and come out along their axis — so all parts can be taken out in reverse order. **Test interlocking** uses the same directions. Parts also go **inside open trays, U shapes and boxes** whenever they can be lifted out. The voxel size is chosen so the clearance is a whole number of voxels, surfaces are rasterized exactly and the keep-out around a part has rounded corners (true distance), so the gaps stay close to the clearance. **Nesting detail**: *Fast* uses one voxel per clearance; *Normal* a grid as fine as about 100 million voxels allows (lined up with the clearance: 1 mm for a 1 mm clearance, 0.83 mm for 2.5 mm on the HP 5200); *Fine* runs everything Normal does, then retries the two best orders on a finer grid (0.5 mm on the HP 5200), so it is never less dense and its time stays bounded. Each level tries several part orders (largest volume, tallest, largest box, **most open space first** — cups, trays and U shapes go in early so other parts can be nested inside them —, with and without patterns), each in its own worker, as many at a time as the computer has cores, coarser grids first. **The densest builds found so far are shown straight away** and replaced when a better one comes; **Stop and keep** (or Cancel on the progress card) keeps what is shown. Example: 279 parts of 40 kinds on an HP 5200 — first builds after about 10 s, all of Normal in about 25 s with 3 workers (test machine). Every part is voxelized once and shared by all the ways tried. **Symmetric arrangement** (on by default): copies of a part are also tried in a regular pattern; packing density comes first, so the pattern result is used only when it needs no more builds and is no taller than the best free nest (parts that do not fit the pattern are placed freely). **Max build height** (0 = the printer's full height), nesting detail (fast / normal / fine), **time limit** (default 10 min: nesting then stops and keeps the best builds found), parts oriented by the powder-bed rules above (no automatic 30° tilt any more).
- **Assemblies**: select the parts that are assembled together and press **Group as assembly** (in the Builds panel). All parts of a group get the orientation of the largest one (its flat-face turn and tilt), so the mating faces are printed at the same angle to the layers; they may still be turned about Z, which keeps that angle. Grouped parts show an A1, A2, … badge; **Ungroup** separates them.
- **Checks** for the active build (every printer): **Check collisions** finds parts whose surfaces cross, parts inside other parts and parts closer than the clearance, then shows only those parts with red markers where it happens; **Test interlocking** checks that every part can be taken out one after the other by sliding it straight out.
- **Edit by hand**: Select / Move / Rotate / Drag parts of the active build (Shift-drag up / down). Hand edits pause automatic re-arranging; **Re-arrange** applies the current settings again. **Pick single copies** selects one copy instead of every copy of a part.
- **Lock copies in place**: lock a copy's position along X, Y, Z and its rotation about X, Y, Z (per axis, or **Lock all axes**). The Move / Rotate handles and Drag only offer the free axes. On **Start nesting**, copies locked on all three position axes stay exactly where they are, copies locked on some axes keep those coordinates and are placed along the others, locked copies are never turned, and all other parts are nested around them (3D nesting).
- **Undo / Redo** (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y, toolbar buttons) in Build generation too: adding / removing parts, quantities, settings, nesting results, hand edits, locks and groups; Mesh prep keeps its own history.
- **Z cut**: the slider on the right of the view cuts the build at a height to look inside (show the parts below, or above).
- **Hide**: eye button per part, or **Hide selected** (whole parts or single copies) / **Show all**; hidden parts are only hidden in the view.
- **Not watertight warning**: parts with open edges are marked and listed with **Select** and **Repair in Mesh prep** (opens them there with the Repair tool; **Send to Build** afterwards replaces the build parts, quantities and settings kept).
- **Large parts**: when a build would show more than about 6 million triangles, heavy parts are drawn with a light copy (export, checks and nesting always use the full mesh); the view frames the build after nesting. Every part is voxelized once (in parallel workers) and the voxels are shared by all nesting runs; a 4.4-million-triangle part voxelizes in under 2 s on the test machine.
- **packing density** per build: total part volume ÷ the printer's full build volume (X × Y × Z), and ÷ the volume up to the tallest part plus an allowance (5 mm by default, editable; capped at the printer height). Shown on every build in the list and in detail for the active build.

**Snap** (Mesh prep → Transform, and Build generation → Select & edit): move in steps of a set distance (positions land on multiples of it) and rotate in steps of a set angle, for the Move / Rotate handles and Pick & place.

**Reliability (Build generation)**: every nesting starts with a quick coarse run, so a build is shown within about a minute; the time limit never ends a nesting before the first build is finished. A job that fails (e.g. a worker runs out of memory) is retried on a coarser grid, one job at a time, then skipped, while the others go on; only as many jobs run at once as the computer's memory allows. The **Nesting log** (Builds panel) lists what happened — grids, times, memory, failures — with **Copy log** to send it on. **Autosave**: parts, settings, builds and locks are kept in the browser; after a crash or closing the tab, Build generation offers **Restore** / **Discard**. Everything runs on each person's own computer (nothing is shared between users).

**Saving files** (Export, build export, report CSV): **Save to** → *Ask where* (pick the folder and file name each time), *A folder* (choose once, every export goes straight into it; remembered between visits) or *Downloads*. Choosing a location needs Chrome or Edge; Firefox and Safari save to Downloads (turn on "Ask where to save each file" in their download settings to be asked).

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
- `pointHoleCutters` (tapered holes), `applyLabel` / `conformToSurface`, `textureMesh`, `arrangeShelves`, `arrangeBoxes` (X/Y/Z layout), `gridArrayOffsets`, `simplifyMesh`, `remeshMesh`
- `growSelection`, `shrinkSelection`, `invertSelection`, `shellOfTriangle`, `brushSelect`, `polylineToOutline`
- `findFlattestFace`, `autoOrient`, `minAreaRectAngle`, `packBuilds` (build packing with MaxRects)
- `offsetMesh`, `offsetRegion`, `findSharpEdge`, `blendEdges` (fillet / chamfer), `bridgeEdges`, `findCrackEdges`
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
