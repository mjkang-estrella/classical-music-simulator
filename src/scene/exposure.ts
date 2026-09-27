import { wrapEffect } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import { Uniform } from 'three';

/** Linear exposure applied before tone mapping (the effect chain ignores renderer exposure). */
class ExposureEffectImpl extends Effect {
  constructor({ exposure = 1 }: { exposure?: number } = {}) {
    super('ExposureEffect', 'uniform float exposure;\nvoid mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb * exposure, inputColor.a); }', {
      uniforms: new Map([['exposure', new Uniform(exposure)]]),
    });
  }

  get exposure(): number {
    return (this.uniforms.get('exposure') as Uniform<number>).value;
  }

  set exposure(v: number) {
    (this.uniforms.get('exposure') as Uniform<number>).value = v;
  }
}

export const Exposure = wrapEffect(ExposureEffectImpl);
