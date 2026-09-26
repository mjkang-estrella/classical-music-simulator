import type { DrumKind, PieceMeta, SectionId } from './types';

export interface TrackInfo {
  index: number;
  name: string;
  channel: number;
  program: number;
  noteCount: number;
  meanPitch: number;
}

/** Intermediate result: a section, or generic 'violin' resolved by order. */
type Guess = SectionId | 'violin' | null;

const NAME_RULES: [RegExp, Guess][] = [
  [/\b(violin|violino|vln?|vn|violine)\s*(1|i)\b|violin1|violino1|violinoi\b|primo/i, 'violin1'],
  [/\b(violin|violino|vln?|vn|violine)\s*(2|ii)\b|violin2|violino2|violinoii|secondo/i, 'violin2'],
  [/piccolo|ottavino|picc\b/i, 'piccolo'],
  [/contrabass(?!oon)|contrabasso|kontrabass|double ?bass|\bbass(i|o)?\b(?!oon)|\bcb\b|\bkb\b/i, 'bass'],
  [/viol(a|e)s?\b|viole|bratsche|\bvla\b|\bva\b/i, 'viola'],
  [/violoncell|cello|\bvc\b/i, 'cello'],
  [/violin|violino|violine|\bvl\b/i, 'violin'],
  [/flaut|flute|flöte|\bfl\b/i, 'flute'],
  [/obo[ei]|hautbois|\bob\b/i, 'oboe'],
  [/clarinet|klarinett|\bcl\b/i, 'clarinet'],
  [/fagott|bassoon|basson|\bbsn\b/i, 'bassoon'],
  [/\bcorn[oi]\b|corni|horn|\bhn\b/i, 'horn'],
  [/tromb[ae]\b|trumpet|trompete|tromba|\btpt?\b/i, 'trumpet'],
  [/trombon|posaune|\btbn\b/i, 'trombone'],
  [/tuba/i, 'tuba'],
  [/timpan|pauke|timbal/i, 'timpani'],
  [/harp|arpa|harfe/i, 'harp'],
  [/drum|cymbal|piatti|triang|tamburo|cassa|percuss|snare/i, 'percussion'],
];

export function guessFromName(name: string): Guess {
  const n = name.replace(/[:_]/g, ' ').trim();
  if (!n) return null;
  for (const [re, guess] of NAME_RULES) if (re.test(n)) return guess;
  return null;
}

export function guessFromProgram(program: number, channel: number, meanPitch: number): Guess {
  if (channel === 9) return 'percussion';
  if (program === 40 || program === 110) return 'violin';
  if (program === 41) return 'viola';
  if (program === 42) return 'cello';
  if (program === 43 || program === 32 || program === 33) return 'bass';
  if (program === 44 || program === 45 || (program >= 48 && program <= 51)) {
    // string ensemble / pizzicato: infer from register
    if (meanPitch >= 67) return 'violin';
    if (meanPitch >= 57) return 'viola';
    if (meanPitch >= 45) return 'cello';
    return 'bass';
  }
  if (program === 46) return 'harp';
  if (program === 47) return 'timpani';
  if (program === 56 || program === 59) return 'trumpet';
  if (program === 57) return 'trombone';
  if (program === 58) return 'tuba';
  if (program === 60 || program === 61) return 'horn';
  if (program === 68) return 'oboe';
  if (program === 69) return 'oboe'; // english horn
  if (program === 70) return 'bassoon';
  if (program === 71) return 'clarinet';
  if (program === 72) return 'piccolo';
  if (program === 73 || program === 74 || program === 75) return 'flute';
  if (program >= 112 && program <= 119) return 'percussion';
  if (program >= 0 && program <= 7) return meanPitch > 60 ? 'violin' : 'cello'; // piano reductions
  return null;
}

/**
 * Maps every track with notes to a section (or null to drop it).
 * Precedence: per-piece override → track name → GM program → ordinal/pitch disambiguation.
 */
export function mapTracks(tracks: TrackInfo[], overrides: PieceMeta['trackOverrides'] = {}): Map<number, SectionId | null> {
  const guesses = new Map<number, Guess | 'ignore'>();
  for (const t of tracks) {
    if (t.noteCount === 0) continue;
    const override = overrides[String(t.index)];
    if (override) {
      guesses.set(t.index, override);
      continue;
    }
    guesses.set(t.index, guessFromName(t.name) ?? guessFromProgram(t.program, t.channel, t.meanPitch));
  }

  // Generic violins: first → violin1, second → violin2, extra ones by pitch
  const generic = tracks.filter((t) => guesses.get(t.index) === 'violin');
  const hasV1 = [...guesses.values()].includes('violin1');
  const hasV2 = [...guesses.values()].includes('violin2');
  generic.forEach((t, i) => {
    let target: SectionId;
    if (!hasV1 && !hasV2) target = i === 0 ? 'violin1' : 'violin2';
    else if (!hasV1) target = 'violin1';
    else if (!hasV2) target = 'violin2';
    else target = t.meanPitch > 70 ? 'violin1' : 'violin2';
    guesses.set(t.index, target);
  });

  const result = new Map<number, SectionId | null>();
  for (const [idx, g] of guesses) result.set(idx, g === 'ignore' || g === 'violin' ? null : g);
  return result;
}

/** Sections that aren't written but should play along with another section. */
export function inferAlsoDrives(present: Set<SectionId>, explicit: PieceMeta['alsoDrives'] = {}): Partial<Record<SectionId, SectionId[]>> {
  const drives: Partial<Record<SectionId, SectionId[]>> = {};
  for (const [src, targets] of Object.entries(explicit) as [SectionId, SectionId[]][]) {
    drives[src] = targets.filter((t) => !present.has(t));
  }
  const add = (src: SectionId, target: SectionId) => {
    if (present.has(src) && !present.has(target)) {
      const list = (drives[src] ??= []);
      if (!list.includes(target)) list.push(target);
    }
  };
  // Classical scores often write cellos and basses on one staff.
  if (present.has('cello') && present.has('violin1')) add('cello', 'bass');
  if (present.has('violin1') && present.has('viola') && !present.has('violin2')) add('violin1', 'violin2');
  return drives;
}

/** General MIDI percussion key → orchestral percussion instrument. */
export function drumForKey(key: number, drumMap: PieceMeta['drumMap'] = {}): DrumKind | null {
  const mapped = drumMap[String(key)];
  if (mapped) return mapped;
  if (key === 35 || key === 36) return 'bassdrum';
  if (key === 38 || key === 40 || key === 37) return 'snare';
  if (key === 49 || key === 57 || key === 55 || key === 52) return 'cymbals';
  if (key === 51 || key === 59 || key === 53) return 'suspended';
  if (key === 80 || key === 81) return 'triangle';
  if (key === 41 || key === 43 || key === 45 || key === 47 || key === 48 || key === 50) return 'bassdrum';
  return null;
}
