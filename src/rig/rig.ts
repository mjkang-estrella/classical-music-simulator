import { Bone, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { canonicalName, FINGERS, type CanonBone, type Finger, type Side } from './boneMaps';
import type { HandPose } from './handPose';

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

/** Rotation whose X axis is `x` and whose Y axis is `y` (orthonormalised against x). */
export function frameQuat(x: Vector3, y: Vector3, out: Quaternion): Quaternion {
  const X = _fx.copy(x).normalize();
  const Z = _fz.crossVectors(X, y);
  if (Z.lengthSq() < 1e-10) Z.set(0, 0, 1).cross(X);
  Z.normalize();
  const Y = _fy.crossVectors(Z, X);
  _fm.makeBasis(X, Y, Z);
  return out.setFromRotationMatrix(_fm);
}
const _fx = new Vector3();
const _fy = new Vector3();
const _fz = new Vector3();
const _fm = new Matrix4();

export function worldQuat(obj: Object3D, out: Quaternion): Quaternion {
  _m.extractRotation(obj.matrixWorld);
  return out.setFromRotationMatrix(_m);
}

export function worldPos(obj: Object3D, out: Vector3): Vector3 {
  return out.setFromMatrixPosition(obj.matrixWorld);
}

interface Limb {
  upper: Bone;
  lower: Bone;
  end: Bone;
  l1: number;
  l2: number;
  /** frame^-1 · bindWorldQuat, so worldQuat = frame · r0 */
  r0Upper: Quaternion;
  r0Lower: Quaternion;
}

interface HandInfo {
  bone: Bone;
  forearm: Bone;
  r0: Quaternion;
  /** hand world rotation relative to the forearm in bind pose (a "straight wrist") */
  relBind: Quaternion;
  /** wrist → knuckles distance */
  palm: number;
}

interface FingerChain {
  bones: Bone[];
  /** per-bone local axis: +angle curls toward the palm */
  flex: Vector3[];
  /** first-bone local axis: +angle fans toward the little-finger side */
  spread: Vector3;
  /** thumb only — per-bone local axis: +angle moves across the palm toward the little finger */
  across: Vector3[];
}

interface AxisSet {
  /** root-space X (pitch forward), Y (turn left), Z (roll) expressed in the bone's local frame */
  x: Vector3;
  y: Vector3;
  z: Vector3;
}

export interface RigMeasurements {
  height: number;
  hipHeight: number;
  shoulderHeight: number;
  shoulderWidth: number;
  upperArm: number;
  forearm: number;
  thigh: number;
  shin: number;
  ankleHeight: number;
  headTop: number;
}

/**
 * Bind-pose-agnostic animation layer over a skinned character.
 * Everything is posed from root-space directions, so Rocketbox (A-pose, Biped axes),
 * Mixamo (T-pose) and the placeholder mannequin all work with the same performer code.
 */
export class Rig {
  readonly root: Object3D;
  readonly bones: Partial<Record<CanonBone, Bone>> = {};
  readonly measure: RigMeasurements;
  readonly limbs: Record<'LeftArm' | 'RightArm' | 'LeftLeg' | 'RightLeg', Limb>;
  readonly hands: Record<Side, HandInfo>;
  readonly fingers: Record<Side, Partial<Record<Finger, FingerChain>>>;
  private readonly axes = new Map<Bone, AxisSet>();
  private readonly allBones: Bone[] = [];
  private readonly bindQ: Quaternion[] = [];
  private readonly bindP: Vector3[] = [];
  private readonly hipsParentInv = new Matrix4();
  private readonly footRootQ: Record<Side, Quaternion> = { Left: new Quaternion(), Right: new Quaternion() };
  readonly bindHips = new Vector3();

  /** `root` must be at the origin with identity rotation when constructed. */
  constructor(root: Object3D) {
    this.root = root;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if ((o as Bone).isBone) {
        const b = o as Bone;
        this.allBones.push(b);
        this.bindQ.push(b.quaternion.clone());
        this.bindP.push(b.position.clone());
        const canon = canonicalName(b.name);
        if (canon && !this.bones[canon]) this.bones[canon] = b;
      }
    });
    const missing = (['Hips', 'Spine', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'] as CanonBone[]).filter((b) => !this.bones[b]);
    if (missing.length) throw new Error(`Rig is missing bones: ${missing.join(', ')}`);

    const b = this.bones;
    const p = (bone: Bone | undefined) => (bone ? worldPos(bone, new Vector3()) : new Vector3());
    const fwd = new Vector3(0, 0, 1);

    const headTop = (() => {
      let top = p(b.Head).y + 0.12;
      root.traverse((o) => {
        const mesh = o as { isSkinnedMesh?: boolean; geometry?: { boundingBox: { max: Vector3 } | null; computeBoundingBox(): void } };
        if (mesh.isSkinnedMesh && mesh.geometry) {
          mesh.geometry.computeBoundingBox();
          top = Math.max(top, Math.min(2.2, mesh.geometry.boundingBox!.max.y));
        }
      });
      return top;
    })();

    this.measure = {
      height: headTop,
      hipHeight: p(b.Hips).y,
      shoulderHeight: (p(b.LeftArm).y + p(b.RightArm).y) / 2,
      shoulderWidth: p(b.LeftArm).distanceTo(p(b.RightArm)),
      upperArm: p(b.LeftArm).distanceTo(p(b.LeftForeArm)),
      forearm: p(b.LeftForeArm).distanceTo(p(b.LeftHand)),
      thigh: p(b.LeftUpLeg).distanceTo(p(b.LeftLeg)),
      shin: p(b.LeftLeg).distanceTo(p(b.LeftFoot)),
      ankleHeight: p(b.LeftFoot).y,
      headTop,
    };
    this.bindHips.copy(p(b.Hips));
    this.hipsParentInv.copy(b.Hips!.parent!.matrixWorld).invert();

    const limb = (upper: Bone, lower: Bone, end: Bone, kind: 'arm' | 'leg'): Limb => {
      const s = p(upper);
      const e = p(lower);
      const w = p(end);
      const d1 = e.clone().sub(s).normalize();
      const d2 = w.clone().sub(e).normalize();
      // anatomical hinge axis in bind pose
      let n = new Vector3().crossVectors(d1, d2);
      if (n.length() < 0.08) n = kind === 'arm' ? new Vector3().crossVectors(d1, fwd) : new Vector3().crossVectors(fwd, d1);
      n.normalize();
      const r0Upper = frameQuat(d1, n, new Quaternion()).invert().multiply(worldQuat(upper, new Quaternion()));
      const r0Lower = frameQuat(d2, n, new Quaternion()).invert().multiply(worldQuat(lower, new Quaternion()));
      return { upper, lower, end, l1: s.distanceTo(e), l2: e.distanceTo(w), r0Upper, r0Lower };
    };
    this.limbs = {
      LeftArm: limb(b.LeftArm!, b.LeftForeArm!, b.LeftHand!, 'arm'),
      RightArm: limb(b.RightArm!, b.RightForeArm!, b.RightHand!, 'arm'),
      LeftLeg: limb(b.LeftUpLeg!, b.LeftLeg!, b.LeftFoot!, 'leg'),
      RightLeg: limb(b.RightUpLeg!, b.RightLeg!, b.RightFoot!, 'leg'),
    };

    const hand = (side: Side): HandInfo => {
      const bone = b[`${side}Hand`]!;
      const forearm = b[`${side}ForeArm`]!;
      const wrist = p(bone);
      const mid = b[`${side}HandMiddle1`];
      const idx = b[`${side}HandIndex1`];
      const pinky = b[`${side}HandPinky1`];
      const fore = p(forearm);
      const dir = mid ? p(mid).sub(wrist) : wrist.clone().sub(fore);
      const palmLen = mid ? dir.length() : 0.09;
      dir.normalize();
      let palm: Vector3;
      if (idx && pinky) {
        const across = p(idx).sub(p(pinky));
        palm = side === 'Left' ? new Vector3().crossVectors(dir, across) : new Vector3().crossVectors(across, dir);
      } else {
        palm = new Vector3(0, -1, 0);
      }
      palm.normalize();
      const r0 = frameQuat(dir, palm, new Quaternion()).invert().multiply(worldQuat(bone, new Quaternion()));
      const relBind = worldQuat(forearm, new Quaternion()).invert().multiply(worldQuat(bone, new Quaternion()));
      return { bone, forearm, r0, relBind, palm: palmLen };
    };
    this.hands = { Left: hand('Left'), Right: hand('Right') };

    const fingerChains = (side: Side) => {
      const out: Partial<Record<Finger, FingerChain>> = {};
      const handBone = b[`${side}Hand`]!;
      const hq = worldQuat(handBone, new Quaternion());
      const handFrame = this.hands[side];
      // palm normal, hand direction and the little-finger side, in world space at bind
      const bindFrame = hq.clone().multiply(handFrame.r0.clone().invert());
      const palmN = new Vector3(0, 1, 0).applyQuaternion(bindFrame);
      const handDir = new Vector3(1, 0, 0).applyQuaternion(bindFrame);
      const idx1 = b[`${side}HandIndex1`];
      const pinky1 = b[`${side}HandPinky1`];
      const pinkySide = idx1 && pinky1 ? p(pinky1).sub(p(idx1)).normalize() : new Vector3().crossVectors(palmN, handDir).normalize();
      pinkySide.addScaledVector(handDir, -pinkySide.dot(handDir)).normalize();
      for (const f of FINGERS) {
        const bones = [1, 2, 3].map((i) => b[`${side}Hand${f}${i}` as CanonBone]).filter(Boolean) as Bone[];
        if (!bones.length) continue;
        const segs: Vector3[] = [];
        bones.forEach((bone, i) => {
          const start = p(bone);
          const child = bones[i + 1] ?? (bone.children.find((c) => (c as Bone).isBone) as Bone | undefined);
          let seg = child ? p(child).sub(start) : segs[i - 1]?.clone() ?? (f === 'Thumb' ? p(bone).sub(p(handBone)) : handDir.clone());
          if (seg.lengthSq() < 1e-8) seg = handDir.clone();
          segs.push(seg.normalize());
        });
        const toLocal = (v: Vector3, bone: Bone) => v.clone().applyQuaternion(worldQuat(bone, new Quaternion()).invert()).normalize();
        const flex = bones.map((bone, i) => toLocal(new Vector3().crossVectors(segs[i], palmN), bone));
        const across = bones.map((bone, i) => toLocal(new Vector3().crossVectors(segs[i], pinkySide), bone));
        // spread axis: palm normal, signed so that +angle moves the finger toward the little-finger side
        const spreadW = palmN.clone();
        if (new Vector3().crossVectors(spreadW, segs[0]).dot(pinkySide) < 0) spreadW.negate();
        out[f] = { bones, flex, spread: toLocal(spreadW, bones[0]), across };
      }
      return out;
    };
    this.fingers = { Left: fingerChains('Left'), Right: fingerChains('Right') };

    for (const name of ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'Hips', 'Jaw'] as CanonBone[]) {
      const bone = b[name];
      if (!bone) continue;
      const inv = worldQuat(bone, new Quaternion()).invert();
      this.axes.set(bone, {
        x: new Vector3(1, 0, 0).applyQuaternion(inv),
        y: new Vector3(0, 1, 0).applyQuaternion(inv),
        z: new Vector3(0, 0, 1).applyQuaternion(inv),
      });
    }
    for (const side of ['Left', 'Right'] as Side[]) {
      const foot = b[`${side}Foot`]!;
      this.footRootQ[side].copy(worldQuat(foot, new Quaternion()));
    }
  }

  /** Restores the bind pose (call at the start of every frame). */
  reset(): void {
    for (let i = 0; i < this.allBones.length; i++) {
      this.allBones[i].quaternion.copy(this.bindQ[i]);
      this.allBones[i].position.copy(this.bindP[i]);
    }
  }

  /** Moves the pelvis to a root-space position. */
  setHips(rootPos: Vector3): void {
    const hips = this.bones.Hips!;
    hips.position.copy(rootPos).applyMatrix4(this.hipsParentInv);
  }

  /**
   * Additive rotation of a spine-like bone about root-space axes (radians).
   * pitch > 0 leans forward, yaw > 0 turns to the player's left, roll > 0 tilts to the player's right.
   */
  rotate(name: CanonBone, pitch: number, yaw = 0, roll = 0): void {
    const bone = this.bones[name];
    if (!bone) return;
    const ax = this.axes.get(bone);
    if (!ax) return;
    if (pitch) bone.quaternion.multiply(_q.setFromAxisAngle(ax.x, pitch));
    if (yaw) bone.quaternion.multiply(_q.setFromAxisAngle(ax.y, yaw));
    if (roll) bone.quaternion.multiply(_q.setFromAxisAngle(ax.z, roll));
  }

  update(): void {
    this.root.updateMatrixWorld(true);
  }

  /** World position of a canonical bone (after update()). */
  pos(name: CanonBone, out: Vector3): Vector3 {
    return worldPos(this.bones[name]!, out);
  }

  /**
   * Analytic two-bone IK. `target` is where the end joint (wrist / ankle) should be, `pole` a
   * world-space direction the elbow / knee should point towards. Returns reach ratio (1 = exact).
   */
  solveLimb(which: keyof Rig['limbs'], target: Vector3, pole: Vector3): number {
    const L = this.limbs[which];
    const s = worldPos(L.upper, _v);
    const toT = _v2.copy(target).sub(s);
    const dist = toT.length();
    const reachMax = (L.l1 + L.l2) * 0.999;
    const reachMin = Math.abs(L.l1 - L.l2) * 1.01 + 1e-4;
    const d = Math.min(reachMax, Math.max(reachMin, dist));
    const dir = toT.divideScalar(dist || 1);
    const a = (L.l1 * L.l1 - L.l2 * L.l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L.l1 * L.l1 - a * a));
    const perp = _v3.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0).addScaledVector(dir, dir.y);
    perp.normalize();
    const elbow = _elbow.copy(s).addScaledVector(dir, a).addScaledVector(perp, h);
    const end = _end.copy(s).addScaledVector(dir, d);
    const d1 = _d1.copy(elbow).sub(s).normalize();
    const d2 = _d2.copy(end).sub(elbow).normalize();
    const n = _n.crossVectors(d1, d2);
    if (n.lengthSq() < 1e-6) n.crossVectors(d1, _tmp.copy(perp).negate());
    n.normalize();

    const upperW = frameQuat(d1, n, _qa).multiply(L.r0Upper);
    this.setWorldQuat(L.upper, upperW);
    L.upper.updateMatrixWorld(true);
    const lowerW = frameQuat(d2, n, _qb).multiply(L.r0Lower);
    this.setWorldQuat(L.lower, lowerW);
    L.lower.updateMatrixWorld(true);
    return dist > 0 ? d / dist : 1;
  }

  /**
   * Orients a hand: `dir` = wrist→knuckles, `palm` = out of the palm.
   * Part of the rotation about the forearm axis is taken by the forearm itself (pronation /
   * supination), like a real arm, and the remaining wrist bend is limited to `maxWrist` radians.
   */
  orientHand(side: Side, dir: Vector3, palm: Vector3, twistShare = 0.6, maxWrist = 1.2): void {
    const h = this.hands[side];
    const target = frameQuat(dir, palm, _qa).multiply(h.r0);
    const qFore = worldQuat(h.forearm, _qf);
    const neutral = _qn.copy(qFore).multiply(h.relBind);
    const delta = _qd.copy(target).multiply(_qi.copy(neutral).invert());
    const axis = worldPos(h.bone, _v).sub(worldPos(h.forearm, _v2)).normalize();
    twistAbout(delta, axis, _qt);
    const share = _qs.identity().slerp(_qt, twistShare);
    this.setWorldQuat(h.forearm, _qx.copy(share).multiply(qFore));
    h.forearm.updateMatrixWorld(true);
    // limit the remaining wrist deviation
    worldQuat(h.forearm, _qf);
    _qn.copy(_qf).multiply(h.relBind);
    const rel = _qr.copy(_qn).invert().multiply(target);
    if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w);
    const angle = 2 * Math.acos(Math.min(1, rel.w));
    if (angle > maxWrist) {
      rel.copy(_qs.identity().slerp(rel, maxWrist / angle));
      target.copy(_qn).multiply(rel);
    }
    this.setWorldQuat(h.bone, target);
    h.bone.updateMatrixWorld(true);
  }

  /** Raises (elev) and brings forward (prot) a shoulder girdle, in radians. Updates the arm. */
  shrug(side: Side, elev: number, prot: number): void {
    const name = side === 'Left' ? 'LeftShoulder' : 'RightShoulder';
    const bone = this.bones[name];
    if (!bone) return;
    const sgn = side === 'Left' ? 1 : -1;
    this.rotate(name, 0, -sgn * prot, sgn * elev);
    bone.updateMatrixWorld(true);
  }

  /** Applies a full hand pose (finger joints, spread, thumb) on top of the bind pose. */
  applyHandPose(side: Side, pose: HandPose, weight = 1): void {
    const fingers = this.fingers[side];
    const apply = (chain: FingerChain | undefined, a: readonly number[]) => {
      if (!chain) return;
      for (let i = 0; i < chain.bones.length && i < 3; i++) chain.bones[i].quaternion.multiply(_q2.setFromAxisAngle(chain.flex[i], a[i] * weight));
      if (a[3]) chain.bones[0].quaternion.multiply(_q2.setFromAxisAngle(chain.spread, a[3] * weight));
    };
    apply(fingers.Index, pose.index);
    apply(fingers.Middle, pose.middle);
    apply(fingers.Ring, pose.ring);
    apply(fingers.Pinky, pose.pinky);
    const t = fingers.Thumb;
    if (t) {
      const [oppose, across, mcp, ip] = pose.thumb;
      t.bones[0].quaternion.multiply(_q2.setFromAxisAngle(t.flex[0], oppose * weight));
      t.bones[0].quaternion.multiply(_q2.setFromAxisAngle(t.across[0], across * weight));
      if (t.bones[1]) {
        t.bones[1].quaternion.multiply(_q2.setFromAxisAngle(t.across[1], mcp * 0.7 * weight));
        t.bones[1].quaternion.multiply(_q2.setFromAxisAngle(t.flex[1], mcp * 0.5 * weight));
      }
      if (t.bones[2]) {
        t.bones[2].quaternion.multiply(_q2.setFromAxisAngle(t.across[2], ip * 0.7 * weight));
        t.bones[2].quaternion.multiply(_q2.setFromAxisAngle(t.flex[2], ip * 0.5 * weight));
      }
    }
  }

  /** Keeps a foot at its bind orientation relative to the character root. */
  plantFoot(side: Side): void {
    const foot = this.bones[`${side}Foot`]!;
    const q = worldQuat(this.root, _qa).multiply(this.footRootQ[side]);
    this.setWorldQuat(foot, q);
  }

  /**
   * Curls a finger (0 = straight, 1 ≈ fist) with optional spread (radians).
   * Uses local axes, so no world-matrix updates are required.
   */
  curl(side: Side, finger: Finger, amount: number, spread = 0): void {
    const chain = this.fingers[side][finger];
    if (!chain) return;
    const base = finger === 'Thumb' ? 0.55 : 1.25;
    for (let i = 0; i < chain.bones.length; i++) {
      const w = finger === 'Thumb' ? [0.4, 0.5, 0.6][i] : [0.85, 1.1, 0.8][i];
      chain.bones[i].quaternion.multiply(_q2.setFromAxisAngle(chain.flex[i], amount * base * w));
    }
    if (spread) chain.bones[0].quaternion.multiply(_q2.setFromAxisAngle(chain.spread, spread));
  }

  hasFingers(side: Side): boolean {
    return !!this.fingers[side].Index;
  }

  /** Sets a bone's rotation from a world-space quaternion (parent world matrix must be current). */
  setWorldQuat(bone: Object3D, qWorld: Quaternion): void {
    const parentQ = worldQuat(bone.parent!, _qp).invert();
    bone.quaternion.copy(parentQ.multiply(qWorld));
  }
}

const _qa = new Quaternion();
const _qb = new Quaternion();
const _qp = new Quaternion();
const _qf = new Quaternion();
const _qn = new Quaternion();
const _qd = new Quaternion();
const _qi = new Quaternion();
const _qt = new Quaternion();
const _qs = new Quaternion();
const _qx = new Quaternion();
const _qr = new Quaternion();

/** Twist part of `q` about `axis` (swing–twist decomposition). */
export function twistAbout(q: Quaternion, axis: Vector3, out: Quaternion): Quaternion {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const len = Math.hypot(out.x, out.y, out.z, out.w);
  if (len < 1e-8) return out.identity();
  out.x /= len;
  out.y /= len;
  out.z /= len;
  out.w /= len;
  return out;
}
const _elbow = new Vector3();
const _end = new Vector3();
const _d1 = new Vector3();
const _d2 = new Vector3();
const _n = new Vector3();
const _tmp = new Vector3();
