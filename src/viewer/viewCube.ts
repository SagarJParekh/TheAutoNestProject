import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Camera, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh,
  MeshBasicMaterial, OrthographicCamera, Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';

/**
 * Navigation cube in the bottom-left corner: it turns with the view, its
 * faces are labelled (TOP, FRONT, RIGHT…), and clicking a face, an edge or a
 * corner looks at the parts from that direction. Short X / Y / Z axes run
 * from its corner.
 */
export class ViewCube {
  private scene = new Scene();
  private camera = new OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);
  private cube: Mesh;
  private raycaster = new Raycaster();
  size = 110;
  margin = 8;

  constructor() {
    // world Z is up: the box is turned so its local +Y face is the top
    const faces: [string, number][] = [
      ['RIGHT', 0], // +X
      ['LEFT', 1], // −X
      ['TOP', 2], // local +Y → +Z
      ['BOTTOM', 3], // local −Y → −Z
      ['FRONT', 4], // local +Z → −Y
      ['BACK', 5], // local −Z → +Y
    ];
    const geo = new BoxGeometry(1, 1, 1);
    geo.rotateX(Math.PI / 2);
    this.cube = new Mesh(
      geo,
      faces.map(([label]) => new MeshBasicMaterial({ map: faceTexture(label), depthTest: true })),
    );
    const edges = new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color: 0x1b1f26 }));
    const axes = new Group();
    const o = -0.5, l = 0.95;
    const axis = (to: number[], color: number) =>
      new LineSegments(
        new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([o, o, o, ...to]), 3)),
        new LineBasicMaterial({ color, depthTest: false }),
      );
    axes.add(axis([o + l, o, o], 0xff4d5e), axis([o, o + l, o], 0x57d16a), axis([o, o, o + l], 0x4d8dff));
    axes.renderOrder = 2;
    this.scene.add(this.cube, edges, axes);
    this.camera.up.set(0, 0, 1);
  }

  render(renderer: WebGLRenderer, main: Camera) {
    const dir = new Vector3(0, 0, 1).applyQuaternion(main.quaternion);
    this.camera.position.copy(dir).multiplyScalar(4);
    this.camera.quaternion.copy(main.quaternion);
    const s = this.size, m = this.margin;
    renderer.clearDepth();
    renderer.setViewport(m, m, s, s);
    renderer.setScissor(m, m, s, s);
    renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  /**
   * The direction to look from when (clientX, clientY) is on the cube: a face
   * gives its axis, an edge or corner the diagonal between its faces. Null
   * when the point is not on the cube.
   */
  directionAt(clientX: number, clientY: number, rect: DOMRect): Vector3 | null {
    const s = this.size, m = this.margin;
    const x = clientX - rect.left - m, y = rect.bottom - clientY - m;
    if (x < 0 || y < 0 || x > s || y > s) return null;
    this.raycaster.setFromCamera(new Vector2((x / s) * 2 - 1, (y / s) * 2 - 1), this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    // near an edge or corner (within 0.15 of it), the neighbouring faces count too
    const d = new Vector3(Math.abs(p.x) > 0.35 ? Math.sign(p.x) : 0, Math.abs(p.y) > 0.35 ? Math.sign(p.y) : 0, Math.abs(p.z) > 0.35 ? Math.sign(p.z) : 0);
    return d.lengthSq() ? d.normalize() : null;
  }

  /** Whether (clientX, clientY) is inside the cube's corner square. */
  contains(clientX: number, clientY: number, rect: DOMRect): boolean {
    const x = clientX - rect.left - this.margin, y = rect.bottom - clientY - this.margin;
    return x >= 0 && y >= 0 && x <= this.size && y <= this.size;
  }
}

function faceTexture(text: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d9dee6';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#9aa3b0';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 122, 122);
  ctx.fillStyle = '#1f2630';
  ctx.font = `bold ${text.length > 5 ? 24 : 28}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 66);
  const t = new CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
