import { create } from 'zustand';
import type { PieceMeta, SectionId } from '../music/types';

export type Status = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
export type CameraPreset = 'audience' | 'balcony' | 'conductor' | 'strings' | 'woodwinds' | 'brass' | 'percussion' | 'overhead';

export interface AppState {
  library: PieceMeta[];
  pieceId: string | null;
  status: Status;
  loadProgress: number;
  loadLabel: string;
  error: string | null;
  duration: number;
  tab: 'library' | 'musician' | 'mixer';
  selectedId: string | null;
  hoveredId: string | null;
  follow: boolean;
  muted: SectionId[];
  solo: SectionId[];
  highlight: SectionId | null;
  rate: number;
  volume: number;
  cameraPreset: { name: CameraPreset; nonce: number } | null;
  placeholderAssets: boolean;
  sectionsInPiece: SectionId[];
  set: (partial: Partial<AppState>) => void;
  select: (id: string | null) => void;
  toggleMute: (s: SectionId) => void;
  toggleSolo: (s: SectionId) => void;
  toggleHighlight: (s: SectionId) => void;
  setCamera: (name: CameraPreset) => void;
}

export const useApp = create<AppState>((set, get) => ({
  library: [],
  pieceId: null,
  status: 'idle',
  loadProgress: 0,
  loadLabel: '',
  error: null,
  duration: 0,
  tab: 'library',
  selectedId: null,
  hoveredId: null,
  follow: true,
  muted: [],
  solo: [],
  highlight: null,
  rate: 1,
  volume: 0.9,
  cameraPreset: null,
  placeholderAssets: true,
  sectionsInPiece: [],
  set: (partial) => set(partial),
  select: (id) => set({ selectedId: id, tab: id ? 'musician' : get().tab, follow: id ? true : get().follow }),
  toggleMute: (s) => {
    const muted = get().muted.includes(s) ? get().muted.filter((x) => x !== s) : [...get().muted, s];
    set({ muted });
  },
  toggleSolo: (s) => {
    const solo = get().solo.includes(s) ? get().solo.filter((x) => x !== s) : [...get().solo, s];
    set({ solo });
  },
  toggleHighlight: (s) => set({ highlight: get().highlight === s ? null : s }),
  setCamera: (name) => set({ cameraPreset: { name, nonce: Date.now() }, selectedId: null, follow: false }),
}));
