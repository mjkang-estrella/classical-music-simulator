import { Midi } from '@tonejs/midi';
import { SECTIONS } from '../orchestra/sections';
import { expressionCurve, lacksDynamics, percentile, rawLoudness, smoothEnvelope, tuttiCurve } from './dynamics';
import { drumForKey, inferAlsoDrives, mapTracks, type TrackInfo } from './sectionMapping';
import { buildBeats } from './tempoMap';
import { LOUDNESS_RATE, type Note, type Part, type PieceMeta, type Score, type SectionId } from './types';

/** Minimal shape of a parsed MIDI so tests can feed fixtures without @tonejs/midi. */
export function parseMidi(data: ArrayBuffer | Uint8Array): Midi {
  return new Midi(data instanceof Uint8Array ? data : new Uint8Array(data));
}

export function buildScore(midi: Midi, meta: Pick<PieceMeta, 'id' | 'trackOverrides' | 'alsoDrives' | 'drumMap'>): Score {
  const infos: TrackInfo[] = midi.tracks.map((t, index) => ({
    index,
    name: t.name ?? '',
    channel: t.channel,
    program: t.instrument.number,
    noteCount: t.notes.length,
    meanPitch: t.notes.length ? t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length : 0,
  }));
  const mapping = mapTracks(infos, meta.trackOverrides);

  let duration = 0;
  for (const t of midi.tracks) for (const n of t.notes) duration = Math.max(duration, n.time + n.duration);
  duration += 0.5;
  const frames = Math.ceil(duration * LOUDNESS_RATE) + 1;

  interface Draft {
    trackIndex: number;
    section: SectionId;
    name: string;
    channel: number;
    program: number;
    notes: Note[];
    expression: Float32Array;
  }
  const drafts: Draft[] = [];
  let anyControllers = false;
  for (const [trackIndex, section] of mapping) {
    if (!section) continue;
    const track = midi.tracks[trackIndex];
    const isDrums = track.channel === 9 || section === 'percussion';
    const notes: Note[] = [];
    for (const n of track.notes) {
      // MIDI exports often have zero-length or overlapping notes; keep them audible
      const dur = Math.max(0.05, n.duration);
      const note: Note = { pitch: n.midi, start: n.time, end: n.time + dur, velocity: n.velocity };
      if (isDrums) {
        const drum = drumForKey(n.midi, meta.drumMap);
        if (!drum) continue;
        note.drum = drum;
      }
      notes.push(note);
    }
    if (!notes.length) continue;
    notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const cc7 = track.controlChanges[7];
    const cc11 = track.controlChanges[11];
    if ((cc7?.length ?? 0) > 2 || (cc11?.length ?? 0) > 2) anyControllers = true;
    drafts.push({
      trackIndex,
      section,
      name: track.name || SECTIONS[section].label,
      channel: track.channel,
      program: track.instrument.number,
      notes,
      expression: expressionCurve(cc7, cc11, frames),
    });
  }

  const heuristic = lacksDynamics(
    drafts.map((d) => d.notes),
    anyControllers,
  );
  const tutti = heuristic ? tuttiCurve(drafts.map((d) => d.notes), frames) : null;

  const parts: Part[] = drafts.map((d) => {
    if (tutti) {
      // fold inferred dynamics into the notes so audio follows too
      for (const n of d.notes) {
        const i = Math.min(frames - 1, Math.floor(n.start * LOUDNESS_RATE));
        n.velocity = 0.42 + 0.55 * Math.min(1, tutti[i] * 1.25);
      }
    }
    const raw = rawLoudness(d.notes, d.expression, frames);
    return {
      id: `t${d.trackIndex}`,
      trackIndex: d.trackIndex,
      name: d.name,
      section: d.section,
      channel: d.channel,
      program: d.program,
      notes: d.notes,
      maxDur: d.notes.reduce((m, n) => Math.max(m, n.end - n.start), 0),
      chordRatio: chordRatio(d.notes),
      loudness: smoothEnvelope(raw),
      expression: d.expression,
    };
  });

  // normalise loudness piece-wide so ff ≈ 1 regardless of the file's velocity scale
  const all = new Float32Array(parts.reduce((s, p) => s + p.loudness.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p.loudness, o);
    o += p.loudness.length;
  }
  const ref = Math.max(0.05, percentile(all, 0.97));
  for (const p of parts) for (let i = 0; i < p.loudness.length; i++) p.loudness[i] = Math.min(1, p.loudness[i] / ref);

  const present = new Set(parts.map((p) => p.section));
  const drivers: Score['drivers'] = {};
  for (const p of parts) (drivers[p.section] ??= []).push(p.id);
  const also = inferAlsoDrives(present, meta.alsoDrives);
  for (const [src, targets] of Object.entries(also) as [SectionId, SectionId[]][]) {
    for (const target of targets) drivers[target] = [...(drivers[target] ?? []), ...(drivers[src] ?? [])];
  }

  const endTicks = midi.durationTicks + midi.header.ppq * 4;
  const beats = buildBeats(
    midi.header.timeSignatures.map((ts) => ({ ticks: ts.ticks, numerator: ts.timeSignature[0], denominator: ts.timeSignature[1] })),
    midi.header.ppq,
    endTicks,
    (ticks) => midi.header.ticksToSeconds(ticks),
  ).filter((b) => b.time <= duration + 1);

  return { pieceId: meta.id, parts, duration, beats, drivers };
}

function chordRatio(notes: Note[]): number {
  if (notes.length < 2) return 0;
  let chordal = 0;
  for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i].start - notes[i - 1].start) < 0.02) chordal++;
  return chordal / notes.length;
}

export function loudnessAt(curve: Float32Array, t: number): number {
  const x = t * LOUDNESS_RATE;
  const i = Math.floor(x);
  if (i < 0) return curve[0] ?? 0;
  if (i >= curve.length - 1) return curve[curve.length - 1] ?? 0;
  const f = x - i;
  return curve[i] * (1 - f) + curve[i + 1] * f;
}
