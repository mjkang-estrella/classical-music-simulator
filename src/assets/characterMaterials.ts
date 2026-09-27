import { Color, DoubleSide, FrontSide, Material, MeshPhysicalMaterial, MeshStandardMaterial, ShaderChunk, Texture, Vector2, type WebGLProgramParametersWithUniforms } from 'three';

/**
 * Realistic character shading on top of the Rocketbox textures:
 *  - skin: a cheap subsurface-scattering approximation (per-channel wrap lighting, so the
 *    terminator is soft and reddish like real skin) applied only where the texel looks like skin
 *    (hue/saturation mask), so suits and shirts in the same texture are unaffected;
 *  - fabric: a soft sheen lobe that gives wool its velvety rim;
 *  - hair: anisotropic highlights and alpha-to-coverage edges;
 *  - eyes / mouth: wet, glossy surfaces.
 * Per-musician variation (skin tone, hair colour) is driven by uniforms so materials stay cheap.
 */

export type CharacterPart = 'skinFabric' | 'skin' | 'hair' | 'glasses' | 'eyes' | 'mouth' | 'other';

export function classifyMaterial(name: string, mat: MeshStandardMaterial): CharacterPart {
  const n = name.toLowerCase();
  if (/eye/.test(n)) return 'eyes';
  if (/mouth|teeth|tongue/.test(n)) return 'mouth';
  if (/glasses|spectacle/.test(n)) return 'glasses';
  if (/opacity|hair|lash|brow/.test(n) || mat.alphaTest > 0 || mat.transparent) return 'hair';
  if (/head|face/.test(n)) return 'skin';
  if (/body/.test(n)) return 'skinFabric';
  return 'other';
}

const SKIN_UNIFORMS = {
  uSkinStrength: { value: 1 },
};

/** Skin mask + tint, inserted after the base colour is known. */
const SKIN_MASK = /* glsl */ `
  {
    vec3 sc = pow( max( diffuseColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
    float mx = max( max( sc.r, sc.g ), sc.b );
    float mn = min( min( sc.r, sc.g ), sc.b );
    float sat = ( mx - mn ) / max( mx, 1e-4 );
    float order = step( sc.b, sc.g + 0.02 ) * step( sc.g, sc.r + 0.02 );
    float hue = ( sc.g - sc.b ) / max( sc.r - sc.b, 1e-4 );
    skinMask = order
      * smoothstep( 0.1, 0.2, sat ) * ( 1.0 - smoothstep( 0.72, 0.9, sat ) )
      * smoothstep( 0.02, 0.1, hue ) * ( 1.0 - smoothstep( 0.78, 0.92, hue ) )
      * smoothstep( 0.1, 0.22, mx ) * uSkinStrength;
    diffuseColor.rgb *= mix( vec3( 1.0 ), uSkinTint, skinMask );
    // the source textures are over-saturated for stage light; pull skin toward its luminance a little
    float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( lum ), 0.14 * skinMask );
  }
`;

/** Replacement for the final diffuse line of RE_Direct_Physical: wrap lighting inside skin. */
const SSS_DIFFUSE = /* glsl */ `
  vec3 sssIrradiance = irradiance;
  if ( skinMask > 0.001 ) {
    float ndl = dot( geometryNormal, directLight.direction );
    // red light travels furthest under the skin, blue the least
    vec3 wrapW = vec3( 0.4, 0.2, 0.14 );
    vec3 wrapped = saturate( ( vec3( ndl ) + wrapW ) / ( 1.0 + wrapW ) );
    // a faint warm glow where light grazes thin tissue (ears, nose, fingers)
    float thin = pow( saturate( 1.0 - abs( ndl ) ), 3.0 ) * 0.12;
    vec3 sss = ( wrapped + thin * vec3( 1.0, 0.35, 0.22 ) ) * directLight.color;
    sssIrradiance = mix( irradiance, sss, skinMask * 0.75 );
  }
  reflectedLight.directDiffuse += sssIrradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
`;

function patchSkin(shader: WebGLProgramParametersWithUniforms, hairTint: boolean) {
  shader.uniforms.uSkinStrength = SKIN_UNIFORMS.uSkinStrength;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nfloat skinMask = 0.0;\nuniform float uSkinStrength;\nuniform vec3 uSkinTint;\nuniform vec3 uHairTint;')
    .replace('#include <color_fragment>', `#include <color_fragment>\n${hairTint ? 'diffuseColor.rgb *= uHairTint;' : SKIN_MASK}`)
    .replace(
      '#include <lights_physical_pars_fragment>',
      THREE_LIGHTS_PHYSICAL().replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
        SSS_DIFFUSE,
      ),
    );
}

let lightsChunk: string | null = null;
function THREE_LIGHTS_PHYSICAL(): string {
  if (!lightsChunk) {
    lightsChunk = ShaderChunk.lights_physical_pars_fragment;
    if (!lightsChunk.includes('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );')) {
      console.warn('[characters] three.js lighting chunk changed; skin scattering disabled');
    }
  }
  return lightsChunk;
}

