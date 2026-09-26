import type { Family, SectionId } from '../music/types';

export type InstrumentKind =
  | 'violin'
  | 'viola'
  | 'cello'
  | 'bass'
  | 'harp'
  | 'piccolo'
  | 'flute'
  | 'oboe'
  | 'clarinet'
  | 'bassoon'
  | 'horn'
  | 'trumpet'
  | 'trombone'
  | 'tuba'
  | 'timpani'
  | 'bassdrum'
  | 'snare'
  | 'cymbals'
  | 'suspended'
  | 'triangle';

export interface SectionInfo {
  id: SectionId;
  label: string;
  plural: string;
  family: Family;
  instrument: InstrumentKind;
  /** players in a full symphony orchestra */
  full: number;
  /** players in a chamber orchestra */
  chamber: number;
  /** standard pitch range (MIDI) used to place the left hand */
  range: [number, number];
  /** open-string pitches, low to high (bowed strings only) */
  strings?: number[];
  color: string;
}

export const SECTIONS: Record<SectionId, SectionInfo> = {
  violin1: { id: 'violin1', label: 'First Violin', plural: 'First Violins', family: 'strings', instrument: 'violin', full: 12, chamber: 6, range: [55, 100], strings: [55, 62, 69, 76], color: '#e8a33d' },
  violin2: { id: 'violin2', label: 'Second Violin', plural: 'Second Violins', family: 'strings', instrument: 'violin', full: 10, chamber: 6, range: [55, 96], strings: [55, 62, 69, 76], color: '#e07b39' },
  viola: { id: 'viola', label: 'Viola', plural: 'Violas', family: 'strings', instrument: 'viola', full: 8, chamber: 4, range: [48, 88], strings: [48, 55, 62, 69], color: '#c95b4a' },
  cello: { id: 'cello', label: 'Cello', plural: 'Cellos', family: 'strings', instrument: 'cello', full: 8, chamber: 4, range: [36, 76], strings: [36, 43, 50, 57], color: '#b34766' },
  bass: { id: 'bass', label: 'Double Bass', plural: 'Double Basses', family: 'strings', instrument: 'bass', full: 6, chamber: 2, range: [28, 67], strings: [28, 33, 38, 43], color: '#8e3f7a' },
  harp: { id: 'harp', label: 'Harp', plural: 'Harp', family: 'strings', instrument: 'harp', full: 1, chamber: 1, range: [24, 103], color: '#d9b36c' },
  piccolo: { id: 'piccolo', label: 'Piccolo', plural: 'Piccolo', family: 'woodwinds', instrument: 'piccolo', full: 1, chamber: 1, range: [74, 108], color: '#7fc6a4' },
  flute: { id: 'flute', label: 'Flute', plural: 'Flutes', family: 'woodwinds', instrument: 'flute', full: 2, chamber: 1, range: [60, 96], color: '#5fb89a' },
  oboe: { id: 'oboe', label: 'Oboe', plural: 'Oboes', family: 'woodwinds', instrument: 'oboe', full: 2, chamber: 1, range: [58, 91], color: '#4ea3a0' },
  clarinet: { id: 'clarinet', label: 'Clarinet', plural: 'Clarinets', family: 'woodwinds', instrument: 'clarinet', full: 2, chamber: 1, range: [50, 94], color: '#448da6' },
  bassoon: { id: 'bassoon', label: 'Bassoon', plural: 'Bassoons', family: 'woodwinds', instrument: 'bassoon', full: 2, chamber: 1, range: [34, 75], color: '#3f76a3' },
  horn: { id: 'horn', label: 'Horn', plural: 'Horns', family: 'brass', instrument: 'horn', full: 2, chamber: 2, range: [34, 77], color: '#d6c14a' },
  trumpet: { id: 'trumpet', label: 'Trumpet', plural: 'Trumpets', family: 'brass', instrument: 'trumpet', full: 2, chamber: 2, range: [52, 84], color: '#e3d35a' },
  trombone: { id: 'trombone', label: 'Trombone', plural: 'Trombones', family: 'brass', instrument: 'trombone', full: 3, chamber: 2, range: [34, 72], color: '#c9a83f' },
  tuba: { id: 'tuba', label: 'Tuba', plural: 'Tuba', family: 'brass', instrument: 'tuba', full: 1, chamber: 1, range: [26, 60], color: '#b08c35' },
  timpani: { id: 'timpani', label: 'Timpani', plural: 'Timpani', family: 'percussion', instrument: 'timpani', full: 1, chamber: 1, range: [38, 57], color: '#9c9c9c' },
  percussion: { id: 'percussion', label: 'Percussion', plural: 'Percussion', family: 'percussion', instrument: 'bassdrum', full: 1, chamber: 1, range: [0, 127], color: '#7d7d86' },
};

export const FAMILY_LABEL: Record<Family, string> = {
  strings: 'Strings',
  woodwinds: 'Woodwinds',
  brass: 'Brass',
  percussion: 'Percussion',
};

export const SECTION_ORDER: SectionId[] = [
  'piccolo',
  'flute',
  'oboe',
  'clarinet',
  'bassoon',
  'horn',
  'trumpet',
  'trombone',
  'tuba',
  'timpani',
  'percussion',
  'harp',
  'violin1',
  'violin2',
  'viola',
  'cello',
  'bass',
];

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function noteName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
