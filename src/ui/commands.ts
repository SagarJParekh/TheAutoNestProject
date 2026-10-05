/**
 * Searchable command list for the command palette (Ctrl+K or /).
 * Each command opens a tool (and tab) or runs an action directly.
 */
import { getState, redo, setState, undo } from '../state/store';
import {
  analyzePart, cancelTool, centerOnOrigin, deleteParts, dropToBed, duplicateParts, mirrorParts, previewFillHoles, previewRepair,
  selectAll, setImportQuality, setTool,
} from '../state/actions';
import {
  checkIntersections, flipAllNormals, mergeSelectedParts, previewMakeSolid, previewRemoveOverlaps, previewStitch, previewUnifyShells,
  splitShellsToParts, unifyNormals, previewCleanTriangles, previewFixNonManifold,
} from '../state/repairActions';
import { alignToReference, arrangeOnBed, arrayParts } from '../state/featureActions';
import { loadShells, previewFixOpenEdges, startLasso } from '../state/editActions';
import { viewerApi } from '../viewer/api';
import type { DisplayMode, MeasureMode, RepairTab, ToolId } from '../state/types';

export interface Command {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  shortcut?: string;
  run: () => void;
}

const tool = (t: ToolId, extra: Record<string, unknown> = {}) => () => {
  setTool(t);
  if (Object.keys(extra).length) setState(extra as never);
};
const repair = (tab: RepairTab, then?: () => void) => () => {
  setTool('repair');
  setState({ repairTab: tab });
  then?.();
};
const selectedId = () => getState().selection[0];
const measure = (mode: MeasureMode) => () => {
  setTool('measure');
  const s = getState();
  setState({ settings: { ...s.settings, measure: { ...s.settings.measure, mode } } });
};
const display = (d: DisplayMode) => () => setState({ display: d });
const boolOp = (op: 'union' | 'subtract' | 'intersect') =>
  repair('combine', () => setState((s) => ({ settings: { ...s.settings, boolean: { op } } })));

