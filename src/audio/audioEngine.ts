import { CacheStorage, SampleLoader, Scheduler, Smolken, Soundfont, Versilian, type Smplr } from 'smplr';
import type { DrumKind, Note, Part, Score, SectionId } from '../music/types';
import { patchFor, patchKey, SECTION_PAN, sectionLayer, type Patch } from './patches';

interface PartVoice {
  part: Part;
  gate: GainNode;
  expression: GainNode;
  instruments: Map<string, { inst: Smplr; patch: Patch }>;
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

/**
 * Web Audio graph:
 *   instrument → part gate → part expression → section (mute/solo) → pan → master → dry + reverb → out
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  /** tap on the master bus for level metering (tests / UI) */
  readonly analyser: AnalyserNode;
  private readonly bus: GainNode;
  private readonly loader: ReturnType<typeof SampleLoader>;
  private readonly scheduler: ReturnType<typeof Scheduler>;
  private readonly storage: ReturnType<typeof CacheStorage> | undefined;
  private readonly sections = new Map<SectionId, { gain: GainNode; pan: StereoPannerNode }>();
  private readonly parts = new Map<string, PartVoice>();
  private mix = { muted: new Set<SectionId>(), solo: new Set<SectionId>() };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.bus = this.ctx.createGain();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    const reverb = this.ctx.createConvolver();
    reverb.buffer = hallImpulse(this.ctx, 2.6);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.32;
    this.bus.connect(this.master);
    this.bus.connect(reverb).connect(wet).connect(this.master);
    this.master.connect(comp).connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    comp.connect(this.analyser);
    this.loader = SampleLoader(this.ctx);
    // generous lookahead: our own feeder decides how far ahead notes are created
    this.scheduler = Scheduler(this.ctx, { lookaheadMs: 4000, intervalMs: 50 });
    try {
      this.storage = typeof caches !== 'undefined' ? CacheStorage('orchestra-samples') : undefined;
    } catch {
      this.storage = undefined;
    }
  }

  private section(id: SectionId) {
    let s = this.sections.get(id);
    if (!s) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = SECTION_PAN[id];
      gain.connect(pan).connect(this.bus);
      s = { gain, pan };
      this.sections.set(id, s);
      this.applyMix();
    }
    return s;
  }

  /** Creates (or reuses) every instrument the score needs and waits for the samples. */
  async prepare(score: Score, onProgress?: (p: LoadProgress) => void): Promise<void> {
    this.releaseParts();

    const jobs: { key: string; patch: Patch; pv: PartVoice }[] = [];
    for (const part of score.parts) {
      const gate = this.ctx.createGain();
      const expression = this.ctx.createGain();
      gate.connect(expression).connect(this.section(part.section).gain);
      const pv: PartVoice = { part, gate, expression, instruments: new Map() };
      this.parts.set(part.id, pv);
      const drums = new Set<DrumKind | undefined>(part.notes.map((n) => n.drum));
      for (const drum of drums) {
        const patch = patchFor(part.section, part.program, drum);
        jobs.push({ key: drum ?? 'main', patch, pv });
      }
      const layer = sectionLayer(part.section, part.program);
      if (layer) jobs.push({ key: 'layer', patch: layer, pv });
    }

    // one instrument per (part, patch): each part needs its own gain for mute/expression
    const progress = new Map<number, LoadProgress>();
    const report = () => {
      let loaded = 0;
      let total = 0;
      for (const p of progress.values()) {
        loaded += p.loaded;
        total += p.total;
      }
      onProgress?.({ loaded, total: Math.max(total, 1) });
    };
    await Promise.all(
      jobs.map(async (job, i) => {
        progress.set(i, { loaded: 0, total: 1 });
        const inst = this.createInstrument(job.patch, job.pv.gate, (p) => {
          progress.set(i, p);
          report();
        });
        try {
          await inst.ready;
        } catch (err) {
          console.warn(`[audio] could not load ${patchKey(job.patch)}`, err);
        }
        progress.set(i, { loaded: 1, total: 1 });
        report();
        job.pv.instruments.set(job.key, { inst, patch: job.patch });
      }),
    );
  }

  private createInstrument(patch: Patch, destination: AudioNode, onLoadProgress: (p: LoadProgress) => void): Smplr {
    const common = {
      destination,
      loader: this.loader,
      scheduler: this.scheduler,
      storage: this.storage,
      onLoadProgress,
      volume: Math.round(Math.min(127, 100 * patch.gain)),
    };
    switch (patch.lib) {
      case 'soundfont':
        return Soundfont(this.ctx, { ...common, instrument: patch.name, kit: 'MusyngKite', loadLoopData: patch.loop });
      case 'vcsl':
        return Versilian(this.ctx, { ...common, instrument: patch.name });
      case 'smolken':
        return Smolken(this.ctx, { ...common, instrument: patch.name });
    }
  }

  /** Schedules one note at an absolute AudioContext time. */
  playNote(partId: string, note: Note, when: number, duration: number): void {
    const pv = this.parts.get(partId);
    if (!pv) return;
    const entries = [pv.instruments.get(note.drum ?? 'main'), note.drum ? undefined : pv.instruments.get('layer')];
    for (const entry of entries) {
      if (!entry) continue;
      const { inst, patch } = entry;
      const key = patch.lib === 'vcsl' && patch.key !== undefined ? patch.key : note.pitch;
      const isHit = patch.lib === 'vcsl';
      try {
        inst.start({
          note: key,
          velocity: Math.max(1, Math.round(note.velocity * 127)),
          time: when,
          duration: isHit ? Math.max(duration, 2.5) : Math.max(0.06, duration),
        });
      } catch {
        // disposed or not loaded — skip
      }
    }
  }

  /** Expression (CC7/CC11) automation for a part. */
  setExpression(partId: string, value: number, when: number): void {
    const pv = this.parts.get(partId);
    if (!pv) return;
    pv.expression.gain.setTargetAtTime(value, Math.max(when, this.ctx.currentTime), 0.06);
  }

  /** Silences everything immediately (pause / seek). */
  stopAll(): void {
    this.scheduler.stop();
    const now = this.ctx.currentTime;
    for (const pv of this.parts.values()) {
      pv.gate.gain.cancelScheduledValues(now);
      pv.gate.gain.setValueAtTime(pv.gate.gain.value, now);
      pv.gate.gain.linearRampToValueAtTime(0, now + 0.04);
      for (const { inst } of pv.instruments.values()) {
        try {
          inst.stop();
        } catch {
          /* disposed */
        }
      }
    }
  }

  /** Re-opens the part gates at `when` after stopAll(). */
  openGates(when: number): void {
    const t = Math.max(when, this.ctx.currentTime + 0.045);
    for (const pv of this.parts.values()) {
      pv.gate.gain.cancelScheduledValues(t);
      pv.gate.gain.setValueAtTime(1, t);
    }
  }

  setMix(muted: Set<SectionId>, solo: Set<SectionId>): void {
    this.mix = { muted, solo };
    this.applyMix();
  }

  private applyMix() {
    const now = this.ctx.currentTime;
    for (const [id, s] of this.sections) {
      const audible = this.mix.solo.size ? this.mix.solo.has(id) : !this.mix.muted.has(id);
      s.gain.gain.setTargetAtTime(audible ? 1 : 0, now, 0.03);
    }
  }

  /** RMS level of the output (0..1) */
  level(): number {
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private releaseParts() {
    this.scheduler.stop();
    for (const pv of this.parts.values()) {
      for (const { inst } of pv.instruments.values()) inst.dispose();
      pv.gate.disconnect();
      pv.expression.disconnect();
    }
    this.parts.clear();
  }

  dispose() {
    this.releaseParts();
    void this.ctx.close();
  }
}

/** Synthetic concert-hall impulse: stereo decorrelated noise with an exponential tail. */
function hallImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const pre = t < 0.018 ? 0 : 1;
      const env = Math.exp(-t * (6.9 / seconds)) * pre;
      // gentle low-pass that gets darker over time, like air absorption
      const k = 0.55 - 0.4 * (t / seconds);
      lp += (Math.random() * 2 - 1 - lp) * k;
      data[i] = lp * env * 0.6;
    }
  }
  return buf;
}
