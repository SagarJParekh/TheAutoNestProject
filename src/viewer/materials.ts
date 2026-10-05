import { Color, DoubleSide, MeshStandardMaterial } from 'three';

/**
 * Part material: flat shaded (normals from screen-space derivatives, so no
 * normal buffer is needed for multi-million triangle meshes). Back faces are
 * tinted red, which makes inside-out regions obvious.
 */
export function createPartMaterial(color: string): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: new Color(color),
    flatShading: true,
    metalness: 0.05,
    roughness: 0.62,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       if (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.08, 0.12), 0.8);`,
    );
  };
  m.customProgramCacheKey = () => 'part-backface-tint';
  return m;
}
