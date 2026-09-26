import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2];
for (const f of readdirSync(dir).filter(f => f.endsWith('.mid'))) {
  const m = new Midi(readFileSync(`${dir}/${f}`));
  console.log(`\n== ${f} dur=${m.duration.toFixed(1)}s tempos=${m.header.tempos.length} (${m.header.tempos.slice(0,3).map(t=>t.bpm.toFixed(0)).join(',')}) ts=${JSON.stringify(m.header.timeSignatures.slice(0,3).map(t=>t.timeSignature))} ppq=${m.header.ppq}`);
  m.tracks.forEach((t, i) => {
    if (!t.notes.length) return;
    const vels = t.notes.map(n => n.velocity);
    const pitches = t.notes.map(n => n.midi);
    const cc7 = t.controlChanges[7]?.length ?? 0;
    const cc11 = t.controlChanges[11]?.length ?? 0;
    console.log(`  #${i} "${t.name}" ch=${t.channel} prog=${t.instrument.number} (${t.instrument.name}) notes=${t.notes.length} vel=${Math.min(...vels).toFixed(2)}-${Math.max(...vels).toFixed(2)} pitch=${Math.min(...pitches)}-${Math.max(...pitches)} cc7=${cc7} cc11=${cc11}`);
  });
}
