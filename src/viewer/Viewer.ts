import {
  AmbientLight, Box3, Box3Helper, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DecrementWrapStencilOp,
  DirectionalLight, DoubleSide, FrontSide, BackSide, GridHelper, Group, HemisphereLight, IncrementWrapStencilOp,
  LineBasicMaterial, LineSegments, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, NotEqualStencilFunc,
  Object3D, OrthographicCamera, PerspectiveCamera, Plane, PlaneGeometry, Quaternion, Raycaster, ReplaceStencilOp, Scene,
  Sphere, Vector2, Vector3, WebGLRenderer, AlwaysStencilFunc, Material, Line, Line3, Points, PointsMaterial, Sprite, SpriteMaterial,
  CanvasTexture, SRGBColorSpace,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { highlightColors } from '../state/contrast';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { MeshData, Vec3 } from '../geometry';
import { faceNormalSegmentsSplit } from '../geometry/props';
import type { AppState } from '../state/store';
import type { Part, Transform, ViewName } from '../state/types';
import { meshEntry, onMeshEntryChange } from '../state/meshCache';
import { createPartMaterial, orientationUniforms } from './materials';
import { sectionSegments } from './section';
import { AxisGizmo } from './axisGizmo';
import { planeFromSettings, quaternionOf, eulerDegFromQuaternion, worldBounds } from '../state/math';

Mesh.prototype.raycast = acceleratedRaycast;

const ACCENT = new Color('#ffd23f');
const D2R = Math.PI / 180;

export interface PickInfo {
  partId: string;
  faceIndex: number;
  point: [number, number, number];
  normal: [number, number, number];
  shift: boolean;
  ctrl: boolean;
  clientX: number;
  clientY: number;
}

export interface ViewerCallbacks {
  onPick: (info: PickInfo | null, ev: { shift: boolean; ctrl: boolean; clientX: number; clientY: number }) => void;
  onTransformEnd: (partId: string, t: Transform) => void;
  /** called after a zoom-window drag finishes (or is cancelled) */
  onZoomDone?: () => void;
  /** called with the lasso outline (client coordinates) when a lasso drag ends */
  onLasso?: (points: [number, number][]) => void;
  /** brush painting: called for each sample while dragging with the brush mark tool */
  onBrush?: (info: PickInfo, erase: boolean) => void;
  /** window marking: rectangle in client coordinates */
  onRect?: (x0: number, y0: number, x1: number, y1: number, erase: boolean) => void;
  /** polyline drawing finished: points in client coordinates */
  onPolyline?: (points: [number, number][]) => void;
  /** pick & place finished: new positions of the dragged parts */
  onPlaceEnd?: (moves: { id: string; position: [number, number, number] }[]) => void;
}

interface PartObject {
  part: Part;
  group: Group;
  mesh: Mesh;
  material: MeshStandardMaterial;
  edges?: LineSegments;
  edgesFor?: Float32Array;
  stencil?: Group;
  cap?: Mesh;
  section?: LineSegments;
  sectionKey?: string;
  overlay: Group;
  overlayKey?: string;
  selBox?: Box3Helper;
}

interface GeometryRecord {
  geometry: BufferGeometry;
  refs: number;
}

/**
 * Imperative Three.js scene that mirrors the app state. React components
 * call `sync(state)` whenever the store changes; rendering is on demand.
 */
export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  private perspective: PerspectiveCamera;
  private ortho: OrthographicCamera;
  camera: PerspectiveCamera | OrthographicCamera;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private gizmoHelper: Object3D;
  private headlight = new DirectionalLight(0xffffff, 1.6);
  private gridGroup = new Group();
  private partsGroup = new Group();
  private previewGroup = new Group();
  private overlayGroup = new Group();
  private annotGroup = new Group();
  private dimGroup = new Group();
  private dimKey: unknown[] = [];
  private hoverGroup = new Group();
  private hoverPending = false;
  private annotKey: unknown[] = [];
  private zoomRect: { x: number; y: number; div: HTMLDivElement; mark?: boolean; erase?: boolean } | null = null;
  private brushing: { erase: boolean; pending: PointerEvent | null } | null = null;
  private placing: {
    plane: Plane;
    start: Vector3;
    vertical: boolean;
    items: { obj: PartObject; from: Vector3 }[];
    moved: boolean;
  } | null = null;
  private poly: { points: [number, number][]; svg: SVGSVGElement; line: SVGPolylineElement; dots: SVGGElement; cursor: [number, number] | null } | null = null;
  private lasso: { points: [number, number][]; svg: SVGSVGElement; line: SVGPolylineElement } | null = null;
  private capsGroup = new Group();
  private objects = new Map<string, PartObject>();
  private geometries = new WeakMap<MeshData, GeometryRecord>();
  private axis = new AxisGizmo();
  private raycaster = new Raycaster();
  private state: AppState | null = null;
  private renderPending = false;
  private clipPlane: Plane | null = null;
  private previewKey: unknown = null;
  private overlayKey = '';
  private gridSize = 0;
  private draggingGizmo = false;
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private resizeObserver: ResizeObserver;
  private unsubMesh: () => void;

  constructor(private container: HTMLElement, private cb: ViewerCallbacks) {
    this.renderer = new WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x1b1e24);
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.perspective = new PerspectiveCamera(40, 1, 0.1, 100000);
    this.ortho = new OrthographicCamera(-100, 100, 100, -100, -100000, 100000);
    for (const c of [this.perspective, this.ortho]) c.up.set(0, 0, 1);
    this.perspective.position.set(250, -300, 220);
    this.camera = this.perspective;
    this.scene.add(this.perspective, this.ortho);
    this.headlight.position.set(0.4, 0.6, 1);
    this.perspective.add(this.headlight);

    this.scene.add(new AmbientLight(0xffffff, 0.35));
    this.scene.add(new HemisphereLight(0xdde6ff, 0x30281e, 0.9));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 20);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.draggingGizmo = dragging;
      this.controls.enabled = !dragging;
      if (!dragging) this.commitGizmo();
    });

    this.scene.add(this.gridGroup, this.partsGroup, this.capsGroup, this.previewGroup, this.overlayGroup, this.annotGroup, this.hoverGroup, this.dimGroup);
    this.buildGrid(200);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (this.state?.zoomWindow && e.button === 0) this.startZoomRect(e);
      else if (this.state?.lassoMode && e.button === 0) this.startLasso(e);
      else if (this.state?.pickMode === 'window' && e.button === 0) this.startZoomRect(e, true);
      else if (this.state?.pickMode === 'brush' && e.button === 0) this.startBrush(e);
      else if (this.placeActive() && e.button === 0) this.startPlace(e);
    });
    el.addEventListener('pointermove', (e) => {
      this.moveZoomRect(e);
      this.moveLasso(e);
      this.moveBrush(e);
      this.movePoly(e);
      this.movePlace(e);
      this.scheduleHover(e.clientX, e.clientY, e.buttons !== 0);
    });
    el.addEventListener('pointerleave', () => this.clearHover());
    el.addEventListener('pointerup', (e) => {
      if (this.zoomRect) return this.endZoomRect(e);
      if (this.lasso) return this.endLasso();
      if (this.brushing) return this.endBrush();
      if (this.placing) {
        const moved = this.endPlace();
        if (moved) return;
      }
      if (this.state?.polyMode) return this.clickPoly(e);
      this.onPointerUp(e);
    });
    el.addEventListener('dblclick', () => {
      if (this.state?.polyMode) this.finishPolyline();
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.unsubMesh = onMeshEntryChange((mesh) => this.onMeshEntry(mesh));
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.unsubMesh();
    this.gizmo.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------ rendering

  requestRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.render();
    });
  }

  private render() {
    const r = this.renderer;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    r.setViewport(0, 0, w, h);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    this.axis.render(r, this.camera);
  }

  private fatMaterials = new Set<LineMaterial>();
  /** Screen-space thick lines drawn on top (WebGL lines are always 1 px). */
  private fatLines(seg: Float32Array, color: string, widthPx: number): LineSegments2 {
    const g = new LineSegmentsGeometry();
    g.setPositions(seg);
    const m = new LineMaterial({ color: new Color(color).getHex(), linewidth: widthPx, depthTest: false, transparent: true });
    const size = this.renderer.getSize(new Vector2());
    m.resolution.set(size.x, size.y);
    this.fatMaterials.add(m);
    m.addEventListener('dispose', () => this.fatMaterials.delete(m));
    const l = new LineSegments2(g, m);
    l.renderOrder = 1000;
    l.raycast = () => {};
    return l;
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    for (const m of this.fatMaterials) m.resolution.set(w, h);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  private updateOrthoFrustum() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const dist = this.perspective.position.distanceTo(this.controls.target);
    const halfH = dist * Math.tan((this.perspective.fov * D2R) / 2);
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.left = (-halfH * w) / h;
    this.ortho.right = (halfH * w) / h;
    this.ortho.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ grid

  private buildGrid(size: number) {
    if (size === this.gridSize) return;
    this.gridSize = size;
    this.gridGroup.clear();
    const minor = new GridHelper(size, size / 10, 0x2c313a, 0x2c313a);
    const major = new GridHelper(size, size / 50, 0x3a414d, 0x3a414d);
    for (const g of [minor, major]) {
      g.rotation.x = Math.PI / 2;
      (g.material as Material).depthWrite = false;
      g.renderOrder = -2;
    }
    const axes = new LineSegments(
      new BufferGeometry().setAttribute(
        'position',
        new BufferAttribute(new Float32Array([0, 0, 0.01, size / 2, 0, 0.01, 0, 0, 0.01, 0, size / 2, 0.01]), 3),
      ),
      new LineBasicMaterial({ vertexColors: false, color: 0x8a5a5a }),
    );
    const yAxis = new LineSegments(
      new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0.01, 0, size / 2, 0.01]), 3)),
      new LineBasicMaterial({ color: 0x5a8a5f }),
    );
    const xAxis = new LineSegments(
      new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0.01, size / 2, 0, 0.01]), 3)),
      new LineBasicMaterial({ color: 0x9a5a5f }),
    );
    void axes;
    this.gridGroup.add(minor, major, xAxis, yAxis);
  }

  // ------------------------------------------------------------------ geometry cache

  private acquireGeometry(mesh: MeshData): BufferGeometry {
    let rec = this.geometries.get(mesh);
    if (!rec) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      g.setIndex(new BufferAttribute(mesh.indices, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      rec = { geometry: g, refs: 0 };
      this.geometries.set(mesh, rec);
      this.attachBVH(mesh, g);
    }
    rec.refs++;
    return rec.geometry;
  }

  private releaseGeometry(mesh: MeshData) {
    const rec = this.geometries.get(mesh);
    if (!rec) return;
    rec.refs--;
    if (rec.refs <= 0) {
      rec.geometry.dispose();
      this.geometries.delete(mesh);
    }
  }

  private attachBVH(mesh: MeshData, g: BufferGeometry) {
    const e = meshEntry(mesh);
    if (e.bvh && !g.boundsTree) {
      try {
        g.boundsTree = MeshBVH.deserialize(e.bvh as never, g, { setIndex: false });
      } catch (err) {
        console.warn('BVH deserialise failed', err);
      }
    }
  }

  private onMeshEntry(mesh: MeshData) {
    const rec = this.geometries.get(mesh);
    if (rec) this.attachBVH(mesh, rec.geometry);
    // edges / section might need refresh
    if (this.state) this.sync(this.state);
  }

  // ------------------------------------------------------------------ sync

  sync(s: AppState) {
    const prev = this.state;
    this.state = s;
    if (!s.polyMode && this.poly) this.cancelPolyline();
    const ns = s.settings.normals;
    orientationUniforms.uOrient.value = ns.orientation ? 1 : 0;
    orientationUniforms.uFrontColor.value.set(ns.frontColor);
    orientationUniforms.uBackColor.value.set(ns.backColor);
    if (!prev || prev.orthographic !== s.orthographic) this.setOrthographic(s.orthographic);
    this.gridGroup.visible = s.showGrid;

    // clip plane (world)
    this.clipPlane = null;
    if (s.clipEnabled) {
      const p = planeFromSettings(s.clip);
      // keep the side below the plane: three clips where n·x + c < 0
      this.clipPlane = new Plane(new Vector3(-p.normal[0], -p.normal[1], -p.normal[2]), p.constant);
    }

    const seen = new Set<string>();
    const selected = new Set(s.selection);
    const ghosted = new Set(s.preview?.replaces ?? []);
    s.parts.forEach((part, index) => {
      seen.add(part.id);
      let obj = this.objects.get(part.id);
      if (!obj) obj = this.createObject(part);
      else if (obj.part.mesh !== part.mesh) this.swapMesh(obj, part);
      obj.part = part;
      this.updateObject(obj, s, index, selected.has(part.id), ghosted.has(part.id));
    });
    for (const [id, obj] of this.objects) if (!seen.has(id)) this.removeObject(id, obj);

    this.syncGizmo(s);
    this.syncPreview(s);
    this.syncOverlays(s);
    this.syncAnnotations(s);
    this.syncDimensions(s);
    this.updateGridSize(s);
    this.requestRender();
  }

  private createObject(part: Part): PartObject {
    const group = new Group();
    group.name = part.id;
    const geometry = this.acquireGeometry(part.mesh);
    const material = createPartMaterial(part.color);
    const mesh = new Mesh(geometry, material);
    mesh.userData.partId = part.id;
    const overlay = new Group();
    group.add(mesh, overlay);
    this.partsGroup.add(group);
    const obj: PartObject = { part, group, mesh, material, overlay };
    this.objects.set(part.id, obj);
    return obj;
  }

  private swapMesh(obj: PartObject, part: Part) {
    this.releaseGeometry(obj.part.mesh);
    obj.mesh.geometry = this.acquireGeometry(part.mesh);
    if (obj.edges) {
      obj.edges.geometry.dispose();
      obj.group.remove(obj.edges);
      obj.edges = undefined;
      obj.edgesFor = undefined;
    }
    if (obj.stencil) {
      for (const c of obj.stencil.children) (c as Mesh).geometry = obj.mesh.geometry;
    }
    obj.sectionKey = undefined;
    obj.overlayKey = undefined;
  }

  private removeObject(id: string, obj: PartObject) {
    if (this.gizmo.object === obj.group) this.gizmo.detach();
    this.releaseGeometry(obj.part.mesh);
    obj.material.dispose();
    obj.edges?.geometry.dispose();
    obj.section?.geometry.dispose();
    if (obj.cap) this.capsGroup.remove(obj.cap);
    if (obj.selBox) this.overlayGroup.remove(obj.selBox);
    this.partsGroup.remove(obj.group);
    this.objects.delete(id);
  }

  private applyTransform(group: Object3D, t: Transform) {
    group.position.set(...t.position);
    group.quaternion.copy(quaternionOf(t));
    group.scale.set(...t.scale);
    group.updateMatrixWorld(true);
  }

  private updateObject(obj: PartObject, s: AppState, index: number, selected: boolean, ghost: boolean) {
    const { part, group, material } = obj;
    if ((!this.draggingGizmo || this.gizmo.object !== group) && !this.placing?.items.some((i) => i.obj === obj)) this.applyTransform(group, part.transform);
    group.visible = part.visible;

    // material per display mode
    const mode = s.display;
    const color = new Color(part.color);
    material.color.copy(color);
    material.emissive.copy(selected ? color.clone().multiplyScalar(0.28) : new Color(0));
    material.wireframe = mode === 'wireframe';
    const xray = mode === 'xray' || ghost;
    material.transparent = xray;
    material.opacity = ghost ? 0.12 : mode === 'xray' ? 0.28 : 1;
    material.depthWrite = !xray;
    // clipping plane count / transparency are picked up by the renderer without a program rebuild
    const planes = this.clipPlane ? [this.clipPlane] : null;
    if ((material.clippingPlanes?.[0] ?? null) !== (planes?.[0] ?? null)) material.clippingPlanes = planes;

    // feature edges
    const wantEdges = (mode === 'edges' || mode === 'xray') && !ghost && part.visible;
    if (wantEdges) {
      const e = meshEntry(part.mesh);
      if (e.edges && obj.edgesFor !== e.edges) {
        if (obj.edges) {
          obj.edges.geometry.dispose();
          group.remove(obj.edges);
        }
        const g = new BufferGeometry().setAttribute('position', new BufferAttribute(e.edges, 3));
        obj.edges = new LineSegments(g, new LineBasicMaterial({ color: 0x0b0d10, transparent: true, opacity: 0.85 }));
        obj.edgesFor = e.edges;
        group.add(obj.edges);
      } else if (!e.edges) {
        this.edgeRequest?.(part.mesh);
      }
    }
    if (obj.edges) {
      obj.edges.visible = wantEdges;
      const lm = obj.edges.material as LineBasicMaterial;
      lm.color.set(mode === 'xray' ? color : new Color(0x0b0d10));
      lm.clippingPlanes = this.clipPlane ? [this.clipPlane] : null;
    }

    // selection bounding box (the Dimensions tab draws its own exact box)
    if (selected && part.visible && this.state?.tool !== 'dimensions') {
      if (!obj.selBox) {
        obj.selBox = new Box3Helper(new Box3(), ACCENT);
        (obj.selBox.material as LineBasicMaterial).transparent = true;
        (obj.selBox.material as LineBasicMaterial).opacity = 0.55;
        this.overlayGroup.add(obj.selBox);
      }
      const geomBox = obj.mesh.geometry.boundingBox!;
      obj.selBox.box.copy(geomBox).applyMatrix4(group.matrixWorld);
      obj.selBox.visible = true;
    } else if (obj.selBox) obj.selBox.visible = false;

    this.updateClipCaps(obj, index, part.visible && !ghost);
  }

  /** Called by the canvas component to fetch edges lazily. */
  edgeRequest: ((mesh: MeshData) => void) | null = null;

  // ------------------------------------------------------------------ clipping caps

  private updateClipCaps(obj: PartObject, index: number, visible: boolean) {
    const plane = this.clipPlane;
    if (!plane || !visible) {
      if (obj.stencil) obj.stencil.visible = false;
      if (obj.cap) obj.cap.visible = false;
      if (obj.section) obj.section.visible = false;
      return;
    }
    if (!obj.stencil) {
      const base = {
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        stencilWrite: true,
        stencilFunc: AlwaysStencilFunc,
      };
      const back = new MeshBasicMaterial({
        ...base,
        side: BackSide,
        stencilFail: IncrementWrapStencilOp,
        stencilZFail: IncrementWrapStencilOp,
        stencilZPass: IncrementWrapStencilOp,
      });
      const front = new MeshBasicMaterial({
        ...base,
        side: FrontSide,
        stencilFail: DecrementWrapStencilOp,
        stencilZFail: DecrementWrapStencilOp,
        stencilZPass: DecrementWrapStencilOp,
      });
      obj.stencil = new Group();
      obj.stencil.add(new Mesh(obj.mesh.geometry, back), new Mesh(obj.mesh.geometry, front));
      obj.group.add(obj.stencil);
      const capMat = new MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.9,
        side: DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: NotEqualStencilFunc,
        stencilFail: ReplaceStencilOp,
        stencilZFail: ReplaceStencilOp,
        stencilZPass: ReplaceStencilOp,
      });
      obj.cap = new Mesh(new PlaneGeometry(1, 1), capMat);
      obj.cap.onAfterRender = (r) => r.clearStencil();
      obj.cap.raycast = () => {};
      this.capsGroup.add(obj.cap);
    }
    obj.stencil.visible = true;
    for (const m of obj.stencil.children) {
      ((m as Mesh).material as Material).clippingPlanes = [plane];
      m.renderOrder = index * 3 + 1;
    }
    const cap = obj.cap!;
    cap.visible = true;
    cap.renderOrder = index * 3 + 2;
    (cap.material as MeshStandardMaterial).color.set(obj.part.color).multiplyScalar(0.62);
    // size and place the cap plane to cover the part
    const sphere = obj.mesh.geometry.boundingSphere!.clone().applyMatrix4(obj.group.matrixWorld);
    const center = plane.projectPoint(sphere.center, new Vector3());
    cap.position.copy(center);
    cap.lookAt(center.clone().sub(plane.normal));
    cap.scale.setScalar(sphere.radius * 2.2 + 1);
    cap.updateMatrixWorld();

    // BVH-accelerated section outline (local space)
    const g = obj.mesh.geometry;
    const key = `${plane.normal.toArray().join()},${plane.constant},${obj.group.matrixWorld.elements.join()},${!!g.boundsTree}`;
    if (obj.sectionKey !== key) {
      obj.sectionKey = key;
      if (obj.section) {
        obj.section.geometry.dispose();
        obj.group.remove(obj.section);
        obj.section = undefined;
      }
      const bvh = g.boundsTree as MeshBVH | undefined;
      if (bvh) {
        const inv = new Matrix4().copy(obj.group.matrixWorld).invert();
        const local = plane.clone().applyMatrix4(inv);
        const seg = sectionSegments(bvh, local);
        if (seg.length) {
          obj.section = new LineSegments(
            new BufferGeometry().setAttribute('position', new BufferAttribute(seg, 3)),
            new LineBasicMaterial({ color: 0x0b0d10, depthTest: true }),
          );
          obj.section.renderOrder = index * 3 + 2.5;
          obj.group.add(obj.section);
        }
      }
    }
    if (obj.section) obj.section.visible = true;
  }

  // ------------------------------------------------------------------ gizmo

  private syncGizmo(s: AppState) {
    const sel = s.selection.length === 1 ? this.objects.get(s.selection[0]) : undefined;
    const can =
      sel && !sel.part.locked && sel.part.visible && s.tool === 'transform' && s.gizmo !== 'none' && s.gizmo !== 'place' && !s.preview && !s.pickMode;
    if (can) {
      if (this.gizmo.object !== sel.group) this.gizmo.attach(sel.group);
      this.gizmo.setMode(s.gizmo === 'rotate' ? 'rotate' : 'translate');
      this.gizmo.setSpace(s.gizmo === 'rotate' ? 'local' : 'world');
      this.gizmoHelper.visible = true;
    } else {
      if (this.gizmo.object) this.gizmo.detach();
      this.gizmoHelper.visible = false;
    }
  }

  private commitGizmo() {
    const g = this.gizmo.object;
    if (!g) return;
    const id = g.name;
    const t: Transform = {
      position: [round(g.position.x), round(g.position.y), round(g.position.z)],
      rotation: eulerDegFromQuaternion(g.quaternion as Quaternion),
      scale: [g.scale.x, g.scale.y, g.scale.z],
    };
    this.cb.onTransformEnd(id, t);
  }

  // ------------------------------------------------------------------ preview & overlays

  private syncPreview(s: AppState) {
    const p = s.preview;
    if (this.previewKey === p) return;
    this.previewKey = p;
    for (const c of this.previewGroup.children) {
      if (c instanceof Mesh || c instanceof LineSegments) {
        c.geometry.dispose();
        (c.material as Material).dispose();
      }
    }
    this.previewGroup.clear();
    if (!p) return;
    for (const pm of p.meshes) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pm.mesh.positions, 3));
      g.setIndex(new BufferAttribute(pm.mesh.indices, 1));
      g.computeBoundingSphere();
      const m = createPartMaterial(pm.color);
      m.emissive.set(pm.color).multiplyScalar(0.12);
      if (this.clipPlane) m.clippingPlanes = [this.clipPlane];
      const mesh = new Mesh(g, m);
      mesh.raycast = () => {};
      this.previewGroup.add(mesh);
    }
    if (p.lines && p.lines.length) {
      const g = new BufferGeometry().setAttribute('position', new BufferAttribute(p.lines, 3));
      const l = new LineSegments(g, new LineBasicMaterial({ color: ACCENT }));
      this.previewGroup.add(l);
    }
  }

  private syncOverlays(s: AppState) {
    // per-part overlays: analysis highlights, face selection
    for (const obj of this.objects.values()) {
      const a = s.analysis[obj.part.id];
      const analysis = a && a.mesh === obj.part.mesh && s.tool === 'repair' && s.repairTab === 'fix' ? a : null;
      const fs = s.faceSelection?.partId === obj.part.id && (s.tool === 'extrude' || s.tool === 'perforate') ? s.faceSelection : null;
      const hl = s.settings.highlight;
      const inRepair = s.tool === 'repair';
      const ix = inRepair && s.repairTab === 'fix' ? s.intersections[obj.part.id] : undefined;
      const inter = ix && ix.mesh === obj.part.mesh ? ix : null;
      const showNormals = inRepair && s.repairTab === 'fix' && s.settings.normals.show;
      const analysisFor = a;
      const picks = (Object.entries(s.facePicks) as [string, NonNullable<AppState['facePicks'][keyof AppState['facePicks']]>][]).filter(
        ([slot, p]) =>
          p.partId === obj.part.id &&
          p.mesh === obj.part.mesh &&
          ((inRepair && s.repairTab === 'fix' && slot === 'flip') ||
            (s.tool === 'align' && slot.startsWith('align')) ||
            (s.tool === 'props' && slot.startsWith('props')) ||
            (s.tool === 'texture' && slot === 'texture') ||
            (s.tool === 'offset' && slot === 'offset')),
      );
      const sv = inRepair && s.repairTab === 'shells' && s.shellView?.partId === obj.part.id && s.shellView.mesh === obj.part.mesh ? s.shellView : null;
      const te = inRepair && s.repairTab === 'edit' && s.triEdit?.partId === obj.part.id && s.triEdit.mesh === obj.part.mesh ? s.triEdit : null;
      const blend = s.tool === 'offset' ? s.blendEdges.filter((e) => e.partId === obj.part.id && e.mesh === obj.part.mesh) : [];
      const key = `${analysis ? 'a' : ''}${hl.open}${hl.nonManifold}${hl.flipped}${hl.holeIndex}|${fs ? fs.tris.length + ':' + fs.seed : ''}|${showNormals ? `${s.settings.normals.outColor}${s.settings.normals.inColor}${a?.mesh === obj.part.mesh ? 'a' : ''}` : ''}|${picks.map(([k, p]) => k + p.seed).join()}|${sv ? sv.selected.join(',') + ':' + sv.hover + ':' + sv.isolate : ''}|${te ? this.refId(te.tris) + ':' + te.verts.join(',') + ':' + this.refId(te.bridgeA ?? []) + ':' + this.refId(te.bridgeB ?? []) : ''}|${blend.length ? this.refId(s.blendEdges) : ''}`;
      // isolate: ghost the whole part, the selected shells are drawn as an overlay
      const ghostForShells = !!(sv && sv.isolate && sv.selected.length);
      obj.material.transparent = obj.material.transparent || ghostForShells;
      if (ghostForShells) {
        obj.material.opacity = 0.1;
        obj.material.depthWrite = false;
      }
      if (
        obj.overlayKey === key &&
        obj.overlay.userData.analysis === analysis &&
        obj.overlay.userData.fs === fs &&
        obj.overlay.userData.inter === inter &&
        obj.overlay.userData.mesh === obj.part.mesh &&
        obj.overlay.userData.te === te
      )
        continue;
      obj.overlayKey = key;
      obj.overlay.userData = { analysis, fs, inter, mesh: obj.part.mesh, te };
      disposeChildren(obj.overlay);
      if (sv) {
        const trisOf = (ids: Set<number>) => {
          const out: number[] = [];
          for (let t = 0; t < sv.shellOfTri.length; t++) if (ids.has(sv.shellOfTri[t])) out.push(t);
          return Uint32Array.from(out);
        };
        if (sv.selected.length) {
          const m = triMesh(obj.part.mesh, trisOf(new Set(sv.selected)), sv.isolate ? new Color(obj.part.color).getHex() : 0x22d3ee);
          if (!sv.isolate) {
            (m.material as MeshBasicMaterial).transparent = true;
            (m.material as MeshBasicMaterial).opacity = 0.55;
          }
          obj.overlay.add(m);
        }
        if (sv.hover !== null && !sv.selected.includes(sv.hover)) {
          const m = triMesh(obj.part.mesh, trisOf(new Set([sv.hover])), 0xffd23f);
          (m.material as MeshBasicMaterial).transparent = true;
          (m.material as MeshBasicMaterial).opacity = 0.6;
          obj.overlay.add(m);
        }
      }
      if (te) {
        if (te.tris.length) obj.overlay.add(triMesh(obj.part.mesh, Uint32Array.from(te.tris), 0xff3bd4));
        const mp = obj.part.mesh.positions;
        const segOf = (edges: [number, number][]) => {
          const out = new Float32Array(edges.length * 6);
          edges.forEach(([a, b], i) => out.set([mp[a * 3], mp[a * 3 + 1], mp[a * 3 + 2], mp[b * 3], mp[b * 3 + 1], mp[b * 3 + 2]], i * 6));
          return out;
        };
        if (te.bridgeA?.length) obj.overlay.add(this.fatLines(segOf(te.bridgeA), '#ffea00', 5));
        if (te.bridgeB?.length) obj.overlay.add(this.fatLines(segOf(te.bridgeB), '#00e5ff', 5));
        if (te.verts.length) {
          const pos = te.verts.flatMap((v) => [obj.part.mesh.positions[v * 3], obj.part.mesh.positions[v * 3 + 1], obj.part.mesh.positions[v * 3 + 2]]);
          const pts = new Points(
            new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(pos), 3)),
            new PointsMaterial({ color: 0xff3bd4, size: 12, sizeAttenuation: false, depthTest: false, transparent: true }),
          );
          pts.renderOrder = 1004;
          obj.overlay.add(pts);
          if (te.verts.length === 2) obj.overlay.add(lines(new Float32Array(pos), 0xff3bd4, true));
        }
      }
      if (inter) {
        if (inter.report.intersecting.length) obj.overlay.add(triMesh(obj.part.mesh, inter.report.intersecting, 0xff7a1a));
        if (inter.report.overlapping.length) obj.overlay.add(triMesh(obj.part.mesh, inter.report.overlapping, 0x22d3ee));
      }
      if (showNormals) {
        const size = obj.mesh.geometry.boundingSphere?.radius ?? 10;
        const nset = s.settings.normals;
        // inward = triangles that analysis found inverted relative to the outside
        const flipped = analysisFor && analysisFor.mesh === obj.part.mesh ? analysisFor.report.highlights.flippedTriangles : null;
        const segs = faceNormalSegmentsSplit(obj.part.mesh, Math.max(0.2, size * 0.04), flipped, 40000);
        if (segs.outward.length) obj.overlay.add(lines(segs.outward, new Color(nset.outColor).getHex(), false));
        if (segs.inward.length) obj.overlay.add(lines(segs.inward, new Color(nset.inColor).getHex(), true));
      }
      if (blend.length) {
        const seg = new Float32Array(blend.length * 6);
        blend.forEach((e, i) => seg.set([...e.a, ...e.b], i * 6));
        obj.overlay.add(this.fatLines(seg, '#ff9100', 5));
      }
      for (const [slot, p] of picks) {
        const color = slot === 'flip' ? 0xd040ff : slot.endsWith('Source') || slot.endsWith('A') ? 0xffd23f : 0x22d3ee;
        const m = triMesh(obj.part.mesh, p.tris, color);
        (m.material as MeshBasicMaterial).transparent = true;
        (m.material as MeshBasicMaterial).opacity = 0.6;
        obj.overlay.add(m);
      }
      if (analysis) {
        const h = analysis.report.highlights;
        // thick lines in colours picked to contrast with the part and with each other
        const hc = highlightColors(obj.part.color);
        if (hl.open && h.openEdges.length) obj.overlay.add(this.fatLines(h.openEdges, hc.open, 3.5));
        if (hl.open && h.crackEdges?.length) obj.overlay.add(this.fatLines(h.crackEdges, hc.crack, 3.5));
        if (hl.nonManifold && h.nonManifoldEdges.length) obj.overlay.add(this.fatLines(h.nonManifoldEdges, hc.nonManifold, 3.5));
        if (hl.flipped && h.flippedTriangles.length) obj.overlay.add(triMesh(obj.part.mesh, h.flippedTriangles, 0xd040ff));
        if (h.degenerateTriangles.length) obj.overlay.add(triMesh(obj.part.mesh, h.degenerateTriangles, 0x00e0ff));
        if (hl.holeIndex !== null) {
          const loop = analysis.report.loops[hl.holeIndex];
          if (loop) {
            const pos = obj.part.mesh.positions;
            const seg = new Float32Array(loop.vertices.length * 6);
            for (let i = 0; i < loop.vertices.length; i++) {
              const a0 = loop.vertices[i] * 3, b0 = loop.vertices[(i + 1) % loop.vertices.length] * 3;
              seg.set([pos[a0], pos[a0 + 1], pos[a0 + 2], pos[b0], pos[b0 + 1], pos[b0 + 2]], i * 6);
            }
            obj.overlay.add(lines(seg, 0xffd23f, true));
          }
        }
      }
      if (fs) {
        const m = triMesh(obj.part.mesh, fs.tris, 0xffd23f);
        ((m.material as MeshBasicMaterial).opacity = 0.55), ((m.material as MeshBasicMaterial).transparent = true);
        obj.overlay.add(m);
      }
    }

    // world overlays: cut plane, drain holes
    const key = JSON.stringify([
      s.tool,
      s.tool === 'cut' ? [s.cutPlane, s.settings.cutMode] : null,
      s.tool === 'hollow' ? s.settings.hollow.drainHoles : null,
      s.tool === 'hollow' ? s.settings.hollow.drainDiameter : null,
      s.tool === 'hollow' ? s.settings.hollow.thickness : null,
      s.selection,
      !!s.preview,
    ]);
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    for (const c of [...this.overlayGroup.children]) {
      if (c.userData.toolOverlay) {
        disposeChildren(c);
        this.overlayGroup.remove(c);
      }
    }
    const g = new Group();
    g.userData.toolOverlay = true;
    if (s.tool === 'cut' && !s.preview && s.settings.cutMode === 'plane') {
      const target = s.selection.map((id) => this.objects.get(id)).find(Boolean);
      const sphere = target
        ? target.mesh.geometry.boundingSphere!.clone().applyMatrix4(target.group.matrixWorld)
        : new Sphere(new Vector3(), 50);
      const p = planeFromSettings(s.cutPlane);
      const plane = new Plane(new Vector3(...p.normal), -p.constant);
      const center = plane.projectPoint(sphere.center, new Vector3());
      const quad = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false }),
      );
      quad.position.copy(center);
      quad.lookAt(center.clone().add(plane.normal));
      quad.scale.setScalar(sphere.radius * 2.4 + 2);
      quad.raycast = () => {};
      const frame = new LineSegments(
        new BufferGeometry().setAttribute(
          'position',
          new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0]), 3),
        ),
        new LineBasicMaterial({ color: ACCENT }),
      );
      quad.add(frame);
      g.add(quad);
    }
    if (s.tool === 'hollow') {
      const h = s.settings.hollow;
      for (const d of h.drainHoles) {
        const len = h.thickness * 2 + 2;
        const cyl = new Mesh(
          new CylinderGeometry(h.drainDiameter / 2, h.drainDiameter / 2, len, 24),
          new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.7, depthTest: false }),
        );
        const n = new Vector3(...d.normal).normalize();
        cyl.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), n);
        cyl.position.set(...d.point).addScaledVector(n, 1 - len / 2);
        cyl.renderOrder = 1000;
        cyl.raycast = () => {};
        g.add(cyl);
      }
    }
    this.overlayGroup.add(g);
  }

  private updateGridSize(s: AppState) {
    const b = new Box3();
    for (const o of this.objects.values()) {
      if (!o.part.visible) continue;
      const gb = o.mesh.geometry.boundingBox;
      if (gb) b.union(gb.clone().applyMatrix4(o.group.matrixWorld));
    }
    void s;
    const extent = b.isEmpty() ? 0 : Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.y), Math.abs(b.max.y));
    const size = Math.max(200, Math.ceil((extent * 2.4) / 100) * 100);
    this.buildGrid(size);
  }

  // ------------------------------------------------------------------ camera

  setOrthographic(on: boolean) {
    const target = this.controls.target.clone();
    if (on && this.camera !== this.ortho) {
      this.updateOrthoFrustum();
      this.ortho.position.copy(this.perspective.position);
      this.ortho.quaternion.copy(this.perspective.quaternion);
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
      this.ortho.add(this.headlight);
    } else if (!on && this.camera !== this.perspective) {
      // convert ortho zoom into a perspective distance
      const dir = new Vector3().subVectors(this.ortho.position, target).normalize();
      const halfH = (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom;
      const dist = halfH / Math.tan((this.perspective.fov * D2R) / 2);
      this.perspective.position.copy(target).addScaledVector(dir, dist);
      this.camera = this.perspective;
      this.perspective.add(this.headlight);
    }
    this.controls.object = this.camera;
    this.gizmo.camera = this.camera;
    this.controls.update();
    this.requestRender();
  }

  private visibleBounds(selectionOnly: boolean): Box3 {
    const b = new Box3();
    const sel = new Set(this.state?.selection ?? []);
    for (const o of this.objects.values()) {
      if (!o.part.visible) continue;
      if (selectionOnly && sel.size && !sel.has(o.part.id)) continue;
      const gb = o.mesh.geometry.boundingBox;
      if (gb) b.union(gb.clone().applyMatrix4(o.group.matrixWorld));
    }
    if (b.isEmpty()) b.set(new Vector3(-50, -50, 0), new Vector3(50, 50, 50));
    return b;
  }

  fitView(selectionOnly = false) {
    const sphere = this.visibleBounds(selectionOnly).getBoundingSphere(new Sphere());
    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (dir.lengthSq() === 0) dir.set(1, -1, 1).normalize();
    this.frame(sphere, dir);
  }

  setView(v: ViewName) {
    const dirs: Record<ViewName, Vector3> = {
      top: new Vector3(0, -0.0001, 1),
      bottom: new Vector3(0, 0.0001, -1),
      front: new Vector3(0, -1, 0),
      back: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      iso: new Vector3(1, -1, 0.85),
    };
    const sphere = this.visibleBounds(false).getBoundingSphere(new Sphere());
    this.frame(sphere, dirs[v].normalize());
  }

  private frame(sphere: Sphere, dir: Vector3) {
    const r = Math.max(sphere.radius, 1);
    const dist = (r / Math.sin((this.perspective.fov * D2R) / 2)) * 1.08;
    this.controls.target.copy(sphere.center);
    this.perspective.position.copy(sphere.center).addScaledVector(dir, dist);
    this.perspective.lookAt(sphere.center);
    this.perspective.near = Math.max(0.01, dist / 1000);
    this.perspective.far = dist * 100;
    this.perspective.updateProjectionMatrix();
    if (this.camera === this.ortho) {
      this.ortho.position.copy(this.perspective.position);
      this.ortho.quaternion.copy(this.perspective.quaternion);
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.controls.update();
    this.requestRender();
  }

  // ------------------------------------------------------------------ picking

  private onPointerUp(e: PointerEvent) {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    if (this.draggingGizmo || (this.gizmo as unknown as { axis: string | null }).axis) return;
    const info = this.pick(e.clientX, e.clientY);
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, clientX: e.clientX, clientY: e.clientY };
    this.cb.onPick(info ? { ...info, ...mods } : null, mods);
  }

  pick(clientX: number, clientY: number): Omit<PickInfo, 'shift' | 'ctrl' | 'clientX' | 'clientY'> | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ghosted = new Set(this.state?.preview?.replaces ?? []);
    const meshes = [...this.objects.values()].filter((o) => o.part.visible && !ghosted.has(o.part.id)).map((o) => o.mesh);
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = !this.clipPlane;
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hit = hits.find((h) => !this.clipPlane || this.clipPlane.distanceToPoint(h.point) >= 0);
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null || !hit.face) return null;
    const nm = new Matrix3().getNormalMatrix(hit.object.matrixWorld);
    const n = hit.face.normal.clone().applyMatrix3(nm).normalize();
    return {
      partId: hit.object.userData.partId,
      faceIndex: hit.faceIndex,
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [n.x, n.y, n.z],
    };
  }

  // ------------------------------------------------------------------ queries used by tools

  /** First surface hit along a ray (world space). Restrict to one part with `onlyPart`, skip one with `skipPart`. */
  castRay(origin: Vec3, dir: Vec3, opts: { onlyPart?: string; skipPart?: string; minDistance?: number } = {}) {
    const rc = new Raycaster(new Vector3(...origin), new Vector3(...dir).normalize());
    (rc as unknown as { firstHitOnly: boolean }).firstHitOnly = false;
    const meshes = [...this.objects.values()]
      .filter((o) => o.part.visible && (!opts.onlyPart || o.part.id === opts.onlyPart) && o.part.id !== opts.skipPart)
      .map((o) => o.mesh);
    const hits = rc.intersectObjects(meshes, false).filter((h) => h.distance > (opts.minDistance ?? 1e-4));
    const h = hits[0];
    if (!h || !h.face) return null;
    const n = h.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize();
    return { point: [h.point.x, h.point.y, h.point.z] as Vec3, normal: [n.x, n.y, n.z] as Vec3, partId: h.object.userData.partId as string, distance: h.distance };
  }

  toScreen(p: Vec3): [number, number] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new Vector3(...p).project(this.camera);
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
  }

  /** World-space vertices of a part triangle. */
  triangleWorld(partId: string, tri: number): [Vec3, Vec3, Vec3] | null {
    const o = this.objects.get(partId);
    if (!o) return null;
    const { positions, indices } = o.part.mesh;
    const out = [0, 1, 2].map((k) => {
      const v = indices[tri * 3 + k] * 3;
      const w = new Vector3(positions[v], positions[v + 1], positions[v + 2]).applyMatrix4(o.group.matrixWorld);
      return [w.x, w.y, w.z] as Vec3;
    });
    return out as [Vec3, Vec3, Vec3];
  }

  /** Nearest triangle vertex within `px` screen pixels of the click. */
  snapVertex(partId: string, tri: number, clientX: number, clientY: number, px = 12): Vec3 | null {
    const t = this.triangleWorld(partId, tri);
    if (!t) return null;
    let best: Vec3 | null = null, bd = px;
    for (const v of t) {
      const [x, y] = this.toScreen(v);
      const d = Math.hypot(x - clientX, y - clientY);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /**
   * Nearest feature edge (from the edges computed for display) within `px`
   * pixels of the click; falls back to the nearest edge of the clicked triangle.
   */
  snapEdge(partId: string, tri: number, point: Vec3, clientX: number, clientY: number, px = 14): [Vec3, Vec3] | null {
    const o = this.objects.get(partId);
    if (!o) return null;
    const edges = meshEntry(o.part.mesh).edges;
    if (edges && edges.length) {
      const m = o.group.matrixWorld;
      const a = new Vector3(), b = new Vector3();
      let best: [Vec3, Vec3] | null = null, bd = px;
      const rect = this.renderer.domElement.getBoundingClientRect();
      for (let i = 0; i < edges.length; i += 6) {
        a.set(edges[i], edges[i + 1], edges[i + 2]).applyMatrix4(m);
        b.set(edges[i + 3], edges[i + 4], edges[i + 5]).applyMatrix4(m);
        const pa = a.clone().project(this.camera), pb = b.clone().project(this.camera);
        if (pa.z > 1 || pb.z > 1) continue;
        const ax = rect.left + ((pa.x + 1) / 2) * rect.width, ay = rect.top + ((1 - pa.y) / 2) * rect.height;
        const bx = rect.left + ((pb.x + 1) / 2) * rect.width, by = rect.top + ((1 - pb.y) / 2) * rect.height;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((clientX - ax) * dx + (clientY - ay) * dy) / l2)) : 0;
        const d = Math.hypot(ax + dx * t - clientX, ay + dy * t - clientY);
        if (d < bd) {
          bd = d;
          best = [[a.x, a.y, a.z], [b.x, b.y, b.z]];
        }
      }
      if (best) return best;
    }
    const t = this.triangleWorld(partId, tri);
    if (!t) return null;
    let best: [Vec3, Vec3] = [t[0], t[1]], bd = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = new Vector3(...t[k]), b = new Vector3(...t[(k + 1) % 3]);
      const d = new Line3(a, b).closestPointToPoint(new Vector3(...point), true, new Vector3()).distanceTo(new Vector3(...point));
      if (d < bd) {
        bd = d;
        best = [t[k], t[(k + 1) % 3]];
      }
    }
    return best;
  }

  /** Local index of the part vertex closest to the cursor on screen, within `px` pixels (or -1). */
  nearestVertexScreen(partId: string, clientX: number, clientY: number, px = 16): number {
    const o = this.objects.get(partId);
    if (!o) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const m = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(o.group.matrixWorld);
    const e = m.elements;
    const p = o.part.mesh.positions;
    const tx = ((clientX - rect.left) / rect.width) * 2 - 1, ty = -((clientY - rect.top) / rect.height) * 2 + 1;
    const sx = rect.width / 2, sy = rect.height / 2;
    let best = -1, bd = px * px, bz = Infinity;
    for (let v = 0; v < p.length / 3; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 0) continue;
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
      const d = ((nx - tx) * sx) ** 2 + ((ny - ty) * sy) ** 2;
      // prefer the nearer vertex when several are under the cursor
      if (d < bd - 1 || (d <= bd + 1 && nz < bz)) {
        bd = Math.min(bd, d);
        bz = nz;
        best = v;
      }
    }
    return best;
  }

  /** Local point/normal of a part -> world. */
  localToWorld(partId: string, p: Vec3, n?: Vec3): { point: Vec3; normal: Vec3 } | null {
    const o = this.objects.get(partId);
    if (!o) return null;
    const w = new Vector3(...p).applyMatrix4(o.group.matrixWorld);
    const nn = n ? new Vector3(...n).applyMatrix3(new Matrix3().getNormalMatrix(o.group.matrixWorld)).normalize() : new Vector3(0, 0, 1);
    return { point: [w.x, w.y, w.z], normal: [nn.x, nn.y, nn.z] };
  }

  // ------------------------------------------------------------------ snapping (vertex + ortho)

  /** Whether clicks currently pick points (measure / point picks), which enables the hover snap marker. */
  private pointPicking(): boolean {
    const s = this.state;
    if (!s || s.zoomWindow) return false;
    if (s.pickMode === 'point' || s.pickMode === 'vertex') return true;
    return s.tool === 'measure' && !s.pickMode && s.settings.measure.mode !== 'thickness';
  }

  /** The previous point that ortho snapping measures from, if any. */
  private snapAnchor(): Vec3 | null {
    const s = this.state;
    if (!s || !s.settings.measure.ortho) return null;
    if (s.tool === 'measure' && !s.pickMode) {
      if (s.measurePending.points.length) return s.measurePending.points[s.measurePending.points.length - 1];
      const last = s.measurePending.entities[s.measurePending.entities.length - 1]?.entity;
      if (last?.kind === 'point') return last.p;
      if (last?.kind === 'circle' || last?.kind === 'sphere') return last.c;
      return null;
    }
    if (s.pickMode === 'point' && s.pointSlot === 'propEnd' && s.pointPicks.propStart) {
      const p = s.pointPicks.propStart;
      return this.localToWorld(p.partId, p.point, p.normal)?.point ?? null;
    }
    return null;
  }

  /**
   * Snap a picked surface point: to a nearby vertex, else (with a previous
   * point) onto the X/Y/Z line through that point when the cursor is close
   * to it on screen, else the raw surface point.
   */
  snapPoint(partId: string, tri: number, point: Vec3, clientX: number, clientY: number): { point: Vec3; kind: 'vertex' | 'ortho' | 'surface'; axis?: number; anchor?: Vec3 } {
    const v = this.snapVertex(partId, tri, clientX, clientY, 10);
    if (v) return { point: v, kind: 'vertex' };
    const anchor = this.snapAnchor();
    if (anchor) {
      let best = -1, bd = 12;
      const [ax, ay] = this.toScreen(anchor);
      for (let a = 0; a < 3; a++) {
        const q: Vec3 = [...anchor];
        q[a] += 1;
        const [bx, by] = this.toScreen(q);
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
        if (l < 1e-6) continue;
        const d = Math.abs((clientX - ax) * dy - (clientY - ay) * dx) / l;
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
      if (best >= 0) {
        const out: Vec3 = [...anchor];
        out[best] = point[best];
        return { point: out, kind: 'ortho', axis: best, anchor };
      }
    }
    return { point, kind: 'surface' };
  }

  private scheduleHover(clientX: number, clientY: number, dragging: boolean) {
    if (dragging || !this.pointPicking()) {
      if (this.hoverGroup.children.length) this.clearHover();
      return;
    }
    if (this.hoverPending) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      this.updateHover(clientX, clientY);
    });
  }

  private clearHover() {
    if (!this.hoverGroup.children.length) return;
    disposeChildren(this.hoverGroup);
    this.requestRender();
  }

  private updateHover(clientX: number, clientY: number) {
    disposeChildren(this.hoverGroup);
    const hit = this.pick(clientX, clientY);
    if (!hit) return this.requestRender();
    const snap = this.snapPoint(hit.partId, hit.faceIndex, hit.point, clientX, clientY);
    const AXIS = [0xff4d5e, 0x57d16a, 0x4d8dff];
    const color = snap.kind === 'vertex' ? 0x22d3ee : snap.kind === 'ortho' ? AXIS[snap.axis!] : 0xffffff;
    const marker = new Points(
      new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(snap.point), 3)),
      new PointsMaterial({ color, size: snap.kind === 'surface' ? 7 : 11, sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    marker.renderOrder = 1004;
    this.hoverGroup.add(marker);
    if (snap.kind === 'ortho' && snap.anchor) {
      // guide: long faint axis line through the anchor plus the snapped segment
      const a = snap.anchor, b = snap.point, ax = snap.axis!;
      const far = (this.camera.position.distanceTo(new Vector3(...a)) || 100) * 2;
      const p0: Vec3 = [...a], p1: Vec3 = [...a];
      p0[ax] -= far;
      p1[ax] += far;
      const guide = new LineSegments(
        new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([...p0, ...p1]), 3)),
        new LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.35 }),
      );
      const seg = new LineSegments(
        new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([...a, ...b]), 3)),
        new LineBasicMaterial({ color, depthTest: false, transparent: true }),
      );
      guide.renderOrder = seg.renderOrder = 1003;
      this.hoverGroup.add(guide, seg);
      const len = Math.abs(b[ax] - a[ax]);
      this.hoverGroup.add(textSprite(`${'XYZ'[ax]} ${len.toFixed(2)} mm`, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]));
    } else {
      const anchor = this.snapAnchor();
      if (anchor) {
        const seg = new LineSegments(
          new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([...anchor, ...snap.point]), 3)),
          new LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true, opacity: 0.6 }),
        );
        seg.renderOrder = 1003;
        this.hoverGroup.add(seg);
      }
    }
    this.requestRender();
  }

  // ------------------------------------------------------------------ lasso

  private startLasso(e: PointerEvent) {
    const r = this.container.getBoundingClientRect();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lasso-svg');
    svg.setAttribute('width', String(r.width));
    svg.setAttribute('height', String(r.height));
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    svg.appendChild(line);
    this.container.appendChild(svg);
    this.lasso = { points: [[e.clientX, e.clientY]], svg, line };
    this.controls.enabled = false;
  }

  private moveLasso(e: PointerEvent) {
    const l = this.lasso;
    if (!l) return;
    const [px, py] = l.points[l.points.length - 1];
    if (Math.hypot(e.clientX - px, e.clientY - py) < 3) return;
    l.points.push([e.clientX, e.clientY]);
    const r = this.container.getBoundingClientRect();
    l.line.setAttribute('points', [...l.points, l.points[0]].map(([x, y]) => `${x - r.left},${y - r.top}`).join(' '));
  }

  private endLasso() {
    const l = this.lasso!;
    l.svg.remove();
    this.lasso = null;
    this.controls.enabled = true;
    this.cb.onLasso?.(l.points);
  }

  /**
   * Camera-space outline and depth range for a lasso around a part (see
   * geometry/lasso). Perspective outlines are in tangent space (depth 1).
   */
  lassoCamera(points: [number, number][], partId: string) {
    const o = this.objects.get(partId);
    if (!o) return null;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ortho = cam === this.ortho;
    const outline = points.map(([cx, cy]) => {
      const nx = ((cx - rect.left) / rect.width) * 2 - 1;
      const ny = -((cy - rect.top) / rect.height) * 2 + 1;
      if (ortho) {
        const oc = this.ortho;
        return [((oc.left + ((nx + 1) / 2) * (oc.right - oc.left)) / oc.zoom), ((oc.bottom + ((ny + 1) / 2) * (oc.top - oc.bottom)) / oc.zoom)] as [number, number];
      }
      const t = Math.tan((this.perspective.fov * D2R) / 2);
      return [nx * t * this.perspective.aspect, ny * t] as [number, number];
    });
    const sphere = o.mesh.geometry.boundingSphere!.clone().applyMatrix4(o.group.matrixWorld);
    const dir = new Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new Quaternion()));
    const d = sphere.center.clone().sub(cam.getWorldPosition(new Vector3())).dot(dir);
    const r = sphere.radius * 1.5 + 1;
    const near = ortho ? d - r : Math.max(d * 0.02, d - r, 0.01);
    const far = d + r;
    return { outline, camera: { matrixWorld: cam.matrixWorld.elements.slice(), orthographic: ortho, near, far } };
  }

  // ------------------------------------------------------------------ zoom window

  private startZoomRect(e: PointerEvent, mark = false) {
    const div = document.createElement('div');
    div.className = mark ? 'zoom-rect mark-rect' : 'zoom-rect';
    this.container.appendChild(div);
    this.zoomRect = { x: e.clientX, y: e.clientY, div, mark, erase: e.ctrlKey || e.metaKey };
    this.controls.enabled = false;
    this.moveZoomRect(e);
  }

  private moveZoomRect(e: PointerEvent) {
    const z = this.zoomRect;
    if (!z) return;
    const r = this.container.getBoundingClientRect();
    const x0 = Math.min(z.x, e.clientX) - r.left, y0 = Math.min(z.y, e.clientY) - r.top;
    Object.assign(z.div.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(e.clientX - z.x)}px`, height: `${Math.abs(e.clientY - z.y)}px` });
  }

  private endZoomRect(e: PointerEvent) {
    const z = this.zoomRect!;
    z.div.remove();
    this.zoomRect = null;
    this.controls.enabled = true;
    const w = Math.abs(e.clientX - z.x), h = Math.abs(e.clientY - z.y);
    if (z.mark) {
      if (w > 3 && h > 3) this.cb.onRect?.(Math.min(z.x, e.clientX), Math.min(z.y, e.clientY), Math.max(z.x, e.clientX), Math.max(z.y, e.clientY), !!z.erase || e.ctrlKey || e.metaKey);
      return;
    }
    if (w > 6 && h > 6) this.zoomToRect((z.x + e.clientX) / 2, (z.y + e.clientY) / 2, w, h);
    this.cb.onZoomDone?.();
  }

  // ------------------------------------------------------------------ pick & place

  private placeActive() {
    const s = this.state;
    return !!s && s.tool === 'transform' && s.gizmo === 'place' && !s.pickMode && !s.preview && !s.zoomWindow;
  }

  private rayFor(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /** Grab a part under the cursor: drag on a horizontal plane (Shift: vertical, up/down only). */
  private startPlace(e: PointerEvent) {
    const info = this.pick(e.clientX, e.clientY);
    if (!info) return; // empty space: orbit
    const s = this.state!;
    const grabbed = this.objects.get(info.partId);
    if (!grabbed || grabbed.part.locked) return;
    const ids = s.selection.includes(info.partId) ? s.selection : [info.partId];
    const items = ids
      .map((id) => this.objects.get(id))
      .filter((o): o is PartObject => !!o && !o.part.locked && o.part.visible)
      .map((obj) => ({ obj, from: obj.group.position.clone() }));
    const start = new Vector3(...info.point);
    const vertical = e.shiftKey;
    let plane: Plane;
    if (vertical) {
      // plane through the grab point facing the camera, containing the Z axis
      const toCam = this.camera.getWorldPosition(new Vector3()).sub(start);
      toCam.z = 0;
      if (toCam.lengthSq() < 1e-9) toCam.set(0, -1, 0);
      plane = new Plane().setFromNormalAndCoplanarPoint(toCam.normalize(), start);
    } else plane = new Plane().setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1), start);
    this.placing = { plane, start, vertical, items, moved: false };
    this.controls.enabled = false;
    if (!s.selection.includes(info.partId)) this.cb.onPick({ ...info, shift: false, ctrl: false, clientX: e.clientX, clientY: e.clientY }, { shift: false, ctrl: false, clientX: e.clientX, clientY: e.clientY });
  }

  private movePlace(e: PointerEvent) {
    const pl = this.placing;
    if (!pl) return;
    const hit = this.rayFor(e.clientX, e.clientY).intersectPlane(pl.plane, new Vector3());
    if (!hit) return;
    const d = hit.sub(pl.start);
    if (pl.vertical) d.set(0, 0, d.z);
    else d.z = 0;
    // Ctrl / Cmd snaps the move to whole millimetres
    if (e.ctrlKey || e.metaKey) d.set(Math.round(d.x), Math.round(d.y), Math.round(d.z));
    if (d.lengthSq() > 1e-12) pl.moved = true;
    for (const it of pl.items) {
      it.obj.group.position.copy(it.from).add(d);
      it.obj.group.updateMatrixWorld(true);
    }
    this.requestRender();
  }

  /** Returns true when the parts were actually moved (so the click is not a pick). */
  private endPlace(): boolean {
    const pl = this.placing!;
    this.placing = null;
    this.controls.enabled = true;
    if (!pl.moved) return false;
    this.pointerDown = null;
    this.cb.onPlaceEnd?.(pl.items.map((it) => ({ id: it.obj.part.id, position: [round(it.obj.group.position.x), round(it.obj.group.position.y), round(it.obj.group.position.z)] })));
    return true;
  }

  // ------------------------------------------------------------------ brush marking

  private startBrush(e: PointerEvent) {
    const info = this.pick(e.clientX, e.clientY);
    if (!info) return; // empty space: orbit as usual
    this.brushing = { erase: e.ctrlKey || e.metaKey, pending: null };
    this.controls.enabled = false;
    this.cb.onBrush?.({ ...info, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, clientX: e.clientX, clientY: e.clientY }, this.brushing.erase);
  }

  private moveBrush(e: PointerEvent) {
    const b = this.brushing;
    if (!b) return;
    const first = !b.pending;
    b.pending = e;
    if (!first) return;
    requestAnimationFrame(() => {
      const ev = this.brushing?.pending;
      if (!this.brushing || !ev) return;
      this.brushing.pending = null;
      const info = this.pick(ev.clientX, ev.clientY);
      if (info) this.cb.onBrush?.({ ...info, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey, clientX: ev.clientX, clientY: ev.clientY }, this.brushing.erase);
    });
  }

  private endBrush() {
    this.brushing = null;
    this.controls.enabled = true;
    this.pointerDown = null;
  }

  /**
   * Triangles (local ids) of a part whose centres fall inside a screen
   * rectangle. Without `through`, only triangles facing the camera and not
   * hidden behind other surfaces count.
   */
  trianglesInRect(partId: string, x0: number, y0: number, x1: number, y1: number, through: boolean): number[] {
    const o = this.objects.get(partId);
    if (!o) return [];
    const cam = this.camera;
    cam.updateMatrixWorld();
    o.mesh.updateMatrixWorld();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const nx0 = ((x0 - rect.left) / rect.width) * 2 - 1, nx1 = ((x1 - rect.left) / rect.width) * 2 - 1;
    const ny0 = -((y1 - rect.top) / rect.height) * 2 + 1, ny1 = -((y0 - rect.top) / rect.height) * 2 + 1;
    const mw = o.mesh.matrixWorld;
    const mvp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(mw);
    const e = mvp.elements, w = mw.elements;
    const mesh = o.part.mesh;
    const p = mesh.positions, idx = mesh.indices;
    const nt = idx.length / 3;
    const camPos = cam.getWorldPosition(new Vector3());
    const viewDir = new Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new Quaternion()));
    const ortho = cam === this.ortho;
    const det = new Matrix3().setFromMatrix4(mw).determinant();
    const out: number[] = [];
    const meshes = through ? [] : [...this.objects.values()].filter((x) => x.part.visible).map((x) => x.mesh);
    const rc = new Raycaster();
    (rc as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
    const c = new Vector3(), n = new Vector3(), d = new Vector3();
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, cc = idx[t * 3 + 2] * 3;
      const lx = (p[a] + p[b] + p[cc]) / 3, ly = (p[a + 1] + p[b + 1] + p[cc + 1]) / 3, lz = (p[a + 2] + p[b + 2] + p[cc + 2]) / 3;
      const cw = e[3] * lx + e[7] * ly + e[11] * lz + e[15];
      if (cw <= 0) continue;
      const sx = (e[0] * lx + e[4] * ly + e[8] * lz + e[12]) / cw;
      const sy = (e[1] * lx + e[5] * ly + e[9] * lz + e[13]) / cw;
      if (sx < nx0 || sx > nx1 || sy < ny0 || sy > ny1) continue;
      if (through) {
        out.push(t);
        continue;
      }
      // world centre and normal
      c.set(w[0] * lx + w[4] * ly + w[8] * lz + w[12], w[1] * lx + w[5] * ly + w[9] * lz + w[13], w[2] * lx + w[6] * ly + w[10] * lz + w[14]);
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[cc] - p[a], vy = p[cc + 1] - p[a + 1], vz = p[cc + 2] - p[a + 2];
      n.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).transformDirection(mw);
      if (det < 0) n.negate();
      d.copy(ortho ? viewDir : c.clone().sub(camPos).normalize());
      if (n.dot(d) >= 0) continue; // facing away
      const origin = ortho ? c.clone().addScaledVector(viewDir, -1e5) : camPos;
      const dist = origin.distanceTo(c);
      rc.set(origin, d);
      rc.far = dist * (1 + 1e-4) + 1e-3;
      const hit = rc.intersectObjects(meshes, false)[0];
      if (!hit || (hit.object === o.mesh && hit.faceIndex === t) || hit.distance >= dist - Math.max(1e-3, dist * 1e-5)) out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------------------ polyline drawing (cut)

  private ensurePoly() {
    if (this.poly) return this.poly;
    const r = this.container.getBoundingClientRect();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lasso-svg poly-svg');
    svg.setAttribute('width', String(r.width));
    svg.setAttribute('height', String(r.height));
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    const dots = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.append(line, dots);
    this.container.appendChild(svg);
    this.poly = { points: [], svg, line, dots, cursor: null };
    return this.poly;
  }

  /** Snap to 15° steps (Shift) from the previous point. */
  private polyPoint(e: PointerEvent | MouseEvent): [number, number] {
    const pts = this.poly?.points ?? [];
    const last = pts[pts.length - 1];
    if (!e.shiftKey || !last) return [e.clientX, e.clientY];
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 12;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    return [last[0] + Math.cos(a) * len, last[1] + Math.sin(a) * len];
  }

  private drawPoly() {
    const pl = this.poly;
    if (!pl) return;
    const r = this.container.getBoundingClientRect();
    const pts = pl.cursor ? [...pl.points, pl.cursor] : pl.points;
    pl.line.setAttribute('points', pts.map(([x, y]) => `${x - r.left},${y - r.top}`).join(' '));
    pl.dots.innerHTML = pl.points.map(([x, y]) => `<circle cx="${x - r.left}" cy="${y - r.top}" r="4"></circle>`).join('');
  }

  private clickPoly(e: PointerEvent) {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const pl = this.ensurePoly();
    const q = this.polyPoint(e);
    const last = pl.points[pl.points.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 3) return; // second click of a double-click
    pl.points.push(q);
    this.drawPoly();
  }

  private movePoly(e: PointerEvent) {
    if (!this.state?.polyMode || !this.poly?.points.length) return;
    this.poly.cursor = this.polyPoint(e);
    this.drawPoly();
  }

  /** Remove the last polyline point. */
  undoPolyPoint() {
    if (!this.poly) return;
    this.poly.points.pop();
    this.drawPoly();
  }

  polyPointCount() {
    return this.poly?.points.length ?? 0;
  }

  finishPolyline() {
    const pl = this.poly;
    const pts = pl ? pl.points.slice() : [];
    this.cancelPolyline();
    if (pts.length >= 2) this.cb.onPolyline?.(pts);
  }

  cancelPolyline() {
    this.poly?.svg.remove();
    this.poly = null;
  }

  /** Zoom so the given screen rectangle (centre + size in px) fills the view. */
  zoomToRect(cx: number, cy: number, w: number, h: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const frac = Math.max(w / rect.width, h / rect.height);
    const ndc = new Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.objects.values()].filter((o) => o.part.visible).map((o) => o.mesh);
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const viewDir = new Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    // without a hit, use the point at the current target depth
    const newTarget = hit
      ? hit.point.clone()
      : this.raycaster.ray.at(this.raycaster.ray.origin.distanceTo(this.controls.target), new Vector3());
    if (this.camera === this.ortho) {
      const shift = newTarget.clone().sub(this.controls.target);
      this.ortho.position.add(shift);
      this.controls.target.copy(newTarget);
      this.ortho.zoom = Math.min(this.ortho.zoom / frac, 1e5);
      this.ortho.updateProjectionMatrix();
    } else {
      const dist = this.camera.position.distanceTo(newTarget) * frac;
      this.controls.target.copy(newTarget);
      this.camera.position.copy(newTarget).addScaledVector(viewDir, -Math.max(dist, 0.5));
      this.perspective.near = Math.max(0.01, dist / 1000);
      this.perspective.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }

  // ------------------------------------------------------------------ annotations (measurements, picked points)

  private syncAnnotations(s: AppState) {
    const key = [s.tool, s.measurements, s.measurePending, s.pointPicks, s.perfPoints, s.parts, s.settings.perforate.mode, s.settings.props.mode];
    if (key.length === this.annotKey.length && key.every((k, i) => k === this.annotKey[i])) return;
    this.annotKey = key;
    disposeChildren(this.annotGroup);
    const pts: Vec3[] = [];
    const segs: number[] = [];
    const accent = 0xffd23f;
    const ring = (c: Vec3, n: Vec3, r: number, color = accent) => {
      const nn = new Vector3(...n).normalize();
      const u = new Vector3().crossVectors(nn, Math.abs(nn.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
      const v = new Vector3().crossVectors(nn, u);
      const arr: number[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const p = new Vector3(...c).addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
        arr.push(p.x, p.y, p.z);
      }
      const line = new Line(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(arr), 3)), new LineBasicMaterial({ color, depthTest: false, transparent: true }));
      line.renderOrder = 1001;
      this.annotGroup.add(line);
    };
    if (s.tool === 'measure') {
      for (const m of s.measurements) {
        pts.push(...m.draw.points);
        for (const [a, b] of m.draw.segments) segs.push(...a, ...b);
        for (const c of m.draw.circles) ring(c.c, c.n, c.r);
        this.annotGroup.add(textSprite(m.draw.label.text, m.draw.label.pos));
      }
      for (const e of s.measurePending.entities) {
        const en = e.entity;
        if (en.kind === 'point') pts.push(en.p);
        else if (en.kind === 'line') segs.push(...en.a, ...en.b);
        else if (en.kind === 'plane') {
          pts.push(en.p);
          const size = 5;
          segs.push(...en.p, en.p[0] + en.n[0] * size, en.p[1] + en.n[1] * size, en.p[2] + en.n[2] * size);
        } else if (en.kind === 'circle') ring(en.c, en.n, en.r, 0x22d3ee);
        else if (en.kind === 'sphere') ring(en.c, [0, 0, 1], en.r, 0x22d3ee);
      }
      pts.push(...s.measurePending.points);
    }
    const markers: { pick: { partId: string; point: Vec3; normal: Vec3 }; color: number }[] = [];
    if (s.tool === 'label' && s.pointPicks.label) markers.push({ pick: s.pointPicks.label, color: accent });
    if (s.tool === 'props' && s.settings.props.mode === 'single') {
      if (s.pointPicks.propStart) markers.push({ pick: s.pointPicks.propStart, color: accent });
      if (s.pointPicks.propEnd) markers.push({ pick: s.pointPicks.propEnd, color: 0x22d3ee });
    }
    if (s.tool === 'perforate' && s.settings.perforate.mode === 'points') for (const p of s.perfPoints) markers.push({ pick: p, color: accent });
    for (const mk of markers) {
      const w = this.localToWorld(mk.pick.partId, mk.pick.point, mk.pick.normal);
      if (!w) continue;
      pts.push(w.point);
      const o = this.objects.get(mk.pick.partId);
      const len = Math.max(2, (o?.mesh.geometry.boundingSphere?.radius ?? 20) * 0.15);
      segs.push(...w.point, w.point[0] + w.normal[0] * len, w.point[1] + w.normal[1] * len, w.point[2] + w.normal[2] * len);
    }
    if (pts.length) {
      const g = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(pts.flat()), 3));
      const p = new Points(g, new PointsMaterial({ color: accent, size: 9, sizeAttenuation: false, depthTest: false, transparent: true }));
      p.renderOrder = 1002;
      this.annotGroup.add(p);
    }
    if (segs.length) {
      const l = new LineSegments(
        new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(segs), 3)),
        new LineBasicMaterial({ color: accent, depthTest: false, transparent: true }),
      );
      l.renderOrder = 1001;
      this.annotGroup.add(l);
    }
  }

  /**
   * Dimensions tab: exact world bounding box of each selected part with
   * X / Y / Z dimension lines and labels.
   */
  private syncDimensions(s: AppState) {
    const parts = s.tool === 'dimensions' ? s.parts.filter((p) => p.visible && s.selection.includes(p.id)) : [];
    const key: unknown[] = [parts.length, ...parts.flatMap((p) => [p.mesh, p.transform])];
    if (key.length === this.dimKey.length && key.every((k, i) => k === this.dimKey[i])) return;
    this.dimKey = key;
    disposeChildren(this.dimGroup);
    for (const sp of [...this.dimGroup.children]) this.dimGroup.remove(sp);
    for (const p of parts) {
      const b = worldBounds(p);
      const size = b.getSize(new Vector3());
      const mx = Math.max(size.x, size.y, size.z, 1);
      const off = mx * 0.08;
      const tick = mx * 0.025;
      const { min: lo, max: hi } = b;
      const box: number[] = [];
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z]);
      for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) box.push(...corners[i], ...corners[j]);
      const boxLines = lines(new Float32Array(box), 0x3fa7ff, false);
      this.dimGroup.add(boxLines);
      const dim: number[] = [];
      const fmt = (v: number) => `${v.toFixed(2)} mm`;
      // X along the front-bottom edge, Y along the right-bottom edge, Z up the front-right edge
      const yF = lo.y - off, xR = hi.x + off;
      dim.push(lo.x, yF, lo.z, hi.x, yF, lo.z);
      dim.push(lo.x, lo.y, lo.z, lo.x, yF - tick, lo.z, hi.x, lo.y, lo.z, hi.x, yF - tick, lo.z);
      dim.push(xR, lo.y, lo.z, xR, hi.y, lo.z);
      dim.push(hi.x, lo.y, lo.z, xR + tick, lo.y, lo.z, hi.x, hi.y, lo.z, xR + tick, hi.y, lo.z);
      const xz = hi.x + off * 0.7, yz = lo.y - off * 0.7;
      dim.push(xz, yz, lo.z, xz, yz, hi.z);
      dim.push(hi.x, lo.y, hi.z, xz + tick * 0.7, yz - tick * 0.7, hi.z);
      this.dimGroup.add(lines(new Float32Array(dim), 0xffd23f, true));
      this.dimGroup.add(textSprite(`X ${fmt(size.x)}`, [(lo.x + hi.x) / 2, yF - tick, lo.z], 0.03, [0.5, 1.15]));
      this.dimGroup.add(textSprite(`Y ${fmt(size.y)}`, [xR + tick, (lo.y + hi.y) / 2, lo.z], 0.03, [-0.08, 0.5]));
      this.dimGroup.add(textSprite(`Z ${fmt(size.z)}`, [xz, yz, (lo.z + hi.z) / 2], 0.03, [-0.08, 0.5]));
    }
    this.requestRender();
  }

  private refIds = new WeakMap<object, number>();
  private refCounter = 0;
  /** stable id per array identity (overlay cache keys) */
  private refId(o: object): number {
    let id = this.refIds.get(o);
    if (id === undefined) this.refIds.set(o, (id = ++this.refCounter));
    return id;
  }

  setCursor(c: string) {
    this.renderer.domElement.style.cursor = c;
  }
}

function textSprite(text: string, pos: Vec3, h = 0.045, anchor: [number, number] = [0.5, 0.5]): Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = '600 28px Inter, system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w;
  c.height = 44;
  ctx.font = font;
  ctx.fillStyle = 'rgba(20,22,27,0.88)';
  ctx.strokeStyle = '#ffd23f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, 42, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffd23f';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 23);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
  sp.scale.set((h * w) / 44, h, 1);
  sp.position.set(...pos);
  sp.center.set(anchor[0], anchor[1]);
  sp.renderOrder = 1003;
  sp.raycast = () => {};
  return sp;
}

function round(v: number) {
  return Math.round(v * 1e4) / 1e4;
}

function lines(seg: Float32Array, color: number, onTop: boolean): LineSegments {
  const l = new LineSegments(
    new BufferGeometry().setAttribute('position', new BufferAttribute(seg, 3)),
    new LineBasicMaterial({ color, depthTest: !onTop, transparent: onTop }),
  );
  l.renderOrder = 999;
  l.raycast = () => {};
  return l;
}

function triMesh(mesh: MeshData, tris: Uint32Array, color: number): Mesh {
  const idx = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    idx[i * 3] = mesh.indices[tris[i] * 3];
    idx[i * 3 + 1] = mesh.indices[tris[i] * 3 + 1];
    idx[i * 3 + 2] = mesh.indices[tris[i] * 3 + 2];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  const m = new Mesh(
    g,
    new MeshBasicMaterial({ color, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  m.raycast = () => {};
  m.renderOrder = 998;
  return m;
}

function disposeChildren(o: Object3D) {
  for (const c of [...o.children]) {
    if (c instanceof Mesh || c instanceof LineSegments) {
      c.geometry.dispose();
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => m.dispose());
    }
    disposeChildren(c);
    o.remove(c);
  }
}
