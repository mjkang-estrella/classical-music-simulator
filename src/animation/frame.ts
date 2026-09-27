import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Beat, Note } from '../music/types';
import type { Indexes, Plans } from './plans';

/** Everything performers need for one rendered frame. Computed once, shared by all actors. */
export interface FrameState {
  /** song time (latency compensated) */
  t: number;
  /** wall-clock seconds, for breathing / idle motion that continues while paused */
  wall: number;
  dt: number;
  playing: boolean;
  /** true once a piece is loaded */
  loaded: boolean;
  plans: Plans;
  indexes: Indexes;
  active: Map<string, Note[]>;
  loud: Map<string, number>;
  beats: Beat[];
  camera: Vector3;
  /** time of the first note in the piece */
  firstNote: number;
  /** current conducted beat: index into beats (-1 before the first), phase 0..1 within it */
  beatIndex: number;
  beatPhase: number;
  /** seconds since the most recent downbeat (Infinity if none) */
  sinceDownbeat: number;
  /** true when song time jumped (seek / load): smoothed values should snap */
  jumped: boolean;
}

/** Orthonormal frame helper (origin + axes). */
export class Basis {
  readonly o = new Vector3();
  readonly x = new Vector3(1, 0, 0);
  readonly y = new Vector3(0, 1, 0);
  readonly z = new Vector3(0, 0, 1);
  readonly q = new Quaternion();

  point(lx: number, ly: number, lz: number, out: Vector3): Vector3 {
    return out.copy(this.o).addScaledVector(this.x, lx).addScaledVector(this.y, ly).addScaledVector(this.z, lz);
  }

  dir(lx: number, ly: number, lz: number, out: Vector3): Vector3 {
    return out.set(0, 0, 0).addScaledVector(this.x, lx).addScaledVector(this.y, ly).addScaledVector(this.z, lz).normalize();
  }

  /** Builds x/y/z from a forward-ish z and an up-ish y (z wins). */
  fromZY(z: Vector3, y: Vector3): this {
    this.z.copy(z).normalize();
    this.x.crossVectors(y, this.z).normalize();
    this.y.crossVectors(this.z, this.x);
    this.syncQ();
    return this;
  }

  syncQ(): this {
    _m.makeBasis(this.x, this.y, this.z);
    this.q.setFromRotationMatrix(_m);
    return this;
  }
}

const _m = new Matrix4();

/** Deterministic smooth noise in [-1, 1]. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
