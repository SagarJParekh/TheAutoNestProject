import {
  CanvasTexture, Camera, Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Scene,
  Sprite, SpriteMaterial, Vector3, WebGLRenderer,
} from 'three';

/** Small XYZ axis indicator rendered in the bottom-left corner. */
export class AxisGizmo {
  private scene = new Scene();
  private camera = new OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private root = new Group();
  size = 96;

  constructor() {
    const axes: [Vector3, string, string][] = [
      [new Vector3(1, 0, 0), '#ff4d5e', 'X'],
      [new Vector3(0, 1, 0), '#57d16a', 'Y'],
      [new Vector3(0, 0, 1), '#4d8dff', 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      const mat = new MeshBasicMaterial({ color: new Color(color), depthTest: false });
      const shaft = new Mesh(new CylinderGeometry(0.04, 0.04, 0.9, 8), mat);
      const tip = new Mesh(new ConeGeometry(0.11, 0.3, 12), mat);
      shaft.position.y = 0.45;
      tip.position.y = 1.0;
      const g = new Group();
      g.add(shaft, tip);
      g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
      this.root.add(g);
      const sprite = new Sprite(new SpriteMaterial({ map: labelTexture(label, color), depthTest: false }));
      sprite.position.copy(dir).multiplyScalar(1.35);
      sprite.scale.setScalar(0.42);
      this.root.add(sprite);
    }
    this.scene.add(this.root);
    this.camera.up.set(0, 0, 1);
  }

  render(renderer: WebGLRenderer, main: Camera) {
    const dir = new Vector3(0, 0, 1).applyQuaternion(main.quaternion);
    this.camera.position.copy(dir).multiplyScalar(4);
    this.camera.quaternion.copy(main.quaternion);
    const dpr = renderer.getPixelRatio();
    void dpr;
    const s = this.size;
    renderer.clearDepth();
    renderer.setViewport(8, 8, s, s);
    renderer.setScissor(8, 8, s, s);
    renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }
}

function labelTexture(text: string, color: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  return new CanvasTexture(c);
}
