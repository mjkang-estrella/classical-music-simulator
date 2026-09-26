#!/usr/bin/env bash
# Post-process the Rocketbox character GLBs written by tools/blender/rocketbox_to_glb.py.
#
#   tools/gltf/optimize-characters.sh [file.glb ...]      (default: public/assets/characters/*.glb)
#
# 1. LOD generation: nodes LOD1/LOD2 arrive from Blender as full copies of LOD0. Each primitive is
#    simplified in place with meshoptimizer's simplifyWithAttributes (normals + UVs weighted,
#    RegularizeLight for skinning). Only existing vertices are kept, so normals, UVs and skin
#    weights stay exact. Vertices shared with another primitive (e.g. the head/body neck seam) are
#    locked so no cracks open. Targets come from tools/blender/characters.json -> defaults.lods.
#    Idempotent: simplified meshes are tagged extras.lodSimplified and skipped on re-runs.
# 2. Optional (COMPRESS=1): EXT_meshopt_compression + quantization. Off by default (files are
#    ~1 MB already and it would require MeshoptDecoder on the loader).
# 3. Verification: the skin must survive (same joint count, inverseBindMatrices present, all LODs
#    on the same skin) -- the script exits non-zero otherwise.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

node --input-type=module - "$@" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, prune, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const ROOT = process.cwd();
const cast = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/blender/characters.json'), 'utf8'));
const specs = new Map(cast.defaults.lods.map((l) => [l.name, l]));
let files = process.argv.slice(2);
if (files.length === 0) {
  const dir = path.join(ROOT, cast.outputDir);
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort().map((f) => path.join(dir, f));
}
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
});

const triCount = (mesh) => mesh.listPrimitives().reduce((s, p) => s + p.getIndices().getCount() / 3, 0);
const posKey = (a, i) => `${a[i * 3].toFixed(5)},${a[i * 3 + 1].toFixed(5)},${a[i * 3 + 2].toFixed(5)}`;

function skinSignature(doc) {
  const skins = doc.getRoot().listSkins();
  return skins.map((s) => ({ joints: s.listJoints().length, ibm: s.getInverseBindMatrices()?.getCount() ?? 0 }));
}

function simplifyMesh(mesh, spec, refTris, logs) {
  const prims = mesh.listPrimitives();
  // positions of every primitive, to lock vertices on inter-primitive seams
  const keysByPrim = prims.map((p) => {
    const a = p.getAttribute('POSITION').getArray();
    const set = new Set();
    for (let i = 0; i < a.length / 3; i++) set.add(posKey(a, i));
    return set;
  });
  for (const [pi, prim] of prims.entries()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const nrm = prim.getAttribute('NORMAL')?.getArray();
    const uv = prim.getAttribute('TEXCOORD_0')?.getArray();
    const vcount = pos.length / 3;
    const stride = 5;
    const attrs = new Float32Array(vcount * stride);
    for (let i = 0; i < vcount; i++) {
      if (nrm) { attrs[i * stride] = nrm[i * 3]; attrs[i * stride + 1] = nrm[i * 3 + 1]; attrs[i * stride + 2] = nrm[i * 3 + 2]; }
      if (uv) { attrs[i * stride + 3] = uv[i * 2]; attrs[i * stride + 4] = uv[i * 2 + 1]; }
    }
    const lock = new Uint8Array(vcount);
    let locked = 0;
    for (let i = 0; i < vcount; i++) {
      const k = posKey(pos, i);
      for (let pj = 0; pj < prims.length; pj++) {
        if (pj !== pi && keysByPrim[pj].has(k)) { lock[i] = 1; locked++; break; }
      }
    }
    const idx = new Uint32Array(prim.getIndices().getArray());
    const target = Math.floor((spec.ratio * idx.length) / 3) * 3;
    const [dst, err] = MeshoptSimplifier.simplifyWithAttributes(
      idx, new Float32Array(pos), 3, attrs, stride, [0.5, 0.5, 0.5, 1.0, 1.0], lock,
      target, spec.maxError ?? 0.02, ['RegularizeLight'],
    );
    const indices = prim.getIndices().clone().setArray(dst.length / 3 <= 65535 && vcount <= 65535 ? new Uint16Array(dst) : dst);
    prim.setIndices(indices);
    compactPrimitive(prim);
    logs.push(`${prim.getMaterial()?.getName() ?? '?'} ${idx.length / 3}->${dst.length / 3} (err ${err.toFixed(4)}, locked ${locked})`);
  }
}

let failed = false;
for (const file of files) {
  const doc = await io.read(file);
  const before = skinSignature(doc);
  const nodes = doc.getRoot().listNodes();
  const lod0 = nodes.find((n) => n.getName() === 'LOD0');
  const refTris = lod0 ? triCount(lod0.getMesh()) : 0;
  const out = [];
  for (const node of nodes) {
    const spec = specs.get(node.getName());
    const mesh = node.getMesh();
    if (!spec || !mesh || spec.method !== 'meshopt' || node === lod0) continue;
    if (mesh === lod0?.getMesh()) throw new Error(`${file}: ${node.getName()} shares its mesh with LOD0`);
    const tris = triCount(mesh);
    if (mesh.getExtras()?.lodSimplified) { out.push(`${node.getName()}: already simplified (${tris} tris), skipped`); continue; }
    const logs = [];
    simplifyMesh(mesh, spec, refTris, logs);
    mesh.setExtras({ ...mesh.getExtras(), lodSimplified: { ratio: spec.ratio, maxError: spec.maxError ?? 0.02 } });
    out.push(`${node.getName()}: ${tris} -> ${triCount(mesh)} tris [${logs.join('; ')}]`);
  }
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true }));
  // quantizationVolume 'scene': one dequantization transform for all LODs, so they keep sharing one skin
  if (process.env.COMPRESS === '1') await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: 'scene' }));
  const after = skinSignature(doc);
  const lodSkins = new Set(doc.getRoot().listNodes().filter((n) => n.getMesh()).map((n) => n.getSkin()));
  const ok = JSON.stringify(before) === JSON.stringify(after) && after.length === 1 && after[0].ibm === after[0].joints && lodSkins.size === 1 && !lodSkins.has(null);
  await io.write(file, doc);
  console.log(`${path.relative(ROOT, file)} ${(fs.statSync(file).size / 1e6).toFixed(2)} MB  skin ${JSON.stringify(after)} ${ok ? 'OK' : 'SKIN CHANGED!'}`);
  for (const l of out) console.log('  ' + l);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
JS
