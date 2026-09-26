import { CapsuleGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { createCharacter, type CharacterInstance } from '../assets/characterFactory';
import { createInstrument } from '../assets/instrumentFactory';
import type { Grip, InstrumentModel } from '../assets/instruments/types';
import { loudnessAt } from '../music/midiLoader';
import type { Note } from '../music/types';
import type { Musician } from '../orchestra/ensemble';
import { SECTIONS, type InstrumentKind } from '../orchestra/sections';
import type { Rig } from '../rig/rig';
import { Basis, clamp01, damp, noise1, type FrameState } from './frame';
import { bowAt, raiseAmount, smooth, sortedSearch, stickHeight, stringFor, type PartPlan } from './plans';

const V = () => new Vector3();
const _a = V();
const _b = V();
const _c = V();
const _d = V();
const _e = V();
const _pole = V();
const _q = new Quaternion();
const _q2 = new Quaternion();
const UP = new Vector3(0, 1, 0);

export type ActorKind = InstrumentKind | 'conductor';

interface Smoothed {
  raise: number;
  lean: number;
  loud: number;
  bowLift: number;
  lookYaw: number;
  lookPitch: number;
  vib: number;
  cue: number;
  cueYaw: number;
  arms: number;
}

/** One performer on stage: character + instrument + the logic that animates them from the score. */
export class Actor {
  readonly musician: Musician | null;
  readonly kind: ActorKind;
  readonly char: CharacterInstance;
  readonly rig: Rig;
  readonly inst: InstrumentModel | null;
  readonly root: Object3D;
  /** world-space container for the instrument objects */
  readonly props = new Group();
  readonly collider: Mesh;
  readonly scale: number;
  readonly seatTop: number;
  readonly standing: boolean;
  readonly jitter: number;
  readonly seed: number;
  readonly torso = new Basis();
  private readonly s: Smoothed = { raise: 0, lean: 0, loud: 0, bowLift: 0, lookYaw: 0, lookPitch: 0, vib: 0, cue: 0, cueYaw: 0, arms: 0 };
  private notes: Note[] = [];
  private lastWall = 0;
  /** camera distance, used for level of detail */
  distance = 10;
  highlighted = true;

  constructor(musician: Musician | null, pos: Vector3, yaw: number, kind: ActorKind, seatKind: 'chair' | 'stool' | 'standing') {
    this.musician = musician;
    this.kind = kind;
    this.seed = musician?.seed ?? 0.5;
    const section = musician?.section ?? 'conductor';
    this.char = createCharacter(this.seed, section, kind === 'conductor');
    this.rig = this.char.rig;
    this.root = this.char.root;
    this.root.position.copy(pos);
    this.root.rotation.set(0, yaw, 0);
    this.root.updateMatrixWorld(true);
    this.scale = this.rig.measure.height / 1.75;
    this.standing = seatKind === 'standing';
    this.seatTop = seatKind === 'stool' ? 0.765 : seatKind === 'chair' ? 0.485 : 0;
    const family = musician ? SECTIONS[musician.section].family : 'strings';
    this.jitter = musician && musician.index > 0 ? (this.seed - 0.5) * (family === 'strings' ? 0.03 : 0.012) : 0;

    this.inst = kind === 'conductor' ? null : createInstrument(kind, section);
    if (this.inst) {
      this.props.add(this.inst.root);
      if (this.inst.bow) this.props.add(this.inst.bow);
      for (const h of Object.values(this.inst.held ?? {})) if (h) this.props.add(h);
      if (this.inst.floor || kind === 'harp') {
        this.inst.root.position.copy(pos);
        this.inst.root.rotation.set(0, yaw, 0);
      }
    }
    if (kind === 'conductor') this.props.add(buildBaton());

    const height = this.standing ? this.rig.measure.height : this.seatTop + this.rig.measure.height * 0.52;
    const geo = new CapsuleGeometry(this.standing ? 0.3 : 0.36, Math.max(0.2, height - 0.6), 4, 8);
    this.collider = new Mesh(geo, new MeshBasicMaterial());
    this.collider.visible = false;
    this.collider.position.set(0, height / 2 + 0.05, this.standing ? 0 : 0.12);
    this.collider.userData.actor = this;
    this.root.add(this.collider);
  }

  /** Point in the character's root frame → world. */
  private rp(x: number, y: number, z: number, out: Vector3): Vector3 {
    return out.set(x, y, z).applyMatrix4(this.root.matrixWorld);
  }

  /** Direction in the root frame → world. */
  private rd(x: number, y: number, z: number, out: Vector3): Vector3 {
    return out.set(x, y, z).applyQuaternion(this.root.quaternion).normalize();
  }

  /** Main per-frame update. */
  update(f: FrameState): void {
    const dt = Math.min(0.1, Math.max(0.001, f.wall - this.lastWall));
    this.lastWall = f.wall;
    const t = f.t + this.jitter;
    this.gatherNotes(f);
    const loud = this.loudness(f, t);
    this.s.loud = damp(this.s.loud, loud, 6, dt);

    const rig = this.rig;
    rig.reset();
    switch (this.kind) {
      case 'violin':
      case 'viola':
        this.bowedUpper(f, t, dt);
        break;
      case 'cello':
      case 'bass':
        this.bowedLower(f, t, dt);
        break;
      case 'flute':
      case 'piccolo':
      case 'oboe':
      case 'clarinet':
      case 'bassoon':
      case 'trumpet':
      case 'horn':
      case 'trombone':
      case 'tuba':
        this.wind(f, t, dt);
        break;
      case 'timpani':
      case 'snare':
      case 'suspended':
        this.sticks(f, t, dt);
        break;
      case 'bassdrum':
        this.bassDrum(f, t, dt);
        break;
      case 'cymbals':
        this.cymbals(f, t, dt);
        break;
      case 'triangle':
        this.triangle(f, t, dt);
        break;
      case 'harp':
        this.harp(f, t, dt);
        break;
      case 'conductor':
        this.conductor(f, t, dt);
        break;
    }
  }

  // ------------------------------------------------------------------ helpers

  private gatherNotes(f: FrameState) {
    const m = this.musician;
    this.notes.length = 0;
    if (!m) return;
    const all: Note[] = [];
    for (const id of m.partIds) {
      const act = f.active.get(id);
      if (act) for (const n of act) if (!m.drum || n.drum === m.drum) all.push(n);
    }
    if (all.length <= 1 || m.voices <= 1) {
      this.notes.push(...all);
      if (all.length === 1 && m.voices > 1 && m.voice > 0 && SECTIONS[m.section].family !== 'strings' && this.s.loud < 0.55) this.notes.length = 0;
      return;
    }
    all.sort((a, b) => b.pitch - a.pitch);
    const idx = Math.min(all.length - 1, Math.round((m.voice * (all.length - 1)) / Math.max(1, m.voices - 1)));
    this.notes.push(all[idx]);
  }

  private loudness(f: FrameState, t: number): number {
    const m = this.musician;
    if (!m) {
      let max = 0;
      for (const v of f.loud.values()) max = Math.max(max, v);
      return max;
    }
    let max = 0;
    for (const id of m.partIds) {
      const plan = f.plans.get(id);
      if (plan) max = Math.max(max, loudnessAt(plan.part.loudness, t));
    }
    return max;
  }

  private plan(f: FrameState): PartPlan | undefined {
    const id = this.musician?.partIds[0];
    return id ? f.plans.get(id) : undefined;
  }

  /** Common seated/standing posture: hips, spine lean & sway, head. Ends with rig.update(). */
  private posture(f: FrameState, o: { lean?: number; twist?: number; roll?: number; headPitch?: number; headYaw?: number; headRoll?: number; kneesApart?: number; feetForward?: number }) {
    const rig = this.rig;
    const b = rig.bindHips;
    const breath = Math.sin(f.wall * (1.6 + this.seed * 0.5) + this.seed * 20) * 0.5 + 0.5;
    const sway = noise1(f.wall * 0.35 + this.seed * 13) * (0.012 + 0.05 * this.s.loud) + noise1(f.t * 0.7 + this.seed * 7) * 0.03 * this.s.loud;
    if (!this.standing) {
      rig.setHips(_b.set(b.x, this.seatTop + 0.1 + (b.y - rig.measure.hipHeight), -0.05));
    } else {
      rig.setHips(_b.set(b.x, b.y - 0.012 - 0.01 * this.s.loud, b.z));
    }
    const lean = (o.lean ?? 0.06) + this.s.lean;
    rig.rotate('Spine', lean * 0.35 - breath * 0.012, (o.twist ?? 0) * 0.3, sway * 0.4 + (o.roll ?? 0) * 0.3);
    rig.rotate('Spine1', lean * 0.35, (o.twist ?? 0) * 0.35, sway * 0.4 + (o.roll ?? 0) * 0.35);
    rig.rotate('Spine2', lean * 0.3 - breath * 0.02, (o.twist ?? 0) * 0.35, sway * 0.2 + (o.roll ?? 0) * 0.35);
    rig.rotate('Neck', (o.headPitch ?? 0) * 0.4, (o.headYaw ?? 0) * 0.4, (o.headRoll ?? 0) * 0.4);
    rig.rotate('Head', (o.headPitch ?? 0) * 0.6 + sway * 0.3, (o.headYaw ?? 0) * 0.6, (o.headRoll ?? 0) * 0.6);
    rig.update();
    if (!this.standing) this.seatLegs(o.kneesApart ?? 1, o.feetForward ?? 0);
    this.computeTorso();
  }

  private seatLegs(apart: number, forward: number) {
    const rig = this.rig;
    for (const side of ['Left', 'Right'] as const) {
      const hip = rig.pos(`${side}UpLeg`, _a);
      const local = _b.copy(hip).applyMatrix4(_tmpInv.copy(this.root.matrixWorld).invert());
      const x = local.x * (1.25 + 0.9 * (apart - 1)) + (side === 'Left' ? 0.02 : -0.02) * apart;
      const drop = local.y - rig.measure.ankleHeight;
      const reach = Math.sqrt(Math.max(0.01, (rig.measure.thigh + rig.measure.shin) ** 2 * 0.92 - drop * drop));
      const z = local.z + Math.min(reach, rig.measure.thigh * 0.98 + 0.06 + forward);
      const target = this.rp(x, rig.measure.ankleHeight, z, _c);
      rig.solveLimb(`${side}Leg`, target, this.rd(0.1 * (side === 'Left' ? 1 : -1), 0.1, 1, _pole));
      rig.plantFoot(side);
      rig.bones[`${side}Foot`]!.updateMatrixWorld(true);
    }
  }

  private computeTorso() {
    const rig = this.rig;
    const L = rig.pos('LeftArm', _a);
    const R = rig.pos('RightArm', _b);
    const T = this.torso;
    T.o.copy(L).add(R).multiplyScalar(0.5);
    T.x.copy(L).sub(R).normalize();
    const neck = rig.pos(rig.bones.Neck ? 'Neck' : 'Head', _c);
    const spine = rig.pos(rig.bones.Spine1 ? 'Spine1' : 'Spine', _d);
    const up = neck.sub(spine).normalize();
    up.addScaledVector(T.x, -up.dot(T.x)).normalize();
    T.y.copy(up);
    T.z.crossVectors(T.x, T.y).normalize();
    T.syncQ();
  }

  private mouth(out: Vector3): Vector3 {
    const head = this.rig.pos('Head', out);
    return head.addScaledVector(this.torso.y, 0.035 * this.scale).addScaledVector(this.torso.z, 0.105 * this.scale);
  }

  /** Places an instrument (or held object) so that local point `anchor` lands on `target` with rotation q. */
  private place(obj: Object3D, anchorLocal: Vector3, target: Vector3, q: Quaternion) {
    obj.quaternion.copy(q);
    obj.position.copy(target).sub(_e.copy(anchorLocal).applyQuaternion(q));
    obj.updateMatrixWorld(true);
  }

  /** Solves an arm onto a grip (palm centre, finger dir, palm normal) and curls the fingers. */
  private hold(side: 'Left' | 'Right', center: Vector3, dir: Vector3, palm: Vector3, pole: Vector3, curl: number, thumb = curl, spread = 0) {
    const rig = this.rig;
    const palmLen = rig.hands[side].palm;
    const wrist = _d.copy(center).addScaledVector(dir, -palmLen * 0.55).addScaledVector(palm, -0.022 * this.scale);
    rig.solveLimb(side === 'Left' ? 'LeftArm' : 'RightArm', wrist, pole);
    rig.orientHand(side, dir, palm);
    this.curlHand(side, curl, thumb, spread);
  }

  private curlHand(side: 'Left' | 'Right', curl: number, thumb = curl, spread = 0, per?: number[]) {
    const rig = this.rig;
    if (!rig.hasFingers(side) || this.distance > 14) return;
    rig.curl(side, 'Thumb', thumb);
    rig.curl(side, 'Index', per?.[0] ?? curl, spread);
    rig.curl(side, 'Middle', per?.[1] ?? curl);
    rig.curl(side, 'Ring', per?.[2] ?? curl, -spread * 0.5);
    rig.curl(side, 'Pinky', per?.[3] ?? curl * 1.05, -spread);
  }

  /** Grip defined on an object → world palm centre / dir / palm. */
  private gripWorld(g: Grip, holder: Object3D, center: Vector3, dir: Vector3, palm: Vector3) {
    holder.updateMatrixWorld(true);
    g.anchor.getWorldPosition(center);
    holder.getWorldQuaternion(_q2);
    dir.copy(g.dir).applyQuaternion(_q2);
    palm.copy(g.palm).applyQuaternion(_q2);
  }

  private holdGrip(side: 'L' | 'R', holder: Object3D, pole: Vector3, curlBoost = 0) {
    const g = this.inst?.grips[side];
    if (!g) return;
    const center = V();
    const dir = V();
    const palm = V();
    this.gripWorld(g, holder, center, dir, palm);
    this.hold(side === 'L' ? 'Left' : 'Right', center, dir, palm, pole, clamp01(g.curl + curlBoost), g.thumbCurl ?? g.curl);
  }

  // ------------------------------------------------------------------ bowed strings

  private bowedUpper(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const spec = inst.bowed!;
    const plan = this.plan(f);
    const target = plan ? raiseAmount(plan.phrases, t, 1.6, 2.5, 1.2) : 0;
    this.s.raise = damp(this.s.raise, target, 5, dt);
    const r = smooth(this.s.raise);
    this.posture(f, {
      lean: 0.08 + 0.05 * this.s.loud,
      twist: 0.12 * r,
      headPitch: 0.1 + 0.12 * r,
      headYaw: 0.28 * r,
      headRoll: 0.22 * r,
    });
    const T = this.torso;
    const s = this.scale;

    // --- instrument transform: play (on the collarbone) ↔ rest (on the knee)
    const zPlay = T.dir(0.62, -0.16, 0.77, V());
    const yPlay = T.dir(0, 1, -0.05, V());
    const basis = new Basis().fromZY(zPlay, yPlay);
    // roll the top towards the player's right
    _q.setFromAxisAngle(basis.z, 0.3);
    const qPlay = basis.q.clone().premultiply(_q);
    const chin = T.point(0.06 * s, 0.11 * s, 0.06 * s, V());
    const restBasis = new Basis().fromZY(this.rd(0.35, 0.9, 0.35, V()), this.rd(-0.1, 0, 1, V()));
    const restPos = this.rp(0.13 * s, this.seatTop + 0.12, 0.3, V());
    const qInst = _q2.copy(restBasis.q).slerp(qPlay, r);
    const anchorLocal = inst.anchors.chinrest.position;
    const pos = restPos.lerp(chin, r);
    this.place(inst.root, anchorLocal, pos, qInst);

    // --- bow
    const bow = inst.bow!;
    const bs = plan?.strokes?.length ? bowAt(plan, t) : { s: 0.3, stroke: null, sounding: false, speed: 0 };
    const pitch = this.notes[0]?.pitch ?? bs.stroke?.pitch ?? 67;
    const stringIdx = this.notes[0] ? stringFor(this.musician!.section, pitch) : bs.stroke?.string ?? 2;
    this.s.bowLift = damp(this.s.bowLift, bs.sounding || this.notes.length ? 0 : 1, 12, dt);
    this.placeBow(inst, spec, stringIdx, bs.s, this.s.bowLift * 0.03 + (1 - r) * 0.25, r, dt);

    // --- right hand on the frog
    const frog = V();
    bow.getWorldPosition(frog);
    const bq = bow.getWorldQuaternion(new Quaternion());
    const bx = V().set(1, 0, 0).applyQuaternion(bq);
    const by = V().set(0, 1, 0).applyQuaternion(bq);
    const bz = V().set(0, 0, 1).applyQuaternion(bq);
    const center = frog.clone().addScaledVector(by, 0.018 * s).addScaledVector(bz, 0.035);
    const dir = V().addScaledVector(bx, -0.75).addScaledVector(bz, 0.45).addScaledVector(by, -0.35).normalize();
    const palm = V().addScaledVector(by, -1).addScaledVector(bx, -0.35).normalize();
    this.hold('Right', center, dir, palm, this.rd(-0.9, -0.6, -0.3, V()), 0.55, 0.45);

    // --- left hand on the neck
    this.leftHandOnNeck(inst, spec, pitch, stringIdx, f, t, dt, r, 'upper');
  }

  private placeBow(inst: InstrumentModel, spec: NonNullable<InstrumentModel['bowed']>, k: number, sPos: number, lift: number, r: number, _dt: number) {
    const bow = inst.bow!;
    const instQ = inst.root.getWorldQuaternion(new Quaternion());
    const contact = inst.anchors[`string_${k}`].getWorldPosition(V());
    const xs = inst.anchors[`string_${k}`].position.x;
    // tangent of the bridge arch at this string, frog on the player's right
    const dirLocal = V().set(spec.frogSide * spec.arch, -spec.frogSide * xs * 1.2, 0).normalize();
    // bow leans slightly towards the fingerboard
    dirLocal.z -= 0.08 * spec.frogSide;
    dirLocal.normalize();
    const bz = dirLocal.applyQuaternion(instQ);
    const archNormal = V().set(xs * 1.2, spec.arch, 0).normalize().applyQuaternion(instQ);
    const basis = new Basis().fromZY(bz, archNormal);
    const along = spec.hairStart + sPos * (spec.hairEnd - spec.hairStart);
    const frog = contact.clone().addScaledVector(basis.y, spec.hairGap + 0.0015 + lift).addScaledVector(basis.z, -along);
    if (r < 1) {
      // resting: bow held on the right thigh, pointing forward and down
      const restFrog = this.rp(-0.2 * this.scale, this.seatTop + 0.16, 0.18, V());
      const restB = new Basis().fromZY(this.rd(0.15, -0.3, 1, V()), this.rd(0, 1, 0, V()));
      frog.lerp(restFrog, 1 - r);
      basis.q.slerp(restB.q, 1 - r);
    }
    bow.position.copy(frog);
    bow.quaternion.copy(basis.q);
    bow.updateMatrixWorld(true);
  }

  private leftHandOnNeck(inst: InstrumentModel, spec: NonNullable<InstrumentModel['bowed']>, pitch: number, k: number, f: FrameState, t: number, dt: number, r: number, kind: 'upper' | 'lower') {
    const open = SECTIONS[this.musician!.section].strings ?? [55, 62, 69, 76];
    const semis = Math.max(0, pitch - open[k]);
    const handSemi = Math.max(0, semis - 3);
    const L = spec.nutZ - spec.bridgeZ;
    const fingerDist = L * (1 - Math.pow(2, -handSemi / 12));
    const vibrato = this.notes.length && this.notes[0].end - this.notes[0].start > 0.3 ? Math.sin(f.wall * 34 + this.seed * 9) * 0.004 * spec.scale ** 0.5 : 0;
    this.s.vib = damp(this.s.vib, vibrato, 20, dt);
    const z = spec.nutZ - 0.03 * spec.scale ** 0.7 - fingerDist + this.s.vib;
    const a = inst.anchors.left_hand;
    const sc = spec.scale;
    const q = inst.root.getWorldQuaternion(new Quaternion());
    let center: Vector3;
    let dir: Vector3;
    let palm: Vector3;
    let pole: Vector3;
    if (kind === 'upper') {
      a.position.set(0.02 * sc, spec.nutY - 0.028 * sc, z);
      center = a.getWorldPosition(V());
      dir = V().set(-0.45, 0.8, 0.35).normalize().applyQuaternion(q);
      palm = V().set(-0.85, 0.15, -0.35).normalize().applyQuaternion(q);
      pole = this.rd(-0.2, -1, -0.1, V());
    } else {
      a.position.set(-0.035 * sc ** 0.5, spec.nutY - 0.03 * sc ** 0.5, z);
      center = a.getWorldPosition(V());
      dir = V().set(0.85, 0.35, 0.1).normalize().applyQuaternion(q);
      palm = V().set(0.2, 1, 0).normalize().applyQuaternion(q);
      pole = this.rd(0.9, 0.3, -0.2, V());
    }
    if (r < 1) {
      // hand drops to the instrument's shoulder when resting
      const heel = inst.anchors.neck_heel.getWorldPosition(V());
      center.lerp(heel.addScaledVector(palm, -0.03), (1 - r) * 0.6);
    }
    const finger = Math.min(3, Math.max(0, semis - handSemi - 1));
    const pressed = this.notes.length > 0;
    const per = [0, 1, 2, 3].map((i) => (pressed && i <= finger ? 0.75 : 0.5));
    void t;
    this.hold('Left', center, dir, palm, pole, 0.55, 0.35);
    this.curlHand('Left', 0.55, 0.3, 0, per);
  }

  private bowedLower(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const spec = inst.bowed!;
    const plan = this.plan(f);
    const isBass = this.kind === 'bass';
    const target = plan ? raiseAmount(plan.phrases, t, 1.5, 3, 1.2) : 0;
    this.s.raise = damp(this.s.raise, target, 4, dt);
    const r = smooth(this.s.raise);
    this.posture(f, { lean: 0.1 + 0.08 * this.s.loud, headPitch: 0.12, headYaw: isBass ? 0.25 : 0.2, headRoll: -0.08, kneesApart: isBass ? 1.3 : 2.1, feetForward: isBass ? 0.05 : 0.02 });
    const s = this.scale;
    // endpin on the floor, instrument leaning back onto the player
    const endpin = isBass ? this.rp(0.14 * s, -0.12, 0.5, V()) : this.rp(0.02, -0.1, 0.66 * s, V());
    const axis = isBass ? this.rd(0.25, 0.94, -0.3, V()) : this.rd(0.14, 0.86, -0.5, V());
    const lean = noise1(f.wall * 0.3 + this.seed * 5) * 0.02 + this.s.loud * 0.03;
    axis.addScaledVector(this.torso.x, lean).normalize();
    const face = isBass ? this.rd(-0.35, 0.3, 0.9, V()) : this.rd(-0.28, 0.42, 0.86, V());
    const basis = new Basis().fromZY(axis, face);
    this.place(inst.root, inst.anchors.endpin.position, endpin, basis.q);

    const bs = plan?.strokes?.length ? bowAt(plan, t) : { s: 0.3, stroke: null, sounding: false, speed: 0 };
    const pitch = this.notes[0]?.pitch ?? bs.stroke?.pitch ?? (isBass ? 40 : 50);
    const k = this.notes[0] ? stringFor(this.musician!.section, pitch) : bs.stroke?.string ?? 1;
    this.s.bowLift = damp(this.s.bowLift, bs.sounding || this.notes.length ? 0 : 1, 12, dt);
    this.placeBowLower(inst, spec, k, bs.s, this.s.bowLift * 0.04, r);

    const bow = inst.bow!;
    const frog = bow.getWorldPosition(V());
    const bq = bow.getWorldQuaternion(new Quaternion());
    const bx = V().set(1, 0, 0).applyQuaternion(bq);
    const by = V().set(0, 1, 0).applyQuaternion(bq);
    const bz = V().set(0, 0, 1).applyQuaternion(bq);
    const center = frog.clone().addScaledVector(by, 0.02).addScaledVector(bz, 0.03);
    const dir = V().addScaledVector(by, -0.55).addScaledVector(bx, 0.6).addScaledVector(bz, 0.35).normalize();
    const palm = V().addScaledVector(bx, 0.6).addScaledVector(by, -0.6).normalize();
    this.hold('Right', center, dir, palm, this.rd(-1, -0.5, -0.3, V()), 0.55, 0.45);
    this.leftHandOnNeck(inst, spec, pitch, k, f, t, dt, 1, 'lower');
  }

  private placeBowLower(inst: InstrumentModel, spec: NonNullable<InstrumentModel['bowed']>, k: number, sPos: number, lift: number, r: number) {
    const bow = inst.bow!;
    const instQ = inst.root.getWorldQuaternion(new Quaternion());
    const contact = inst.anchors[`string_${k}`].getWorldPosition(V());
    const xs = inst.anchors[`string_${k}`].position.x;
    const dirLocal = V().set(spec.frogSide * spec.arch, -spec.frogSide * xs * 1.2, 0.05).normalize();
    const bz = dirLocal.applyQuaternion(instQ);
    const archNormal = V().set(xs * 1.2, spec.arch, 0).normalize().applyQuaternion(instQ);
    const basis = new Basis().fromZY(bz, archNormal);
    const along = spec.hairStart + sPos * (spec.hairEnd - spec.hairStart);
    const frog = contact.clone().addScaledVector(basis.y, spec.hairGap + 0.002 + lift).addScaledVector(basis.z, -along);
    if (r < 1) {
      const restFrog = this.rp(-0.25, this.seatTop + 0.2, 0.25, V());
      frog.lerp(restFrog, 1 - r);
    }
    bow.position.copy(frog);
    bow.quaternion.copy(basis.q);
    bow.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ winds & brass

  private wind(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const brass = SECTIONS[this.musician!.section].family === 'brass';
    const target = plan ? raiseAmount(plan.phrases, t, brass ? 1.2 : 1.1, brass ? 1.4 : 1.1, 1.1) : 0;
    this.s.raise = damp(this.s.raise, target, 5, dt);
    const r = smooth(this.s.raise);
    const kind = this.kind;
    // breathing: inhale in the gap before a note
    let inhale = 0;
    if (plan) {
      const idx = f.indexes.get(plan.part.id);
      const next = idx?.nextOnset(t);
      const lastEnd = idx?.lastEndBefore(t) ?? -Infinity;
      if (next && t > lastEnd) {
        const gap = next.start - lastEnd;
        const u = (t - lastEnd) / Math.max(0.05, gap);
        if (gap > 0.2) inhale = Math.sin(Math.PI * Math.min(1, u)) * Math.min(1, gap / 0.8);
      }
    }
    const playing = this.notes.length > 0 ? 1 : 0;
    this.posture(f, {
      lean: 0.06 + 0.06 * this.s.loud * r - inhale * 0.05,
      headPitch: (kind === 'trombone' ? -0.04 : kind === 'oboe' || kind === 'clarinet' ? 0.08 : 0.02) * r + 0.05 * (1 - r),
      headYaw: kind === 'flute' || kind === 'piccolo' ? 0.2 * r : 0,
      headRoll: kind === 'flute' || kind === 'piccolo' ? -0.08 * r : 0,
      kneesApart: kind === 'tuba' ? 1.6 : 1,
    });
    const T = this.torso;
    const s = this.scale;
    const mouth = this.mouth(V());
    const bellUp = (this.s.loud - 0.4) * 0.25 * r;

    let qPlay: Quaternion;
    let playPos = mouth.clone();
    let qRest: Quaternion;
    let restPos: Vector3;
    switch (kind) {
      case 'flute':
      case 'piccolo': {
        const b = new Basis().fromZY(T.dir(-0.94, -0.16, 0.3, V()), T.dir(0, 1, 0.05, V()));
        _q.setFromAxisAngle(b.z, -0.25);
        qPlay = b.q.clone().premultiply(_q);
        playPos = mouth.addScaledVector(T.y, -0.012).addScaledVector(T.z, 0.008);
        qRest = new Basis().fromZY(this.rd(-1, 0, 0.15, V()), this.rd(0, 1, 0, V())).q.clone();
        restPos = this.rp(0.24 * s, this.seatTop + 0.17, 0.3, V());
        break;
      }
      case 'oboe':
      case 'clarinet': {
        const down = kind === 'clarinet' ? 0.7 : 0.8;
        const b = new Basis().fromZY(T.dir(0, -down, Math.sqrt(1 - down * down) + bellUp, V()), T.dir(0, 0.5, 0.86, V()));
        qPlay = b.q.clone();
        qRest = new Basis().fromZY(this.rd(0.05, -1, -0.12, V()), this.rd(0, 0.1, 1, V())).q.clone();
        restPos = this.rp(-0.13 * s, this.seatTop + 0.72, 0.24, V());
        break;
      }
      case 'bassoon': {
        const bodyUp = T.dir(0.3, 0.94, 0.12, V());
        const b = new Basis().fromZY(T.dir(0, 0.05, 1, V()), bodyUp);
        // basis from (z, y) makes z exact; we want y exact → rebuild
        const bb = new Basis();
        bb.y.copy(bodyUp);
        bb.x.crossVectors(bodyUp, b.z).normalize();
        bb.z.crossVectors(bb.x, bb.y);
        bb.syncQ();
        qPlay = bb.q.clone();
        qRest = qPlay.clone();
        restPos = mouth.clone().addScaledVector(T.z, 0.18).addScaledVector(T.y, -0.25);
        break;
      }
      case 'trumpet': {
        const b = new Basis().fromZY(T.dir(0, -0.12 + bellUp, 1, V()), T.dir(0, 1, 0.1, V()));
        qPlay = b.q.clone();
        qRest = new Basis().fromZY(this.rd(0.1, 0.35, 1, V()), this.rd(-1, 0.2, 0, V())).q.clone();
        restPos = this.rp(-0.12 * s, this.seatTop + 0.19, 0.18, V());
        break;
      }
      case 'horn': {
        const b = new Basis().fromZY(T.dir(0.05, -0.15, 1, V()), T.dir(0.25, 1, 0.1, V()));
        qPlay = b.q.clone();
        qRest = qPlay.clone();
        restPos = mouth.clone().addScaledVector(T.y, -0.28).addScaledVector(T.z, 0.12);
        break;
      }
      case 'trombone': {
        const b = new Basis().fromZY(T.dir(-0.04, -0.3 + bellUp, 0.95, V()), T.dir(0, 1, 0.3, V()));
        qPlay = b.q.clone();
        qRest = new Basis().fromZY(this.rd(0, 0.97, 0.2, V()), this.rd(0, 0.2, -1, V())).q.clone();
        restPos = this.rp(-0.32 * s, this.seatTop + 0.35, 0.22, V());
        break;
      }
      case 'tuba':
      default: {
        const b = new Basis().fromZY(T.dir(0, -0.05, 1, V()), T.dir(0, 1, 0.05, V()));
        qPlay = b.q.clone();
        qRest = qPlay.clone();
        restPos = mouth.clone().addScaledVector(T.y, -0.14).addScaledVector(T.z, 0.14);
        break;
      }
    }
    const q = qRest.slerp(qPlay, r);
    const pos = restPos.lerp(playPos, r);
    this.place(inst.root, inst.anchors.mouthpiece.position, pos, q);

    if (inst.slide) {
      const pitch = this.notes[0]?.pitch ?? 58;
      const position = ((((70 - pitch) % 7) + 7) % 7) * 0.083;
      inst.slide.position.z = damp(inst.slide.position.z, playing ? position : inst.slide.position.z, 25, dt);
      inst.slide.updateMatrixWorld(true);
    }

    // hands
    const poleL = this.rd(0.8, -1, -0.3, V());
    const poleR = this.rd(-0.8, -1, -0.3, V());
    if (kind === 'trombone') poleR.copy(this.rd(-0.9, -0.6, -0.2, V()));
    if (kind === 'horn') poleR.copy(this.rd(-1, -0.2, -0.5, V()));
    const flicker = playing ? noteFlicker(this.notes[0].pitch) : 0;
    this.holdGrip('L', inst.root, poleL, flicker * 0.15);
    this.holdGrip('R', inst.slide ?? inst.root, poleR, -flicker * 0.12);
  }

  // ------------------------------------------------------------------ percussion

  private sticks(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const timp = this.kind === 'timpani';
    let lean = 0.12;
    let twist = 0;
    const hands: ('L' | 'R')[] = ['L', 'R'];
    const targets: Vector3[] = [];
    const heights: number[] = [];
    for (const h of hands) {
      const hand = h === 'L' ? 0 : 1;
      const st = plan?.hits?.length ? stickHeight(plan, hand, t, timp ? 0.16 : 0.12) : { h: 0.15, target: timp ? (hand ? 2 : 1) : hand, since: Infinity };
      const key = timp ? `head_${st.target}` : `head_${this.kind === 'snare' || this.kind === 'suspended' ? (hand ? 1 : 0) : 0}`;
      const anchor = inst.anchors[key] ?? inst.anchors.head_0;
      targets.push(anchor.getWorldPosition(V()));
      heights.push(st.h);
      if (timp && hand === 1) twist = (1.5 - st.target) * 0.12;
    }
    lean += this.s.loud * 0.08;
    this.posture(f, { lean, twist, headPitch: 0.25, headYaw: twist * 0.8 });
    const s = this.scale;
    hands.forEach((h, i) => {
      const side = h === 'L' ? 'Left' : 'Right';
      const stick = inst.held![h]!;
      const sign = h === 'L' ? 1 : -1;
      const tipTarget = targets[i].clone().addScaledVector(UP, heights[i]);
      const shoulder = this.rig.pos(side === 'Left' ? 'LeftArm' : 'RightArm', V());
      // stick points from the hand down/forward towards the head, angling inwards
      const horiz = tipTarget.clone().sub(shoulder).setY(0).normalize();
      const stickDir = horiz.clone().multiplyScalar(0.9).addScaledVector(UP, -0.35 - heights[i] * 1.2).addScaledVector(this.torso.x, -sign * 0.25).normalize();
      const tipLocal = (stick.getObjectByName('anchor_tip') as Object3D).position;
      const grip = tipTarget.clone().addScaledVector(stickDir, -tipLocal.z);
      const b = new Basis().fromZY(stickDir, UP);
      stick.position.copy(grip);
      stick.quaternion.copy(b.q);
      stick.updateMatrixWorld(true);
      const dir = V().crossVectors(UP, stickDir).multiplyScalar(-sign).addScaledVector(stickDir, 0.35).normalize();
      const palm = V().copy(UP).negate().addScaledVector(stickDir, 0.1).normalize();
      this.hold(side, grip.clone().addScaledVector(UP, 0.015 * s), dir, palm, this.rd(sign * 0.9, -0.8, -0.3, V()), 0.9, 0.55);
    });
    void dt;
  }

  private bassDrum(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const st = plan?.hits?.length ? stickHeight(plan, 1, t, 0.2) : { h: 0.2, target: 0, since: Infinity };
    // bass drum uses the right hand for everything
    const st2 = plan?.hits?.length ? stickHeight(plan, 0, t, 0.2) : st;
    const h = Math.min(st.h, st2.h);
    this.posture(f, { lean: 0.08, headPitch: 0.1, headYaw: -0.15 });
    const head = inst.anchors.head_0.getWorldPosition(V());
    const normal = this.rd(-1, 0, 0, V());
    const tip = head.clone().addScaledVector(normal, 0.02 + h * 1.6).addScaledVector(UP, h * 0.4);
    const stick = inst.held!.R!;
    const stickDir = this.rd(0.25, -0.25, 1, V()).addScaledVector(normal, -0.2 - h).normalize();
    const tipLocal = (stick.getObjectByName('anchor_tip') as Object3D).position;
    const grip = tip.clone().addScaledVector(stickDir, -tipLocal.z);
    stick.position.copy(grip);
    stick.quaternion.copy(new Basis().fromZY(stickDir, UP).q);
    stick.updateMatrixWorld(true);
    const dir = V().crossVectors(UP, stickDir).addScaledVector(stickDir, 0.3).normalize();
    this.hold('Right', grip, dir, this.rd(0, -1, 0, V()), this.rd(-0.9, -0.8, -0.2, V()), 0.9, 0.6);
    const rest = inst.anchors.rest_L.getWorldPosition(V());
    this.hold('Left', rest, this.rd(0.2, 0.5, 1, V()), this.rd(1, 0, 0.2, V()), this.rd(0.8, -0.6, -0.4, V()), 0.2, 0.1);
    void dt;
  }

  private cymbals(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    let gap = 0.12;
    let flourish = 0;
    if (plan?.hitTimes?.length) {
      const i = sortedSearch(plan.hitTimes, t);
      const next = plan.hits![i + 1];
      const prev = plan.hits![i];
      if (next && next.t - t < 0.5) gap = 0.02 + 0.28 * smooth((next.t - t) / 0.5);
      if (prev && t - prev.t < 2) {
        const u = (t - prev.t) / 2;
        flourish = Math.sin(Math.min(1, u * 4) * Math.PI * 0.5) * (1 - smooth(u));
        gap = Math.max(gap, 0.02 + flourish * 0.35);
      }
    }
    this.posture(f, { lean: 0.02 - flourish * 0.05, headPitch: -0.05 });
    const s = this.scale;
    const center = this.rp(0, this.rig.measure.shoulderHeight - 0.18 * s + flourish * 0.25, 0.32 + flourish * 0.05, V());
    for (const h of ['L', 'R'] as const) {
      const sign = h === 'L' ? 1 : -1;
      const plate = inst.held![h]!;
      // plates face each other; during the flourish they open outwards toward the audience
      const face = this.rd(-sign, 0, flourish * 0.9, V());
      const pos = center.clone().addScaledVector(this.rd(1, 0, 0, V()), sign * (gap / 2 + 0.04 + flourish * 0.15));
      const b = new Basis().fromZY(face, UP);
      plate.position.copy(pos);
      plate.quaternion.copy(b.q);
      plate.updateMatrixWorld(true);
      const g = inst.grips[h]!;
      const c = V();
      const d = V();
      const p = V();
      this.gripWorld(g, plate, c, d, p);
      c.addScaledVector(face, -0.03);
      this.hold(h === 'L' ? 'Left' : 'Right', c, UP.clone(), face.clone().negate(), this.rd(sign, -0.7, -0.4, V()), 0.9, 0.6);
    }
    void dt;
  }

  private triangle(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const st = plan?.hits?.length ? stickHeight(plan, 1, t, 0.08) : { h: 0.08, target: 0, since: Infinity };
    this.posture(f, { lean: 0.02, headPitch: 0.05 });
    const s = this.scale;
    const tri = inst.held!.L!;
    const hang = this.rp(0.12 * s, this.rig.measure.shoulderHeight + 0.05, 0.38, V());
    tri.position.copy(hang);
    tri.quaternion.copy(this.root.quaternion);
    tri.updateMatrixWorld(true);
    this.hold('Left', hang.clone().addScaledVector(UP, 0.02), this.rd(-0.3, 0.2, 1, V()), this.rd(-1, 0, 0, V()), this.rd(0.8, -0.8, -0.2, V()), 0.7, 0.9);
    const beater = inst.held!.R!;
    const hit = this.rp(0.12 * s, this.rig.measure.shoulderHeight - 0.08, 0.38, V());
    const tip = hit.addScaledVector(this.rd(-1, 0.2, 0, V()), 0.02 + st.h * 0.6);
    const dir = this.rd(1, -0.1, 0.3, V());
    const grip = tip.clone().addScaledVector(dir, -0.2);
    beater.position.copy(grip);
    beater.quaternion.copy(new Basis().fromZY(dir, UP).q);
    beater.updateMatrixWorld(true);
    this.hold('Right', grip, this.rd(0.2, -0.3, 1, V()), this.rd(0, -1, 0, V()), this.rd(-0.9, -0.8, -0.2, V()), 0.85, 0.5);
    void dt;
  }

  private harp(f: FrameState, t: number, dt: number) {
    const inst = this.inst!;
    this.posture(f, { lean: 0.12, twist: 0.1, headPitch: 0.15, headYaw: 0.35, kneesApart: 1.6 });
    const s = this.scale;
    // harp leans back onto the right shoulder
    const tilt = _q.setFromAxisAngle(this.rd(1, 0, 0, V()), -0.28);
    const q = this.root.quaternion.clone().premultiply(tilt);
    inst.root.quaternion.copy(q);
    inst.root.position.copy(this.rp(-0.1 * s, 0, 0.42, V()));
    inst.root.updateMatrixWorld(true);
    // left hand plays the low notes further away, right hand the high notes near the shoulder
    const low: Note[] = [];
    const high: Note[] = [];
    for (const n of this.notes) (n.pitch < 60 ? low : high).push(n);
    for (const [side, list] of [
      ['Left', low],
      ['Right', high],
    ] as const) {
      const a = inst.anchors[side === 'Left' ? 'pluck_L' : 'pluck_R'].getWorldPosition(V());
      const pitch = list[0]?.pitch ?? (side === 'Left' ? 48 : 72);
      const u = clamp01((pitch - 36) / 60);
      const along = this.rd(0, 0.35, 1, V());
      a.addScaledVector(along, (0.5 - u) * 0.35 * s);
      const pluck = list.length ? Math.max(0, 1 - (t - list[0].start) / 0.15) : 0;
      const sign = side === 'Left' ? 1 : -1;
      a.addScaledVector(this.rd(sign, 0, 0, V()), 0.02 + pluck * 0.03);
      this.hold(side, a, this.rd(0, 0.3, 1, V()), this.rd(-sign, 0, 0, V()), this.rd(sign * 0.9, -0.7, -0.4, V()), 0.35 + pluck * 0.4, 0.3);
    }
    void dt;
  }

  // ------------------------------------------------------------------ conductor

  private conductor(f: FrameState, t: number, dt: number) {
    const beats = f.beats;
    const active = f.loaded && (f.playing || (t > (f.beats[0]?.time ?? 0) - 1.5 && t < (beats[beats.length - 1]?.time ?? 0) + 1));
    this.s.arms = damp(this.s.arms, active ? 1 : 0, 3, dt);
    const loud = this.s.loud;
    // look around the orchestra; turn towards cued sections
    const scan = noise1(f.wall * 0.12 + 3) * 0.35;
    this.s.cue = damp(this.s.cue, 0, 1.5, dt);
    this.posture(f, { lean: 0.05 + loud * 0.1, twist: scan * 0.5 * this.s.arms + this.s.cueYaw * this.s.cue * 0.5, headPitch: 0.08, headYaw: scan + this.s.cueYaw * this.s.cue });
    const s = this.scale;
    const T = this.torso;
    const lead = t + 0.06;
    // find the current beat (beats array is sorted)
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beats[mid].time <= lead) lo = mid + 1;
      else hi = mid;
    }
    const bi = lo - 1;
    const amp = 0.14 + 0.26 * loud;
    const width = 0.16 + 0.22 * loud;
    let x = 0;
    let y = 0;
    if (bi >= 0 && bi < beats.length) {
      const b = beats[bi];
      const u = clamp01((lead - b.time) / Math.max(0.05, b.duration));
      const p0 = ictus(b.beatsPerBar, b.beatInBar, width);
      const nb = beats[bi + 1];
      const p1 = nb ? ictus(nb.beatsPerBar, nb.beatInBar, width) : [0, 0];
      const e = u * u * (3 - 2 * u);
      x = p0[0] + (p1[0] - p0[0]) * e;
      // rebound up after the ictus, then accelerate down into the next one
      y = p0[1] + (p1[1] - p0[1]) * u + amp * Math.sin(Math.PI * Math.pow(u, 0.8)) * (1 - 0.25 * u);
    } else if (beats.length && lead < beats[0].time) {
      // preparatory beat
      const u = clamp01(1 - (beats[0].time - lead) / Math.max(0.3, beats[0].duration));
      y = amp * Math.sin(Math.PI * u) * 1.2;
    }
    const baseY = this.rig.measure.shoulderHeight - 0.14 * s;
    const hand = T.point(-0.18 * s - x, 0, 0.36 * s, V());
    hand.y = this.root.position.y + baseY + y * this.s.arms;
    const restR = this.rp(-0.2 * s, this.rig.measure.hipHeight - 0.02, 0.12, V());
    hand.lerp(restR, 1 - this.s.arms);
    const dirR = T.dir(0.35, 0.2 + y * 0.8, 1, V());
    this.hold('Right', hand, dirR, T.dir(0.2, -1, 0.2, V()), T.dir(-0.9, -0.6, -0.2, V()), 0.75, 0.6);
    // baton from the right hand
    const baton = this.props.getObjectByName('baton')!;
    baton.position.copy(hand).addScaledVector(dirR, 0.03);
    baton.quaternion.copy(new Basis().fromZY(T.dir(0.4, 0.35 + y * 0.6, 1, V()), T.y).q);
    baton.updateMatrixWorld(true);

    // left hand mirrors in loud passages, otherwise rests or cues
    const mirror = clamp01((loud - 0.55) * 3) * this.s.arms;
    const handL = T.point(0.2 * s + x * 0.8, 0, 0.3 * s, V());
    handL.y = this.root.position.y + baseY + y * 0.8 + 0.05;
    const restL = T.point(0.12 * s, -0.12 * s, 0.2 * s, V());
    handL.lerp(restL, 1 - mirror);
    this.hold('Left', handL, T.dir(0.3, 0.4, 1, V()), T.dir(-0.4, -0.3 - mirror * 0.4, 0.6, V()), T.dir(0.9, -0.6, -0.2, V()), 0.3 + (1 - mirror) * 0.3, 0.2);
  }

  /** Conductor cue towards a stage position. */
  cue(worldPos: Vector3) {
    const local = worldPos.clone().applyMatrix4(_tmpInv.copy(this.root.matrixWorld).invert());
    this.s.cueYaw = Math.atan2(local.x, local.z) * 0.8;
    this.s.cue = 1;
  }

  headWorld(out: Vector3): Vector3 {
    return this.rig.pos('Head', out);
  }
}

