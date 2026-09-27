import type { Beat } from './types';

export interface TimeSigEvent {
  ticks: number;
  numerator: number;
  denominator: number;
}

/** How many beats the conductor shows per bar, and how many notated beats each covers. */
export function conductedPattern(numerator: number, denominator: number, beatSeconds: number): { beats: number; group: number } {
  // compound meters are conducted in dotted beats
  if (denominator === 8 && numerator % 3 === 0 && numerator >= 6) return { beats: numerator / 3, group: 3 };
  if (numerator === 3 && denominator === 8) return { beats: 1, group: 3 };
  // fast simple meters are conducted in fewer, larger beats ("in one" / "in two")
  if (numerator === 2 && beatSeconds < 0.3) return { beats: 1, group: 2 };
  if (numerator === 3 && beatSeconds < 0.3) return { beats: 1, group: 3 };
  if (numerator === 4 && beatSeconds < 0.42) return { beats: 2, group: 2 };
  if (numerator > 6) return { beats: numerator % 2 === 0 ? 4 : 3, group: numerator / (numerator % 2 === 0 ? 4 : 3) };
  return { beats: numerator, group: 1 };
}

/**
 * Builds the conducted beat grid from time signatures (in ticks) and a ticks→seconds function
 * that already includes every tempo change.
 */
export function buildBeats(
  timeSigs: TimeSigEvent[],
  ppq: number,
  endTicks: number,
  ticksToSeconds: (ticks: number) => number,
): Beat[] {
  const sigs = timeSigs.length ? [...timeSigs].sort((a, b) => a.ticks - b.ticks) : [{ ticks: 0, numerator: 4, denominator: 4 }];
  if (sigs[0].ticks > 0) sigs.unshift({ ticks: 0, numerator: 4, denominator: 4 });

  const beats: Beat[] = [];
  let bar = 0;
  for (let s = 0; s < sigs.length; s++) {
    const sig = sigs[s];
    const segEnd = s + 1 < sigs.length ? sigs[s + 1].ticks : endTicks;
    const noteTicks = (ppq * 4) / sig.denominator;
    const barTicks = noteTicks * sig.numerator;
    let tick = sig.ticks;
    while (tick < segEnd - 1) {
      const beatSeconds = ticksToSeconds(tick + noteTicks) - ticksToSeconds(tick);
      const { beats: nBeats, group } = conductedPattern(sig.numerator, sig.denominator, beatSeconds);
      const step = noteTicks * group;
      for (let b = 0; b < nBeats; b++) {
        const bt = tick + b * step;
        const time = ticksToSeconds(bt);
        beats.push({ time, bar, beatInBar: b, beatsPerBar: nBeats, duration: ticksToSeconds(bt + step) - time });
      }
      tick += barTicks;
      bar++;
    }
  }
  return beats;
}

/** index of the beat active at time t (-1 before the first beat) */
export function beatIndexAt(beats: Beat[], t: number): number {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
