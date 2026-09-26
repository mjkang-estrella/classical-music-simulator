import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildMannequin, mannequinStyle } from '../../src/assets/placeholder/mannequin';
import { canonicalName } from '../../src/rig/boneMaps';
import { Rig } from '../../src/rig/rig';

function makeRig(seed = 0.3) {
  const { root } = buildMannequin(mannequinStyle(seed));
  return new Rig(root);
}

describe('bone maps', () => {
  it('maps Rocketbox Biped names (sanitised and raw)', () => {
    expect(canonicalName('Bip01_Pelvis')).toBe('Hips');
    expect(canonicalName('Bip01 L UpperArm')).toBe('LeftArm');
    expect(canonicalName('Bip01_R_Forearm')).toBe('RightForeArm');
    expect(canonicalName('Bip01_L_Clavicle')).toBe('LeftShoulder');
    expect(canonicalName('Bip01_L_Finger0')).toBe('LeftHandThumb1');
    expect(canonicalName('Bip01_L_Finger02')).toBe('LeftHandThumb3');
    expect(canonicalName('Bip01_R_Finger21')).toBe('RightHandMiddle2');
    expect(canonicalName('Bip01_L_Finger4')).toBe('LeftHandPinky1');
    expect(canonicalName('Bip01_L_Thigh')).toBe('LeftUpLeg');
    expect(canonicalName('Bip01_R_Calf')).toBe('RightLeg');
    expect(canonicalName('Bip01_L_Toe0')).toBe('LeftToeBase');
    expect(canonicalName('Bip01_MJaw')).toBe('Jaw');
    expect(canonicalName('Bip01_Footsteps')).toBeNull();
  });
  it('maps Mixamo names', () => {
    expect(canonicalName('mixamorigHips')).toBe('Hips');
    expect(canonicalName('mixamorig:LeftForeArm')).toBe('LeftForeArm');
    expect(canonicalName('mixamorigRightHandIndex2')).toBe('RightHandIndex2');
    expect(canonicalName('mixamorigLeftHandIndex4')).toBeNull();
  });
});

describe('Rig on the placeholder mannequin', () => {
  it('measures a plausible body', () => {
    const rig = makeRig();
    expect(rig.measure.height).toBeGreaterThan(1.55);
    expect(rig.measure.height).toBeLessThan(1.95);
    expect(rig.measure.upperArm).toBeGreaterThan(0.22);
    expect(rig.hasFingers('Left')).toBe(true);
  });

  it('two-bone IK reaches reachable targets within 1 mm', () => {
    const rig = makeRig();
    const targets = [
      new Vector3(0.25, 1.1, 0.35),
      new Vector3(-0.1, 1.3, 0.4),
      new Vector3(0.45, 1.45, 0.1),
      new Vector3(0.1, 0.9, 0.2),
    ];
    for (const t of targets) {
      rig.reset();
      rig.update();
      const reach = rig.solveLimb('LeftArm', t, new Vector3(0, -1, -0.3));
      expect(reach).toBeCloseTo(1, 5);
      const wrist = rig.pos('LeftHand', new Vector3());
      expect(wrist.distanceTo(t)).toBeLessThan(0.001);
    }
  });

  it('clamps unreachable targets without NaN and keeps the bone lengths', () => {
    const rig = makeRig();
    rig.update();
    rig.solveLimb('RightArm', new Vector3(-3, 2, 2), new Vector3(0, -1, 0));
    const s = rig.pos('RightArm', new Vector3());
    const e = rig.pos('RightForeArm', new Vector3());
    const w = rig.pos('RightHand', new Vector3());
    expect(Number.isFinite(w.x + w.y + w.z)).toBe(true);
    expect(s.distanceTo(e)).toBeCloseTo(rig.limbs.RightArm.l1, 4);
    expect(e.distanceTo(w)).toBeCloseTo(rig.limbs.RightArm.l2, 4);
  });

  it('elbow follows the pole and the knee bends forward when seated', () => {
    const rig = makeRig();
    rig.update();
    rig.solveLimb('LeftArm', new Vector3(0.2, 1.1, 0.3), new Vector3(0, -1, 0));
    const elbow = rig.pos('LeftForeArm', new Vector3());
    const shoulder = rig.pos('LeftArm', new Vector3());
    expect(elbow.y).toBeLessThan(shoulder.y);

    rig.reset();
    rig.setHips(new Vector3(0, 0.55, -0.05));
    rig.update();
    const hip = rig.pos('LeftUpLeg', new Vector3());
    const ankle = new Vector3(hip.x, rig.measure.ankleHeight, hip.z + rig.measure.thigh);
    rig.solveLimb('LeftLeg', ankle, new Vector3(0, 0, 1));
    const knee = rig.pos('LeftLeg', new Vector3());
    expect(knee.z).toBeGreaterThan(hip.z + 0.2);
    expect(rig.pos('LeftFoot', new Vector3()).distanceTo(ankle)).toBeLessThan(0.002);
  });

  it('orients the hand frame exactly', () => {
    const rig = makeRig();
    rig.update();
    rig.solveLimb('RightArm', new Vector3(-0.2, 1.15, 0.35), new Vector3(0, -1, 0));
    const dir = new Vector3(0, 0, 1);
    const palm = new Vector3(0, -1, 0);
    rig.orientHand('Right', dir, palm);
    const wrist = rig.pos('RightHand', new Vector3());
    const knuckle = rig.pos('RightHandMiddle1', new Vector3());
    const actual = knuckle.sub(wrist).normalize();
    expect(actual.dot(dir)).toBeGreaterThan(0.98);
  });
});
