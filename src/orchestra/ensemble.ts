import type { DrumKind, Part, PieceMeta, Score, SectionId } from '../music/types';
import { generateSeating, type Seat } from './seating';
import { SECTIONS, type InstrumentKind } from './sections';

export interface Musician {
  id: string;
  section: SectionId;
  /** 0-based position within the section (0 = principal) */
  index: number;
  instrument: InstrumentKind;
  seat: Seat;
  /** parts whose notes this player performs */
  partIds: string[];
  /** divisi voice (0 = top) out of `voices` */
  voice: number;
  voices: number;
  drum?: DrumKind;
  /** stable per-player randomness */
  seed: number;
  label: string;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // murmur3 finaliser so similar ids ("violin1-3", "violin1-4") spread over [0, 1)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function playerCounts(score: Score, meta: Pick<PieceMeta, 'ensemble' | 'players'>): Partial<Record<SectionId, number>> {
  const counts: Partial<Record<SectionId, number>> = {};
  const partsBySection = new Map<SectionId, Part[]>();
  for (const p of score.parts) partsBySection.set(p.section, [...(partsBySection.get(p.section) ?? []), p]);

  for (const [section, driverIds] of Object.entries(score.drivers) as [SectionId, string[]][]) {
    if (!driverIds?.length) continue;
    const info = SECTIONS[section];
    let n = meta.players?.[section] ?? (meta.ensemble === 'chamber' ? info.chamber : info.full);
    const own = partsBySection.get(section) ?? [];
    if (section === 'percussion') {
      const drums = new Set(own.flatMap((p) => p.notes.map((x) => x.drum)).filter(Boolean));
      n = Math.max(1, Math.min(3, drums.size));
    } else if (info.family !== 'strings') {
      n = Math.max(n, own.length);
    }
    counts[section] = n;
  }
  return counts;
}

/** Assigns every seat a player, the part(s) they read and their divisi voice. */
export function buildEnsemble(score: Score, meta: Pick<PieceMeta, 'ensemble' | 'players'>): Musician[] {
  const counts = playerCounts(score, meta);
  const seats = generateSeating(counts);
  const partById = new Map(score.parts.map((p) => [p.id, p]));
  const musicians: Musician[] = [];

  const bySection = new Map<SectionId, Seat[]>();
  for (const s of seats) bySection.set(s.section, [...(bySection.get(s.section) ?? []), s]);

  for (const [section, sectionSeats] of bySection) {
    const info = SECTIONS[section];
    const driverIds = score.drivers[section] ?? [];
    const drivers = driverIds.map((id) => partById.get(id)!).filter(Boolean);
    const count = sectionSeats.length;

    let drumsInUse: DrumKind[] = [];
    if (section === 'percussion') {
      const order: DrumKind[] = ['bassdrum', 'cymbals', 'suspended', 'snare', 'triangle'];
      const present = new Set(drivers.flatMap((p) => p.notes.map((n) => n.drum)));
      drumsInUse = order.filter((d) => present.has(d));
    }

    sectionSeats.forEach((seat, i) => {
      let partIds: string[];
      let voice = 0;
      let voices = 1;
      let drum: DrumKind | undefined;
      if (section === 'percussion') {
        drum = drumsInUse[i] ?? drumsInUse[0] ?? 'bassdrum';
        partIds = drivers.filter((p) => p.notes.some((n) => n.drum === drum)).map((p) => p.id);
      } else if (info.family === 'strings' && section !== 'harp') {
        partIds = drivers.map((p) => p.id);
        const chordal = drivers.some((p) => p.chordRatio > 0.04);
        voices = chordal ? 2 : 1;
        voice = chordal && seat.inside ? 1 : 0;
      } else {
        // winds & brass: split players across the written parts, then divide within each group
        const groups = Math.max(1, drivers.length);
        const g = Math.min(groups - 1, Math.floor((i * groups) / count));
        const groupStart = Math.ceil((g * count) / groups);
        const groupEnd = Math.ceil(((g + 1) * count) / groups);
        partIds = drivers.length ? [drivers[g].id] : [];
        voices = Math.max(1, groupEnd - groupStart);
        voice = i - groupStart;
      }

      const instrument: InstrumentKind = section === 'percussion' ? (drum as InstrumentKind) : info.instrument;
      let label: string;
      if (info.family === 'strings' && section !== 'harp') {
        label = `${info.label} · Stand ${seat.stand}, ${seat.inside ? 'inside' : 'outside'}`;
        if (seat.stand === 1 && !seat.inside) label = section === 'violin1' ? 'Concertmaster' : `Principal ${info.label}`;
      } else if (section === 'percussion') {
        label = `Percussion · ${DRUM_LABEL[drum!]}`;
      } else if (count === 1) {
        label = info.label;
      } else {
        label = i === 0 ? `Principal ${info.label}` : `${info.label} ${ROMAN[i] ?? i + 1}`;
      }

      const id = `${section}-${i}`;
      musicians.push({ id, section, index: i, instrument, seat, partIds, voice, voices, drum, seed: hash(id), label });
    });
  }
  return musicians;
}

export const DRUM_LABEL: Record<DrumKind, string> = {
  bassdrum: 'Bass drum',
  snare: 'Snare drum',
  cymbals: 'Clash cymbals',
  suspended: 'Suspended cymbal',
  triangle: 'Triangle',
};
