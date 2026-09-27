import { BufferGeometry, Group, Material, Matrix4, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { InstrumentKind } from '../orchestra/sections';
import { buildBowed } from './instruments/bowed';
import { materials } from './instruments/materials';
import { buildBassDrum, buildCymbals, buildHarp, buildSnare, buildSuspended, buildTimpani, buildTriangle } from './instruments/percussion';
import type { Grip, InstrumentModel } from './instruments/types';
import { buildBassoon, buildFlute, buildHorn, buildReed, buildTrombone, buildTrumpet, buildTuba } from './instruments/winds';

function buildPrototype(kind: InstrumentKind): InstrumentModel {
  const m = materials();
  switch (kind) {
    case 'violin':
    case 'viola':
    case 'cello':
    case 'bass':
      return buildBowed(kind, m);
    case 'flute':
      return buildFlute(m);
    case 'piccolo':
      return buildFlute(m, true);
    case 'oboe':
    case 'clarinet':
      return buildReed(m, kind);
    case 'bassoon':
      return buildBassoon(m);
    case 'trumpet':
      return buildTrumpet(m);
    case 'horn':
      return buildHorn(m);
    case 'trombone':
      return buildTrombone(m);
    case 'tuba':
      return buildTuba(m);
    case 'timpani':
      return buildTimpani(m);
    case 'bassdrum':
      return buildBassDrum(m);
    case 'cymbals':
      return buildCymbals(m);
    case 'suspended':
      return buildSuspended(m);
    case 'snare':
      return buildSnare(m);
    case 'triangle':
      return buildTriangle(m);
    case 'harp':
      return buildHarp(m);
  }
}

/**
 * Merges every mesh below `root` (except inside `keep` subtrees) into one mesh per material,
 * so a whole instrument costs a handful of draw calls.
 */
export function bake(root: Object3D, keep: Set<Object3D>): void {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map<Material, BufferGeometry[]>();
  const remove: Mesh[] = [];
  const visit = (o: Object3D) => {
    if (o !== root && keep.has(o)) return;
    if ((o as Mesh).isMesh && !(o as Mesh).userData.noBake) {
      const mesh = o as Mesh;
      const mat = mesh.material as Material;
      let geo = mesh.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
      if (geo.index) geo = geo.toNonIndexed();
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
      if (!geo.attributes.uv) return;
      byMat.set(mat, [...(byMat.get(mat) ?? []), geo]);
      remove.push(mesh);
    }
    for (const c of [...o.children]) visit(c);
  };
  visit(root);
  for (const mesh of remove) mesh.parent?.remove(mesh);
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

// ---------------------------------------------------------------- realistic (Blender) instruments

interface RealisticEntry {
  kind: InstrumentKind;
  file: string;
  bow?: string;
}

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const realistic = new Map<InstrumentKind, { scene: Object3D; bow?: Object3D }>();

/** Loads tier-2 instrument GLBs listed in public/assets/instruments/instruments.json (optional). */
export async function loadInstrumentLibrary(): Promise<number> {
  let entries: RealisticEntry[] = [];
  try {
    const res = await fetch(`${BASE}assets/instruments/instruments.json`, { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      entries = Array.isArray(json) ? json : (json.instruments ?? []);
    }
  } catch {
    return 0;
  }
  if (!entries.length) return 0;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(
    entries.map(async (e) => {
      try {
        const scene = (await loader.loadAsync(`${BASE}assets/instruments/${e.file}`)).scene;
        const bow = e.bow ? (await loader.loadAsync(`${BASE}assets/instruments/${e.bow}`)).scene : undefined;
        realistic.set(e.kind, { scene, bow });
      } catch (err) {
        console.warn(`[instruments] could not load ${e.file}; using the procedural ${e.kind}`, err);
      }
    }),
  );
  prototypes.clear();
  return realistic.size;
}

export function realisticInstrumentKinds(): InstrumentKind[] {
  return [...realistic.keys()];
}

/** Moves the meshes of `src` (excluding named sub-nodes) under `dst`, keeping their transforms relative to `src`. */
function adoptMeshes(src: Object3D, dst: Object3D, exclude: Set<string>) {
  src.updateMatrixWorld(true);
  const inv = new Matrix4().copy(src.matrixWorld).invert();
  const found: Mesh[] = [];
  const visit = (o: Object3D) => {
    if (o !== src && exclude.has(o.name)) return;
    if ((o as Mesh).isMesh) found.push(o as Mesh);
    for (const c of o.children) visit(c);
  };
  visit(src);
  for (const m of found) {
    const clone = new Mesh(m.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld)), m.material);
    clone.castShadow = clone.receiveShadow = true;
    dst.add(clone);
  }
}

/** Copies anchor positions from a GLB node tree onto the prototype's anchors (same names). */
function syncAnchors(src: Object3D, dst: Object3D) {
  src.updateMatrixWorld(true);
  const inv = new Matrix4().copy(src.matrixWorld).invert();
  src.traverse((o) => {
    // grips are hand-placement data owned by the animation code, not instrument geometry
    if (!o.name.startsWith('anchor_') || o.name.startsWith('anchor_grip') || o.name === 'anchor_left_hand') return;
    const target = dst.getObjectByName(o.name);
    // prototype anchors hang directly off root / slide / floor; nested ones keep their procedural position
    if (!target || target.parent !== dst) return;
    target.position.copy(o.getWorldPosition(target.position.clone()).applyMatrix4(inv));
  });
}

function removeMeshes(obj: Object3D, keep: Set<Object3D>) {
  const doomed: Object3D[] = [];
  const visit = (o: Object3D) => {
    if (o !== obj && keep.has(o)) return;
    if ((o as Mesh).isMesh) doomed.push(o);
    for (const c of o.children) visit(c);
  };
  visit(obj);
  for (const d of doomed) d.parent?.remove(d);
}

/** Replaces the procedural meshes with the realistic GLB meshes, keeping anchors & grips. */
function skinSwap(p: InstrumentModel, glb: { scene: Object3D; bow?: Object3D }) {
  const sub = new Set([p.slide, p.floor].filter(Boolean) as Object3D[]);
  removeMeshes(p.root, sub);
  adoptMeshes(glb.scene, p.root, new Set(['slide', 'floor']));
  syncAnchors(glb.scene, p.root);
  const glbSlide = glb.scene.getObjectByName('slide');
  if (p.slide && glbSlide) {
    removeMeshes(p.slide, new Set());
    adoptMeshes(glbSlide, p.slide, new Set());
    syncAnchors(glbSlide, p.slide);
  }
  const glbFloor = glb.scene.getObjectByName('floor');
  if (p.floor && glbFloor) {
    removeMeshes(p.floor, new Set());
    adoptMeshes(glbFloor, p.floor, new Set());
    syncAnchors(glbFloor, p.floor);
  }
  if (p.bow && glb.bow) {
    removeMeshes(p.bow, new Set());
    adoptMeshes(glb.bow, p.bow, new Set());
  }
}

const prototypes = new Map<InstrumentKind, InstrumentModel>();

function prototype(kind: InstrumentKind): InstrumentModel {
  let p = prototypes.get(kind);
  if (!p) {
    p = buildPrototype(kind);
    if (p.floor) p.floor.name = 'floor';
    const glb = realistic.get(kind);
    if (glb) skinSwap(p, glb);
    const keep = new Set<Object3D>([p.slide, p.floor].filter(Boolean) as Object3D[]);
    bake(p.root, keep);
    if (p.slide) bake(p.slide, new Set());
    if (p.floor) bake(p.floor, new Set());
    if (p.bow) bake(p.bow, new Set());
    for (const h of Object.values(p.held ?? {})) if (h) bake(h, new Set());
    prototypes.set(kind, p);
  }
  return p;
}

/** Per-section material clones so a section can be dimmed / highlighted independently. */
const sectionMaterials = new Map<string, Map<Material, Material>>();

export function sectionMaterial(section: string, mat: Material): Material {
  let map = sectionMaterials.get(section);
  if (!map) sectionMaterials.set(section, (map = new Map()));
  let clone = map.get(mat);
  if (!clone) {
    clone = mat.clone();
    clone.userData.base = mat;
    map.set(mat, clone);
  }
  return clone;
}

export function materialsForSection(section: string): Material[] {
  return [...(sectionMaterials.get(section)?.values() ?? [])];
}

function cloneTree(obj: Object3D, section: string): Object3D {
  const c = obj.clone(true);
  c.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) mesh.material = sectionMaterial(section, mesh.material as Material);
  });
  return c;
}

