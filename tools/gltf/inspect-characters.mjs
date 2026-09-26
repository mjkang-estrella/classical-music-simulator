#!/usr/bin/env node
/**
 * Inspect / validate the Rocketbox character GLBs and (optionally) write the metadata sidecar.
 *
 *   node tools/gltf/inspect-characters.mjs                 # inspect public/assets/characters/*.glb
 *   node tools/gltf/inspect-characters.mjs a.glb b.glb     # specific files
 *   node tools/gltf/inspect-characters.mjs --write-sidecar # also write public/assets/characters/characters.json
 *   node tools/gltf/inspect-characters.mjs --json          # machine-readable dump
 *
 * Prints skins, joint count, inverseBindMatrices, per-LOD triangle counts, bind-pose bounding box,
 * textures, and bind-pose world positions of the key joints. Exits 1 if a check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, ImageUtils } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'public/assets/characters');
const CAST = path.join(ROOT, 'tools/blender/characters.json');

// three.js PropertyBinding.sanitizeNodeName
const sanitize = (name) => name.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');

const KEY_JOINTS = [
  'Bip01 Pelvis', 'Bip01 Spine', 'Bip01 Spine1', 'Bip01 Spine2', 'Bip01 Neck', 'Bip01 Head',
  'Bip01 L Clavicle', 'Bip01 L UpperArm', 'Bip01 L Forearm', 'Bip01 L Hand',
  'Bip01 R Clavicle', 'Bip01 R UpperArm', 'Bip01 R Forearm', 'Bip01 R Hand',
  'Bip01 L Finger1', 'Bip01 L Finger11', 'Bip01 L Finger12',
  'Bip01 L Thigh', 'Bip01 L Calf', 'Bip01 L Foot', 'Bip01 L Toe0',
  'Bip01 R Thigh', 'Bip01 R Calf', 'Bip01 R Foot', 'Bip01 R Toe0',
  'Bip01 MJaw', 'Bip01 LEyeBlinkTop', 'Bip01 LEyeBlinkBottom', 'Bip01 REyeBlinkTop', 'Bip01 REyeBlinkBottom',
  'Bip01 LEye', 'Bip01 REye', 'Bip01 MNose',
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
let files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.glb')).sort().map((f) => path.join(OUT_DIR, f));
}

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const worldPos = (node) => { const m = node.getWorldMatrix(); return [m[12], m[13], m[14]]; };

// column-major 4x4 multiply (gl-matrix layout, as returned by gltf-transform)
function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** Bind-pose bounds of a (skinned) mesh node. In the bind pose every joint's world * IBM is the same
 * matrix (identity, or the dequantization transform when KHR_mesh_quantization folded it into the IBMs). */
function bindPoseBounds(node) {
  let M = node.getWorldMatrix();
  const skin = node.getSkin();
  if (skin && skin.getInverseBindMatrices()) {
    const ibm = []; skin.getInverseBindMatrices().getElement(0, ibm);
    M = mul4(skin.listJoints()[0].getWorldMatrix(), ibm);
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const v = [];
  for (const p of node.getMesh().listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (let r = 0; r < 3; r++) {
        const w = M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + M[12 + r];
        if (w < min[r]) min[r] = w;
        if (w > max[r]) max[r] = w;
      }
    }
  }
  return { min, max };
}

function triCount(mesh) {
  let n = 0;
  for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    const pos = p.getAttribute('POSITION');
    n += (idx ? idx.getCount() : pos.getCount()) / 3;
  }
  return n;
}

function vertCount(mesh) {
  return mesh.listPrimitives().reduce((s, p) => s + p.getAttribute('POSITION').getCount(), 0);
}

function usedJoints(mesh, jointCount) {
  const used = new Set();
  for (const p of mesh.listPrimitives()) {
    const J = p.getAttribute('JOINTS_0');
    const W = p.getAttribute('WEIGHTS_0');
    if (!J || !W) continue;
    const j = [], w = [];
    for (let i = 0; i < J.getCount(); i++) {
      J.getElement(i, j); W.getElement(i, w);
      for (let k = 0; k < 4; k++) if (w[k] > 0) used.add(j[k]);
    }
  }
  return [...used].filter((i) => i < jointCount).length;
}

