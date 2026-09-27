#!/usr/bin/env node
/**
 * Validate the tier-2 instrument GLBs against the TS prototype contract.
 *
 *   node tools/blender/instruments/validate.mjs [--no-write] [kind ...]
 *
 * Per GLB:
 *  - every contract anchor exists as a node with exactly that name, under the right parent
 *    (root / `slide` / `floor` / bow root), within 2 mm of the contract position
 *  - bounding box extent per axis within 15 % of the TS version (documented exceptions -> WARN)
 *  - triangle budget, file size <= 1.5 MB, textures WebP/JPEG only
 * Writes public/assets/instruments/instruments.json listing only the kinds that pass
 * (bowed kinds need their bow to pass too). Exit code 1 if anything FAILs.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(ROOT, 'public', 'assets', 'instruments');
const contract = JSON.parse(fs.readFileSync(path.join(HERE, 'anchor_contract.json'), 'utf8'));

const TOL = 0.002; // 2 mm
const BOUNDS_TOL = 0.15;
const MAX_BYTES = 1.5 * 1024 * 1024;
const BOWED = ['violin', 'viola', 'cello', 'bass'];
const BUDGET = {
  violin: 12000, viola: 12000, cello: 16000, bass: 16000, bow: 2000,
  flute: 10000, piccolo: 10000, oboe: 10000, clarinet: 10000, bassoon: 10000,
  trumpet: 14000, horn: 14000, trombone: 14000, tuba: 14000, timpani: 20000,
};
const ORDER = ['violin', 'viola', 'cello', 'bass', 'trumpet', 'horn', 'trombone', 'tuba', 'flute', 'piccolo', 'oboe', 'clarinet', 'bassoon', 'timpani'];

/**
 * Bounding-box deviations beyond 15 % that are real detail additions of the realistic model
 * (documented here so they show up as WARN instead of FAIL).
 */
const BOUNDS_EXCEPTIONS = {
  violin: { y: 'real arching of the top and back plates (TS body is a flat 46 mm slab; real violin ~58 mm deep)' },
  viola: { y: 'real arching of the top and back plates' },
  violin_bow: { x: 'frog / head width (TS bow is a 12 mm box, the real frog is 11.5 mm wide but the ivory tip and pearl eyes add a little)', y: 'frog + head height of a real bow' },
  viola_bow: { x: 'real frog width', y: 'frog + head height of a real bow' },
  cello_bow: { x: 'real frog width', y: 'frog + head height of a real bow' },
  bass_bow: { x: 'real frog width', y: 'frog + head height of a real bow' },
};
// extra per-kind exceptions can be declared per family in bounds_exceptions_<family>.json:
//   { "<kind>": { "x": "reason", ... } }
for (const f of fs.readdirSync(HERE).filter((f) => /^bounds_exceptions.*\.json$/.test(f))) {
  const extra = JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'));
  for (const [k, v] of Object.entries(extra)) BOUNDS_EXCEPTIONS[k] = { ...(BOUNDS_EXCEPTIONS[k] ?? {}), ...v };
}

// ---------------------------------------------------------------- mat4 helpers (column-major)
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};
function inv(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}
const xform = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (v) => `(${v.map((x) => x.toFixed(4)).join(', ')})`;

// ---------------------------------------------------------------- per-file checks
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function ancestors(node) {
  const out = [];
  let p = node.getParentNode();
  while (p) { out.push(p); p = p.getParentNode(); }
  return out;
}