function remapGrip(g: Grip | undefined, holder: Object3D): Grip | undefined {
  if (!g) return undefined;
  const anchor = holder.getObjectByName(g.anchor.name);
  if (!anchor) return undefined;
  return { ...g, anchor, dir: g.dir.clone(), palm: g.palm.clone() };
}

/** Returns a new instance of an instrument (geometry shared with the prototype). */
export function createInstrument(kind: InstrumentKind, section: string): InstrumentModel {
  const p = prototype(kind);
  const root = cloneTree(p.root, section) as Group;
  const anchors: InstrumentModel['anchors'] = {};
  for (const name of Object.keys(p.anchors)) {
    const a = root.getObjectByName(`anchor_${name}`);
    if (a) anchors[name] = a;
  }
  const slide = p.slide ? root.getObjectByName('slide') ?? undefined : undefined;
  const floor = p.floor ? (root.getObjectByName('floor') as Group | undefined) : undefined;
  const bow = p.bow ? (cloneTree(p.bow, section) as Group) : undefined;
  const held: InstrumentModel['held'] = {};
  for (const side of ['L', 'R'] as const) {
    const h = p.held?.[side];
    if (h) held[side] = cloneTree(h, section) as Group;
  }
  const holderFor = (side: 'L' | 'R'): Object3D => held[side] ?? (side === 'R' && slide ? slide : root);
  return {
    kind,
    root,
    anchors,
    bowed: p.bowed,
    bow,
    held: p.held ? held : undefined,
    slide,
    floor,
    grips: {
      L: remapGrip(p.grips.L, holderFor('L')),
      R: remapGrip(p.grips.R, holderFor('R')),
    },
  };
}
