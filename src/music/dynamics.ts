import { LOUDNESS_RATE, type Note } from './types';

export interface CCEvent {
  time: number;
  /** 0..1 */
  value: number;
}

/** Samples a step-wise controller curve at LOUDNESS_RATE. Missing controller → constant 1. */
export function sampleController(events: CCEvent[] | undefined, frames: number): Float32Array {
  const out = new Float32Array(frames).fill(1);
  if (!events || events.length === 0) return out;
  const sorted = [...events].sort((a, b) => a.time - b.time);
  let j = 0;
  let value = sorted[0].time <= 0 ? sorted[0].value : 1;
  for (let i = 0; i < frames; i++) {
    const t = i / LOUDNESS_RATE;
    while (j < sorted.length && sorted[j].time <= t) value = sorted[j++].value;
    out[i] = value;
  }
  return out;
}

/** CC7 × CC11 with a floor so nothing becomes silent by accident. */
export function expressionCurve(cc7: CCEvent[] | undefined, cc11: CCEvent[] | undefined, frames: number): Float32Array {
  const a = sampleController(cc7, frames);
  const b = sampleController(cc11, frames);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.max(0.05, a[i] * b[i]);
  return out;
}

/** Raw envelope: max(velocity × expression) over sounding notes, 0 when silent. */
export function rawLoudness(notes: Note[], expression: Float32Array, frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (const n of notes) {
    const i0 = Math.max(0, Math.floor(n.start * LOUDNESS_RATE));
    const i1 = Math.min(frames - 1, Math.ceil(n.end * LOUDNESS_RATE));
    for (let i = i0; i <= i1; i++) {
      // decaying emphasis after the attack
      const since = i / LOUDNESS_RATE - n.start;
      const accent = since < 0.12 ? 1 : 0.85;
      const v = n.velocity * expression[i] * accent;
      if (v > out[i]) out[i] = v;
    }
  }
  return out;
}

/** Attack/release smoothing (in-place friendly). */
export function smoothEnvelope(input: Float32Array, attackSec = 0.04, releaseSec = 0.45): Float32Array {
  const out = new Float32Array(input.length);
  const dt = 1 / LOUDNESS_RATE;
  const ka = 1 - Math.exp(-dt / attackSec);
  const kr = 1 - Math.exp(-dt / releaseSec);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    y += (x - y) * (x > y ? ka : kr);
    out[i] = y;
  }
  return out;
}

export function percentile(values: Float32Array, p: number): number {
  const nonZero = Array.from(values).filter((v) => v > 0.001);
  if (!nonZero.length) return 1;
  nonZero.sort((a, b) => a - b);
  return nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))];
}

/** true when velocities are flat and there is no controller data: dynamics must be inferred */
export function lacksDynamics(notes: Note[][], hasControllers: boolean): boolean {
  if (hasControllers) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const list of notes) for (const n of list) {
    if (n.velocity < min) min = n.velocity;
    if (n.velocity > max) max = n.velocity;
  }
  return max - min < 0.08;
}

/**
 * Dynamics heuristic for scores without any: tutti passages and dense writing are loud,
 * thin textures are soft. Returns per-frame 0..1 "orchestral density".
 */
export function tuttiCurve(parts: Note[][], frames: number): Float32Array {
  const counts = new Float32Array(frames);
  for (const notes of parts) {
    const active = new Uint8Array(frames);
    for (const n of notes) {
      const i0 = Math.max(0, Math.floor(n.start * LOUDNESS_RATE));
      const i1 = Math.min(frames - 1, Math.ceil(n.end * LOUDNESS_RATE));
      for (let i = i0; i <= i1; i++) active[i] = 1;
    }
    for (let i = 0; i < frames; i++) counts[i] += active[i];
  }
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = counts[i] / Math.max(1, parts.length);
  return smoothEnvelope(out, 0.3, 1.2);
}
