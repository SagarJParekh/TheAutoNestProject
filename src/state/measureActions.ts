/**
 * Measurement tool: turns viewport clicks into entities (points, edges,
 * surfaces, circles, spheres) and entities into measurements.
 */
import { Matrix3, Vector3 } from 'three';
import { angle3, angleBetween, circleFrom3Points, measureDistance, vec } from '../geometry/measure3d';
import type { MEntity, Vec3 } from '../geometry';
import { getState, notify, partById, setState } from './store';
import type { Measurement, MeasureDraw } from './types';
import { matrixOf } from './math';
import { runJob } from './actions';
import { viewerApi } from '../viewer/api';
import type { PickInfo } from '../viewer/Viewer';

let mid = 1;
const fmt = (v: number, unit: 'mm' | '°') => (unit === 'mm' ? `${v.toFixed(2)} mm` : `${v.toFixed(2)}°`);
const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

export function resetPending() {
  setState({ measurePending: { entities: [], points: [] } });
}

export function clearMeasurements() {
  setState({ measurements: [], measurePending: { entities: [], points: [] } });
}

export function deleteMeasurement(id: number) {
  setState((s) => ({ measurements: s.measurements.filter((m) => m.id !== id) }));
}

function add(m: Omit<Measurement, 'id'>) {
  setState((s) => ({ measurements: [...s.measurements, { ...m, id: mid++ }], measurePending: { entities: [], points: [] } }));
}

function describe(e: MEntity): string {
  switch (e.kind) {
    case 'point': return 'Point';
    case 'line': return 'Edge';
    case 'plane': return 'Surface';
    case 'circle': return `Circle Ø${(e.r * 2).toFixed(2)}`;
    case 'sphere': return `Sphere Ø${(e.r * 2).toFixed(2)}`;
  }
}

/** Fit a circle (cylinder) or sphere to the smooth surface around the clicked triangle. */
async function fitAt(info: PickInfo, kind: 'cylinder' | 'sphere'): Promise<MEntity | null> {
  const part = partById(info.partId);
  if (!part) return null;
  const r = await runJob('Fitting feature', 'fitFeature', { mesh: part.mesh, seed: info.faceIndex, kind }, { silent: true });
  if (!r) return null;
  const m = matrixOf(part.transform);
  const c = new Vector3(...r.c).applyMatrix4(m);
  const s = part.transform.scale.map(Math.abs);
  const scale = (s[0] + s[1] + s[2]) / 3;
  if (r.rms > r.r * 0.05) notify('warning', `The surface is not very round (deviation ${r.rms.toFixed(3)} mm); the result is approximate.`);
  if (kind === 'sphere') return { kind: 'sphere', c: [c.x, c.y, c.z], r: r.r * scale };
  const ax = new Vector3(...(r.axis ?? [0, 0, 1])).applyMatrix3(new Matrix3().getNormalMatrix(m)).normalize();
  return { kind: 'circle', c: [c.x, c.y, c.z], n: [ax.x, ax.y, ax.z], r: r.r * scale };
}

