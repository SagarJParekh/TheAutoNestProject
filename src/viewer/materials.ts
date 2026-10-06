import { Color, DoubleSide, MeshStandardMaterial } from 'three';

/**
 * Shared uniforms for all part materials: the colour used for back faces
 * (inverted triangles) and, in orientation mode, solid contrasting colours
 * for front (correct) and back (inverted) faces.
 */
export const orientationUniforms = {
  uOrient: { value: 0 },
  uFrontColor: { value: new Color('#3fa7ff') },
  uBackColor: { value: new Color('#ff3b4e') },
};

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
    Object.assign(shader.uniforms, orientationUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uOrient;\nuniform vec3 uFrontColor;\nuniform vec3 uBackColor;\nvoid main() {')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
       if (uOrient > 0.5) diffuseColor.rgb = gl_FrontFacing ? uFrontColor : uBackColor;
       else if (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, uBackColor, 0.8);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
       // orientation mode: no part-coloured selection glow, and a little self-light so both colours read clearly in shadow
       if (uOrient > 0.5) totalEmissiveRadiance = diffuseColor.rgb * 0.3;`,
      );
  };
  m.customProgramCacheKey = () => 'part-orientation-v3';
  return m;
}