async function inspect(file) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const errors = [];
  const skins = root.listSkins();
  const nodes = root.listNodes();
  const skin = skins[0];
  const joints = skin ? skin.listJoints() : [];
  const ibm = skin ? skin.getInverseBindMatrices() : null;
  if (skins.length !== 1) errors.push(`expected 1 skin, found ${skins.length}`);
  if (!ibm) errors.push('inverseBindMatrices missing');
  else if (ibm.getCount() !== joints.length) errors.push(`IBM count ${ibm.getCount()} != joints ${joints.length}`);

  const lodNodes = nodes.filter((n) => n.getMesh()).sort((a, b) => a.getName().localeCompare(b.getName()));
  const lods = lodNodes.map((n) => ({
    name: n.getName(),
    triangles: triCount(n.getMesh()),
    vertices: vertCount(n.getMesh()),
    bones: n.getSkin() ? n.getSkin().listJoints().length : 0,
    weightedBones: usedJoints(n.getMesh(), joints.length),
    primitives: n.getMesh().listPrimitives().map((p) => {
      const m = p.getMaterial();
      return m ? `${m.getName()}:${m.getAlphaMode()}${m.getAlphaMode() === 'MASK' ? '@' + m.getAlphaCutoff() : ''}${m.getDoubleSided() ? ':2s' : ''}` : 'none';
    }),
    skin: n.getSkin() ? skins.indexOf(n.getSkin()) : -1,
  }));
  for (const want of ['LOD0', 'LOD1', 'LOD2']) {
    if (!lods.find((l) => l.name === want)) errors.push(`missing mesh node ${want}`);
  }
  if (new Set(lods.map((l) => l.skin)).size !== 1 || lods.some((l) => l.skin < 0)) {
    errors.push('LOD meshes are not all bound to the same skin');
  }
  for (const l of lods) if (l.bones !== joints.length) errors.push(`${l.name} skin joints ${l.bones}`);

  const lod0 = lodNodes.find((n) => n.getName() === 'LOD0') || lodNodes[0];
  const bb = bindPoseBounds(lod0);
  const height = bb.max[1] - bb.min[1];
  if (Math.abs(bb.min[1]) > 0.01) errors.push(`feet not on y=0 (min y ${bb.min[1].toFixed(4)})`);
  if (height < 1.55 || height > 1.95) errors.push(`height ${height.toFixed(3)} m out of range`);

  const byName = new Map(joints.map((j) => [j.getName(), j]));
  const keyJoints = {};
  for (const k of KEY_JOINTS) {
    const j = byName.get(k);
    if (j) keyJoints[sanitize(k)] = r3(worldPos(j));
  }
  const head = byName.get('Bip01 Head'), nose = byName.get('Bip01 MNose');
  if (head && nose && !(worldPos(nose)[2] > worldPos(head)[2])) errors.push('character does not face +Z');
  // A-pose / palm facts (left side; right side is mirrored)
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const dot = (a, b) => a.reduce((acc, v, i) => acc + v * b[i], 0);
  const unit = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const P = (n) => worldPos(byName.get(n));
  let armInfo = null;
  if (['Bip01 L UpperArm', 'Bip01 L Forearm', 'Bip01 L Hand', 'Bip01 L Finger1', 'Bip01 L Finger4', 'Bip01 L Finger2', 'Bip01 L Finger21', 'Bip01 L Finger22'].every((n) => byName.has(n))) {
    const ua = sub(P('Bip01 L Forearm'), P('Bip01 L UpperArm'));
    const fa = sub(P('Bip01 L Hand'), P('Bip01 L Forearm'));
    const below = (v) => (Math.atan2(-v[1], Math.hypot(v[0], v[2])) * 180) / Math.PI;
    let palm = unit(cross(sub(P('Bip01 L Finger1'), P('Bip01 L Finger4')), sub(P('Bip01 L Finger2'), P('Bip01 L Hand'))));
    const curl = sub(unit(sub(P('Bip01 L Finger22'), P('Bip01 L Finger21'))), unit(sub(P('Bip01 L Finger21'), P('Bip01 L Finger2'))));
    if (dot(palm, curl) < 0) palm = palm.map((v) => -v);
    armInfo = {
      upperArmBelowHorizontal_deg: +below(ua).toFixed(1),
      forearmBelowHorizontal_deg: +below(fa).toFixed(1),
      elbowFlex_deg: +((Math.acos(dot(unit(ua), unit(fa))) * 180) / Math.PI).toFixed(1),
      leftPalmNormal: r3(palm),
    };
  }
  const lua = byName.get('Bip01 L UpperArm');
  if (lua && !(worldPos(lua)[0] > 0)) errors.push("character's left is not +X");
  for (const req of ['Bip01 MJaw', 'Bip01 L Finger0', 'Bip01 L Finger42', 'Bip01 R Finger42', 'Bip01 LEyeBlinkTop']) {
    if (!byName.has(req)) errors.push(`missing joint ${req}`);
  }
  if ([...byName.keys()].some((n) => /footsteps/i.test(n))) errors.push('Footsteps bone still present');

  const textures = root.listTextures().map((t) => {
    const size = ImageUtils.getSize(t.getImage(), t.getMimeType());
    return { name: t.getName(), mime: t.getMimeType(), size: size ? `${size[0]}x${size[1]}` : '?', bytes: t.getImage().byteLength };
  });
  const extensions = root.listExtensionsUsed().map((e) => e.extensionName);
  const rootNodes = root.getDefaultScene()?.listChildren().map((n) => n.getName()) ?? [];
  const bytes = fs.statSync(file).size;
  if (bytes > 4.2e6) errors.push(`file size ${(bytes / 1e6).toFixed(2)} MB > 4 MB budget`);
  if (animationsCount(root)) errors.push('file contains animations');

  return {
    file: path.relative(ROOT, file), bytes, skins: skins.length, joints: joints.length,
    ibm: ibm ? ibm.getCount() : 0, lods, bbox: { min: r3(bb.min), max: r3(bb.max) }, height: +height.toFixed(3),
    rootNodes, skeletonRoot: skin?.getSkeleton()?.getName() ?? null,
    jointNamesRaw: joints.map((j) => j.getName()), boneNames: joints.map((j) => sanitize(j.getName())),
    keyJoints, armInfo, textures, extensions, errors,
  };
}

