/**
 * Hand poses: per-joint finger flexion (radians) plus spread and thumb opposition.
 *
 * Finger arrays are [mcp, pip, dip, spread]. Flexion curls toward the palm. Spread fans the
 * finger toward the little-finger side (negative = toward the thumb).
 * Thumb is [oppose, across, mcp, ip]: `oppose` swings it in front of the palm, `across` toward
 * the little finger, and `mcp` / `ip` bend the two outer joints.
 */
export type FingerAngles = [number, number, number, number];
export type ThumbAngles = [number, number, number, number];

export interface HandPose {
  thumb: ThumbAngles;
  index: FingerAngles;
  middle: FingerAngles;
  ring: FingerAngles;
  pinky: FingerAngles;
}

const P = (thumb: ThumbAngles, index: FingerAngles, middle: FingerAngles, ring: FingerAngles, pinky: FingerAngles): HandPose => ({ thumb, index, middle, ring, pinky });

export const POSES = {
  /** relaxed natural hand: a gentle cascade, little finger most curled */
  relaxed: P([0.35, 0.15, 0.2, 0.15], [0.22, 0.35, 0.2, -0.06], [0.28, 0.42, 0.24, 0], [0.34, 0.5, 0.28, 0.05], [0.4, 0.55, 0.3, 0.1]),
  /** resting on the thigh: fingers softly draped */
  rest: P([0.3, 0.1, 0.25, 0.2], [0.35, 0.5, 0.3, -0.04], [0.4, 0.58, 0.32, 0], [0.45, 0.62, 0.34, 0.04], [0.5, 0.66, 0.36, 0.08]),
  /** Franco-Belgian bow hold: index hooks the stick at its middle joint, curved thumb opposite the middle finger, pinky perched on top */
  bowHold: P([0.95, 0.35, 0.45, 0.35], [0.55, 0.85, 0.35, -0.2], [0.55, 1.15, 0.55, -0.04], [0.5, 1.2, 0.6, 0.06], [0.2, 1.0, 0.75, 0.18]),
  /** bow hold at the tip: fingers extend, index presses */
  bowHoldTip: P([0.85, 0.3, 0.3, 0.25], [0.45, 0.6, 0.25, -0.24], [0.45, 0.85, 0.4, -0.04], [0.42, 0.9, 0.45, 0.06], [0.12, 0.55, 0.4, 0.2]),
  /** German-ish cello / bass bow hold: fuller hand around the stick */
  bowHoldLow: P([1.0, 0.4, 0.5, 0.4], [0.7, 1.0, 0.45, -0.14], [0.75, 1.2, 0.6, -0.02], [0.75, 1.25, 0.6, 0.06], [0.6, 1.2, 0.6, 0.14]),
  /** left hand on a fingerboard, fingers arched over the strings, none pressing */
  neckHover: P([1.0, 0.1, 0.25, 0.2], [0.55, 0.95, 0.5, -0.06], [0.55, 1.0, 0.55, 0], [0.55, 1.0, 0.55, 0.05], [0.55, 0.95, 0.5, 0.1]),
  /** a finger pressing the string: rounder, fingertip down */
  neckPress: P([1.0, 0.1, 0.25, 0.2], [0.8, 1.25, 0.65, -0.06], [0.8, 1.3, 0.7, 0], [0.8, 1.3, 0.7, 0.05], [0.8, 1.2, 0.65, 0.1]),
  /** woodwind keys: flat-ish arched fingers with pads on the keys */
  keys: P([1.05, 0.15, 0.3, 0.25], [0.38, 0.62, 0.3, -0.05], [0.4, 0.66, 0.32, 0], [0.42, 0.68, 0.34, 0.04], [0.36, 0.6, 0.32, 0.1]),
  keysPressed: P([1.05, 0.15, 0.3, 0.25], [0.5, 0.82, 0.38, -0.05], [0.52, 0.86, 0.4, 0], [0.54, 0.88, 0.42, 0.04], [0.48, 0.8, 0.4, 0.1]),
  /** flute left hand: tube rests on the index base, fingers arch over the top onto the keys */
  fluteLeft: P([0.9, 0.2, 0.3, 0.25], [0.55, 0.95, 0.45, -0.05], [0.7, 1.05, 0.5, 0], [0.75, 1.1, 0.52, 0.04], [0.7, 1.05, 0.5, 0.1]),
  fluteLeftPressed: P([0.9, 0.2, 0.3, 0.25], [0.7, 1.15, 0.6, -0.05], [0.85, 1.25, 0.62, 0], [0.9, 1.28, 0.64, 0.04], [0.7, 1.05, 0.5, 0.1]),
  /** trumpet right hand: fingertips on the valve caps, little finger in the hook */
  valves: P([0.9, 0.25, 0.25, 0.2], [0.35, 0.7, 0.4, -0.02], [0.38, 0.72, 0.42, 0], [0.4, 0.74, 0.44, 0.02], [0.55, 1.0, 0.6, 0.12]),
  valvesPressed: P([0.9, 0.25, 0.25, 0.2], [0.55, 0.95, 0.5, -0.02], [0.58, 0.98, 0.52, 0], [0.6, 1.0, 0.54, 0.02], [0.55, 1.0, 0.6, 0.12]),
  /** wrapping a tube or casing (trumpet / trombone left hand, cymbal straps) */
  wrap: P([1.1, 0.45, 0.4, 0.35], [0.95, 1.2, 0.6, -0.04], [1.0, 1.25, 0.62, 0], [1.02, 1.28, 0.64, 0.04], [1.05, 1.3, 0.64, 0.08]),
  /** holding a mallet / drumstick: thumb along the stick, index guiding, back fingers wrapped */
  stick: P([0.75, 0.2, 0.35, 0.2], [0.7, 0.95, 0.45, -0.08], [0.95, 1.25, 0.6, 0], [1.05, 1.3, 0.62, 0.04], [1.1, 1.3, 0.62, 0.08]),
  /** conductor baton: thumb pad on the baton, index curved over it, others softly closed */
  baton: P([0.9, 0.3, 0.35, 0.25], [0.4, 0.75, 0.35, -0.1], [0.75, 1.15, 0.55, 0], [0.9, 1.25, 0.6, 0.06], [1.0, 1.3, 0.62, 0.12]),
  /** conductor's open expressive left hand */
  open: P([0.25, 0.05, 0.1, 0.05], [0.08, 0.14, 0.08, -0.12], [0.1, 0.16, 0.1, 0], [0.14, 0.2, 0.12, 0.1], [0.18, 0.24, 0.14, 0.2]),
  /** pointing cue: index extended */
  point: P([0.8, 0.5, 0.35, 0.3], [0.05, 0.08, 0.04, -0.05], [1.0, 1.4, 0.7, 0], [1.1, 1.45, 0.72, 0.05], [1.15, 1.45, 0.72, 0.1]),
  /** harp: fingers curled into the palm after plucking */
  pluck: P([0.6, 0.2, 0.35, 0.3], [0.85, 1.1, 0.5, -0.06], [0.9, 1.15, 0.55, 0], [0.95, 1.2, 0.58, 0.05], [0.8, 1.1, 0.55, 0.1]),
} satisfies Record<string, HandPose>;

