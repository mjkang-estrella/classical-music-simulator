import { transport } from '../audio/transport';
import { loadCharacterLibrary } from '../assets/characterFactory';
import { loadInstrumentLibrary } from '../assets/instrumentFactory';
import { fetchLibrary, importMidiFile, loadScore } from '../music/library';
import type { PieceMeta, SectionId } from '../music/types';
import { orchestra } from '../scene/orchestra';
import { useApp } from './store';

let assetsReady: Promise<number> | null = null;

/** Loads the library + realistic character assets, then seats the default orchestra. */
export async function boot(): Promise<void> {
  const set = useApp.getState().set;
  set({ status: 'loading', loadLabel: 'Setting the stage…', loadProgress: 0.1 });
  try {
    assetsReady ??= Promise.all([
      loadCharacterLibrary((done, total) => set({ loadProgress: 0.1 + 0.8 * (done / total), loadLabel: 'Dressing the musicians…' })),
      loadInstrumentLibrary(),
    ]).then(([characters]) => characters);
    const [library, characters] = await Promise.all([fetchLibrary(), assetsReady]);
    set({ library, placeholderAssets: characters === 0 });
    orchestra.build(null);
    set({ status: 'idle', loadLabel: '', loadProgress: 1 });
  } catch (err) {
    console.error(err);
    set({ status: 'error', error: String((err as Error).message ?? err) });
  }
}

export async function loadPiece(id: string, autoplay = true): Promise<void> {
  const state = useApp.getState();
  const meta = state.library.find((p) => p.id === id);
  if (!meta) return;
  const set = state.set;
  transport.pause();
  set({ pieceId: id, status: 'loading', loadLabel: 'Reading the score…', loadProgress: 0.05, error: null, selectedId: null, highlight: null, solo: [], muted: [] });
  try {
    const engine = transport.ensureEngine();
    // unlock audio inside the click gesture
    if (engine.ctx.state !== 'running') void engine.ctx.resume();
    await assetsReady;
    const score = await loadScore(meta);
    if (useApp.getState().pieceId !== id) return;
    set({ loadLabel: 'Seating the orchestra…', loadProgress: 0.15 });
    await nextFrame();
    orchestra.build(score, meta);
    set({ sectionsInPiece: [...new Set(orchestra.musicians.map((m) => m.section))] as SectionId[], duration: score.duration });
    set({ loadLabel: 'Tuning the instruments…', loadProgress: 0.2 });
    const ok = await transport.load(score, (p) => set({ loadProgress: 0.2 + 0.8 * (p.loaded / p.total) }));
    if (!ok || useApp.getState().pieceId !== id) return;
    transport.setRate(useApp.getState().rate);
    engine.setMasterVolume(useApp.getState().volume);
    set({ status: 'ready', loadLabel: '', loadProgress: 1 });
    if (autoplay) await play();
  } catch (err) {
    console.error(err);
    set({ status: 'error', error: `Could not load “${meta.title}”: ${(err as Error).message ?? err}` });
  }
}

export async function play() {
  await transport.play();
}

export function pause() {
  transport.pause();
}

export function togglePlay() {
  transport.toggle();
}

export function seek(t: number) {
  transport.seek(t);
}

export function setRate(rate: number) {
  useApp.getState().set({ rate });
  transport.setRate(rate);
}

export function setVolume(volume: number) {
  useApp.getState().set({ volume });
  transport.engine?.setMasterVolume(volume);
}

export async function importMidi(file: File): Promise<void> {
  const meta: PieceMeta = await importMidiFile(file);
  const lib = useApp.getState().library;
  useApp.getState().set({ library: [...lib, meta] });
  await loadPiece(meta.id);
}

// keep store status in sync with the transport
transport.subscribe(() => {
  const s = transport.state;
  const map = { empty: 'idle', loading: 'loading', ready: 'ready', playing: 'playing', paused: 'paused', ended: 'ended' } as const;
  const cur = useApp.getState().status;
  if (cur === 'error') return;
  if (s === 'loading' && cur === 'loading') return;
  useApp.getState().set({ status: map[s] });
});

// mixer
useApp.subscribe((state, prev) => {
  if (state.muted !== prev.muted || state.solo !== prev.solo) transport.engine?.setMix(new Set(state.muted), new Set(state.solo));
  if (state.highlight !== prev.highlight) orchestra.setHighlight(state.highlight);
});

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}
