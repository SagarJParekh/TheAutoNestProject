/**
 * What each function does, shown when the cursor rests on it for a few
 * seconds. Looked up by the control's `data-help` or its visible label
 * (lower case, without counts in brackets); controls without an entry show
 * their tooltip text instead.
 */
export const HELP: Record<string, string> = {
  // workspaces and file
  'mesh prep': 'Mesh prep: open, check, repair and edit single parts — cut, hollow, lattice, label, texture, measure — before printing.',
  'build generation': 'Build generation: arrange many parts and their quantities on a printer platform (nesting), check collisions and interlocking, and export the builds.',
  open: 'Open 3D files: STL, OBJ, PLY, 3MF, AMF, 3DM, STEP / IGES / BREP, glTF and OFF. You can also drag files or whole folders onto the window.',
  export: 'Export parts as STL, 3MF, OBJ or SLC (slices for SLA / DLP) — selected or all parts, as one file, separate files in a folder, or a ZIP.',
  // tools
  transform: 'Transform: move, rotate and scale parts with the handles or exact numbers, lay a face flat, drop to the bed, mirror, array and arrange.',
  shapes: 'Shapes: create basic solids — cube, cylinder, cone, sphere, donut, tube, pyramid, prism, wedge, capsule, ellipsoid — to use as parts or for booleans.',
  'clip & cut': 'Clip & Cut: Clip shows a section through the parts without changing them; Cut splits parts with planes (X / Y / Z together), a drawn line, a lasso or a joint profile.',
  repair: 'Repair: find and fix holes, cracks, flipped and duplicate triangles, non-manifold edges and loose shells; edit triangles by hand. Repaired parts are saved as name_repaired.',
  boolean: 'Boolean operations: union, subtract or intersect parts (the first selected is the base), merge parts, split or unify the shells of a part, or rebuild it as one solid.',
  hollow: 'Hollow: make a part a shell with a set wall thickness to save material, with drain holes to let resin or powder out.',
  lattice: 'Lattice: lighten a part by keeping a solid skin and filling the inside with a gyroid, diamond, Schwarz P, cubic or honeycomb lattice.',
  perforate: 'Perforate: cut a pattern of holes through a face, or holes at picked points (straight or tapered), optionally keeping the cut-out plugs.',
  extrude: 'Extrude: push picked faces outwards (or inwards) by a distance, building side walls.',
  label: 'Label: emboss or engrave text on a picked point of the surface, following its curvature.',
  texture: 'Texture: give a surface a relief pattern from an image or a built-in texture.',
  align: 'Align: move one part so a picked face lies on (or against) a face of another part.',
  props: 'Props: add supporting props between surfaces, or a single prop from a picked point to the platform.',
  offset: 'Offset: grow or shrink a whole part, or push single faces in or out.',
  fillet: 'Fillet & Chamfer: round (fillet) or bevel (chamfer) picked sharp edges; outside edges lose material, inside edges gain it.',
  'vc module': 'VC module (vacuum casting): arrange parts in their minimum bounding box, then create silicone mould blocks around all or selected parts — 20 / 30 / 50 mm clearance on all sides by part size — with the part as the cavity.',
  shrinkwrap: 'Shrinkwrap: wrap one closed surface around a part and make it solid — closes holes, gaps and cavities up to a size; good for broken scans.',
  measure: 'Measure: distances, angles, diameters and wall thickness between points, edges, surfaces, circles and spheres; plus a wall-thickness heat map.',
  dimensions: 'Dimensions: the bounding box, size, volume and surface of the selected parts, drawn on the part; arrange parts in their smallest box.',
  report: 'Report: a table of all parts (size, volume, triangles, state) to copy to Excel or save as CSV.',
  // clip & cut
  'clip (section view)': 'Section clip: hide everything past the planes and fill the cut faces, to look inside the parts. Nothing is changed.',
  'cut part': 'Cut: split parts into separate pieces (named name_cut1, name_cut2…).',
  plane: 'Plane cut: cut by the X, Y and Z planes that are switched on (any combination), or by one angled plane.',
  'draw line': 'Draw line: click points to draw a line of straight segments across the part (steps, zig-zags); the part is split along it in the view direction.',
  lasso: 'Lasso: drag a freehand outline; everything inside it, through the part, becomes one piece.',
  joint: 'Joint: cut with a profile so the pieces key together — lap joints follow the outline (step, square, U, dovetail…), tongue joints overlap across the section.',
  'execute cut': 'Execute cut: cut the parts by every plane that is on, right away (Ctrl+Z undoes it).',
  'section clip': 'Section clip: turn on the X / Y / Z clip planes from any tool, to look inside parts and previews before applying.',
  // repair tabs
  fix: 'Fix: analyse the part and fix its problems one by one or with Auto repair.',
  shells: 'Shells: list the separate pieces (shells) of a part to delete, keep, merge, hide or extract them.',
  edit: 'Edit: mark triangles (by click, plane, surface, shell, brush or window) to delete, fill, bridge or remesh them by hand.',
  // build generation
  sla: 'SLA printers (laser resin): Eplus, Magform or a custom size. Parts are arranged on the platform, never stacked.',
  dlp: 'DLP printers (projected resin): Formlabs, Vayu, YouSu, 3D Systems Figure 4 or a custom size. Parts are arranged on the platform, never stacked.',
  dmls: 'DMLS printers (metal): parts are arranged on the platform, never stacked.',
  'hp mjf / sls': 'Powder-bed printers (HP MJF, SLS): parts are nested by their shape anywhere in the volume, with a clearance and no interlocking.',
  custom: 'Custom printer: enter your own build volume (X × Y × Z).',
  'start nesting': 'Start nesting: arrange all parts and quantities into as few builds as possible. The best result so far is shown while it works; Stop keeps it.',
  're-arrange': 'Re-arrange: nest the parts again with the current settings (locked copies stay where they are).',
  'add files…': 'Add files: add 3D files to the build; set the quantity of each part in the list.',
  'from mesh prep': 'From Mesh prep: bring the selected (or all) parts from Mesh prep into the build.',
  'check collisions': 'Check collisions: find parts that touch or overlap in the current build.',
  'test interlocking': 'Test interlocking: check that every part can be taken out of the build (no part trapped inside another).',
  'export all': 'Export all builds as 3MF files in one ZIP.',
  'open in mesh prep': 'Open in Mesh prep: copy this build, with the parts in place, to Mesh prep for editing.',
  slc: 'SLC: slice the build into contour layers (SLC file) for SLA / DLP printers, at the SLC layer thickness.',
};

/** Key of a control for the table above. */
export function helpKey(text: string): string {
  return text.replace(/\(\d+\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