export type PoseName = keyof typeof POSES;

const FINGER_KEYS = ['index', 'middle', 'ring', 'pinky'] as const;

/** out = a·(1−t) + b·t */
export function blendPose(a: HandPose, b: HandPose, t: number, out: HandPose = clonePose(a)): HandPose {
  for (let i = 0; i < 4; i++) out.thumb[i] = a.thumb[i] + (b.thumb[i] - a.thumb[i]) * t;
  for (const k of FINGER_KEYS) for (let i = 0; i < 4; i++) out[k][i] = a[k][i] + (b[k][i] - a[k][i]) * t;
  return out;
}

export function clonePose(p: HandPose): HandPose {
  return { thumb: [...p.thumb], index: [...p.index], middle: [...p.middle], ring: [...p.ring], pinky: [...p.pinky] };
}

/** Blend a single finger toward another pose (e.g. one finger pressing a string). */
export function blendFinger(out: HandPose, finger: (typeof FINGER_KEYS)[number], target: HandPose, t: number) {
  for (let i = 0; i < 4; i++) out[finger][i] += (target[finger][i] - out[finger][i]) * t;
}

/** Small per-musician, per-moment variation so no two hands are identical. */
export function jitterPose(p: HandPose, seed: number, amount = 0.06): HandPose {
  const r = (k: number) => {
    const x = Math.sin((seed * 91.7 + k * 12.3) * 43.1) * 1e4;
    return (x - Math.floor(x)) * 2 - 1;
  };
  let k = 0;
  for (const f of FINGER_KEYS) for (let i = 0; i < 3; i++) p[f][i] += r(k++) * amount;
  for (let i = 0; i < 4; i++) p.thumb[i] += r(k++) * amount * 0.6;
  return p;
}

export const FINGERS_ORDER = FINGER_KEYS;
