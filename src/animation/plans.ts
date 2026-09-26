import type { NoteIndex } from '../music/noteIndex';
import type { Note, Part, Score, SectionId } from '../music/types';
import { SECTIONS } from '../orchestra/sections';

/** A single bow stroke: bow position s (0 = frog, 1 = tip) moves s0 → s1 over [t0, t1]. */
export interface Stroke {
  t0: number;
  t1: number;
  s0: number;
  s1: number;
  string: number;
  pitch: number;
  pizz: boolean;
}

export interface Hit {
  t: number;
  hand: 0 | 1;
  target: number;
  velocity: number;
}

export interface PartPlan {
  part: Part;
  /** [start, end] of phrases (notes joined across short rests) */
  phrases: [number, number][];
  strokes?: Stroke[];
  strokeStarts?: Float64Array;
  hits?: Hit[];
  hitTimes?: Float64Array;
}

export function sortedSearch(arr: Float64Array, t: number): number {
  // index of last element <= t (or -1)
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function phrasesOf(notes: Note[], gap: number): [number, number][] {
  const out: [number, number][] = [];
  let cur: [number, number] | null = null;
  const byStart = notes;
  let maxEnd = -Infinity;
  for (const n of byStart) {
    if (!cur || n.start - maxEnd > gap) {
      if (cur) out.push(cur);
      cur = [n.start, n.end];
      maxEnd = n.end;
    } else {
      maxEnd = Math.max(maxEnd, n.end);
      cur[1] = maxEnd;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Collapse chords into single events (top note), in start order. */
function events(notes: Note[]): { start: number; end: number; pitch: number; low: number; velocity: number }[] {
  const ev: { start: number; end: number; pitch: number; low: number; velocity: number }[] = [];
  for (const n of notes) {
    const last = ev[ev.length - 1];
    if (last && n.start - last.start < 0.025) {
      last.end = Math.max(last.end, n.end);
      last.pitch = Math.max(last.pitch, n.pitch);
      last.low = Math.min(last.low, n.pitch);
      last.velocity = Math.max(last.velocity, n.velocity);
    } else {
      ev.push({ start: n.start, end: n.end, pitch: n.pitch, low: n.pitch, velocity: n.velocity });
    }
  }
  return ev;
}

export function stringFor(section: SectionId, pitch: number): number {
  const open = SECTIONS[section].strings ?? [55, 62, 69, 76];
  let k = 0;
  for (let i = 0; i < open.length; i++) if (pitch >= open[i]) k = i;
  // prefer staying low in the position: if a lower string reaches within a fifth, use it for lyric notes
  return k;
}

/**
 * Détaché bowing: direction alternates per note, stroke length follows duration and dynamics,
 * the bow never runs off either end, and short rests lift the bow.
 */
export function planBowing(part: Part): Stroke[] {
  const pizz = part.program === 45;
  const ev = events(part.notes);
  const strokes: Stroke[] = [];
  let s = 0.25;
  let dir = 1;
  let lastEnd = -Infinity;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    const next = ev[i + 1];
    const dur = Math.max(0.04, Math.min(e.end, next ? next.start : e.end) - e.start);
    const restBefore = e.start - lastEnd;
    if (restBefore > 1.2) {
      // new phrase: loud entries start down-bow near the frog, soft ones up-bow from the middle
      dir = e.velocity > 0.6 ? 1 : -1;
      s = dir > 0 ? 0.12 : 0.62;
    } else {
      dir = -dir;
    }
    const speed = 0.35 + 0.9 * e.velocity; // bow lengths per second
    let len = Math.min(0.85, Math.max(0.05, dur * speed * (dur < 0.2 ? 1.6 : 1)));
    if (dur < 0.12) len = Math.min(len, 0.12);
    let s1 = s + dir * len;
    if (s1 > 0.95 || s1 < 0.05) {
      // not enough bow left: bounce back in the other direction
      dir = -dir;
      s1 = Math.min(0.95, Math.max(0.05, s + dir * len));
    }
    const pitchForString = Math.round((e.pitch + e.low) / 2);
    strokes.push({ t0: e.start, t1: e.start + dur, s0: s, s1, string: stringFor(part.section, pitchForString), pitch: e.pitch, pizz });
    s = s1;
    lastEnd = e.start + dur;
  }
  return strokes;
}

/** Timpani / percussion sticking: alternate hands, rolls when notes repeat quickly. */
export function planHits(part: Part, targetOf: (n: Note) => number, singleHand = false): Hit[] {
  const hits: Hit[] = [];
  let hand: 0 | 1 = 1;
  let prevT = -Infinity;
  let prevTarget = -1;
  for (const n of part.notes) {
    if (hits.length && n.start - prevT < 0.012) continue; // flam / duplicate
    const target = targetOf(n);
    const fast = n.start - prevT < 0.35;
    // alternate on fast passages; lead with the right hand after a rest; cross over when moving drums
    if (singleHand) hand = 1;
    else if (fast) hand = hand === 1 ? 0 : 1;
    else hand = target === prevTarget || target >= 2 ? 1 : 0;
    hits.push({ t: n.start, hand, target, velocity: n.velocity });
    // sustained timpani notes are rolls: add alternating strokes
    const dur = n.end - n.start;
    if (!singleHand && dur > 0.9 && part.section === 'timpani') {
      for (let t = n.start + 0.075; t < n.end - 0.05; t += 0.075) {
        hand = hand === 1 ? 0 : 1;
        hits.push({ t, hand, target, velocity: n.velocity * 0.6 });
      }
    }
    prevT = n.start;
    prevTarget = target;
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

/** Timpani drum for a pitch: 4 drums tuned low → high from the player's left. */
export function timpaniDrum(pitch: number): number {
  if (pitch <= 42) return 0;
  if (pitch <= 46) return 1;
  if (pitch <= 50) return 2;
  return 3;
}

export function buildPlans(score: Score): Map<string, PartPlan> {
  const plans = new Map<string, PartPlan>();
  for (const part of score.parts) {
    const fam = SECTIONS[part.section].family;
    const gap = fam === 'strings' ? 4.5 : fam === 'brass' ? 2.4 : 2.0;
    const plan: PartPlan = { part, phrases: phrasesOf(part.notes, gap) };
    if (fam === 'strings' && part.section !== 'harp') {
      plan.strokes = planBowing(part);
      plan.strokeStarts = Float64Array.from(plan.strokes, (s) => s.t0);
    }
    if (part.section === 'timpani') {
      plan.hits = planHits(part, (n) => timpaniDrum(n.pitch));
      plan.hitTimes = Float64Array.from(plan.hits, (h) => h.t);
    }
    if (part.section === 'percussion') {
      plan.hits = planHits(part, () => 0, false);
      plan.hitTimes = Float64Array.from(plan.hits, (h) => h.t);
    }
    plans.set(part.id, plan);
  }
  return plans;
}

/** 0 → 1 when the instrument should be up (lead-in before a phrase, hold after it). */
export function raiseAmount(phrases: [number, number][], t: number, lead = 1.3, hold = 1.2, fade = 1.0): number {
  // binary search the phrase whose start is <= t + lead
  let lo = 0;
  let hi = phrases.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (phrases[mid][0] <= t + lead) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0) return 0;
  const [start, end] = phrases[i];
  let up = 0;
  if (t < start) up = smooth((t - (start - lead)) / (lead * 0.75));
  else if (t <= end + hold) up = 1;
  else up = 1 - smooth((t - end - hold) / fade);
  return up;
}

export function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** Bow state at time t from the plan. */
export function bowAt(plan: PartPlan, t: number): { s: number; stroke: Stroke | null; sounding: boolean; speed: number } {
  const strokes = plan.strokes!;
  const i = sortedSearch(plan.strokeStarts!, t);
  if (i < 0) return { s: strokes.length ? strokes[0].s0 : 0.3, stroke: strokes[0] ?? null, sounding: false, speed: 0 };
  const st = strokes[i];
  if (t <= st.t1) {
    const u = Math.min(1, (t - st.t0) / Math.max(1e-3, st.t1 - st.t0));
    // bow speed is nearly constant, with a softened start at each change of direction
    const e = u - 0.05 * Math.sin(2 * Math.PI * u);
    const s = st.s0 + (st.s1 - st.s0) * e;
    return { s, stroke: st, sounding: true, speed: (st.s1 - st.s0) / Math.max(1e-3, st.t1 - st.t0) };
  }
  return { s: st.s1, stroke: st, sounding: false, speed: 0 };
}

/** Height of a stick above its target for one hand (anticipation lift, contact, rebound). */
export function stickHeight(plan: PartPlan, hand: 0 | 1, t: number, restHeight = 0.18): { h: number; target: number; since: number } {
  const hits = plan.hits!;
  const i = sortedSearch(plan.hitTimes!, t);
  let prev: Hit | null = null;
  for (let k = i; k >= 0 && k > i - 40; k--) {
    if (hits[k].hand === hand) {
      prev = hits[k];
      break;
    }
  }
  let next: Hit | null = null;
  for (let k = i + 1; k < hits.length && k < i + 40; k++) {
    if (hits[k].hand === hand) {
      next = hits[k];
      break;
    }
  }
  const lift = (v: number) => 0.07 + 0.2 * v;
  // rebound after the previous stroke: 0 at contact, up to the lift height, then settle at rest
  let since = Infinity;
  let up = restHeight;
  if (prev) {
    since = t - prev.t;
    const L = lift(prev.velocity);
    up = L * (1 - Math.exp(-since / 0.05)) + (restHeight - L) * (1 - Math.exp(-since / 0.6));
  }
  // anticipation before the next stroke: comes down to 0 exactly on the note
  let down = Infinity;
  let target = prev?.target ?? next?.target ?? 1;
  if (next) {
    const tau = next.t - t;
    const window = Math.min(0.28, Math.max(0.05, prev ? (next.t - prev.t) * 0.9 : 0.28));
    const L = lift(next.velocity);
    down = tau < window ? L * Math.pow(tau / window, 0.7) : L + (tau - window) * 1.2;
    if (!prev || tau < window * 1.5 || since > 0.5) target = next.target;
  }
  const h = Math.min(up, down);
  return { h: Math.max(0, h), target, since };
}

export type Plans = Map<string, PartPlan>;
export type Indexes = Map<string, NoteIndex>;
