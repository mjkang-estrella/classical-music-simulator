import { CapsuleGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { createCharacter, type CharacterInstance } from '../assets/characterFactory';
import { createInstrument } from '../assets/instrumentFactory';
import type { BowedSpec, InstrumentModel } from '../assets/instruments/types';
import { loudnessAt } from '../music/midiLoader';
import type { Note } from '../music/types';
import type { Musician } from '../orchestra/ensemble';
import { SECTIONS, type InstrumentKind } from '../orchestra/sections';
import { blendFinger, blendPose, clonePose, FINGERS_ORDER, jitterPose, POSES, type HandPose } from '../rig/handPose';
import type { Rig } from '../rig/rig';
import { keysFor, stringFingering, valvesFor } from './fingering';
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
const _inv = new Matrix4();
const UP = new Vector3(0, 1, 0);

export type ActorKind = InstrumentKind | 'conductor';
type Hand = 'Left' | 'Right';

interface Smoothed {
  raise: number;
  lean: number;
  loud: number;
  trend: number;
  bowLift: number;
  bowTwist: number;
  stringF: number;
  handZ: number;
  vib: number;
  cue: number;
  cueYaw: number;
  arms: number;
  nod: number;
  inhale: number;
  pluckL: number;
  pluckR: number;
  batonFlick: number;
  glance: number;
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
  private readonly s: Smoothed = { raise: 0, lean: 0, loud: 0, trend: 0, bowLift: 0, bowTwist: 0, stringF: 2, handZ: NaN, vib: 0, cue: 0, cueYaw: 0, arms: 0, nod: 0, inhale: 0, pluckL: 0, pluckR: 0, batonFlick: 0, glance: 0 };
  /** current (smoothed) finger poses */
  private readonly hands: Record<Hand, HandPose> = { Left: clonePose(POSES.relaxed), Right: clonePose(POSES.relaxed) };
  private readonly scratch: Record<Hand, HandPose> = { Left: clonePose(POSES.relaxed), Right: clonePose(POSES.relaxed) };
  private notes: Note[] = [];
  private lastWall = 0;
  private dt = 1 / 60;
  private snap = true;
  /** camera distance, used for level of detail */
  distance = 10;

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

  /** Critically damped smoothing that snaps after a seek. */
  private sm(current: number, target: number, lambda: number): number {
    return this.snap || !Number.isFinite(current) ? target : damp(current, target, lambda, this.dt);
  }

  /** Main per-frame update. */
  update(f: FrameState): void {
    this.dt = Math.min(0.1, Math.max(0.001, f.wall - this.lastWall));
    this.lastWall = f.wall;
    this.snap = f.jumped || this.dt > 0.09;
    const t = f.t + this.jitter;
    this.gatherNotes(f);
    const loud = this.loudness(f, t);
    this.s.loud = this.sm(this.s.loud, loud, 6);
    // crescendo / diminuendo trend drives leaning in and out of the phrase
    this.s.trend = this.sm(this.s.trend, clamp01(loud - this.loudness(f, t - 0.8) + 0.5) - 0.5, 3);
    // small nod into each downbeat while playing
    const nodTarget = this.notes.length && f.sinceDownbeat < 0.5 ? Math.exp(-f.sinceDownbeat * 7) * (0.02 + 0.04 * this.s.loud) : 0;
    this.s.nod = this.sm(this.s.nod, nodTarget, 18);

    this.rig.reset();
    switch (this.kind) {
      case 'violin':
      case 'viola':
        this.bowedUpper(f, t);
        break;
      case 'cello':
      case 'bass':
        this.bowedLower(f, t);
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
        this.wind(f, t);
        break;
      case 'timpani':
      case 'snare':
      case 'suspended':
        this.sticks(f, t);
        break;
      case 'bassdrum':
        this.bassDrum(f, t);
        break;
      case 'cymbals':
        this.cymbals(f, t);
        break;
      case 'triangle':
        this.triangle(f, t);
        break;
      case 'harp':
        this.harp(f, t);
        break;
      case 'conductor':
        this.conductor(f, t);
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
      for (const plan of f.plans.values()) max = Math.max(max, loudnessAt(plan.part.loudness, t));
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
    // two layers of sway: slow idle drift, and a musical one that grows with the dynamics
    const sway = noise1(f.wall * 0.35 + this.seed * 13) * (0.012 + 0.03 * this.s.loud) + noise1(f.t * 0.55 + this.seed * 7) * 0.045 * this.s.loud;
    const rock = noise1(f.t * 0.4 + this.seed * 3) * 0.03 * this.s.loud;
    if (!this.standing) {
      rig.setHips(_b.set(b.x, this.seatTop + 0.1 + (b.y - rig.measure.hipHeight), -0.05));
    } else {
      rig.setHips(_b.set(b.x, b.y - 0.012 - 0.012 * this.s.loud, b.z));
    }
    // lean into crescendos, sit back as the phrase relaxes; inhale lifts the chest
    const lean = (o.lean ?? 0.06) + this.s.trend * 0.18 + rock - this.s.inhale * 0.04;
    const twist = o.twist ?? 0;
    const roll = o.roll ?? 0;
    rig.rotate('Spine', lean * 0.35 - breath * 0.012, twist * 0.3, sway * 0.4 + roll * 0.3);
    rig.rotate('Spine1', lean * 0.35, twist * 0.35, sway * 0.4 + roll * 0.35);
    rig.rotate('Spine2', lean * 0.3 - breath * 0.02 - this.s.inhale * 0.03, twist * 0.35, sway * 0.2 + roll * 0.35);
    // read the part on the stand, glancing up at the conductor every few seconds
    const glance = this.kind === 'conductor' ? 0 : clamp01((noise1(f.wall * 0.23 + this.seed * 31) - 0.35) * 4);
    this.s.glance = this.sm(this.s.glance, glance, 6);
    const hp = (o.headPitch ?? 0) + this.s.nod + (this.kind === 'conductor' ? 0 : 0.1 - this.s.glance * 0.22);
    const hy = (o.headYaw ?? 0) * (1 - this.s.glance * 0.5);
    rig.rotate('Neck', hp * 0.4, hy * 0.4, (o.headRoll ?? 0) * 0.4);
    rig.rotate('Head', hp * 0.6 + sway * 0.3, hy * 0.6, (o.headRoll ?? 0) * 0.6);
    rig.update();
    if (!this.standing) this.seatLegs(o.kneesApart ?? 1, o.feetForward ?? 0);
    this.computeTorso();
  }

  private seatLegs(apart: number, forward: number) {
    const rig = this.rig;
    _inv.copy(this.root.matrixWorld).invert();
    for (const side of ['Left', 'Right'] as const) {
      const hip = rig.pos(`${side}UpLeg`, _a);
      const local = _b.copy(hip).applyMatrix4(_inv);
      const x = local.x * (1.25 + 0.9 * (apart - 1)) + (side === 'Left' ? 0.02 : -0.02) * apart;
      const drop = local.y - rig.measure.ankleHeight;
      const reach = Math.sqrt(Math.max(0.01, (rig.measure.thigh + rig.measure.shin) ** 2 * 0.92 - drop * drop));
      const z = local.z + Math.min(reach, rig.measure.thigh * 0.98 + 0.06 + forward) + (side === 'Left' ? 0.02 : -0.02) * (this.seed - 0.5);
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
    return head.addScaledVector(this.torso.y, 0.02 * this.scale).addScaledVector(this.torso.z, 0.105 * this.scale);
  }

  /** Places an instrument (or held object) so that local point `anchor` lands on `target` with rotation q. */
  private place(obj: Object3D, anchorLocal: Vector3, target: Vector3, q: Quaternion) {
    obj.quaternion.copy(q);
    obj.position.copy(target).sub(_e.copy(anchorLocal).applyQuaternion(q));
    obj.updateMatrixWorld(true);
  }

  /**
   * Places a hand: palm centre, finger direction, palm normal, elbow pole and a finger pose.
   * The shoulder girdle rises / comes forward for high or far reaches, part of the hand's twist is
   * taken by the forearm, and finger poses are smoothed so fingers move rather than jump.
   */
  private hold(side: Hand, center: Vector3, dir: Vector3, palm: Vector3, pole: Vector3, pose: HandPose, opts: { twist?: number; wrist?: number; shrug?: number; smooth?: number } = {}) {
    const rig = this.rig;
    const palmLen = rig.hands[side].palm;
    const wrist = _d.copy(center).addScaledVector(dir, -palmLen * 0.5).addScaledVector(palm, -0.02 * this.scale);
    // high reaches lift the shoulder girdle, far reaches bring it forward
    const rel = rig.pos(side === 'Left' ? 'LeftArm' : 'RightArm', _c).sub(wrist).negate();
    const elev = clamp01((rel.dot(this.torso.y) + 0.05) * 1.1) * 0.3 + (opts.shrug ?? 0) + this.s.inhale * 0.04;
    const prot = clamp01((rel.dot(this.torso.z) - 0.3) * 0.8) * 0.22;
    rig.shrug(side, elev, prot);
    rig.solveLimb(side === 'Left' ? 'LeftArm' : 'RightArm', wrist, pole);
    rig.orientHand(side, dir, palm, opts.twist ?? 0.6, opts.wrist ?? 1.15);
    if (this.distance > 16 || !rig.hasFingers(side)) return;
    const cur = this.hands[side];
    if (this.snap) blendPose(pose, pose, 0, cur);
    else blendPose(cur, pose, 1 - Math.exp(-(opts.smooth ?? 22) * this.dt), cur);
    rig.applyHandPose(side, cur);
  }

  /** Pose helper: a copy of a library pose with this musician's own slight variation. */
  private pose(side: Hand, name: keyof typeof POSES): HandPose {
    const out = this.scratch[side];
    blendPose(POSES[name], POSES[name], 0, out);
    return jitterPose(out, this.seed + (side === 'Left' ? 0.37 : 0.71), 0.05);
  }

  // ------------------------------------------------------------------ bowed strings

  private bowState(plan: PartPlan | undefined, t: number) {
    return plan?.strokes?.length ? bowAt(plan, t) : { s: 0.35, stroke: null, sounding: false, speed: 0 };
  }

  private bowedUpper(f: FrameState, t: number) {
    const inst = this.inst!;
    const spec = inst.bowed!;
    const plan = this.plan(f);
    const target = plan ? raiseAmount(plan.phrases, t, 1.6, 2.5, 1.2) : 0;
    this.s.raise = this.sm(this.s.raise, target, 5);
    const r = smooth(this.s.raise);
    const bs = this.bowState(plan, t);
    const pitch = this.notes[0]?.pitch ?? bs.stroke?.pitch ?? 67;
    const k = this.notes[0] ? stringFor(this.musician!.section, pitch) : bs.stroke?.string ?? 2;
    this.s.stringF = this.sm(this.s.stringF, k, 24);
    // the torso follows the bow a little: turn with down-bows, back with up-bows
    const bowing = bs.sounding ? Math.sign(bs.speed) * Math.min(1, Math.abs(bs.speed)) : 0;
    this.s.bowTwist = this.sm(this.s.bowTwist, bowing * 0.06 * r, 4);
    this.posture(f, {
      lean: 0.08 + 0.05 * this.s.loud,
      twist: 0.12 * r + this.s.bowTwist,
      headPitch: 0.1 + 0.12 * r,
      headYaw: 0.28 * r,
      headRoll: 0.22 * r,
    });
    const T = this.torso;
    const s = this.scale;

    // --- instrument transform: play (on the collarbone) ↔ rest (on the knee)
    const phraseLift = this.s.trend * 0.12 + noise1(f.t * 0.3 + this.seed * 5) * 0.03;
    const zPlay = T.dir(0.62, -0.16 + phraseLift, 0.77, V());
    const yPlay = T.dir(0, 1, -0.05, V());
    const basis = new Basis().fromZY(zPlay, yPlay);
    // roll the top towards the player's right; it rocks slightly toward the bow on down-bows
    _q.setFromAxisAngle(basis.z, 0.28 - this.s.bowTwist * 0.6);
    const qPlay = basis.q.clone().premultiply(_q);
    const chin = T.point(0.06 * s, 0.11 * s, 0.06 * s, V());
    const restBasis = new Basis().fromZY(this.rd(0.35, 0.9, 0.35, V()), this.rd(-0.1, 0, 1, V()));
    const restPos = this.rp(0.13 * s, this.seatTop + 0.12, 0.3, V());
    const qInst = _q2.copy(restBasis.q).slerp(qPlay, r);
    this.place(inst.root, inst.anchors.chinrest.position, restPos.lerp(chin, r), qInst);

    // --- bow
    this.s.bowLift = this.sm(this.s.bowLift, bs.sounding || this.notes.length ? 0 : 1, 12);
    this.placeBow(inst, spec, this.s.stringF, bs.s, this.s.bowLift * 0.03 + (1 - r) * 0.25, r, 'upper');
    this.bowHand(inst, bs.s, bs.stroke ? t - bs.stroke.t0 : 1, 'upper');

    // --- left hand on the neck
    this.leftHandOnNeck(inst, spec, pitch, k, f, r, 'upper');
  }

  /** Contact point + string geometry for a fractional string index. */
  private stringPoint(inst: InstrumentModel, stringF: number, out: Vector3): { xs: number } {
    const k0 = Math.max(0, Math.min(3, Math.floor(stringF)));
    const k1 = Math.min(3, k0 + 1);
    const u = Math.min(1, Math.max(0, stringF - k0));
    const a0 = inst.anchors[`string_${k0}`];
    const a1 = inst.anchors[`string_${k1}`];
    out.copy(a0.position).lerp(a1.position, u).applyMatrix4(inst.root.matrixWorld);
    return { xs: a0.position.x + (a1.position.x - a0.position.x) * u };
  }

  private placeBow(inst: InstrumentModel, spec: BowedSpec, stringF: number, sPos: number, lift: number, r: number, kind: 'upper' | 'lower') {
    const bow = inst.bow!;
    const instQ = inst.root.getWorldQuaternion(new Quaternion());
    const contact = V();
    const { xs } = this.stringPoint(inst, stringF, contact);
    // tangent of the bridge arch at this string; frog on the player's right
    const dirLocal = V().set(spec.frogSide * spec.arch, -spec.frogSide * xs * 1.2, 0).normalize();
    // a slight slant of the bow toward the fingerboard
    dirLocal.z += kind === 'upper' ? -0.06 * spec.frogSide : 0.03;
    dirLocal.normalize();
    const bz = dirLocal.applyQuaternion(instQ);
    const archNormal = V().set(xs * 1.2, spec.arch, 0).normalize().applyQuaternion(instQ);
    const basis = new Basis().fromZY(bz, archNormal);
    const along = spec.hairStart + sPos * (spec.hairEnd - spec.hairStart);
    const frog = contact.clone().addScaledVector(basis.y, spec.hairGap + 0.0015 + lift).addScaledVector(basis.z, -along);
    if (r < 1) {
      const rest = kind === 'upper' ? this.rp(-0.2 * this.scale, this.seatTop + 0.16, 0.18, V()) : this.rp(-0.25, this.seatTop + 0.2, 0.25, V());
      frog.lerp(rest, 1 - r);
      if (kind === 'upper') basis.q.slerp(new Basis().fromZY(this.rd(0.15, -0.3, 1, V()), this.rd(0, 1, 0, V())).q, 1 - r);
    }
    bow.position.copy(frog);
    bow.quaternion.copy(basis.q);
    bow.updateMatrixWorld(true);
  }

  /**
   * Right hand on the bow. The hand frame is built from the bow and the player's body, so it stays
   * natural at any string or bow position: fingers drape over the far side of the stick, the wrist
   * flexes at the frog and flattens (with the index pressing) toward the tip.
   */
  private bowHand(inst: InstrumentModel, sPos: number, sinceStroke: number, kind: 'upper' | 'lower') {
    const bow = inst.bow!;
    const s = this.scale;
    const frog = bow.getWorldPosition(V());
    const bq = bow.getWorldQuaternion(new Quaternion());
    const bz = V().set(0, 0, 1).applyQuaternion(bq);
    const shoulder = this.rig.pos('RightArm', V());
    const contactish = frog.clone().addScaledVector(bz, 0.3);
    const away = contactish.sub(shoulder);
    away.addScaledVector(bz, -away.dot(bz)).normalize();
    const down = V().set(0, -1, 0);
    down.addScaledVector(bz, -down.dot(bz)).normalize();
    const tip = clamp01(sPos);
    // a quick finger "give" at every change of bow
    const change = Math.exp(-Math.max(0, sinceStroke) / 0.07);
    let center: Vector3;
    let dir: Vector3;
    let palm: Vector3;
    let pose: HandPose;
    let pole: Vector3;
    if (kind === 'upper') {
      // palm over the frog (thumb at its front edge), fingers draping over the far side of the stick
      center = frog.clone().addScaledVector(bz, 0.004).addScaledVector(down, -0.032 * s).addScaledVector(away, -0.012 * s);
      dir = V()
        .addScaledVector(away, 0.55 + 0.15 * tip)
        .addScaledVector(bz, 0.42)
        .addScaledVector(down, 0.5 - 0.4 * tip)
        .normalize();
      palm = V().addScaledVector(down, 0.9).addScaledVector(away, 0.25).addScaledVector(bz, 0.1 * tip).normalize();
      pose = blendPose(POSES.bowHold, POSES.bowHoldTip, tip, this.scratch.Right);
      // elbow higher on the low strings, drops and opens toward the tip
      pole = this.rd(-0.55, -1.0 - 0.18 * this.s.stringF - 0.25 * tip, -0.15, V());
    } else {
      center = frog.clone().addScaledVector(bz, 0.006).addScaledVector(down, -0.034 * s).addScaledVector(away, -0.018 * s);
      dir = V().addScaledVector(away, 0.5).addScaledVector(down, 0.6 - 0.2 * tip).addScaledVector(bz, 0.35).normalize();
      palm = V().addScaledVector(down, 0.75).addScaledVector(away, 0.45).normalize();
      pose = blendPose(POSES.bowHoldLow, POSES.bowHoldTip, tip * 0.5, this.scratch.Right);
      // cello: the arm is higher on the A string (player's left), lower on C
      pole = this.rd(-1, -0.62 + 0.1 * this.s.stringF, -0.25, V());
    }
    for (const fk of FINGERS_ORDER) pose[fk][1] += change * 0.12;
    this.hold('Right', center, dir, palm, pole, jitterPose(pose, this.seed, 0.03), { smooth: 30 });
  }

  private leftHandOnNeck(inst: InstrumentModel, spec: BowedSpec, pitch: number, k: number, f: FrameState, r: number, kind: 'upper' | 'lower') {
    const section = this.musician!.section;
    const open = SECTIONS[section].strings ?? [55, 62, 69, 76];
    const { handSemi, finger } = stringFingering(section, pitch, open[k]);
    const L = spec.nutZ - spec.bridgeZ;
    const sc = kind === 'upper' ? spec.scale : Math.sqrt(spec.scale);
    // the index knuckle sits over the first finger's note; the palm centre is a little toward the body
    const zIndex = spec.nutZ - L * (1 - Math.pow(2, -(handSemi + 1) / 12));
    const targetZ = zIndex - 0.045 * sc;
    this.s.handZ = this.sm(this.s.handZ, targetZ, 18);
    const sustained = this.notes.length && this.notes[0].end - this.notes[0].start > 0.3 && finger > 0;
    this.s.vib = this.sm(this.s.vib, sustained ? Math.sin(f.wall * 34 + this.seed * 9) * 0.0035 * sc ** 0.5 : 0, 20);
    const a = inst.anchors.left_hand;
    const q = inst.root.getWorldQuaternion(new Quaternion());
    let dir: Vector3;
    let palm: Vector3;
    let pole: Vector3;
    if (kind === 'upper') {
      // hand below the neck on the E-string side, fingers arching over toward the G string, thumb opposite
      a.position.set(-0.017 * sc, spec.nutY - 0.036 * sc, this.s.handZ + this.s.vib);
      dir = V().set(0.2, 0.96, -0.1).normalize().applyQuaternion(q);
      palm = V().set(0.95, 0.22, 0.08).normalize().applyQuaternion(q);
      pole = this.rd(-0.3, -1, 0.05, V());
    } else {
      // cello / bass: hand wraps from the player's left, thumb behind the neck, elbow out
      a.position.set(-0.038 * sc, spec.nutY - 0.03 * sc, this.s.handZ + this.s.vib);
      dir = V().set(0.3, 0.95, 0.05).normalize().applyQuaternion(q);
      palm = V().set(0.95, -0.25, 0).normalize().applyQuaternion(q);
      pole = this.rd(0.9, 0.2, -0.35, V());
    }
    const center = a.getWorldPosition(V());
    if (r < 1) {
      const heel = inst.anchors.neck_heel.getWorldPosition(V());
      center.lerp(heel.addScaledVector(palm, -0.03), (1 - r) * 0.6);
    }
    const pose = this.pose('Left', 'neckHover');
    if (this.notes.length && finger > 0) {
      // the stopping finger presses; lower fingers usually stay down behind it
      for (let i = 0; i < 4; i++) {
        const fk = FINGERS_ORDER[i];
        if (i + 1 === finger) blendFinger(pose, fk, POSES.neckPress, 1);
        else if (i + 1 < finger) blendFinger(pose, fk, POSES.neckPress, 0.55);
      }
    }
    this.hold('Left', center, dir, palm, pole, pose, { twist: 0.7, smooth: 30 });
  }

  private bowedLower(f: FrameState, t: number) {
    const inst = this.inst!;
    const spec = inst.bowed!;
    const plan = this.plan(f);
    const isBass = this.kind === 'bass';
    const target = plan ? raiseAmount(plan.phrases, t, 1.5, 3, 1.2) : 0;
    this.s.raise = this.sm(this.s.raise, target, 4);
    const r = smooth(this.s.raise);
    const bs = this.bowState(plan, t);
    const bowing = bs.sounding ? Math.sign(bs.speed) * Math.min(1, Math.abs(bs.speed)) : 0;
    this.s.bowTwist = this.sm(this.s.bowTwist, bowing * 0.04, 5);
    this.posture(f, { lean: 0.1 + 0.08 * this.s.loud, twist: -this.s.bowTwist, headPitch: 0.12, headYaw: isBass ? 0.25 : 0.2, headRoll: -0.08, kneesApart: isBass ? 1.3 : 2.1, feetForward: isBass ? 0.05 : 0.02 });
    const s = this.scale;
    // endpin on the floor, instrument leaning back onto the player, moving a little with the body
    const endpin = isBass ? this.rp(0.14 * s, -0.12, 0.5, V()) : this.rp(0.02, -0.1, 0.66 * s, V());
    const axis = isBass ? this.rd(0.25, 0.94, -0.3, V()) : this.rd(0.14, 0.86, -0.5, V());
    const lean = noise1(f.wall * 0.3 + this.seed * 5) * 0.02 + this.s.loud * 0.03 + this.s.bowTwist * 0.4;
    axis.addScaledVector(this.torso.x, lean).normalize();
    const face = isBass ? this.rd(-0.35, 0.3, 0.9, V()) : this.rd(-0.28, 0.42, 0.86, V());
    const basis = new Basis().fromZY(axis, face);
    this.place(inst.root, inst.anchors.endpin.position, endpin, basis.q);

    const pitch = this.notes[0]?.pitch ?? bs.stroke?.pitch ?? (isBass ? 40 : 50);
    const k = this.notes[0] ? stringFor(this.musician!.section, pitch) : bs.stroke?.string ?? 1;
    this.s.stringF = this.sm(this.s.stringF, k, 24);
    this.s.bowLift = this.sm(this.s.bowLift, bs.sounding || this.notes.length ? 0 : 1, 12);
    this.placeBow(inst, spec, this.s.stringF, bs.s, this.s.bowLift * 0.04, r, 'lower');
    this.bowHand(inst, bs.s, bs.stroke ? t - bs.stroke.t0 : 1, 'lower');
    this.leftHandOnNeck(inst, spec, pitch, k, f, 1, 'lower');
  }

  // ------------------------------------------------------------------ winds & brass

  private wind(f: FrameState, t: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const section = this.musician!.section;
    const brass = SECTIONS[section].family === 'brass';
    const target = plan ? raiseAmount(plan.phrases, t, brass ? 1.2 : 1.1, brass ? 1.4 : 1.1, 1.1) : 0;
    this.s.raise = this.sm(this.s.raise, target, 5);
    const r = smooth(this.s.raise);
    const kind = this.kind;
    // breathing: a visible inhale in the gap before each phrase / note
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
    this.s.inhale = this.sm(this.s.inhale, inhale * r, 10);
    const playing = this.notes.length > 0;
    this.posture(f, {
      lean: 0.06 + 0.06 * this.s.loud * r,
      headPitch: (kind === 'trombone' ? -0.04 : kind === 'oboe' || kind === 'clarinet' ? 0.08 : 0.02) * r + 0.05 * (1 - r),
      headYaw: kind === 'flute' || kind === 'piccolo' ? 0.2 * r : 0,
      headRoll: kind === 'flute' || kind === 'piccolo' ? -0.08 * r : 0,
      kneesApart: kind === 'tuba' ? 1.6 : 1,
    });
    const T = this.torso;
    const s = this.scale;
    const mouth = this.mouth(V());
    // bells lift in loud passages and sink at phrase ends
    const bellUp = ((this.s.loud - 0.4) * 0.25 + this.s.trend * 0.2) * r;

    let qPlay: Quaternion;
    let playPos = mouth.clone();
    let qRest: Quaternion;
    let restPos: Vector3;
    switch (kind) {
      case 'flute':
      case 'piccolo': {
        const b = new Basis().fromZY(T.dir(-0.94, -0.16 + bellUp * 0.3, 0.3, V()), T.dir(0, 1, 0.05, V()));
        _q.setFromAxisAngle(b.z, -0.25);
        qPlay = b.q.clone().premultiply(_q);
        playPos = mouth.addScaledVector(T.y, -0.03).addScaledVector(T.z, 0.006);
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
        const b = new Basis().fromZY(T.dir(0.05, -0.15 + bellUp * 0.5, 1, V()), T.dir(0.25, 1, 0.1, V()));
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
    this.place(inst.root, inst.anchors.mouthpiece.position, restPos.lerp(playPos, r), q);

    const pitch = this.notes[0]?.pitch ?? plan?.part.notes[0]?.pitch ?? 60;
    if (inst.slide) {
      const position = ((((70 - pitch) % 7) + 7) % 7) * 0.083;
      inst.slide.position.z = this.sm(inst.slide.position.z, playing ? position : inst.slide.position.z, 25);
      inst.slide.updateMatrixWorld(true);
    }

    // finger poses from real fingerings
    const gL = inst.grips.L;
    const gR = inst.grips.R;
    const poseL = this.pose('Left', gL?.pose ?? 'keys');
    const poseR = this.pose('Right', gR?.pose ?? 'keys');
    if (playing && r > 0.5) {
      if (brass) {
        const valves = valvesFor(section, pitch);
        const hand = kind === 'horn' ? poseL : poseR;
        const pressedName = (kind === 'horn' ? gL?.pressed : gR?.pressed) ?? 'valvesPressed';
        valves.forEach((down, i) => down && blendFinger(hand, FINGERS_ORDER[i], POSES[pressedName], 1));
      } else {
        const keys = keysFor(section, pitch);
        for (let i = 0; i < 3; i++) {
          if (keys[i]) blendFinger(poseL, FINGERS_ORDER[i], POSES.keysPressed, 1);
          if (keys[i + 3]) blendFinger(poseR, FINGERS_ORDER[i], POSES.keysPressed, 1);
        }
      }
    }
    const poleL = this.rd(0.8, -1, -0.3, V());
    const poleR = this.rd(-0.8, -1, -0.3, V());
    if (kind === 'trombone') poleR.copy(this.rd(-0.9, -0.6, -0.2, V()));
    if (kind === 'horn') poleR.copy(this.rd(-1, -0.2, -0.5, V()));
    this.holdGrip('L', inst.root, poleL, poseL);
    this.holdGrip('R', inst.slide ?? inst.root, poleR, poseR);
  }

  private holdGrip(side: 'L' | 'R', holder: Object3D, pole: Vector3, pose: HandPose) {
    const g = this.inst?.grips[side];
    if (!g) return;
    holder.updateMatrixWorld(true);
    const center = g.anchor.getWorldPosition(V());
    holder.getWorldQuaternion(_q2);
    const dir = g.dir.clone().applyQuaternion(_q2);
    const palm = g.palm.clone().applyQuaternion(_q2);
    this.hold(side === 'L' ? 'Left' : 'Right', center, dir, palm, pole, pose, { smooth: 26, twist: g.twist, wrist: g.wrist });
  }

  // ------------------------------------------------------------------ percussion

  private sticks(f: FrameState, t: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const timp = this.kind === 'timpani';
    let twist = 0;
    const hands: ('L' | 'R')[] = ['L', 'R'];
    const targets: Vector3[] = [];
    const heights: number[] = [];
    const since: number[] = [];
    for (const h of hands) {
      const hand = h === 'L' ? 0 : 1;
      const st = plan?.hits?.length ? stickHeight(plan, hand, t, timp ? 0.16 : 0.12) : { h: 0.15, target: timp ? (hand ? 2 : 1) : hand, since: Infinity };
      const key = timp ? `head_${st.target}` : `head_${this.kind === 'snare' || this.kind === 'suspended' ? (hand ? 1 : 0) : 0}`;
      const anchor = inst.anchors[key] ?? inst.anchors.head_0;
      targets.push(anchor.getWorldPosition(V()));
      heights.push(st.h);
      since.push(st.since);
      if (timp && hand === 1) twist = (1.5 - st.target) * 0.12;
    }
    this.s.lean = this.sm(this.s.lean, twist, 6);
    this.posture(f, { lean: 0.12 + this.s.loud * 0.08, twist: this.s.lean, headPitch: 0.25, headYaw: this.s.lean * 0.8 });
    const s = this.scale;
    hands.forEach((h, i) => {
      const side: Hand = h === 'L' ? 'Left' : 'Right';
      const stick = inst.held![h]!;
      const sign = h === 'L' ? 1 : -1;
      const tipTarget = targets[i].clone().addScaledVector(UP, heights[i]);
      const shoulder = this.rig.pos(side === 'Left' ? 'LeftArm' : 'RightArm', V());
      // stroke comes from the wrist: the stick tilts up as it lifts
      const horiz = tipTarget.clone().sub(shoulder).setY(0).normalize();
      const stickDir = horiz.clone().multiplyScalar(0.9).addScaledVector(UP, -0.35 - heights[i] * 1.2).addScaledVector(this.torso.x, -sign * 0.25).normalize();
      const tipLocal = (stick.getObjectByName('anchor_tip') as Object3D).position;
      const grip = tipTarget.clone().addScaledVector(stickDir, -tipLocal.z);
      stick.position.copy(grip);
      stick.quaternion.copy(new Basis().fromZY(stickDir, UP).q);
      stick.updateMatrixWorld(true);
      const dir = V().crossVectors(UP, stickDir).multiplyScalar(-sign).addScaledVector(stickDir, 0.35).normalize();
      const palm = V().copy(UP).negate().addScaledVector(stickDir, 0.1).normalize();
      // fingers squeeze on impact, relax as the stick rebounds
      const pose = this.pose(side, 'stick');
      const squeeze = Math.exp(-Math.max(0, since[i]) / 0.08) * 0.15;
      for (const fk of FINGERS_ORDER) pose[fk][1] += squeeze;
      this.hold(side, grip.clone().addScaledVector(UP, 0.015 * s), dir, palm, this.rd(sign * 0.9, -0.8, -0.3, V()), pose, { smooth: 40 });
    });
  }

  private bassDrum(f: FrameState, t: number) {
    const inst = this.inst!;
    const plan = this.plan(f);
    const st = plan?.hits?.length ? stickHeight(plan, 1, t, 0.2) : { h: 0.2, target: 0, since: Infinity };
    const st2 = plan?.hits?.length ? stickHeight(plan, 0, t, 0.2) : st;
    const h = Math.min(st.h, st2.h);
    this.posture(f, { lean: 0.08, headPitch: 0.1, headYaw: 0.25 });
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
    this.hold('Right', grip, dir, this.rd(0, -1, 0, V()), this.rd(-0.9, -0.8, -0.2, V()), this.pose('Right', 'stick'));
    const rest = inst.anchors.rest_L.getWorldPosition(V());
    this.hold('Left', rest, this.rd(0.2, 0.5, 1, V()), this.rd(1, 0, 0.2, V()), this.rd(0.8, -0.6, -0.4, V()), this.pose('Left', 'open'));
  }

  private cymbals(f: FrameState, t: number) {
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
      const face = this.rd(-sign, 0, flourish * 0.9, V());
      const pos = center.clone().addScaledVector(this.rd(1, 0, 0, V()), sign * (gap / 2 + 0.04 + flourish * 0.15));
      plate.position.copy(pos);
      plate.quaternion.copy(new Basis().fromZY(face, UP).q);
      plate.updateMatrixWorld(true);
      const c = inst.grips[h]!.anchor.getWorldPosition(V()).addScaledVector(face, -0.03);
      this.hold(h === 'L' ? 'Left' : 'Right', c, UP.clone(), face.clone().negate(), this.rd(sign, -0.7, -0.4, V()), this.pose(h === 'L' ? 'Left' : 'Right', 'wrap'));
    }
  }

  private triangle(f: FrameState, t: number) {
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
    this.hold('Left', hang.clone().addScaledVector(UP, 0.02), this.rd(-0.3, 0.2, 1, V()), this.rd(-1, 0, 0, V()), this.rd(0.8, -0.8, -0.2, V()), this.pose('Left', 'wrap'));
    const beater = inst.held!.R!;
    const hit = this.rp(0.12 * s, this.rig.measure.shoulderHeight - 0.08, 0.38, V());
    const tip = hit.addScaledVector(this.rd(-1, 0.2, 0, V()), 0.02 + st.h * 0.6);
    const dir = this.rd(1, -0.1, 0.3, V());
    const grip = tip.clone().addScaledVector(dir, -0.2);
    beater.position.copy(grip);
    beater.quaternion.copy(new Basis().fromZY(dir, UP).q);
    beater.updateMatrixWorld(true);
    this.hold('Right', grip, this.rd(0.2, -0.3, 1, V()), this.rd(0, -1, 0, V()), this.rd(-0.9, -0.8, -0.2, V()), this.pose('Right', 'stick'));
  }

  private harp(f: FrameState, t: number) {
    const inst = this.inst!;
    this.posture(f, { lean: 0.12, twist: 0.1, headPitch: 0.15, headYaw: 0.35, kneesApart: 1.6 });
    const s = this.scale;
    const tilt = _q.setFromAxisAngle(this.rd(1, 0, 0, V()), -0.28);
    inst.root.quaternion.copy(this.root.quaternion).premultiply(tilt);
    inst.root.position.copy(this.rp(-0.1 * s, 0, 0.42, V()));
    inst.root.updateMatrixWorld(true);
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
      a.addScaledVector(this.rd(0, 0.35, 1, V()), (0.5 - u) * 0.35 * s);
      const pluck = list.length ? Math.max(0, 1 - (t - list[0].start) / 0.18) : 0;
      const key = side === 'Left' ? 'pluckL' : 'pluckR';
      this.s[key] = this.sm(this.s[key], pluck, 30);
      const sign = side === 'Left' ? 1 : -1;
      a.addScaledVector(this.rd(sign, 0, 0, V()), 0.02 + this.s[key] * 0.03);
      const pose = blendPose(POSES.open, POSES.pluck, this.s[key], this.scratch[side]);
      this.hold(side, a, this.rd(0, 0.3, 1, V()), this.rd(-sign, 0, 0, V()), this.rd(sign * 0.9, -0.7, -0.4, V()), pose, { smooth: 40 });
    }
  }

  // ------------------------------------------------------------------ conductor

  private conductor(f: FrameState, t: number) {
    const beats = f.beats;
    const active = f.loaded && (f.playing || (t > (f.beats[0]?.time ?? 0) - 1.5 && t < (beats[beats.length - 1]?.time ?? 0) + 1));
    this.s.arms = this.sm(this.s.arms, active ? 1 : 0, 3);
    const loud = this.s.loud;
    const scan = noise1(f.wall * 0.12 + 3) * 0.35;
    this.s.cue = this.sm(this.s.cue, 0, 1.5);
    this.posture(f, { lean: 0.05 + loud * 0.1, twist: scan * 0.5 * this.s.arms + this.s.cueYaw * this.s.cue * 0.5, headPitch: 0.08, headYaw: scan + this.s.cueYaw * this.s.cue });
    const s = this.scale;
    const T = this.torso;
    // the gesture leads the sound slightly, as real conductors do
    const lead = t + 0.06;
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beats[mid].time <= lead) lo = mid + 1;
      else hi = mid;
    }
    const bi = lo - 1;
    // gesture size follows the dynamics, and shrinks for quick beats
    const beatDur = beats[Math.max(0, bi)]?.duration ?? 0.6;
    const size = Math.min(1, 0.45 + beatDur / 1.1);
    const amp = (0.11 + 0.2 * loud) * size;
    const width = (0.14 + 0.18 * loud) * size;
    let x = 0;
    let y = 0;
    let vy = 0;
    if (bi >= 0 && bi < beats.length) {
      const b = beats[bi];
      const u = clamp01((lead - b.time) / Math.max(0.05, b.duration));
      const p0 = ictus(b.beatsPerBar, b.beatInBar, width);
      const nb = beats[bi + 1];
      const p1 = nb ? ictus(nb.beatsPerBar, nb.beatInBar, width) : [0, 0];
      // horizontal travel eases between ictus points; vertically the hand rebounds after the
      // ictus, floats, then accelerates down into the next one
      const e = u * u * (3 - 2 * u);
      x = p0[0] + (p1[0] - p0[0]) * e;
      const bounce = (uu: number) => Math.sin(Math.PI * Math.pow(uu, 0.75)) * (1 - 0.25 * uu);
      y = p0[1] + (p1[1] - p0[1]) * u + amp * bounce(u);
      vy = amp * (bounce(Math.min(1, u + 0.02)) - bounce(u)) / 0.02;
    } else if (beats.length && lead < beats[0].time) {
      const u = clamp01(1 - (beats[0].time - lead) / Math.max(0.3, beats[0].duration));
      y = amp * Math.sin(Math.PI * u) * 1.2;
    }
    // wrist flick: the baton tip trails on the way down and snaps through the ictus
    this.s.batonFlick = this.sm(this.s.batonFlick, clamp01(-vy * 0.35) - clamp01(vy * 0.2), 20);
    // ictus around the sternum, rebounds rise toward the chin in loud passages
    const baseY = this.rig.measure.shoulderHeight - 0.17 * s;
    const hand = T.point(-0.2 * s + x, 0, 0.44 * s, V());
    hand.y = this.root.position.y + baseY + y * this.s.arms;
    const restR = this.rp(-0.2 * s, this.rig.measure.hipHeight - 0.02, 0.12, V());
    hand.lerp(restR, 1 - this.s.arms);
    const flick = this.s.batonFlick;
    const dirR = T.dir(0.3, 0.1 - flick * 0.5, 1, V());
    const palmR = T.dir(0.45, -0.85, 0.15, V());
    this.hold('Right', hand, dirR, palmR, T.dir(-0.9, -0.6, -0.2, V()), blendPose(POSES.relaxed, POSES.baton, 0.3 + 0.7 * this.s.arms, this.scratch.Right), { twist: 0.7 });
    const baton = this.props.getObjectByName('baton')!;
    const handBone = this.rig.bones.RightHand!;
    const palmCenter = handBone.getWorldPosition(V()).addScaledVector(dirR, this.rig.hands.Right.palm * 0.55);
    // the baton butt rests in the palm and leaves the hand between thumb and index finger
    baton.position.copy(palmCenter).addScaledVector(palmR, 0.022 * s).addScaledVector(T.x, 0.012 * s);
    baton.quaternion.copy(new Basis().fromZY(T.dir(0.4, 0.25 - flick * 0.7 + y * 0.15, 1, V()), T.y).q);
    baton.updateMatrixWorld(true);

    // left hand: mirrors in big tutti moments, shapes crescendos (palm up) and diminuendos
    // (palm down), points at sections it cues, otherwise rests at the waist
    const mirror = clamp01((loud - 0.65) * 3) * this.s.arms;
    const handL = T.point(0.2 * s - x * 0.7, 0, 0.36 * s, V());
    handL.y = this.root.position.y + baseY + y * 0.6 + 0.06;
    const restL = T.point(0.12 * s, -0.14 * s, 0.18 * s, V());
    const cue = this.s.cue * this.s.arms;
    const expressive = Math.max(mirror, cue);
    handL.lerp(restL, 1 - expressive);
    if (cue > 0.05) handL.addScaledVector(T.dir(-this.s.cueYaw, 0.2, 1, V()), 0.15 * cue);
    const trend = this.s.trend;
    const palmL = T.dir(-0.4, -0.3 - mirror * 0.4 + trend * 1.6, 0.6, V());
    let poseL = blendPose(POSES.rest, POSES.open, expressive, this.scratch.Left);
    if (cue > 0.3) poseL = blendPose(poseL, POSES.point, (cue - 0.3) / 0.7, poseL);
    this.hold('Left', handL, T.dir(0.3, 0.4, 1, V()), palmL, T.dir(0.9, -0.6, -0.2, V()), poseL, { smooth: 10 });
  }

  /** Conductor cue towards a stage position. */
  cue(worldPos: Vector3) {
    const local = worldPos.clone().applyMatrix4(_inv.copy(this.root.matrixWorld).invert());
    this.s.cueYaw = Math.atan2(local.x, local.z) * 0.8;
    this.s.cue = 1;
  }

  headWorld(out: Vector3): Vector3 {
    return this.rig.pos('Head', out);
  }
}

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