export function buildCommands(): Command[] {
  return [
    // file
    { id: 'open', label: 'Open files…', group: 'File', keywords: 'import load stl step 3mf obj', shortcut: 'Ctrl+O', run: () => (document.querySelector('.toolbar input[type=file]') as HTMLInputElement | null)?.click() },
    { id: 'export', label: 'Export…', group: 'File', keywords: 'save stl 3mf obj download', shortcut: 'Ctrl+E', run: () => setState({ showExport: true }) },
    ...(['draft', 'normal', 'fine', 'ultra'] as const).map((q) => ({
      id: `quality-${q}`, label: `CAD import quality: ${q}`, group: 'File', keywords: 'step iges resolution tessellation triangles', run: () => setImportQuality(q),
    })),
    { id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', run: undo },
    { id: 'redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Shift+Z', run: redo },
    { id: 'select-all', label: 'Select all parts', group: 'Edit', shortcut: 'Ctrl+A', run: selectAll },
    { id: 'duplicate', label: 'Duplicate selected parts', group: 'Edit', keywords: 'copy clone', shortcut: 'Ctrl+D', run: () => duplicateParts() },
    { id: 'delete', label: 'Delete selected parts', group: 'Edit', keywords: 'remove', shortcut: 'Del', run: () => deleteParts() },
    // transform
    { id: 'transform', label: 'Transform tool (move / rotate / scale)', group: 'Transform', keywords: 'position rotation scale size gizmo', shortcut: 'T', run: tool('transform') },
    { id: 'drop', label: 'Drop to bed', group: 'Transform', keywords: 'floor z zero', shortcut: 'B', run: () => dropToBed() },
    { id: 'center', label: 'Centre on origin', group: 'Transform', keywords: 'middle', shortcut: 'Shift+C', run: () => centerOnOrigin() },
    { id: 'layflat', label: 'Lay flat (click a face)', group: 'Transform', keywords: 'orient bottom face down', shortcut: 'F', run: () => { setTool('transform'); setState({ pickMode: 'layflat' }); } },
    ...([0, 1, 2] as const).map((a) => ({ id: `mirror-${a}`, label: `Mirror ${'XYZ'[a]}`, group: 'Transform', keywords: 'flip reflect', run: () => mirrorParts(a) })),
    { id: 'align-part', label: 'Align parts to a reference part', group: 'Transform', keywords: 'left right front back centre distance', run: () => { setTool('transform'); alignToReference(); } },
    { id: 'array', label: 'Create 2D array of copies', group: 'Transform', keywords: 'grid pattern copies duplicate', run: () => { setTool('transform'); arrayParts(); } },
    { id: 'arrange', label: 'Arrange parts on bed', group: 'Transform', keywords: 'layout pack nest 2d', run: arrangeOnBed },
    { id: 'align-tool', label: 'Align by faces (mate / flush)', group: 'Transform', keywords: 'mate flush face', shortcut: 'A', run: tool('align') },
    // view
    { id: 'fit', label: 'Fit all to view', group: 'View', keywords: 'zoom extents', shortcut: 'Home', run: () => viewerApi.current?.fitView() },
    { id: 'fit-sel', label: 'Fit selection', group: 'View', keywords: 'zoom', shortcut: 'Shift+F', run: () => viewerApi.current?.fitView(true) },
    { id: 'zoom-area', label: 'Zoom to area', group: 'View', keywords: 'window rectangle', shortcut: 'Z', run: () => setState({ zoomWindow: true }) },
    ...(['top', 'front', 'side', 'iso', 'back', 'bottom'] as const).map((v) => ({ id: `view-${v}`, label: `View: ${v === 'side' ? 'right' : v}`, group: 'View', keywords: 'camera standard', run: () => viewerApi.current?.setView(v) })),
    { id: 'ortho', label: 'Toggle perspective / orthographic', group: 'View', keywords: 'camera projection', shortcut: 'O', run: () => setState({ orthographic: !getState().orthographic }) },
    { id: 'grid', label: 'Toggle grid', group: 'View', shortcut: 'G', run: () => setState({ showGrid: !getState().showGrid }) },
    { id: 'disp-shaded', label: 'Display: shaded', group: 'View', run: display('shaded') },
    { id: 'disp-edges', label: 'Display: shaded with edges', group: 'View', run: display('edges') },
    { id: 'disp-wire', label: 'Display: wireframe', group: 'View', keywords: 'mesh triangles', run: display('wireframe') },
    { id: 'disp-xray', label: 'Display: x-ray', group: 'View', keywords: 'transparent see through', run: display('xray') },
    // tools
    { id: 'clip', label: 'Section clip (inspect inside)', group: 'Tools', keywords: 'section plane cross-section', shortcut: 'C', run: tool('clip') },
    { id: 'cut', label: 'Cut with a plane', group: 'Tools', keywords: 'split slice angle tilt', shortcut: 'X', run: tool('cut', {}) },
    { id: 'lasso', label: 'Lasso cut (freehand)', group: 'Tools', keywords: 'cut split draw outline', run: () => { setTool('cut'); setState((s) => ({ settings: { ...s.settings, cutMode: 'lasso' } })); startLasso(); } },
    { id: 'hollow', label: 'Hollow (wall thickness, drain holes)', group: 'Tools', keywords: 'shell inner wall', shortcut: 'H', run: tool('hollow') },
    { id: 'perforate', label: 'Perforate (hole pattern, single / tapered holes)', group: 'Tools', keywords: 'holes drill pattern plug', shortcut: 'P', run: tool('perforate') },
    { id: 'extrude', label: 'Extrude surface', group: 'Tools', keywords: 'push pull face thicken', shortcut: 'E', run: tool('extrude') },
    { id: 'label', label: 'Label (emboss / engrave text)', group: 'Tools', keywords: 'text font letters', shortcut: 'L', run: tool('label') },
    { id: 'texture', label: 'Texture (knurl, pattern, image)', group: 'Tools', keywords: 'surface displacement heightmap', shortcut: 'K', run: tool('texture') },
    { id: 'props', label: 'Props / supports between faces', group: 'Tools', keywords: 'pillar strut support connect', shortcut: 'S', run: tool('props') },
    // measure
    { id: 'measure', label: 'Measure', group: 'Measure', shortcut: 'D', run: tool('measure') },
    { id: 'm-dist', label: 'Measure distance', group: 'Measure', keywords: 'length point edge surface', run: measure('distance') },
    { id: 'm-angle', label: 'Measure angle', group: 'Measure', run: measure('angle') },
    { id: 'm-dia', label: 'Measure diameter / radius', group: 'Measure', keywords: 'circle hole sphere', run: measure('diameter') },
    { id: 'm-thick', label: 'Measure wall thickness', group: 'Measure', run: measure('thickness') },
    // repair
    { id: 'repair', label: 'Repair: analyse mesh', group: 'Repair', keywords: 'check errors watertight', shortcut: 'R', run: repair('fix', () => { const id = selectedId(); if (id) analyzePart(id); }) },
    { id: 'autorepair', label: 'Auto repair', group: 'Repair', keywords: 'fix all one click', run: repair('fix', previewRepair) },
    { id: 'fill', label: 'Fill all holes', group: 'Repair', keywords: 'open edges close', run: repair('fix', () => previewFillHoles()) },
    { id: 'open-edges', label: 'Fix open edges (stitch & fill)', group: 'Repair', keywords: 'holes cracks gaps boundary', run: repair('fix', () => previewFixOpenEdges('stitchFill')) },
    { id: 'trim', label: 'Remove dangling triangles', group: 'Repair', keywords: 'open edges slivers', run: repair('fix', () => previewFixOpenEdges('trim')) },
    { id: 'stitch', label: 'Stitch cracks', group: 'Repair', keywords: 'weld gaps t-junction', run: repair('fix', previewStitch) },
    { id: 'dups', label: 'Remove duplicate triangles', group: 'Repair', run: repair('fix', () => previewCleanTriangles('duplicates')) },
    { id: 'degen', label: 'Remove degenerate triangles', group: 'Repair', keywords: 'zero area slivers', run: repair('fix', () => previewCleanTriangles('degenerate')) },
    { id: 'nonmanifold', label: 'Fix non-manifold edges', group: 'Repair', keywords: 'manifold fins', run: repair('fix', () => previewFixNonManifold(true)) },
    { id: 'overlaps', label: 'Check overlapping / intersecting triangles', group: 'Repair', keywords: 'self intersection', run: repair('fix', () => { const id = selectedId(); if (id) checkIntersections(id); }) },
    { id: 'rm-overlaps', label: 'Remove overlapping triangles', group: 'Repair', run: repair('fix', previewRemoveOverlaps) },
    { id: 'normals', label: 'Unify normals (outward)', group: 'Repair', keywords: 'winding orientation flipped', run: repair('fix', unifyNormals) },
    { id: 'flip', label: 'Flip all normals', group: 'Repair', keywords: 'inside out', run: repair('fix', flipAllNormals) },
    { id: 'shells', label: 'View shells (delete / merge / extract)', group: 'Repair', keywords: 'bodies islands components', run: repair('shells', () => { const id = selectedId(); if (id) loadShells(id); }) },
    { id: 'split', label: 'Split shells into parts', group: 'Repair', keywords: 'separate bodies', run: repair('combine', splitShellsToParts) },
    { id: 'unify', label: 'Unify shells (boolean union)', group: 'Repair', keywords: 'merge overlapping', run: repair('combine', previewUnifyShells) },
    { id: 'solid', label: 'Make solid (voxel remesh)', group: 'Repair', keywords: 'rebuild watertight', run: repair('combine', previewMakeSolid) },
    { id: 'union', label: 'Boolean union', group: 'Repair', keywords: 'combine add join', run: boolOp('union') },
    { id: 'subtract', label: 'Boolean subtract', group: 'Repair', keywords: 'difference minus remove', run: boolOp('subtract') },
    { id: 'intersect', label: 'Boolean intersect', group: 'Repair', keywords: 'common overlap', run: boolOp('intersect') },
    { id: 'merge', label: 'Merge parts (no boolean)', group: 'Repair', keywords: 'combine group', run: repair('combine', mergeSelectedParts) },
    { id: 'tri-delete', label: 'Delete triangles (manual)', group: 'Repair', keywords: 'edit remove faces', run: repair('edit', () => setState((s) => ({ settings: { ...s.settings, triEdit: { ...s.settings.triEdit, mode: 'delete' } }, pickMode: 'triangle' }))) },
    { id: 'tri-create', label: 'Create triangles (manual)', group: 'Repair', keywords: 'edit add face bridge', run: repair('edit', () => setState((s) => ({ settings: { ...s.settings, triEdit: { ...s.settings.triEdit, mode: 'create' } }, pickMode: 'vertex' }))) },
    // help
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', shortcut: '?', run: () => setState({ showShortcuts: true }) },
    { id: 'cancel', label: 'Cancel current tool', group: 'Help', keywords: 'escape exit', run: cancelTool },
  ];
}

/** Commands whose label/group/keywords contain every typed word, best matches first. */
export function searchCommands(all: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  const scored: [number, Command][] = [];
  for (const c of all) {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.group.toLowerCase()} ${c.keywords ?? ''}`;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    const main = label.split('(')[0];
    if (label.startsWith(words[0])) score += 10;
    for (const w of words) {
      if (label.includes(w)) score += 3;
      if (main.includes(w)) score += 4; // the name itself matters more than the bracketed details
    }
    if (new RegExp(`\\b${words[0]}`).test(label)) score += 2;
    scored.push([score, c]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, c]) => c);
}