async function checkFile(label, file, anchorSets, bounds, budget, requiredNodes = []) {
  const rows = [];
  const res = { label, file, ok: true, rows, triangles: 0, bytes: 0, warnings: [] };
  const fp = path.join(OUT, file);
  if (!fs.existsSync(fp)) {
    res.ok = false;
    res.missing = true;
    rows.push({ check: 'file', status: 'FAIL', detail: 'missing' });
    return res;
  }
  res.bytes = fs.statSync(fp).size;
  const doc = await io.read(fp);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const tops = scene.listChildren();
  if (tops.length !== 1) {
    rows.push({ check: 'root', status: 'FAIL', detail: `expected 1 root node, got ${tops.length}` });
    res.ok = false;
  }
  const root = tops[0];
  const rootInv = inv(root.getWorldMatrix());
  const byName = new Map();
  for (const n of doc.getRoot().listNodes()) {
    if (byName.has(n.getName())) rows.push({ check: `unique ${n.getName()}`, status: 'FAIL', detail: 'duplicate node name' });
    byName.set(n.getName(), n);
  }
  for (const req of requiredNodes) {
    const n = byName.get(req.name);
    const ok = !!n && (req.parent ? n.getParentNode() === (req.parent === '<root>' ? root : byName.get(req.parent)) : true);
    rows.push({ check: `node ${req.name}`, status: ok ? 'PASS' : 'FAIL', detail: ok ? `child of ${req.parent}` : 'missing or wrongly parented' });
    if (!ok) res.ok = false;
    if (n && req.restTranslation) {
      const t = n.getTranslation();
      const d = dist(t, req.restTranslation);
      const pass = d <= TOL;
      rows.push({ check: `${req.name} rest`, status: pass ? 'PASS' : 'FAIL', detail: `${fmt(t)} vs ${fmt(req.restTranslation)}` });
      if (!pass) res.ok = false;
    }
  }
  // anchors
  for (const set of anchorSets) {
    const frameNode = set.frame === '<root>' ? root : byName.get(set.frame);
    for (const [name, expected] of Object.entries(set.anchors)) {
      const n = byName.get(name);
      if (!n || !frameNode) {
        rows.push({ check: `${set.frame === '<root>' ? '' : set.frame + '/'}${name}`, status: 'FAIL', detail: 'missing' });
        res.ok = false;
        continue;
      }
      const anc = ancestors(n);
      const parentOk = anc.includes(frameNode) && (!set.parent || n.getParentNode() === byName.get(set.parent));
      const frameInv = frameNode === root ? rootInv : inv(frameNode.getWorldMatrix());
      const p = xform(mul(frameInv, n.getWorldMatrix()), [0, 0, 0]);
      const d = dist(p, expected);
      const pass = d <= TOL && parentOk;
      // grip anchors (anchor_grip_*, anchor_left_hand) are owned by the app: informational only
      const appOwned = /^anchor_(grip_|left_hand)/.test(name);
      rows.push({
        check: `${set.frame === '<root>' ? '' : set.frame + '/'}${name}`,
        status: pass ? 'PASS' : appOwned ? 'INFO' : 'FAIL',
        detail: `${fmt(p)} Δ=${(d * 1000).toFixed(2)}mm${parentOk ? '' : ` bad parent (${n.getParentNode()?.getName()})`}`,
      });
      if (!pass && !appOwned) res.ok = false;
    }
  }
  // geometry: triangles + bounds in the root frame
  let tris = 0;
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    if (!(n === root || ancestors(n).includes(root))) continue;
    const m = mul(rootInv, n.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (prim.getMode() === 4) tris += (idx ? idx.getCount() : pos.getCount()) / 3;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const w = xform(m, v);
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
      }
    }
  }
  res.triangles = tris;
  res.bounds = { min: mn, max: mx };
  const tpass = tris <= budget;
  rows.push({ check: 'triangles', status: tpass ? 'PASS' : 'FAIL', detail: `${tris} / ${budget}` });
  if (!tpass) res.ok = false;
  const spass = res.bytes <= MAX_BYTES;
  rows.push({ check: 'file size', status: spass ? 'PASS' : 'FAIL', detail: `${(res.bytes / 1024).toFixed(0)} KB / ${MAX_BYTES / 1024} KB` });
  if (!spass) res.ok = false;
  const badTex = doc.getRoot().listTextures().filter((t) => !['image/webp', 'image/jpeg'].includes(t.getMimeType()));
  rows.push({ check: 'textures', status: badTex.length ? 'FAIL' : 'PASS', detail: `${doc.getRoot().listTextures().length} (${[...new Set(doc.getRoot().listTextures().map((t) => t.getMimeType()))].join(', ') || 'none'})` });
  if (badTex.length) res.ok = false;
  const mats = doc.getRoot().listMaterials();
  rows.push({ check: 'materials', status: 'INFO', detail: `${mats.length}: ${mats.map((m) => m.getName() + (m.getDoubleSided() ? '(2s)' : '')).join(', ')}` });
  if (bounds && bounds.min && bounds.min[0] !== null) {
    const axes = ['x', 'y', 'z'];
    for (let k = 0; k < 3; k++) {
      const ts = bounds.max[k] - bounds.min[k];
      const ours = mx[k] - mn[k];
      const ratio = ours / ts;
      const dev = Math.abs(ratio - 1);
      let status = dev <= BOUNDS_TOL ? 'PASS' : 'WARN';
      const exc = BOUNDS_EXCEPTIONS[label]?.[axes[k]];
      let detail = `extent ${ours.toFixed(3)} vs TS ${ts.toFixed(3)} (${(ratio * 100).toFixed(0)}%)  [${mn[k].toFixed(3)}, ${mx[k].toFixed(3)}] vs [${bounds.min[k].toFixed(3)}, ${bounds.max[k].toFixed(3)}]`;
      if (status === 'WARN') {
        if (exc) detail += `  -- exception: ${exc}`;
        else { status = 'FAIL'; res.ok = false; }
      }
      if (status === 'WARN') res.warnings.push(`${axes[k]}: ${exc}`);
      rows.push({ check: `bounds ${axes[k]}`, status, detail });
    }
  }
  return res;
}

