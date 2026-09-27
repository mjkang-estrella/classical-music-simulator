import { Color, Group, Material, Mesh, MeshStandardMaterial, Raycaster, Vector3, type Camera } from 'three';
import { Actor } from '../animation/actor';
import type { FrameState } from '../animation/frame';
import { buildPlans, type Plans } from '../animation/plans';
import { materialsForSection } from '../assets/instrumentFactory';
import { buildSeatingProps } from '../assets/props';
import { loudnessAt } from '../music/midiLoader';
import type { Note, PieceMeta, Score, SectionId } from '../music/types';
import { NoteIndex } from '../music/noteIndex';
import { buildEnsemble, type Musician } from '../orchestra/ensemble';
import { PODIUM } from '../orchestra/seating';
import { SECTIONS } from '../orchestra/sections';

/** A score with no notes that seats a full classical orchestra (shown before a piece is chosen). */
function emptyScore(): Score {
  const sections: SectionId[] = ['violin1', 'violin2', 'viola', 'cello', 'bass', 'flute', 'oboe', 'clarinet', 'bassoon', 'horn', 'trumpet', 'trombone', 'timpani'];
  const drivers: Score['drivers'] = {};
  for (const s of sections) drivers[s] = [`idle-${s}`];
  return { pieceId: 'idle', parts: [], duration: 0, beats: [], drivers };
}

/**
 * Owns every performer on stage. Rebuilt when a piece is loaded; updated once per frame.
 */
export class Orchestra {
  readonly group = new Group();
  actors: Actor[] = [];
  conductor: Actor | null = null;
  musicians: Musician[] = [];
  plans: Plans = new Map();
  indexes = new Map<string, NoteIndex>();
  score: Score | null = null;
  private props: Group | null = null;
  private readonly raycaster = new Raycaster();
  private readonly frame: FrameState = {
    t: 0,
    wall: 0,
    dt: 0,
    playing: false,
    loaded: false,
    plans: new Map(),
    indexes: new Map(),
    active: new Map(),
    loud: new Map(),
    beats: [],
    camera: new Vector3(),
    firstNote: 0,
    beatIndex: -1,
    beatPhase: 0,
    sinceDownbeat: Infinity,
    jumped: true,
  };
  private highlight: SectionId | null = null;
  private dimAmount = 0;
  private cueCursor = new Map<string, number>();
  version = 0;

  constructor() {
    this.group.name = 'orchestra';
  }

  build(score: Score | null, meta: Pick<PieceMeta, 'ensemble' | 'players'> = { ensemble: 'full' }) {
    this.clear();
    const s = score ?? emptyScore();
    this.score = score;
    this.musicians = buildEnsemble(s, meta);
    this.plans = score ? buildPlans(score) : new Map();
    this.indexes = new Map((score?.parts ?? []).map((p) => [p.id, new NoteIndex(p.notes)]));
    for (const m of this.musicians) {
      const actor = new Actor(m, new Vector3(m.seat.x, m.seat.y, m.seat.z), m.seat.yaw, m.instrument, m.seat.kind);
      this.actors.push(actor);
      this.group.add(actor.root, actor.props);
    }
    this.conductor = new Actor(null, new Vector3(PODIUM.x, PODIUM.height, PODIUM.z), Math.PI, 'conductor', 'standing');
    this.group.add(this.conductor.root, this.conductor.props);
    this.props = buildSeatingProps(this.musicians.map((m) => m.seat));
    this.group.add(this.props);
    this.frame.plans = this.plans;
    this.frame.indexes = this.indexes;
    this.frame.beats = score?.beats ?? [];
    this.frame.loaded = !!score;
    this.frame.firstNote = score ? Math.min(...score.parts.map((p) => p.notes[0]?.start ?? Infinity)) : 0;
    this.cueCursor.clear();
    this.version++;
  }

  clear() {
    for (const a of this.allActors) {
      this.group.remove(a.root, a.props);
      a.collider.geometry.dispose();
    }
    if (this.props) {
      this.group.remove(this.props);
      // chairs / stands are rebuilt per piece; instrument & character geometry is shared and kept
      this.props.traverse((o) => (o as Mesh).geometry?.dispose());
    }
    this.actors = [];
    this.conductor = null;
    this.props = null;
  }

  get allActors(): Actor[] {
    return this.conductor ? [...this.actors, this.conductor] : this.actors;
  }

  actorById(id: string | null): Actor | null {
    if (!id) return null;
    if (id === 'conductor') return this.conductor;
    return this.actors.find((a) => a.musician?.id === id) ?? null;
  }

  /** milliseconds spent in the last update (debug / perf overlay) */
  lastUpdateMs = 0;

