import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { keysFor, stringFingering, valvesFor } from '../../src/animation/fingering';
import { buildMannequin, mannequinStyle } from '../../src/assets/placeholder/mannequin';
import { POSES } from '../../src/rig/handPose';
import { Rig, worldQuat } from '../../src/rig/rig';

function rig() {
  return new Rig(buildMannequin(mannequinStyle(0.3)).root);
}

describe('hand poses', () => {
  it('flexion curls every fingertip toward the palm', () => {
    const r = rig();
    r.update();
    const palmN = new Vector3(0, -1, 0); // mannequin bind: palms down
    const tipOf = (f: string) => r.pos(`LeftHand${f}3` as never, new Vector3());
    const before = ['Index', 'Middle', 'Ring', 'Pinky'].map((f) => tipOf(f).dot(palmN));
    r.applyHandPose('Left', POSES.wrap);
    r.update();
    const after = ['Index', 'Middle', 'Ring', 'Pinky'].map((f) => tipOf(f).dot(palmN));
    after.forEach((a, i) => expect(a, `finger ${i}`).toBeGreaterThan(before[i] + 0.005));
  });

  it('thumb opposition swings the thumb in front of the palm', () => {
    const r = rig();
    r.update();
    const palmN = new Vector3(0, -1, 0);
    const before = r.pos('LeftHandThumb3', new Vector3()).dot(palmN);
    r.applyHandPose('Left', POSES.bowHold);
    r.update();
    expect(r.pos('LeftHandThumb3', new Vector3()).dot(palmN)).toBeGreaterThan(before);
  });

  it('orientHand shares twist with the forearm and limits the wrist', () => {
    const r = rig();
    r.update();
    r.solveLimb('LeftArm', new Vector3(0.3, 1.1, 0.35), new Vector3(0, -1, 0));
    const foreBefore = worldQuat(r.bones.LeftForeArm!, new Quaternion());
    // palm up: a strong supination away from the bind (palm down)
    r.orientHand('Left', new Vector3(0, 0, 1), new Vector3(0, 1, 0), 0.6, 1.0);
    const foreAfter = worldQuat(r.bones.LeftForeArm!, new Quaternion());
    expect(foreBefore.angleTo(foreAfter)).toBeGreaterThan(0.3);
    // remaining hand deviation relative to a straight wrist stays within the limit
    const h = r.hands.Left;
    const neutral = foreAfter.clone().multiply(h.relBind);
    const hand = worldQuat(h.bone, new Quaternion());
    expect(neutral.angleTo(hand)).toBeLessThanOrEqual(1.0 + 1e-3);
  });
});

describe('fingerings', () => {
  it('trumpet valves follow the harmonic series', () => {
    expect(valvesFor('trumpet', 70)).toEqual([false, false, false]); // B♭4 open
    expect(valvesFor('trumpet', 69)).toEqual([false, true, false]); // A4: 2
    expect(valvesFor('trumpet', 68)).toEqual([true, false, false]); // A♭4: 1
    expect(valvesFor('trumpet', 67)).toEqual([true, true, false]); // G4: 1+2
    expect(valvesFor('trumpet', 64)).toEqual([false, true, false]); // E4 (written F♯4): 2
    expect(valvesFor('trumpet', 52)).toEqual([true, true, true]); // E3 (written F♯3): 1+2+3
  });

  it('woodwind keys lift from the bottom as the scale rises', () => {
    const low = keysFor('clarinet', 50).filter(Boolean).length;
    const mid = keysFor('clarinet', 55).filter(Boolean).length;
    const high = keysFor('clarinet', 60).filter(Boolean).length;
    expect(low).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThan(high);
  });

  it('string fingering: open strings use no finger, first position covers a fourth', () => {
    expect(stringFingering('violin1', 69, 69)).toEqual({ handSemi: 1, finger: 0 });
    expect(stringFingering('violin1', 71, 69).finger).toBe(1);
    expect(stringFingering('violin1', 74, 69).finger).toBe(3); // D on the A string
    expect(stringFingering('violin1', 76, 69).finger).toBe(4); // E on the A string
    expect(stringFingering('cello', 52, 50).finger).toBe(1); // E on the D string
    // high notes shift the hand up the neck
    expect(stringFingering('violin1', 81, 69).handSemi).toBeGreaterThan(4);
  });
});
