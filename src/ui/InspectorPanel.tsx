import { useEffect, useRef, useState } from 'react';
import { transport } from '../audio/transport';
import { useApp } from '../app/store';
import { loudnessAt } from '../music/midiLoader';
import type { Note, SectionId } from '../music/types';
import { DRUM_LABEL } from '../orchestra/ensemble';
import { FAMILY_LABEL, noteName, SECTIONS } from '../orchestra/sections';
import { orchestra } from '../scene/orchestra';

const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];

export function InspectorPanel() {
  const selectedId = useApp((s) => s.selectedId);
  const pieceId = useApp((s) => s.pieceId);
  const actor = orchestra.actorById(selectedId);
  if (!actor) {
    return (
      <div className="inspector empty">
        <div className="empty-illustration" aria-hidden>
          ♪
        </div>
        <p>Click any musician on stage to follow them, see what they are playing and solo or mute their section.</p>
        <p className="fine">Drag to orbit, scroll to zoom, right-drag to pan.</p>
      </div>
    );
  }
  if (!actor.musician) return <ConductorInspector key={pieceId ?? 'none'} />;
  return <MusicianInspector key={`${selectedId}-${pieceId}`} id={selectedId!} />;
}

function ConductorInspector() {
  const [beat, setBeat] = useState('—');
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = transport.visualTime();
      const beats = orchestra.score?.beats ?? [];
      let lo = 0;
      let hi = beats.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (beats[mid].time <= t) lo = mid + 1;
        else hi = mid;
      }
      const b = beats[lo - 1];
      setBeat(b ? `Bar ${b.bar + 1} · beat ${b.beatInBar + 1} of ${b.beatsPerBar}` : '—');
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="inspector">
      <header className="insp-head">
        <span className="insp-family">On the podium</span>
        <h2>Conductor</h2>
        <p className="insp-sub">Beats time from the score's tempo map, sizes gestures to the dynamics and cues sections as they come in.</p>
      </header>
      <div className="insp-live">
        <span className="label">Now</span>
        <span className="beat">{beat}</span>
      </div>
      <FollowToggle />
    </div>
  );
}