const _tmpInv = new Matrix4();

/** Conducting pattern ictus positions (x = towards the conductor's left, y = height offset). */
function ictus(beatsPerBar: number, beat: number, w: number): [number, number] {
  switch (beatsPerBar) {
    case 1:
      return [0, 0];
    case 2:
      return beat === 0 ? [0, 0] : [-w * 0.35, 0.05];
    case 3:
      return beat === 0 ? [0, 0] : beat === 1 ? [-w, 0.02] : [-w * 0.25, 0.1];
    case 4:
      return [
        [0, 0],
        [w * 0.8, 0.02],
        [-w, 0.02],
        [-w * 0.2, 0.1],
      ][beat] as [number, number];
    default: {
      const side = beat % 2 ? w : -w;
      return beat === 0 ? [0, 0] : [side * (0.5 + beat / beatsPerBar), 0.03];
    }
  }
}

function noteFlicker(pitch: number): number {
  const s = Math.sin(pitch * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function buildBaton(): Object3D {
  const g = new Group();
  g.name = 'baton';
  const shaft = new Mesh(new CapsuleGeometry(0.0022, 0.38, 2, 6), new MeshBasicMaterial({ color: '#f4f1e8' }));
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.19;
  const handle = new Mesh(new CapsuleGeometry(0.008, 0.05, 2, 8), new MeshBasicMaterial({ color: '#3a2a1c' }));
  handle.rotation.x = Math.PI / 2;
  handle.position.z = -0.01;
  g.add(shaft, handle);
  return g;
}
