import { useEffect } from 'react';
import { boot } from './app/controller';
import { useApp } from './app/store';
import { Viewport } from './scene/Viewport';
import { InspectorPanel, MixerPanel } from './ui/InspectorPanel';
import { LibraryPanel } from './ui/LibraryPanel';
import { CameraPresets, LoadingOverlay, TransportBar } from './ui/TransportBar';
import './app/debug';

export default function App() {
  useEffect(() => {
    void boot();
  }, []);
  const tab = useApp((s) => s.tab);
  const placeholder = useApp((s) => s.placeholderAssets);
  const selected = useApp((s) => s.selectedId);
  return (
    <div className="app">
      <main className="stage-view">
        <Viewport />
        <header className="brand">
          <span className="brand-mark">𝄞</span>
          <span className="brand-name">Orchestra</span>
        </header>
        <CameraPresets />
        {placeholder ? <span className="badge" title="Run the Blender pipeline (tools/blender) to replace these with realistic characters">Placeholder musicians</span> : null}
        <TransportBar />
        <LoadingOverlay />
      </main>
      <aside className="panel">
        <nav className="tabs" role="tablist">
          {(
            [
              ['library', 'Library'],
              ['musician', selected ? 'Musician' : 'Inspect'],
              ['mixer', 'Mixer'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => useApp.getState().set({ tab: id as never })}>
              {label}
            </button>
          ))}
        </nav>
        <div className="panel-body">{tab === 'library' ? <LibraryPanel /> : tab === 'musician' ? <InspectorPanel /> : <MixerPanel />}</div>
      </aside>
    </div>
  );
}