// ---------------------------------------------------------------- main
const args = process.argv.slice(2);
const noWrite = args.includes('--no-write');
const only = args.filter((a) => !a.startsWith('--'));
const kinds = ORDER.filter((k) => (only.length ? only.includes(k) || only.includes(`${k}_bow`) : true));

const results = [];
for (const kind of kinds) {
  const c = contract[kind];
  const file = `${kind}.glb`;
  if (!fs.existsSync(path.join(OUT, file)) && !only.length) continue;
  const anchorSets = [{ frame: '<root>', anchors: c.root.anchors }];
  const required = [];
  if (c.slide) {
    required.push({ name: 'slide', parent: '<root>', restTranslation: c.slide.restPosition });
    anchorSets.push({ frame: 'slide', anchors: c.slide.anchors, parent: 'slide' });
  }
  if (kind === 'timpani') {
    required.push({ name: 'floor', parent: '<root>' });
    anchorSets[0] = { frame: '<root>', anchors: c.root.anchors, parent: 'floor' };
  }
  const r = await checkFile(kind, file, anchorSets, c.root.bounds, BUDGET[kind] ?? 14000, required);
  r.kind = kind;
  results.push(r);
  if (BOWED.includes(kind)) {
    const br = await checkFile(`${kind}_bow`, `${kind}_bow.glb`, [{ frame: '<root>', anchors: c.bow.anchors }], c.bow.bounds, BUDGET.bow);
    br.kind = kind;
    br.isBow = true;
    results.push(br);
  }
}

// ---------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
let anyFail = false;
console.log('');
console.log(pad('file', 20) + pad('check', 28) + pad('status', 8) + 'detail');
console.log('-'.repeat(120));
for (const r of results) {
  for (const row of r.rows) {
    if (row.status === 'FAIL') anyFail = true;
    console.log(pad(r.file, 20) + pad(row.check, 28) + pad(row.status, 8) + row.detail);
  }
  console.log('-'.repeat(120));
}
console.log('');
console.log(pad('summary', 20) + pad('triangles', 12) + pad('size', 10) + 'result');
const manifest = [];
for (const kind of kinds) {
  const main = results.find((r) => r.kind === kind && !r.isBow);
  if (!main) continue;
  const bow = results.find((r) => r.kind === kind && r.isBow);
  for (const r of [main, bow].filter(Boolean)) {
    console.log(pad(r.file, 20) + pad(r.triangles, 12) + pad(`${(r.bytes / 1024).toFixed(0)}KB`, 10) + (r.ok ? (r.warnings.length ? 'PASS (warn)' : 'PASS') : 'FAIL'));
  }
  if (main.ok && (!bow || bow.ok)) {
    const entry = { kind, file: main.file };
    if (bow) entry.bow = bow.file;
    entry.triangles = main.triangles;
    if (bow) entry.bowTriangles = bow.triangles;
    entry.license = 'CC0 (procedurally generated)';
    manifest.push(entry);
  }
}
if (!noWrite) {
  fs.writeFileSync(path.join(OUT, 'instruments.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nwrote public/assets/instruments/instruments.json (${manifest.length} kinds: ${manifest.map((m) => m.kind).join(', ')})`);
}
console.log(anyFail ? '\nVALIDATION: FAIL' : '\nVALIDATION: PASS');
process.exit(anyFail ? 1 : 0);
