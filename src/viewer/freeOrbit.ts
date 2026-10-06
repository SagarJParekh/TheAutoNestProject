import { EventDispatcher, OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';

type Cam = PerspectiveCamera | OrthographicCamera;
const Z = new Vector3(0, 0, 1);

/**
 * Orbit / pan / zoom camera controls without angle limits.
 *
 * Unlike three's OrbitControls (which stops at the top and bottom poles),
 * the camera can keep rotating in any direction: horizontal drags turn
 * around the world Z axis like a turntable, vertical drags tilt around the
 * screen's horizontal axis and carry on over the top and underneath.
 *
 * Left drag rotates, right drag (or Shift / Ctrl + left) pans, middle drag
 * dollies, the wheel zooms towards the cursor.
 */
export class FreeOrbitControls extends EventDispatcher<{ change: object; start: object; end: object }> {
  readonly target = new Vector3();
  enabled = true;
  zoomToCursor = true;
  /** kept for API compatibility: panning is always in screen space */
  screenSpacePanning = true;
  rotateSpeed = 1;
  zoomSpeed = 1;
  minDistance = 0.01;
  maxDistance = 1e7;

  private mode: 'rotate' | 'pan' | 'dolly' | null = null;
  private last = new Vector2();
  private pointerId = -1;
  private raycaster = new Raycaster();

  constructor(
    public object: Cam,
    private readonly domElement: HTMLElement,
  ) {
    super();
    domElement.addEventListener('pointerdown', this.onDown);
    domElement.addEventListener('pointermove', this.onMove);
    domElement.addEventListener('pointerup', this.onUp);
    domElement.addEventListener('pointercancel', this.onUp);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this.onContextMenu);
    domElement.style.touchAction = 'none';
  }

  dispose() {
    const el = this.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Re-aim the camera at the target (call after moving the camera or target). */
  update() {
    const up = this.object.up;
    const view = new Vector3().subVectors(this.target, this.object.position);
    // keep the up vector usable (not parallel to the view direction)
    if (view.lengthSq() > 0 && Math.abs(view.clone().normalize().dot(up.clone().normalize())) > 0.9999) {
      up.copy(new Vector3(0, 1, 0).applyQuaternion(this.object.quaternion));
    }
    this.object.lookAt(this.target);
    this.dispatchEvent({ type: 'change' });
  }

  // ---------------------------------------------------------------- pointer handling

  private onContextMenu = (e: Event) => e.preventDefault();

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || this.mode) return;
    if (e.button === 0) this.mode = e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'rotate';
    else if (e.button === 1) this.mode = 'dolly';
    else if (e.button === 2) this.mode = 'pan';
    else return;
    this.pointerId = e.pointerId;
    this.last.set(e.clientX, e.clientY);
    this.dispatchEvent({ type: 'start' });
  };

  private onMove = (e: PointerEvent) => {
    if (!this.mode || e.pointerId !== this.pointerId) return;
    // another tool (gizmo, lasso, brush…) took over the drag
    if (!this.enabled) return this.finish();
    const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
    this.last.set(e.clientX, e.clientY);
    if (!dx && !dy) return;
    if (this.mode === 'rotate') this.rotate(dx, dy);
    else if (this.mode === 'pan') this.pan(dx, dy);
    else this.dollyBy(Math.exp(dy * 0.005 * this.zoomSpeed), null);
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.pointerId) this.finish();
  };

  private finish() {
    if (!this.mode) return;
    this.mode = null;
    this.pointerId = -1;
    this.dispatchEvent({ type: 'end' });
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const factor = Math.exp(Math.max(-300, Math.min(300, px)) * 0.0015 * this.zoomSpeed);
    this.dollyBy(factor, this.zoomToCursor ? new Vector2(e.clientX, e.clientY) : null);
  };

  // ---------------------------------------------------------------- camera moves

  /** Turntable around world Z (horizontal) and tilt around the screen X axis (vertical), no limits. */
  private rotate(dx: number, dy: number) {
    const h = this.domElement.clientHeight || 1;
    const cam = this.object;
    const yaw = ((-2 * Math.PI * dx) / h) * this.rotateSpeed;
    const pitch = ((-2 * Math.PI * dy) / h) * this.rotateSpeed;
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    // when the view is upside down, turn the other way so the scene follows the mouse
    const qYaw = new Quaternion().setFromAxisAngle(Z, up.z < 0 ? -yaw : yaw);
    const qPitch = new Quaternion().setFromAxisAngle(right, pitch);
    const q = qYaw.multiply(qPitch);
    const offset = new Vector3().subVectors(cam.position, this.target).applyQuaternion(q);
    cam.position.copy(this.target).add(offset);
    cam.up.copy(up.applyQuaternion(q));
    cam.lookAt(this.target);
    this.dispatchEvent({ type: 'change' });
  }

  /** World size of one screen pixel at the target depth. */
  private pixelSize(): number {
    const h = this.domElement.clientHeight || 1;
    const cam = this.object;
    if ((cam as OrthographicCamera).isOrthographicCamera) {
      const o = cam as OrthographicCamera;
      return (o.top - o.bottom) / o.zoom / h;
    }
    const p = cam as PerspectiveCamera;
    const dist = p.position.distanceTo(this.target);
    return (2 * dist * Math.tan(((p.fov * Math.PI) / 180) / 2)) / h;
  }

  private pan(dx: number, dy: number) {
    const cam = this.object;
    const s = this.pixelSize();
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const move = right.multiplyScalar(-dx * s).add(up.multiplyScalar(dy * s));
    cam.position.add(move);
    this.target.add(move);
    this.dispatchEvent({ type: 'change' });
  }

  /** Point under the cursor on the plane through the target facing the camera. */
  private cursorPoint(client: Vector2): Vector3 | null {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new Vector2(((client.x - rect.left) / rect.width) * 2 - 1, -((client.y - rect.top) / rect.height) * 2 + 1);
    this.object.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.object);
    const n = new Vector3().subVectors(this.object.position, this.target).normalize();
    return this.raycaster.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(n, this.target), new Vector3());
  }

  /** factor > 1 zooms out, < 1 zooms in; towards `client` when given. */
  private dollyBy(factor: number, client: Vector2 | null) {
    const cam = this.object;
    const anchor = client ? this.cursorPoint(client) : null;
    if ((cam as OrthographicCamera).isOrthographicCamera) {
      const o = cam as OrthographicCamera;
      o.zoom = Math.max(1e-5, Math.min(1e5, o.zoom / factor));
      o.updateProjectionMatrix();
      if (anchor && client) {
        // keep the point under the cursor in place
        const after = this.cursorPoint(client);
        if (after) {
          const shift = anchor.sub(after);
          o.position.add(shift);
          this.target.add(shift);
        }
      }
    } else {
      const offset = new Vector3().subVectors(cam.position, this.target);
      const dist = offset.length();
      const next = Math.max(this.minDistance, Math.min(this.maxDistance, dist * factor));
      const k = next / (dist || 1);
      if (anchor) {
        // scale camera and target about the cursor point
        cam.position.sub(anchor).multiplyScalar(k).add(anchor);
        this.target.sub(anchor).multiplyScalar(k).add(anchor);
      } else cam.position.copy(this.target).addScaledVector(offset, k);
    }
    this.dispatchEvent({ type: 'change' });
  }
}
