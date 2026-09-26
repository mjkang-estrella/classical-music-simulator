export const SECTION_IDS = [
  'violin1',
  'violin2',
  'viola',
  'cello',
  'bass',
  'harp',
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
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export type Family = 'strings' | 'woodwinds' | 'brass' | 'percussion';

/** Unpitched percussion instruments that can be driven from GM drum notes. */
export type DrumKind = 'bassdrum' | 'snare' | 'cymbals' | 'suspended' | 'triangle';

export interface Note {
  pitch: number;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  /** 0..1 */
  velocity: number;
  /** percussion only */
  drum?: DrumKind;
}

export interface Part {
  id: string;
  trackIndex: number;
  name: string;
  section: SectionId;
  channel: number;
  program: number;
  notes: Note[];
  /** longest note duration, used by the active-note query */
  maxDur: number;
  /** fraction of note onsets that are part of a chord */
  chordRatio: number;
  /** normalised 0..1 loudness sampled at LOUDNESS_RATE Hz */
  loudness: Float32Array;
  /** expression (CC7 * CC11) 0..1 sampled at LOUDNESS_RATE Hz — drives audio gain */
  expression: Float32Array;
}

export interface Beat {
  time: number;
  bar: number;
  /** 0-based index within the bar */
  beatInBar: number;
  /** number of conducted beats in this bar */
  beatsPerBar: number;
  /** seconds until next beat */
  duration: number;
}

export interface Score {
  pieceId: string;
  parts: Part[];
  duration: number;
  beats: Beat[];
  /** sections that play, including ones driven by another section's part */
  drivers: Partial<Record<SectionId, string[]>>;
}

export interface PieceMeta {
  id: string;
  title: string;
  movement?: string;
  composer: string;
  year?: number;
  file: string;
  ensemble: 'full' | 'chamber';
  blurb?: string;
  license: string;
  attribution: string;
  sourceUrl?: string;
  trackOverrides?: Record<string, SectionId | 'ignore'>;
  alsoDrives?: Partial<Record<SectionId, SectionId[]>>;
  players?: Partial<Record<SectionId, number>>;
  drumMap?: Record<string, DrumKind>;
  dynamics?: 'heuristic';
  /** set for user-imported MIDI */
  imported?: boolean;
  /** only listed with ?diagnostics */
  hidden?: boolean;
}

export const LOUDNESS_RATE = 20;