function animationsCount(root) { return root.listAnimations().length; }

const results = [];
for (const f of files) results.push(await inspect(f));

if (flags.has('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`\n== ${r.file}  ${(r.bytes / 1e6).toFixed(2)} MB  ext=[${r.extensions.join(', ')}]`);
    console.log(`   skins=${r.skins} joints=${r.joints} inverseBindMatrices=${r.ibm} skeletonRoot=${r.skeletonRoot} sceneRoots=[${r.rootNodes}]`);
    for (const l of r.lods) {
      console.log(`   ${l.name.padEnd(5)} tris=${String(l.triangles).padStart(5)} verts=${String(l.vertices).padStart(5)} skin#${l.skin} joints=${l.bones} weighted=${l.weightedBones}  [${l.primitives.join(' | ')}]`);
    }
    console.log(`   bbox min=${r.bbox.min} max=${r.bbox.max} height=${r.height} m`);
    for (const t of r.textures) console.log(`   tex ${t.name} ${t.mime} ${t.size} ${(t.bytes / 1024).toFixed(0)} KB`);
    const k = r.keyJoints;
    console.log(`   head=${k.Bip01_Head} Lsh=${k.Bip01_L_UpperArm} Rsh=${k.Bip01_R_UpperArm} Lel=${k.Bip01_L_Forearm} Lwr=${k.Bip01_L_Hand} Lhip=${k.Bip01_L_Thigh} Lknee=${k.Bip01_L_Calf} Lank=${k.Bip01_L_Foot}`);
    console.log(r.errors.length ? `   FAIL: ${r.errors.join('; ')}` : '   OK');
  }
}

if (flags.has('--write-sidecar')) {
  const cast = JSON.parse(fs.readFileSync(CAST, 'utf8'));
  const byId = new Map(cast.characters.map((c) => [c.id, c]));
  const sidecar = results.map((r) => {
    const id = path.basename(r.file, '.glb');
    const c = byId.get(id) || {};
    return {
      id,
      file: path.basename(r.file),
      source: 'rocketbox',
      sourceAvatar: c.name,
      license: 'MIT',
      gender: c.gender,
      height_m: r.height,
      bytes: r.bytes,
      lods: r.lods.map((l) => ({ name: l.name, triangles: l.triangles, bones: l.bones, weightedBones: l.weightedBones })),
      rig: 'bip01',
      rootNode: r.rootNodes[0] ?? null,
      boneNames: r.boneNames,
      bindPose: {
        pose: 'A-pose (native Rocketbox bind pose = glTF rest pose; no animations in file)',
        space: 'glTF world, meters, +Y up, character faces +Z, character left = +X; joint origins in the rest (bind) pose',
        axes: '3ds Max Biped joint frames: spine/limb/finger joints point to their child along local +X; hands: palm normal = local +Y (both sides); root node Bip01 has identity transform',
        ...r.armInfo,
        joints: r.keyJoints,
      },
      notes: [
        c.notes,
        'LOD0 is the Rocketbox hipoly_81_bones mesh; LOD1/LOD2 are meshoptimizer simplifications of it (original vertices kept; the repo FBX ships no other LOD meshes).',
        'In three.js each LOD node is a Group with one SkinnedMesh child per material; all share one Skeleton.',
      ].filter(Boolean).join(' '),
    };
  });
  const dst = path.join(OUT_DIR, 'characters.json');
  fs.writeFileSync(dst, JSON.stringify(sidecar, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, dst)} (${sidecar.length} characters)`);
}

const failed = results.filter((r) => r.errors.length);
if (failed.length) {
  console.error(`\n${failed.length} file(s) failed validation`);
  process.exit(1);
}
