import type { SectionId } from '../music/types';
import { SECTIONS } from '../orchestra/sections';

/**
 * Valve combinations for a sounding pitch. Brass instruments play the harmonic series of the
 * open tube; each valve (2 = one semitone, 1 = two, 3 = three) lowers it. We pick the partial
 * that needs the fewest semitones of lowering, like a real player's default fingering.
 */
const COMBOS: [boolean, boolean, boolean][] = [
  [false, false, false], // 0
  [false, true, false], // 1: 2
  [true, false, false], // 2: 1
  [true, true, false], // 3: 1+2
  [false, true, true], // 4: 2+3
  [true, false, true], // 5: 1+3
  [true, true, true], // 6: 1+2+3
];

function partials(fundamental: number): number[] {
  // harmonic series in semitones above the fundamental
  const steps = [0, 12, 19, 24, 28, 31, 34, 36, 38, 40, 42, 43, 44, 46, 47, 48];
  return steps.map((s) => fundamental + s);
}

const OPEN: Partial<Record<SectionId, number[]>> = {
  trumpet: partials(46).slice(1), // B♭ trumpet (sounding B♭2 pedal)
  horn: partials(29).slice(1), // F horn (sounding F1 pedal)
  tuba: partials(22), // BB♭ tuba
};

export function valvesFor(section: SectionId, pitch: number): [boolean, boolean, boolean] {
  const open = OPEN[section];
  if (!open) return COMBOS[0];
  let best = 6;
  for (const p of open) {
    const lower = p - pitch;
    if (lower >= 0 && lower < best) best = lower;
  }
  return COMBOS[Math.min(6, Math.max(0, best))];
}

/**
 * Tone-hole pattern for woodwinds, [L index, L middle, L ring, R index, R middle, R ring].
 * Like a simple-system fingering, more fingers lift as the note rises through the octave.
 */
const SCALE_HOLES = [6, 6, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0];

export function keysFor(section: SectionId, pitch: number): boolean[] {
  const low = SECTIONS[section].range[0];
  const deg = (((pitch - low) % 12) + 12) % 12;
  // overblown register: the octave key / thumb changes but the pattern repeats
  const closed = SCALE_HOLES[deg];
  const keys = [0, 1, 2, 3, 4, 5].map((i) => i < closed);
  // cross-fingerings on chromatic notes: an extra finger down lower in the stack
  if ([1, 3, 6, 8, 10].includes(deg) && closed < 6) keys[Math.min(5, closed + 1)] = true;
  return keys;
}

/**
 * Left-hand position on a bowed string: which semitone above the open string the hand's first
 * finger sits at, and which finger (0 = open string, 1–4) stops the note.
 * Uses the standard first-position finger patterns and shifts up the neck beyond them.
 */
const UPPER_PATTERN = [0, 1, 1, 2, 2, 3, 3, 4]; // violin / viola: fingers roughly a tone apart
const LOWER_PATTERN = [0, 1, 1, 2, 3, 4]; // cello / bass: fingers a semitone apart

export function stringFingering(section: SectionId, pitch: number, openPitch: number): { handSemi: number; finger: number } {
  const semis = Math.max(0, pitch - openPitch);
  const pattern = section === 'cello' || section === 'bass' ? LOWER_PATTERN : UPPER_PATTERN;
  const reach = pattern.length - 1;
  if (semis <= reach) return { handSemi: 1, finger: pattern[semis] };
  // shift so the note falls under the 3rd finger of the new position
  const shift = semis - (reach - 2);
  return { handSemi: 1 + shift, finger: pattern[reach - 2] || 3 };
}
