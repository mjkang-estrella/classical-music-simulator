import { useEffect, useRef, useState } from 'react';
import { transport } from '../audio/transport';
import { seek, setRate, setVolume, togglePlay } from '../app/controller';
import { useApp, type CameraPreset } from '../app/store';

function fmt(t: number) {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function TransportBar() {
  const status = useApp((s) => s.status);
  const duration = useApp((s) => s.duration);
  const rate = useApp((s) => s.rate);
  const volume = useApp((s) => s.volume);
  const pieceId = useApp((s) => s.pieceId);
  const piece = useApp((s) => s.library.find((p) => p.id === s.pieceId));
  const [time, setTime] = useState(0);
  const scrubbing = useRef(false);

  useEffect(() => {
    const id = setInterval(() => {
      if (!scrubbing.current) setTime(transport.visualTime());
    }, 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') seek(transport.visualTime() + 5);
      else if (e.code === 'ArrowLeft') seek(transport.visualTime() - 5);
      else if (e.code === 'Escape') useApp.getState().select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const disabled = !pieceId || status === 'loading' || status === 'error';
  const playing = status === 'playing';
  const pct = duration ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;

  return (
    <div className={`transport ${disabled ? 'disabled' : ''}`}>
      <button className="play" onClick={togglePlay} disabled={disabled} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? (
          <svg viewBox="0 0 24 24" width="22" height="22">
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="now">
        <span className="now-title">{piece ? piece.title : 'No piece selected'}</span>
        <span className="now-sub">{piece ? `${piece.composer}${piece.movement ? ` — ${piece.movement}` : ''}` : 'Pick one from the library →'}</span>
      </div>
      <span className="time">{fmt(time)}</span>
      <input
        className="scrub"
        type="range"
        min={0}
        max={duration || 1}
        step={0.01}
        value={Math.max(0, time)}
        disabled={disabled}
        style={{ ['--pct' as string]: `${pct}%` }}
        onPointerDown={() => (scrubbing.current = true)}
        onPointerUp={() => (scrubbing.current = false)}
        onChange={(e) => {
          const t = Number(e.target.value);
          setTime(t);
          seek(t);
        }}
        aria-label="Position"
      />
      <span className="time">{fmt(duration)}</span>
      <select className="rate" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Tempo">
        {[0.5, 0.75, 1, 1.25].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      <input className="vol" type="range" min={0} max={1.2} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
    </div>
  );
}

const PRESETS: [CameraPreset, string][] = [
  ['audience', 'Audience'],
  ['balcony', 'Balcony'],
  ['overhead', 'Overhead'],
  ['conductor', 'Conductor'],
  ['strings', 'Strings'],
  ['woodwinds', 'Winds'],
  ['brass', 'Brass'],
  ['percussion', 'Percussion'],
];

export function CameraPresets() {
  const current = useApp((s) => s.cameraPreset?.name);
  return (
    <nav className="presets" aria-label="Camera views">
      {PRESETS.map(([id, label]) => (
        <button key={id} className={current === id ? 'on' : ''} onClick={() => useApp.getState().setCamera(id)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

export function LoadingOverlay() {
  const status = useApp((s) => s.status);
  const label = useApp((s) => s.loadLabel);
  const progress = useApp((s) => s.loadProgress);
  const error = useApp((s) => s.error);
  if (status === 'error' && error)
    return (
      <div className="overlay">
        <div className="overlay-card error">
          <strong>Something went wrong</strong>
          <span>{error}</span>
          <button onClick={() => useApp.getState().set({ status: 'idle', error: null })}>Dismiss</button>
        </div>
      </div>
    );
  if (status !== 'loading') return null;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <span className="overlay-label">{label || 'Loading…'}</span>
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}
