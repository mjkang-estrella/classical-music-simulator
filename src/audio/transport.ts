import { loudnessAt } from '../music/midiLoader';
import { NoteIndex } from '../music/noteIndex';
import type { Score } from '../music/types';
import { AudioEngine, type LoadProgress } from './audioEngine';

export type TransportState = 'empty' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';

const HORIZON = 0.35;
const HIDDEN_HORIZON = 1.6;
const START_MARGIN = 0.08;

/** Pure clock maths — kept separate so it can be unit tested without Web Audio. */
export class Clock {
  anchorSong = 0;
  anchorCtx = 0;
  rate = 1;
  running = false;

  songAt(ctxTime: number): number {
    return this.running ? this.anchorSong + (ctxTime - this.anchorCtx) * this.rate : this.anchorSong;
  }

  ctxAt(songTime: number): number {
    return this.anchorCtx + (songTime - this.anchorSong) / this.rate;
  }

  start(ctxTime: number, songTime: number) {
    this.anchorCtx = ctxTime;
    this.anchorSong = songTime;
    this.running = true;
  }

  stop(ctxTime: number) {
    this.anchorSong = this.songAt(ctxTime);
    this.running = false;
  }

  setRate(ctxTime: number, rate: number) {
    const now = this.songAt(ctxTime);
    this.anchorCtx = ctxTime;
    this.anchorSong = now;
    this.rate = rate;
  }
}

/**
 * Owns the single source of musical time. Audio is scheduled against AudioContext time;
 * visuals read `visualTime()`, which maps "what is coming out of the speakers now" to song time.
 */
export class Transport {
  engine: AudioEngine | null = null;
  score: Score | null = null;
  indexes = new Map<string, NoteIndex>();
  readonly clock = new Clock();
  state: TransportState = 'empty';
  private cursors = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private loadToken = 0;
  /** song time the performance starts at (negative = conductor's preparatory beat) */
  private countIn = 0;
  /** true when no audio device is available: the clock falls back to wall time and nothing is scheduled */
  silent = false;

  /** Current clock reading: AudioContext time, or wall time when running silently. */
  private now(): number {
    if (this.silent || !this.engine) return performance.now() / 1000;
    return this.engine.ctx.currentTime;
  }

  ensureEngine(): AudioEngine {
    if (!this.engine) this.engine = new AudioEngine();
    return this.engine;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async load(score: Score, onProgress?: (p: LoadProgress) => void): Promise<boolean> {
    const token = ++this.loadToken;
    this.pauseInternal();
    this.score = score;
    this.indexes = new Map(score.parts.map((p) => [p.id, new NoteIndex(p.notes)]));
    this.clock.anchorSong = 0;
    this.clock.running = false;
    const first = score.beats[0];
    this.countIn = first ? -Math.min(1.2, Math.max(0.5, first.duration)) : 0;
    this.state = 'loading';
    this.emit();
    const engine = this.ensureEngine();
    await engine.prepare(score, onProgress);
    if (token !== this.loadToken) return false;
    this.state = 'ready';
    this.clock.anchorSong = this.countIn;
    this.emit();
    return true;
  }

  get duration(): number {
    return this.score?.duration ?? 0;
  }

  get playing(): boolean {
    return this.state === 'playing';
  }

  /** Current song time for scheduling (ctx.currentTime based). */
  songTime(): number {
    if (!this.engine) return this.clock.anchorSong;
    return this.clock.songAt(this.now());
  }

  /** Song time of the audio currently leaving the speakers (latency-compensated). */
  visualTime(): number {
    if (!this.engine || !this.clock.running) return this.clock.anchorSong;
    if (this.silent) return this.clock.songAt(this.now());
    const ctx = this.engine.ctx;
    let ctxNow = ctx.currentTime;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.contextTime > 0) {
        ctxNow = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
    }
    return this.clock.songAt(ctxNow);
  }

  async play(): Promise<void> {
    if (!this.score || !this.engine || this.state === 'loading' || this.state === 'empty') return;
    if (this.state === 'playing') return;
    const ctx = this.engine.ctx;
    if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    const wasSilent = this.silent;
    this.silent = (ctx.state as string) !== 'running';
    if (this.silent && !wasSilent) console.warn('[audio] no audio output available — playing silently');
    let from = this.clock.anchorSong;
    if (this.state === 'ended' || from >= this.duration - 0.05) from = this.countIn;
    this.startAt(from);
    this.state = 'playing';
    this.emit();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.pauseInternal();
    this.state = 'paused';
    this.emit();
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else void this.play();
  }

  seek(t: number): void {
    if (!this.score) return;
    const target = Math.max(this.countIn, Math.min(this.duration, t));
    if (this.state === 'playing') {
      this.engine?.stopAll();
      this.startAt(target);
    } else {
      this.clock.anchorSong = target;
      if (this.state === 'ended') this.state = 'paused';
    }
    this.emit();
  }

  setRate(rate: number): void {
    if (!this.engine) {
      this.clock.rate = rate;
      return;
    }
    if (this.state === 'playing') {
      // re-anchor and reschedule so already-queued notes use the new rate
      const current = this.songTime();
      this.engine.stopAll();
      this.clock.rate = rate;
      this.startAt(current);
    } else {
      this.clock.rate = rate;
    }
    this.emit();
  }

  private startAt(songTime: number) {
    const engine = this.engine!;
    const ctxStart = this.now() + START_MARGIN;
    this.clock.start(ctxStart, songTime);
    if (!this.silent) engine.openGates(ctxStart);
    this.cursors.clear();
    for (const part of this.score!.parts) {
      const idx = this.indexes.get(part.id)!;
      // re-trigger notes that are still sounding at the new position
      if (!this.silent) {
        for (const n of idx.active(songTime)) {
          if (n.end - songTime > 0.3) engine.playNote(part.id, n, ctxStart, (n.end - songTime) / this.clock.rate);
        }
        engine.setExpression(part.id, loudnessAt(part.expression, Math.max(0, songTime)), ctxStart);
      }
      this.cursors.set(part.id, idx.upperBound(songTime));
    }
    this.tick();
    if (this.timer === null) this.timer = setInterval(() => this.tick(), 25);
  }

  private pauseInternal() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.engine) {
      this.clock.stop(this.now());
      this.engine.stopAll();
    }
  }

  private tick() {
    if (!this.score || !this.engine || !this.clock.running) return;
    const ctx = this.engine.ctx;
    const now = this.clock.songAt(this.now());
    if (now >= this.duration) {
      this.pauseInternal();
      this.clock.anchorSong = this.duration;
      this.state = 'ended';
      this.emit();
      return;
    }
    if (this.silent) return;
    const horizon = typeof document !== 'undefined' && document.hidden ? HIDDEN_HORIZON : HORIZON;
    const until = this.clock.songAt(ctx.currentTime + horizon);
    for (const part of this.score.parts) {
      const notes = part.notes;
      let i = this.cursors.get(part.id) ?? 0;
      while (i < notes.length && notes[i].start < until) {
        const n = notes[i];
        const when = this.clock.ctxAt(n.start);
        if (when >= ctx.currentTime - 0.02) this.engine.playNote(part.id, n, when, (n.end - n.start) / this.clock.rate);
        i++;
      }
      this.cursors.set(part.id, i);
      this.engine.setExpression(part.id, loudnessAt(part.expression, Math.max(0, now + 0.05)), ctx.currentTime);
    }
  }
}

export const transport = new Transport();
