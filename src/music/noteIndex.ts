import type { Note } from './types';

/** Fast time queries over a start-sorted note list. */
export class NoteIndex {
  readonly notes: Note[];
  readonly starts: Float64Array;
  readonly maxDur: number;

  constructor(notes: Note[]) {
    this.notes = notes;
    this.starts = Float64Array.from(notes, (n) => n.start);
    let maxDur = 0;
    for (const n of notes) maxDur = Math.max(maxDur, n.end - n.start);
    this.maxDur = maxDur;
  }

  /** index of the first note whose start is > t */
  upperBound(t: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** index of the first note whose start is >= t */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** notes sounding at time t (start <= t < end), appended to out */
  active(t: number, out: Note[] = []): Note[] {
    out.length = 0;
    const floor = t - this.maxDur;
    for (let i = this.upperBound(t) - 1; i >= 0 && this.starts[i] >= floor; i--) {
      const n = this.notes[i];
      if (n.end > t) out.push(n);
    }
    return out;
  }

  /** notes with start in [t0, t1) */
  range(t0: number, t1: number): Note[] {
    const out: Note[] = [];
    for (let i = this.lowerBound(t0); i < this.notes.length && this.starts[i] < t1; i++) out.push(this.notes[i]);
    return out;
  }

  /** first note starting after t (strictly) */
  nextOnset(t: number): Note | null {
    const i = this.upperBound(t);
    return i < this.notes.length ? this.notes[i] : null;
  }

  /** most recent note starting at or before t */
  lastOnset(t: number): Note | null {
    const i = this.upperBound(t) - 1;
    return i >= 0 ? this.notes[i] : null;
  }

  /** latest end time of any note starting at or before t */
  lastEndBefore(t: number): number {
    const last = this.upperBound(t) - 1;
    if (last < 0) return -Infinity;
    let best = -Infinity;
    const floor = this.starts[last] - this.maxDur;
    for (let i = last; i >= 0 && this.starts[i] >= floor; i--) {
      const e = this.notes[i].end;
      if (e > best) best = e;
    }
    return best;
  }
}
