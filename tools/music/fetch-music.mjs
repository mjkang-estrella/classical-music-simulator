#!/usr/bin/env node
// Downloads the default (redistributable) MIDI library into public/music/.
// Sources: The Mutopia Project (public domain / CC BY-SA). Re-run safely; existing files are skipped.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'public', 'music');
mkdirSync(outDir, { recursive: true });

export const SOURCES = [
  {
    file: 'beethoven-symphony-5-i.mid',
    url: 'https://www.mutopiaproject.org/ftp/BeethovenLv/O67/Symphony5_1/Symphony5_1.mid',
  },
  {
    file: 'beethoven-symphony-7-ii.mid',
    url: 'https://www.mutopiaproject.org/ftp/BeethovenLv/O92/Symphony7_2/Symphony7_2.mid',
  },
  {
    file: 'beethoven-egmont-overture.mid',
    url: 'https://www.mutopiaproject.org/ftp/BeethovenLv/O84/Egmont/Egmont.mid',
  },
  {
    file: 'dvorak-symphony-9-iv.mid',
    url: 'https://www.mutopiaproject.org/ftp/DvorakA/O95/Sym9/Sym9-mids.zip',
    member: 'Mvt4_conFuoco.mid',
  },
  {
    file: 'mozart-eine-kleine-nachtmusik-i.mid',
    url: 'https://www.mutopiaproject.org/ftp/MozartWA/KV525/MozartWA-KV525/MozartWA-KV525-mids.zip',
    member: 'MozartWA-KV525-mov-01.mid',
  },
  {
    file: 'rossini-eduardo-e-cristina-overture.mid',
    url: 'https://www.mutopiaproject.org/ftp/RossiniG/Eduardo_e_Cristina/Eduardo_e_Cristina.mid',
  },
  {
    file: 'beethoven-coriolan-overture.mid',
    url: 'https://www.mutopiaproject.org/ftp/BeethovenLv/O62/Coriolan/Coriolan-mids.zip',
    member: 'coriolan.mid',
  },
];

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const force = process.argv.includes('--force');
  const hashes = {};
  for (const src of SOURCES) {
    const dest = join(outDir, src.file);
    if (existsSync(dest) && !force) {
      hashes[src.file] = sha256(readFileSync(dest));
      console.log(`✓ ${src.file} (cached)`);
      continue;
    }
    let buf = await fetchBuffer(src.url);
    if (src.member) {
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find((f) => f.name.split('/').pop() === src.member);
      if (!entry) throw new Error(`${src.member} not found in ${src.url}: ${Object.keys(zip.files).join(', ')}`);
      buf = Buffer.from(await entry.async('uint8array'));
    }
    if (buf.subarray(0, 4).toString('latin1') !== 'MThd') throw new Error(`${src.file} is not a MIDI file`);
    writeFileSync(dest, buf);
    hashes[src.file] = sha256(buf);
    console.log(`↓ ${src.file} (${buf.length} bytes)`);
  }
  writeFileSync(join(outDir, 'checksums.json'), JSON.stringify(hashes, null, 2) + '\n');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
