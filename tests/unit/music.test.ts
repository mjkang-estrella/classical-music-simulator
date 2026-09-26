import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScore, parseMidi } from '../../src/music/midiLoader';
import { NoteIndex } from '../../src/music/noteIndex';
import { buildBeats, conductedPattern } from '../../src/music/tempoMap';
import type { Note, PieceMeta, SectionId } from '../../src/music/types';

const musicDir = join(__dirname, '..', '..', 'public', 'music');
const library = JSON.parse(readFileSync(join(musicDir, 'library.json'), 'utf8')).pieces as PieceMeta[];

function load(id: string) {
  const meta = library.find((p) => p.id === id)!;
  return buildScore(parseMidi(readFileSync(join(musicDir, meta.file))), meta);
}

function sections(id: string): Record<number, SectionId> {
  return Object.fromEntries(load(id).parts.map((p) => [p.trackIndex, p.section]));
}

describe('track → section mapping on the real library', () => {
  it('Beethoven 5: GM 69 tracks become horn and trumpet via overrides', () => {
    expect(sections('beethoven-5-i')).toEqual({
      0: 'flute', 1: 'oboe', 2: 'clarinet', 3: 'bassoon', 4: 'horn', 5: 'trumpet', 6: 'timpani',
      7: 'violin1', 8: 'violin2', 9: 'viola', 10: 'cello', 11: 'bass',
    });
  });

  it('Dvořák 9: GM 48 strings are mapped by track name, cymbal kept', () => {
    const s = sections('dvorak-9-iv');
    expect([s[5], s[6], s[7], s[8], s[9]]).toEqual(['violin1', 'violin2', 'viola', 'cello', 'bass']);
    expect([s[10], s[11], s[12], s[4], s[13], s[14]]).toEqual(['horn', 'horn', 'trumpet', 'trombone', 'timpani', 'percussion']);
  });

  it('Mozart K525: unnamed violins by order, cellos also drive basses', () => {
    const score = load('mozart-k525-i');
    expect(sections('mozart-k525-i')).toEqual({ 0: 'violin1', 1: 'violin2', 2: 'viola', 3: 'cello' });
    expect(score.drivers.bass).toEqual(score.drivers.cello);
    expect(score.drivers.flute).toBeUndefined();
  });

  it('Coriolan: Italian names map cleanly', () => {
    expect(sections('beethoven-coriolan')).toEqual({
      0: 'flute', 1: 'oboe', 2: 'clarinet', 3: 'bassoon', 4: 'horn', 5: 'trumpet', 6: 'timpani',
      7: 'violin1', 8: 'violin2', 9: 'viola', 10: 'cello', 11: 'bass',
    });
  });

  it('Rossini: programs map, one violin track drives both violin sections, drum mapped', () => {
    const score = load('rossini-eduardo');
    const s = sections('rossini-eduardo');
    expect(s[0]).toBe('piccolo');
    expect([s[7], s[8]]).toEqual(['trombone', 'trombone']);
    expect(s[10]).toBe('percussion');
    expect(score.drivers.violin2).toEqual(score.drivers.violin1);
    expect(score.drivers.bass).toEqual(score.drivers.cello);
    const drums = score.parts.find((p) => p.section === 'percussion')!;
    expect(drums.notes.every((n) => n.drum === 'bassdrum')).toBe(true);
  });

  it('every library piece loads with a beat grid and normalised loudness', () => {
    for (const meta of library.filter((p) => !p.hidden)) {
      const score = load(meta.id);
      expect(score.parts.length).toBeGreaterThan(3);
      expect(score.beats.length).toBeGreaterThan(50);
      expect(score.duration).toBeGreaterThan(120);
      for (const p of score.parts) {
        const max = Math.max(...p.loudness);
        expect(max).toBeLessThanOrEqual(1);
        expect(max).toBeGreaterThan(0.1);
      }
    }
  });

  it('diagnostics piece: Italian track names map to every section', () => {
    const score = load('diagnostics');
    const secs = score.parts.map((p) => p.section);
    expect(secs).toEqual(['violin1', 'violin2', 'viola', 'cello', 'bass', 'flute', 'oboe', 'clarinet', 'bassoon', 'horn', 'trumpet', 'trombone', 'tuba', 'timpani', 'percussion']);
    expect(score.beats[1].time - score.beats[0].time).toBeCloseTo(60 / 96, 3);
  });

  it('Beethoven 5 (flat velocities) gets inferred dynamics', () => {
    const score = load('beethoven-5-i');
    const vels = new Set(score.parts.flatMap((p) => p.notes.map((n) => n.velocity.toFixed(2))));
    expect(vels.size).toBeGreaterThan(5);
  });
});

describe('NoteIndex', () => {
  function brute(notes: Note[], t: number) {
    return notes.filter((n) => n.start <= t && n.end > t);
  }

  it('matches a brute-force active-note query', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const notes: Note[] = [];
    for (let i = 0; i < 400; i++) {
      const start = rand() * 60;
      notes.push({ pitch: 40 + Math.floor(rand() * 40), start, end: start + 0.05 + rand() * rand() * 8, velocity: 0.8 });
    }
    notes.sort((a, b) => a.start - b.start);
    const idx = new NoteIndex(notes);
    for (let k = 0; k < 500; k++) {
      const t = rand() * 70 - 2;
      const got = idx.active(t).slice().sort((a, b) => a.start - b.start);
      expect(got).toEqual(brute(notes, t));
    }
  });

  it('finds neighbouring onsets', () => {
    const notes: Note[] = [0, 1, 2, 3].map((s) => ({ pitch: 60, start: s, end: s + 0.5, velocity: 1 }));
    const idx = new NoteIndex(notes);
    expect(idx.nextOnset(1)?.start).toBe(2);
    expect(idx.lastOnset(1)?.start).toBe(1);
    expect(idx.lastOnset(-1)).toBeNull();
    expect(idx.lastEndBefore(2.2)).toBe(2.5);
  });
});

describe('beat grid', () => {
  const ppq = 480;
  const constantTempo = (bpm: number) => (ticks: number) => (ticks / ppq) * (60 / bpm);

  it('4/4 at 120 → 4 beats per bar, 0.5 s apart', () => {
    const beats = buildBeats([{ ticks: 0, numerator: 4, denominator: 4 }], ppq, ppq * 16, constantTempo(120));
    expect(beats).toHaveLength(16);
    expect(beats[5]).toMatchObject({ bar: 1, beatInBar: 1, beatsPerBar: 4 });
    expect(beats[5].time).toBeCloseTo(2.5);
  });

  it('6/8 is conducted in 2', () => {
    expect(conductedPattern(6, 8, 0.3)).toEqual({ beats: 2, group: 3 });
    const beats = buildBeats([{ ticks: 0, numerator: 6, denominator: 8 }], ppq, ppq * 6, constantTempo(120));
    expect(beats.map((b) => b.beatInBar)).toEqual([0, 1, 0, 1]);
  });

  it('handles a mid-piece meter change', () => {
    const beats = buildBeats(
      [
        { ticks: 0, numerator: 3, denominator: 4 },
        { ticks: ppq * 6, numerator: 2, denominator: 4 },
      ],
      ppq,
      ppq * 10,
      constantTempo(100),
    );
    expect(beats.filter((b) => b.beatsPerBar === 3)).toHaveLength(6);
    expect(beats.filter((b) => b.beatsPerBar === 2)).toHaveLength(4);
  });
});