function copyMaps(src: MeshStandardMaterial, dst: MeshPhysicalMaterial) {
  const keys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'emissiveMap', 'bumpMap'] as const;
  for (const k of keys) (dst as unknown as Record<string, Texture | null>)[k] = src[k] ?? null;
  dst.normalScale = (src.normalScale ?? new Vector2(1, 1)).clone();
  dst.color.copy(src.color);
  dst.emissive.copy(src.emissive);
  dst.roughness = src.roughness;
  dst.metalness = src.metalness;
  dst.alphaTest = src.alphaTest;
  dst.transparent = src.transparent;
  dst.opacity = src.opacity;
  dst.side = src.side;
  dst.name = src.name;
  dst.vertexColors = src.vertexColors;
}

/** Builds the realistic material for one character material (once per prototype). */
export function realisticMaterial(src: Material): Material {
  const std = src as MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return src;
  const part = classifyMaterial(std.name, std);
  if (part === 'other') return src;
  const m = new MeshPhysicalMaterial();
  copyMaps(std, m);
  m.userData.part = part;
  switch (part) {
    case 'skinFabric':
      // suit wool + hands: sheen for the fabric, skin scattering where the texture is skin
      m.sheen = 0.7;
      m.sheenColor = new Color('#3a3a40');
      m.sheenRoughness = 0.75;
      m.specularIntensity = 0.6;
      if (!std.roughnessMap) m.roughness = 0.72;
      m.userData.skin = true;
      break;
    case 'skin':
      m.specularIntensity = 0.6;
      if (!std.roughnessMap) m.roughness = 0.5;
      m.userData.skin = true;
      break;
    case 'hair':
      m.anisotropy = 0.55;
      m.anisotropyRotation = Math.PI / 2;
      m.sheen = 0.4;
      m.sheenColor = new Color('#6a5a48');
      m.sheenRoughness = 0.35;
      m.specularIntensity = 0.5;
      m.roughness = Math.min(m.roughness, 0.55);
      // a softer cutoff keeps fine strands; alpha-to-coverage (with MSAA) feathers the edges
      if (m.alphaTest > 0) m.alphaTest = Math.min(m.alphaTest, 0.28);
      m.alphaToCoverage = m.alphaTest > 0;
      m.side = m.side === DoubleSide ? DoubleSide : FrontSide;
      m.userData.hair = true;
      break;
    case 'glasses':
      // thin metal frames + lenses: keep the cutout, add a glossy coat, render both sides
      m.metalness = 0.6;
      m.roughness = 0.25;
      m.clearcoat = 1;
      m.clearcoatRoughness = 0.05;
      m.side = DoubleSide;
      m.alphaToCoverage = true;
      break;
    case 'eyes':
      m.roughness = 0.04;
      m.clearcoat = 1;
      m.clearcoatRoughness = 0.02;
      m.specularIntensity = 1;
      break;
    case 'mouth':
      m.roughness = 0.25;
      m.clearcoat = 0.6;
      m.clearcoatRoughness = 0.1;
      break;
  }
  installShader(m);
  return m;
}

/** (Re)installs the skin / hair shader hook — Material.clone() does not copy it. */
export function installShader(m: Material) {
  const u = m.userData as { skin?: boolean; hair?: boolean; skinTint?: Color; hairTint?: Color };
  if (!u.skin && !u.hair) return;
  // userData is JSON-cloned by Material.clone(), so rebuild real Color objects
  u.skinTint = new Color(1, 1, 1);
  u.hairTint = new Color(1, 1, 1);
  const skinTint = { value: u.skinTint };
  const hairTint = { value: u.hairTint };
  m.onBeforeCompile = (shader) => {
    patchSkin(shader, !!u.hair);
    shader.uniforms.uSkinTint = skinTint;
    shader.uniforms.uHairTint = hairTint;
  };
  m.customProgramCacheKey = () => (u.hair ? 'orchestra-hair' : 'orchestra-skin');
}

/** Global strength of the skin scattering (0 disables it). */
export function setSkinScattering(v: number) {
  SKIN_UNIFORMS.uSkinStrength.value = v;
}

/** Per-musician look: skin tone multiplier and hair colour multiplier. */
export function personalize(mat: Material, seed: number) {
  const u = mat.userData as { skin?: boolean; hair?: boolean; skinTint?: Color; hairTint?: Color };
  const r = (k: number) => {
    const x = Math.sin((seed * 131.7 + k * 17.3) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  if (u.skin && u.skinTint) {
    // ±6 % brightness with a slight warm / cool shift
    const b = 0.94 + r(1) * 0.12;
    const warm = (r(2) - 0.5) * 0.06;
    u.skinTint.setRGB(b * (1 + warm), b, b * (1 - warm));
  }
  if (u.hair && u.hairTint) {
    // a third keep their colour, the rest darken toward brown / near-black or grey
    const v = r(3);
    if (v < 0.33) u.hairTint.setRGB(1, 1, 1);
    else if (v < 0.66) u.hairTint.setRGB(0.55, 0.45, 0.38);
    else if (v < 0.88) u.hairTint.setRGB(0.3, 0.26, 0.24);
    else u.hairTint.setRGB(1.05, 1.05, 1.08);
  }
}
