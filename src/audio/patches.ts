import type { DrumKind, SectionId } from '../music/types';

export type Patch =
  | { lib: 'soundfont'; name: string; gain: number; loop: boolean }
  | { lib: 'vcsl'; name: string; gain: number; key?: number }
  | { lib: 'smolken'; name: 'Arco' | 'Pizzicato'; gain: number };

// loop data only exists for some MusyngKite instruments (clarinet, horn, trombone, tuba and
// string_ensemble_1 have none), so those load without it
const sf = (name: string, gain = 1, loop = true): Patch => ({ lib: 'soundfont', name, gain, loop });
const vcsl = (name: string, gain = 1, key?: number): Patch => ({ lib: 'vcsl', name, gain, key });

/** Patch per section. The section decides the sound, not the (often wrong) GM program. */
export function patchFor(section: SectionId, program: number, drum?: DrumKind): Patch {
  const pizz = program === 45;
  switch (section) {
    case 'violin1':
    case 'violin2':
      return pizz ? sf('pizzicato_strings', 1, false) : sf('violin', 1.15);
    case 'viola':
      return pizz ? sf('pizzicato_strings', 1, false) : sf('viola', 1.1);
    case 'cello':
      return pizz ? sf('pizzicato_strings', 1, false) : sf('cello', 1.15);
    case 'bass':
      return { lib: 'smolken', name: pizz ? 'Pizzicato' : 'Arco', gain: 1.1 };
    case 'harp':
      return vcsl('Chordophones/Composite Chordophones/Concert Harp', 1.2);
    case 'piccolo':
      return sf('piccolo', 0.7);
    case 'flute':
      return sf('flute', 0.85);
    case 'oboe':
      return sf(program === 69 ? 'english_horn' : 'oboe', 0.75);
    case 'clarinet':
      return sf('clarinet', 0.8, false);
    case 'bassoon':
      return sf('bassoon', 0.9);
    case 'horn':
      return sf('french_horn', 0.8, false);
    case 'trumpet':
      return sf('trumpet', 0.6);
    case 'trombone':
      return sf('trombone', 0.7, false);
    case 'tuba':
      return sf('tuba', 0.8, false);
    case 'timpani':
      return vcsl('Membranophones/Struck Membranophones/Timpani 1 - Hit', 1.2);
    case 'percussion':
      switch (drum) {
        case 'snare':
          return vcsl('Membranophones/Struck Membranophones/Snare Drum, Modern 1', 0.8, 60);
        case 'cymbals':
          return vcsl('Idiophones/Struck Idiophones/Clash Cymbals 1', 0.9, 60);
        case 'suspended':
          return vcsl('Idiophones/Struck Idiophones/Suspended Cymbal 1', 0.8, 68);
        case 'triangle':
          return vcsl('Idiophones/Struck Idiophones/Triangles', 0.7, 60);
        default:
          return vcsl('Membranophones/Struck Membranophones/Bass Drum 1', 1.1, 60);
      }
  }
}

/** Extra layer that thickens a section played by many musicians (a solo sample sounds thin for 12 violins). */
export function sectionLayer(section: SectionId, program: number): Patch | null {
  if (program === 45) return null;
  switch (section) {
    case 'violin1':
    case 'violin2':
      return sf('string_ensemble_1', 0.55, false);
    case 'viola':
      return sf('string_ensemble_1', 0.5, false);
    case 'cello':
      return sf('string_ensemble_1', 0.42, false);
    default:
      return null;
  }
}

export function patchKey(p: Patch): string {
  return `${p.lib}:${p.name}`;
}

/** Stereo position of each section as heard from the audience. */
export const SECTION_PAN: Record<SectionId, number> = {
  violin1: -0.55,
  violin2: -0.3,
  viola: 0.2,
  cello: 0.45,
  bass: 0.65,
  harp: -0.7,
  piccolo: -0.15,
  flute: -0.1,
  oboe: 0.1,
  clarinet: -0.1,
  bassoon: 0.1,
  horn: -0.35,
  trumpet: 0,
  trombone: 0.3,
  tuba: 0.45,
  timpani: 0,
  percussion: -0.35,
};
