import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bowAt, buildPlans, planBowing, raiseAmount, stickHeight } from '../../src/animation/plans';
import { buildScore, parseMidi } from '../../src/music/midiLoader';
import type { Part, PieceMeta } from '../../src/music/types';
import { buildEnsemble, playerCounts } from '../../src/orchestra/ensemble';
import { generateSeating, STAGE } from '../../src/orchestra/seating';

const musicDir = join(__dirname, '..', '..', 'public', 'music');
const library = JSON.parse(readFileSync(join(musicDir, 'library.json'), 'utf8')).pieces as PieceMeta[];
const load = (id: string) => {
  const meta = library.find((p) => p.id === id)!;
  return { meta, score: buildScore(parseMidi(readFileSync(join(musicDir, meta.file))), meta) };
};

describe('seating', () => {
  const counts = { violin1: 12, violin2: 10, viola: 8, cello: 8, bass: 6, flute: 2, oboe: 2, clarinet: 2, bassoon: 2, horn: 4, trumpet: 2, trombone: 3, tuba: 1, timpani: 1, percussion: 2, harp: 1, piccolo: 1 } as const;
  const seats = generateSeating(counts);

  it('seats exactly the requested players', () => {
    for (const [s, n] of Object.entries(counts)) expect(seats.filter((x) => x.section === s)).toHaveLength(n);
  });

  it('keeps everyone on stage and at least 0.55 m apart', () => {
    for (const s of seats) {
      expect(Math.abs(s.x)).toBeLessThan(STAGE.halfWidth);
      expect(s.z).toBeLessThan(STAGE.front);
      expect(s.z).toBeGreaterThan(STAGE.back);
    }
    for (let i = 0; i < seats.length; i++)
      for (let j = i + 1; j < seats.length; j++) {
        const d = Math.hypot(seats[i].x - seats[j].x, seats[i].z - seats[j].z);
        expect(d, `${seats[i].section}-${seats[i].index} vs ${seats[j].section}-${seats[j].index}`).toBeGreaterThan(0.55);
      }
  });

  it('follows American seating: first violins audience-left, cellos audience-right, brass behind winds', () => {
    const avg = (sec: string, k: 'x' | 'z') => {
      const list = seats.filter((s) => s.section === sec);
      return list.reduce((a, s) => a + s[k], 0) / list.length;
    };
    expect(avg('violin1', 'x')).toBeLessThan(-1);
    expect(avg('cello', 'x')).toBeGreaterThan(1);
    expect(avg('trumpet', 'z')).toBeLessThan(avg('flute', 'z'));
    expect(avg('timpani', 'z')).toBeLessThan(avg('trumpet', 'z'));
    // the concertmaster sits nearest the podium
    const v1 = seats.filter((s) => s.section === 'violin1');
    const dist = (s: { x: number; z: number }) => Math.hypot(s.x, s.z - 0.4);
    expect(dist(v1[0])).toBeLessThanOrEqual(Math.min(...v1.map(dist)) + 0.35);
  });

  it('winds and brass sit on risers', () => {
    for (const s of seats.filter((x) => ['clarinet', 'horn', 'trumpet', 'timpani'].includes(x.section))) expect(s.y).toBeGreaterThan(0.2);
  });
});

describe('ensemble', () => {
  it('a string serenade seats only strings', () => {
    const { meta, score } = load('mozart-k525-i');
    const m = buildEnsemble(score, meta);
    expect(new Set(m.map((x) => x.section))).toEqual(new Set(['violin1', 'violin2', 'viola', 'cello', 'bass']));
    // basses read the cello part
    const bass = m.find((x) => x.section === 'bass')!;
    const cello = m.find((x) => x.section === 'cello')!;
    expect(bass.partIds).toEqual(cello.partIds);
  });

  it('Dvořák splits four horns across the two horn parts', () => {
    const { meta, score } = load('dvorak-9-iv');
    expect(playerCounts(score, meta).horn).toBe(4);
    const horns = buildEnsemble(score, meta).filter((x) => x.section === 'horn');
    expect(new Set(horns.map((h) => h.partIds[0])).size).toBe(2);
    expect(horns.map((h) => h.voice)).toEqual([0, 1, 0, 1]);
  });

  it('gives every player a unique id and a label', () => {
    const { meta, score } = load('beethoven-egmont');
    const m = buildEnsemble(score, meta);
    expect(new Set(m.map((x) => x.id)).size).toBe(m.length);
    expect(m.find((x) => x.id === 'violin1-0')!.label).toBe('Concertmaster');
  });
});

describe('performance plans', () => {
  it('bowing alternates direction and stays on the hair', () => {
    const { score } = load('beethoven-5-i');
    const part = score.parts.find((p) => p.section === 'violin1')!;
    const strokes = planBowing(part);
    expect(strokes.length).toBeGreaterThan(100);
    let alternations = 0;
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      expect(s.s0).toBeGreaterThanOrEqual(0.04);
      expect(s.s0).toBeLessThanOrEqual(0.96);
      expect(s.s1).toBeGreaterThanOrEqual(0.04);
      expect(s.s1).toBeLessThanOrEqual(0.96);
      if (i > 0 && Math.sign(s.s1 - s.s0) !== Math.sign(strokes[i - 1].s1 - strokes[i - 1].s0)) alternations++;
      // the bow continues from where the last stroke ended
      if (i > 0 && s.t0 - strokes[i - 1].t1 < 1.2) expect(s.s0).toBeCloseTo(strokes[i - 1].s1, 6);
    }
    expect(alternations / strokes.length).toBeGreaterThan(0.6);
  });

  it('bowAt is continuous inside a stroke', () => {
    const { score } = load('mozart-k525-i');
    const plans = buildPlans(score);
    const plan = plans.get(score.parts[0].id)!;
    const st = plan.strokes![10];
    const mid = (st.t0 + st.t1) / 2;
    const a = bowAt(plan, mid).s;
    const b = bowAt(plan, mid + 0.001).s;
    expect(Math.abs(a - b)).toBeLessThan(0.02);
    expect(bowAt(plan, st.t0 + 1e-6).s).toBeCloseTo(st.s0, 2);
  });

  it('instruments come up before an entrance and go down in long rests', () => {
    const phrases: [number, number][] = [
      [10, 20],
      [40, 50],
    ];
    expect(raiseAmount(phrases, 5)).toBe(0);
    expect(raiseAmount(phrases, 9.9)).toBeGreaterThan(0.9);
    expect(raiseAmount(phrases, 15)).toBe(1);
    expect(raiseAmount(phrases, 30)).toBe(0);
  });

  it('timpani sticks touch the head exactly on the beat', () => {
    const { score } = load('beethoven-5-i');
    const plans = buildPlans(score);
    const timp = score.parts.find((p) => p.section === 'timpani') as Part;
    const plan = plans.get(timp.id)!;
    const hit = plan.hits![5];
    const at = stickHeight(plan, hit.hand, hit.t);
    expect(at.h).toBeLessThan(0.01);
    const before = stickHeight(plan, hit.hand, hit.t - 0.08);
    expect(before.h).toBeGreaterThan(at.h);
  });
});