function MusicianInspector({ id }: { id: string }) {
  const actor = orchestra.actorById(id)!;
  const m = actor.musician!;
  const info = SECTIONS[m.section];
  const muted = useApp((s) => s.muted.includes(m.section));
  const solo = useApp((s) => s.solo.includes(m.section));
  const highlight = useApp((s) => s.highlight === m.section);
  const { toggleMute, toggleSolo, toggleHighlight } = useApp.getState();
  const parts = m.partIds.map((pid) => orchestra.plans.get(pid)?.part).filter(Boolean);
  const [now, setNow] = useState<{ notes: string[]; dyn: number }>({ notes: [], dyn: 0 });

  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      const t = transport.visualTime();
      const act: Note[] = [];
      for (const pid of m.partIds) {
        const idx = orchestra.indexes.get(pid);
        if (idx) for (const n of idx.active(t)) if (!m.drum || n.drum === m.drum) act.push(n);
      }
      act.sort((a, b) => b.pitch - a.pitch);
      let dyn = 0;
      for (const p of parts) if (p) dyn = Math.max(dyn, loudnessAt(p.loudness, t));
      const names = m.drum ? (act.length ? [DRUM_LABEL[m.drum]] : []) : act.map((n) => noteName(n.pitch));
      const key = names.join(',') + Math.round(dyn * 20);
      if (key !== last) {
        last = key;
        setNow({ notes: names, dyn });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dynLabel = now.notes.length ? DYNAMICS[Math.min(7, Math.max(0, Math.round(now.dyn * 7)))] : 'rest';
  const partName = parts.map((p) => p!.name.replace(/:$/, '')).join(' + ');
  const shared = parts.length && parts[0]!.section !== m.section ? `Reads the ${SECTIONS[parts[0]!.section].label.toLowerCase()} part` : null;

  return (
    <div className="inspector">
      <header className="insp-head" style={{ ['--sec' as string]: info.color }}>
        <span className="insp-family">
          {FAMILY_LABEL[info.family]} · {info.plural}
        </span>
        <h2>{m.label}</h2>
        <p className="insp-sub">
          {m.drum ? DRUM_LABEL[m.drum] : info.label}
          {m.voices > 1 ? ` · divisi voice ${m.voice + 1} of ${m.voices}` : ''}
          {partName ? ` · part “${partName}”` : ''}
          {shared ? ` · ${shared}` : ''}
        </p>
      </header>

      <div className="insp-live">
        <div className="notes-now">
          <span className="label">Sounding now</span>
          <div className="note-chips">
            {now.notes.length ? now.notes.map((n, i) => <span key={i} className="note-chip">{n}</span>) : <span className="resting">Resting</span>}
          </div>
        </div>
        <div className="dyn">
          <span className="label">Dynamics</span>
          <div className="dyn-meter" aria-label={`dynamics ${dynLabel}`}>
            <div className="dyn-fill" style={{ width: `${Math.round((now.notes.length ? now.dyn : 0) * 100)}%` }} />
          </div>
          <span className="dyn-label">{dynLabel}</span>
        </div>
      </div>

      <PianoRoll partIds={m.partIds} drum={m.drum} color={info.color} />

      <div className="insp-actions">
        <FollowToggle />
        <button className={`tog ${solo ? 'on' : ''}`} onClick={() => toggleSolo(m.section)} title="Hear only this section">
          Solo {info.plural.toLowerCase()}
        </button>
        <button className={`tog ${muted ? 'on warn' : ''}`} onClick={() => toggleMute(m.section)} title="Silence this section">
          Mute
        </button>
        <button className={`tog ${highlight ? 'on' : ''}`} onClick={() => toggleHighlight(m.section)} title="Dim everyone else">
          Highlight section
        </button>
      </div>
    </div>
  );
}

function FollowToggle() {
  const follow = useApp((s) => s.follow);
  return (
    <button className={`tog ${follow ? 'on' : ''}`} onClick={() => useApp.getState().set({ follow: !follow })} title="Keep the camera on this musician">
      {follow ? 'Following' : 'Follow'}
    </button>
  );
}

/** Scrolling piano roll of the musician's part: 2 s of past, 6 s ahead. */
function PianoRoll({ partIds, drum, color }: { partIds: string[]; drum?: string; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const notes = partIds.flatMap((pid) => orchestra.plans.get(pid)?.part.notes ?? []).filter((n) => !drum || n.drum === drum);
    const pitches = notes.map((n) => n.pitch);
    let lo = pitches.length ? Math.min(...pitches) - 2 : 48;
    let hi = pitches.length ? Math.max(...pitches) + 2 : 72;
    if (hi - lo < 14) {
      const mid = (hi + lo) / 2;
      lo = mid - 7;
      hi = mid + 7;
    }
    const idx = partIds.map((pid) => orchestra.indexes.get(pid)).filter(Boolean);
    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = transport.visualTime();
      const past = 2;
      const ahead = 6;
      const x = (time: number) => ((time - (t - past)) / (past + ahead)) * w;
      const y = (p: number) => h - ((p - lo) / (hi - lo)) * h;
      // octave guides
      ctx.strokeStyle = 'rgba(255,240,220,0.06)';
      ctx.lineWidth = 1;
      for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
        ctx.beginPath();
        ctx.moveTo(0, y(p));
        ctx.lineTo(w, y(p));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,240,220,0.3)';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(`C${p / 12 - 1}`, 4, y(p) - 3);
      }
      const noteH = Math.max(3, h / (hi - lo) - 1);
      for (const ix of idx) {
        for (const n of ix!.range(t - past - ix!.maxDur, t + ahead)) {
          if (drum && n.drum !== drum) continue;
          if (n.end < t - past) continue;
          const sounding = n.start <= t && n.end > t;
          ctx.fillStyle = sounding ? color : 'rgba(239,230,216,0.28)';
          const x0 = x(n.start);
          const x1 = Math.max(x0 + 2, x(n.end));
          roundRect(ctx, x0, y(n.pitch) - noteH / 2, x1 - x0, noteH, 2);
          if (sounding) {
            ctx.shadowColor = color;
            ctx.shadowBlur = 8;
            roundRect(ctx, x0, y(n.pitch) - noteH / 2, x1 - x0, noteH, 2);
            ctx.shadowBlur = 0;
          }
        }
      }
      // playhead
      ctx.fillStyle = 'rgba(243,196,107,0.9)';
      ctx.fillRect(x(t) - 0.5, 0, 1.5, h);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [partIds, drum, color]);
  return (
    <div className="pianoroll">
      <span className="label">Their part</span>
      <canvas ref={canvas} />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

export function MixerPanel() {
  const sections = useApp((s) => s.sectionsInPiece);
  const muted = useApp((s) => s.muted);
  const solo = useApp((s) => s.solo);
  const highlight = useApp((s) => s.highlight);
  const { toggleMute, toggleSolo, toggleHighlight } = useApp.getState();
  if (!sections.length) return <div className="inspector empty"><p>Load a piece to mix its sections.</p></div>;
  const order: SectionId[] = ['violin1', 'violin2', 'viola', 'cello', 'bass', 'harp', 'piccolo', 'flute', 'oboe', 'clarinet', 'bassoon', 'horn', 'trumpet', 'trombone', 'tuba', 'timpani', 'percussion'];
  return (
    <div className="mixer">
      <p className="panel-intro">Solo, mute or spotlight any section while the piece plays.</p>
      <ul>
        {order
          .filter((s) => sections.includes(s))
          .map((s) => (
            <li key={s} className="mix-row">
              <span className="swatch" style={{ background: SECTIONS[s].color }} />
              <button
                className="mix-name"
                onClick={() => {
                  const a = orchestra.actors.find((x) => x.musician?.section === s);
                  if (a) useApp.getState().select(a.musician!.id);
                }}
              >
                {SECTIONS[s].plural}
              </button>
              <button className={`mini ${solo.includes(s) ? 'on' : ''}`} onClick={() => toggleSolo(s)} title="Solo">
                S
              </button>
              <button className={`mini ${muted.includes(s) ? 'on warn' : ''}`} onClick={() => toggleMute(s)} title="Mute">
                M
              </button>
              <button className={`mini ${highlight === s ? 'on' : ''}`} onClick={() => toggleHighlight(s)} title="Highlight">
                ☀
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
