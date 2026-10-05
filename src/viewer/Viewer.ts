import {
  AmbientLight, Box3, Box3Helper, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DecrementWrapStencilOp,
  DirectionalLight, DoubleSide, FrontSide, BackSide, GridHelper, Group, HemisphereLight, IncrementWrapStencilOp,
  LineBasicMaterial, LineSegments, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, NotEqualStencilFunc,
  Object3D, OrthographicCamera, PerspectiveCamera, Plane, PlaneGeometry, Quaternion, Raycaster, ReplaceStencilOp, Scene,
  Sphere, Vector2, Vector3, WebGLRenderer, AlwaysStencilFunc, Material,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { MeshData } from '../geometry';
import type { AppState } from '../state/store';
import type { Part, Transform, ViewName } from '../state/types';
import { meshEntry, onMeshEntryChange } from '../state/meshCache';
import { createPartMaterial } from './materials';
import { sectionSegments } from './section';
import { AxisGizmo } from './axisGizmo';
import { planeFromSettings, quaternionOf, eulerDegFromQuaternion } from '../state/math';

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
}

export interface ViewerCallbacks {
  onPick: (info: PickInfo | null, ev: { shift: boolean; ctrl: boolean }) => void;
  onTransformEnd: (partId: string, t: Transform) => void;
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

    this.scene.add(this.gridGroup, this.partsGroup, this.capsGroup, this.previewGroup, this.overlayGroup);
    this.buildGrid(200);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
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

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
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
    if (!this.draggingGizmo || this.gizmo.object !== group) this.applyTransform(group, part.transform);
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

    // selection bounding box
    if (selected && part.visible) {
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
      sel && !sel.part.locked && sel.part.visible && s.tool === 'transform' && s.gizmo !== 'none' && !s.preview && !s.pickMode;
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
      const analysis = a && a.mesh === obj.part.mesh && s.tool === 'repair' ? a : null;
      const fs = s.faceSelection?.partId === obj.part.id && (s.tool === 'extrude' || s.tool === 'perforate') ? s.faceSelection : null;
      const hl = s.settings.highlight;
      const key = `${analysis ? 'a' : ''}${hl.open}${hl.nonManifold}${hl.flipped}${hl.holeIndex}|${fs ? fs.tris.length + ':' + fs.seed : ''}`;
      if (obj.overlayKey === key && obj.overlay.userData.analysis === analysis && obj.overlay.userData.fs === fs) continue;
      obj.overlayKey = key;
      obj.overlay.userData = { analysis, fs };
      disposeChildren(obj.overlay);
      if (analysis) {
        const h = analysis.report.highlights;
        if (hl.open && h.openEdges.length) obj.overlay.add(lines(h.openEdges, 0xff3b4e, true));
        if (hl.nonManifold && h.nonManifoldEdges.length) obj.overlay.add(lines(h.nonManifoldEdges, 0xffb020, true));
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
      s.tool === 'cut' ? s.cutPlane : null,
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
    if (s.tool === 'cut' && !s.preview) {
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
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    this.cb.onPick(info ? { ...info, ...mods } : null, mods);
  }

  pick(clientX: number, clientY: number): Omit<PickInfo, 'shift' | 'ctrl'> | null {
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

  setCursor(c: string) {
    this.renderer.domElement.style.cursor = c;
  }
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
