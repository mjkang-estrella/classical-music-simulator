import { buildScore, parseMidi } from './midiLoader';
import type { PieceMeta, Score } from './types';

const BASE = import.meta.env.BASE_URL ?? '/';

export async function fetchLibrary(): Promise<PieceMeta[]> {
  const res = await fetch(`${BASE}music/library.json`);
  if (!res.ok) throw new Error(`Could not load the music library (${res.status})`);
  const json = (await res.json()) as { pieces: PieceMeta[] };
  return json.pieces;
}

const importedFiles = new Map<string, ArrayBuffer>();

export async function loadScore(meta: PieceMeta): Promise<Score> {
  let data = importedFiles.get(meta.id);
  if (!data) {
    const res = await fetch(`${BASE}music/${meta.file}`);
    if (!res.ok) throw new Error(`Could not load ${meta.file} (${res.status})`);
    data = await res.arrayBuffer();
  }
  return buildScore(parseMidi(data), meta);
}

/** Registers a user-provided MIDI file (kept in memory only). */
export async function importMidiFile(file: File): Promise<PieceMeta> {
  const data = await file.arrayBuffer();
  const midi = parseMidi(data);
  const id = `import-${Date.now().toString(36)}`;
  importedFiles.set(id, data);
  const base = file.name.replace(/\.(mid|midi)$/i, '').replace(/[_-]+/g, ' ');
  const title = midi.name?.trim() || base;
  return {
    id,
    title,
    composer: 'Imported MIDI',
    file: file.name,
    ensemble: 'full',
    license: 'Your file',
    attribution: 'Imported locally; not uploaded anywhere',
    imported: true,
  };
}