  update(t: number, wall: number, playing: boolean, camera: Camera, selectedId: string | null) {
    const t0 = performance.now();
    this.updateInner(t, wall, playing, camera, selectedId);
    this.lastUpdateMs = this.lastUpdateMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  private updateInner(t: number, wall: number, playing: boolean, camera: Camera, selectedId: string | null) {
    const f = this.frame;
    f.dt = wall - f.wall;
    f.jumped = Math.abs(t - f.t) > 0.3 + Math.max(0, f.dt) * 2;
    f.t = t;
    // beat bookkeeping (shared by every performer)
    const beats = f.beats;
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beats[mid].time <= t) lo = mid + 1;
      else hi = mid;
    }
    f.beatIndex = lo - 1;
    const b = beats[f.beatIndex];
    f.beatPhase = b ? Math.min(1, (t - b.time) / Math.max(0.05, b.duration)) : 0;
    let db = f.beatIndex;
    while (db >= 0 && beats[db].beatInBar !== 0) db--;
    f.sinceDownbeat = db >= 0 ? t - beats[db].time : Infinity;
    f.wall = wall;
    f.playing = playing;
    f.camera.copy(camera.position);
    f.active.clear();
    f.loud.clear();
    if (this.score) {
      for (const p of this.score.parts) {
        const idx = this.indexes.get(p.id)!;
        f.active.set(p.id, idx.active(t, []) as Note[]);
        f.loud.set(p.id, loudnessAt(p.loudness, t));
      }
      this.updateCues(t);
    }
    const cam = camera.position;
    for (const a of this.actors) {
      a.distance = cam.distanceTo(a.root.position);
      // far musicians animate every other frame
      const skip = a.distance > 22 && a.musician?.id !== selectedId && (Math.floor(wall * 60) + (a.musician?.index ?? 0)) % 2 === 1;
      if (!skip) a.update(f);
      this.applyLod(a);
    }
    this.conductor?.update(f);
    this.animateHighlight(f.dt);
  }

  private applyLod(a: Actor) {
    const lods = a.char.lods;
    if (lods.length <= 1) return;
    const level = a.distance < 9 ? 0 : a.distance < 20 ? 1 : 2;
    const chosen = Math.min(level, lods.length - 1);
    lods.forEach((meshes, i) => meshes.forEach((m) => (m.visible = i === chosen)));
  }

  /** Conductor cues sections that enter after a long rest. */
  private updateCues(t: number) {
    if (!this.conductor || !this.score) return;
    for (const [section, ids] of Object.entries(this.score.drivers) as [SectionId, string[]][]) {
      const plan = this.plans.get(ids[0]);
      if (!plan) continue;
      let i = this.cueCursor.get(section) ?? 0;
      const phrases = plan.phrases;
      while (i < phrases.length && phrases[i][0] < t - 0.1) i++;
      this.cueCursor.set(section, i);
      const next = phrases[i];
      if (!next) continue;
      const prevEnd = i > 0 ? phrases[i - 1][1] : -Infinity;
      if (next[0] - prevEnd > 5 && next[0] - t < 0.6 && next[0] - t > 0.3) {
        const actor = this.actors.find((a) => a.musician?.section === section);
        if (actor) this.conductor.cue(actor.root.position);
      }
    }
  }

  pick(ndcX: number, ndcY: number, camera: Camera): Actor | null {
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY } as never, camera);
    const colliders = this.allActors.map((a) => a.collider);
    const hits = this.raycaster.intersectObjects(colliders, false);
    return (hits[0]?.object.userData.actor as Actor | undefined) ?? null;
  }

  /** debug: show / hide chairs and music stands */
  setStandsVisible(v: boolean) {
    if (this.props) this.props.visible = v;
  }

  setHighlight(section: SectionId | null) {
    this.highlight = section;
  }

  private animateHighlight(dt: number) {
    const target = this.highlight ? 1 : 0;
    const prev = this.dimAmount;
    this.dimAmount += (target - this.dimAmount) * (1 - Math.exp(-8 * Math.max(0.001, dt)));
    if (Math.abs(prev - this.dimAmount) < 1e-4 && this.lastApplied === this.highlight) return;
    this.lastApplied = this.highlight;
    for (const id of [...Object.keys(SECTIONS), 'conductor']) {
      const dim = this.highlight && id !== this.highlight ? this.dimAmount : 0;
      const glow = this.highlight && id === this.highlight ? this.dimAmount : 0;
      for (const mat of materialsForSection(id)) applyDim(mat, dim, glow);
    }
  }
  private lastApplied: SectionId | null = null;

  /** Position to frame the camera on for a section (centroid of its players). */
  sectionCentroid(section: SectionId): Vector3 | null {
    const list = this.actors.filter((a) => a.musician?.section === section);
    if (!list.length) return null;
    const c = new Vector3();
    for (const a of list) c.add(a.root.position);
    return c.divideScalar(list.length);
  }
}

function applyDim(mat: Material, dim: number, glow: number) {
  const m = mat as MeshStandardMaterial;
  const base = m.userData.base as MeshStandardMaterial | undefined;
  if (!base || !m.color) return;
  m.color.copy(base.color).multiplyScalar(1 - 0.78 * dim);
  if (m.emissive) {
    const baseE = base.emissive ?? new Color(0, 0, 0);
    m.emissive.copy(baseE).lerp(_warm, glow * 0.025);
  }
}

const _warm = new Color('#ffcf8a');

export const orchestra = new Orchestra();