/** Handle a viewport click while the Measure tool is active. */
export async function onMeasurePick(info: PickInfo) {
  const viewer = viewerApi.current?.viewer;
  if (!viewer) return;
  const s = getState();
  const { mode, pickAs } = s.settings.measure;

  if (mode === 'thickness') {
    const n = info.normal;
    const origin: Vec3 = [info.point[0] - n[0] * 0.01, info.point[1] - n[1] * 0.01, info.point[2] - n[2] * 0.01];
    const hit = viewer.castRay(origin, [-n[0], -n[1], -n[2]], { onlyPart: info.partId });
    if (!hit) return notify('warning', 'No opposite wall found (is the part closed?)');
    const t = hit.distance + 0.01;
    add({
      mode, title: 'Thickness', value: t, unit: 'mm', extras: [],
      draw: { points: [info.point, hit.point], segments: [[info.point, hit.point]], circles: [], label: { pos: midpoint(info.point, hit.point), text: fmt(t, 'mm') } },
    });
    return;
  }

  const snapped = () => viewer.snapVertex(info.partId, info.faceIndex, info.clientX, info.clientY) ?? info.point;

  // three-point modes collect raw points
  if (pickAs === 'circle3' || (mode === 'angle' && pickAs === 'point')) {
    const points = [...s.measurePending.points, snapped()];
    if (points.length < 3) return setState({ measurePending: { ...s.measurePending, points } });
    if (mode === 'angle' && pickAs === 'point') {
      const a = angle3(points[0], points[1], points[2]);
      add({
        mode, title: 'Angle (3 points)', value: a, unit: '°', extras: [],
        draw: { points, segments: [[points[1], points[0]], [points[1], points[2]]], circles: [], label: { pos: points[1], text: fmt(a, '°') } },
      });
      return;
    }
    let circle: MEntity;
    try {
      circle = circleFrom3Points(points[0], points[1], points[2]);
    } catch (e) {
      resetPending();
      return notify('warning', (e as Error).message);
    }
    setState({ measurePending: { ...s.measurePending, points: [] } });
    return useEntity(circle, '3-point circle');
  }

  let entity: MEntity | null = null;
  switch (pickAs) {
    case 'point':
      entity = { kind: 'point', p: snapped() };
      break;
    case 'edge': {
      const e = viewer.snapEdge(info.partId, info.faceIndex, info.point, info.clientX, info.clientY);
      if (e) entity = { kind: 'line', a: e[0], b: e[1] };
      break;
    }
    case 'surface':
      entity = { kind: 'plane', p: info.point, n: info.normal };
      break;
    case 'circle':
      entity = await fitAt(info, 'cylinder');
      break;
    case 'sphere':
      entity = await fitAt(info, 'sphere');
      break;
  }
  if (entity) useEntity(entity, describe(entity));
}

function useEntity(entity: MEntity, label: string) {
  const s = getState();
  const { mode } = s.settings.measure;
  if (mode === 'diameter') {
    if (entity.kind !== 'circle' && entity.kind !== 'sphere') return notify('warning', 'Pick a circle or sphere to measure a diameter');
    const d = entity.r * 2;
    const draw: MeasureDraw = {
      points: [entity.c],
      segments: [],
      circles: [{ c: entity.c, n: entity.kind === 'circle' ? entity.n : [0, 0, 1], r: entity.r }],
      label: { pos: entity.c, text: `Ø ${fmt(d, 'mm')}` },
    };
    add({
      mode, title: entity.kind === 'circle' ? (label === '3-point circle' ? 'Diameter (3 points)' : 'Diameter (circle)') : 'Diameter (sphere)',
      value: d, unit: 'mm', extras: [{ label: 'Radius', value: entity.r, unit: 'mm' }, { label: 'Centre X', value: entity.c[0], unit: 'mm' }, { label: 'Centre Y', value: entity.c[1], unit: 'mm' }, { label: 'Centre Z', value: entity.c[2], unit: 'mm' }],
      draw,
    });
    return;
  }
  const entities = [...s.measurePending.entities, { entity, label }];
  if (entities.length < 2) return setState({ measurePending: { ...s.measurePending, entities } });
  const [A, B] = entities.map((e) => e.entity);
  const title = `${entities[0].label} → ${entities[1].label}`;
  if (mode === 'angle') {
    const a = angleBetween(A, B);
    if (a === null) {
      resetPending();
      return notify('warning', 'Angles need edges, surfaces or circle axes (or use Point mode for 3 points)');
    }
    const r = measureDistance(A, B);
    const pos = midpoint(r.from, r.to);
    add({ mode, title, value: a, unit: '°', extras: [], draw: { points: [r.from, r.to], segments: [], circles: [], label: { pos, text: fmt(a, '°') } } });
    return;
  }
  const r = measureDistance(A, B);
  const extras = [...r.extra];
  if (r.angle !== undefined) extras.push({ label: 'Angle', value: r.angle, unit: '°' });
  const d = vec.sub(r.to, r.from);
  extras.push({ label: 'ΔX', value: Math.abs(d[0]), unit: 'mm' }, { label: 'ΔY', value: Math.abs(d[1]), unit: 'mm' }, { label: 'ΔZ', value: Math.abs(d[2]), unit: 'mm' });
  const circles = [A, B].filter((e): e is Extract<MEntity, { kind: 'circle' }> => e.kind === 'circle').map((e) => ({ c: e.c, n: e.n, r: e.r }));
  add({
    mode, title, value: r.distance, unit: 'mm', extras, note: r.note,
    draw: { points: [r.from, r.to], segments: [[r.from, r.to]], circles, label: { pos: midpoint(r.from, r.to), text: fmt(r.distance, 'mm') } },
  });
}
