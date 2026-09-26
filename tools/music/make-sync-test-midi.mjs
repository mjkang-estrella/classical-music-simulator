#!/usr/bin/env node
// Generates public/music/diagnostics.mid: a timpani click on every beat plus a scale handed from
// section to section, so audio/visual sync and track→section mapping can be checked by eye and ear.
import pkg from '@tonejs/midi';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Midi } = pkg;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bpm = 96;
const beat = 60 / bpm;
const midi = new Midi();
midi.header.setTempo(bpm);
midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4], measures: 0 });

const sections = [
  ['violin I', 40, 67],
  ['violin II', 40, 62],
  ['viola', 41, 55],
  ['violoncello', 42, 48],
  ['contrabasso', 43, 36],
  ['flauto', 73, 72],
  ['oboe', 68, 67],
  ['clarinetto', 71, 60],
  ['fagotto', 70, 48],
  ['corno', 60, 55],
  ['tromba', 56, 67],
  ['trombone', 57, 48],
  ['tuba', 58, 36],
];
const scale = [0, 2, 4, 5, 7, 9, 11, 12];
let channel = 0;
sections.forEach(([name, program, base], i) => {
  const t = midi.addTrack();
  t.name = name;
  t.channel = channel === 9 ? ++channel : channel;
  channel++;
  t.instrument.number = program;
  const start = i * 2 * 4 * beat; // two bars per section
  scale.forEach((step, k) => t.addNote({ midi: base + step, time: start + k * beat, duration: beat * 0.9, velocity: 0.55 + 0.05 * k }));
});
const total = sections.length * 2 * 4;
const timp = midi.addTrack();
timp.name = 'timpani';
timp.channel = 13;
timp.instrument.number = 47;
for (let b = 0; b < total; b++) timp.addNote({ midi: b % 4 === 0 ? 43 : 48, time: b * beat, duration: 0.2, velocity: b % 4 === 0 ? 0.95 : 0.6 });
const perc = midi.addTrack();
perc.name = 'piatti';
perc.channel = 9;
perc.addNote({ midi: 49, time: total * beat, duration: 1.5, velocity: 0.9 });

writeFileSync(join(root, 'public', 'music', 'diagnostics.mid'), Buffer.from(midi.toArray()));
console.log(`wrote diagnostics.mid (${(total * beat).toFixed(1)} s)`);
