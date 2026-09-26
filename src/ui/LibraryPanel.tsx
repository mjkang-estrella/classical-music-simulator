import { useRef, useState } from 'react';
import { importMidi, loadPiece, togglePlay } from '../app/controller';
import { useApp } from '../app/store';
import type { PieceMeta } from '../music/types';

export function LibraryPanel() {
  const all = useApp((s) => s.library);
  const showHidden = typeof location !== 'undefined' && new URLSearchParams(location.search).has('diagnostics');
  const library = all.filter((p) => showHidden || !p.hidden);
  const pieceId = useApp((s) => s.pieceId);
  const status = useApp((s) => s.status);
  return (
    <div className="library">
      <p className="panel-intro">Choose a piece. The whole orchestra will perform it, and every musician plays exactly their own part.</p>
      <ul className="pieces">
        {library.map((p) => (
          <PieceCard key={p.id} piece={p} active={p.id === pieceId} status={status} />
        ))}
      </ul>
      <ImportMidi />
      <Credits />
    </div>
  );
}

function PieceCard({ piece, active, status }: { piece: PieceMeta; active: boolean; status: string }) {
  const playing = active && status === 'playing';
  const loading = active && status === 'loading';
  return (
    <li>
      <button
        className={`piece ${active ? 'active' : ''}`}
        onClick={() => (active && status !== 'loading' && status !== 'error' ? togglePlay() : loadPiece(piece.id))}
        aria-pressed={active}
      >
        <span className="piece-composer">
          {piece.composer}
          {piece.year ? <span className="piece-year"> · {piece.year}</span> : null}
        </span>
        <span className="piece-title">{piece.title}</span>
        {piece.movement ? <span className="piece-movement">{piece.movement}</span> : null}
        {piece.blurb ? <span className="piece-blurb">{piece.blurb}</span> : null}
        <span className="piece-meta">
          <span className="chip">{piece.ensemble === 'chamber' ? 'String orchestra' : 'Full orchestra'}</span>
          <span className="chip subtle" title={piece.attribution}>
            {piece.license}
          </span>
          <span className="piece-state">{loading ? 'Loading…' : playing ? <Bars /> : active ? 'Paused' : ''}</span>
        </span>
      </button>
    </li>
  );
}

function Bars() {
  return (
    <span className="bars" aria-label="Playing">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function ImportMidi() {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const handle = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    if (!/\.midi?$/i.test(file.name)) {
      setErr('Please choose a .mid or .midi file.');
      return;
    }
    try {
      await importMidi(file);
    } catch (e) {
      setErr(`Could not read that MIDI file: ${(e as Error).message}`);
    }
  };
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void handle(e.dataTransfer.files[0]);
      }}
    >
      <strong>Play your own MIDI</strong>
      <span>Drop an orchestral .mid file here, or</span>
      <button className="link" onClick={() => input.current?.click()}>
        browse…
      </button>
      <span className="fine">Stays in your browser. Tracks are matched to sections by name and General MIDI instrument.</span>
      {err ? <span className="error">{err}</span> : null}
      <input ref={input} type="file" accept=".mid,.midi,audio/midi" hidden onChange={(e) => void handle(e.target.files?.[0])} />
    </div>
  );
}

function Credits() {
  const placeholder = useApp((s) => s.placeholderAssets);
  return (
    <details className="credits">
      <summary>Credits & licenses</summary>
      <p>
        Scores: <a href="https://www.mutopiaproject.org" target="_blank" rel="noreferrer">The Mutopia Project</a> (public domain; Dvořák 9 typeset by Keith OHara, CC BY-SA 3.0).
      </p>
      <p>
        Sounds: MusyngKite soundfont by Gleitz (CC BY-SA 3.0), Versilian Community Sample Library (CC0), Smolken double bass (CC0), played with <a href="https://github.com/danigb/smplr" target="_blank" rel="noreferrer">smplr</a>.
      </p>
      <p>
        Musicians: {placeholder ? 'procedural placeholder figures (realistic characters are built with the Blender pipeline in tools/blender).' : 'Microsoft Rocketbox avatars (MIT), converted with Blender.'}
      </p>
    </details>
  );
}
