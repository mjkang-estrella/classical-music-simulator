import { Group, Material, Mesh, Object3D, SkinnedMesh, Sphere, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Rig } from '../rig/rig';
import { sectionMaterial } from './instrumentFactory';
import { buildMannequin, mannequinStyle } from './placeholder/mannequin';

export interface CharacterEntry {
  id: string;
  file: string;
  gender?: 'male' | 'female';
  height_m?: number;
  rig?: string;
  source?: string;
  license?: string;
}

interface Proto {
  entry: CharacterEntry;
  scene: Object3D;
}

export interface CharacterInstance {
  root: Group;
  rig: Rig;
  /** skinned meshes by LOD level (0 = most detailed) */
  lods: SkinnedMesh[][];
  source: 'glb' | 'mannequin';
  id: string;
}

const BASE = import.meta.env.BASE_URL ?? '/';
let protos: Proto[] = [];
let loaded = false;

/** Loads the realistic character GLBs listed in public/assets/characters/characters.json (if any). */
export async function loadCharacterLibrary(onProgress?: (done: number, total: number) => void): Promise<number> {
  if (loaded) return protos.length;
  loaded = true;
  let entries: CharacterEntry[] = [];
  try {
    const res = await fetch(`${BASE}assets/characters/characters.json`, { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      entries = Array.isArray(json) ? json : (json.characters ?? []);
    }
  } catch {
    entries = [];
  }
  if (!entries.length) return 0;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let done = 0;
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const gltf = await loader.loadAsync(`${BASE}assets/characters/${entry.file}`);
        onProgress?.(++done, entries.length);
        return { entry, scene: gltf.scene } as Proto;
      } catch (err) {
        console.warn(`[characters] failed to load ${entry.file}`, err);
        onProgress?.(++done, entries.length);
        return null;
      }
    }),
  );
  protos = results.filter(Boolean) as Proto[];
  // validate each rig once so a broken asset falls back to the mannequin
  protos = protos.filter((p) => {
    try {
      new Rig(skeletonClone(p.scene));
      return true;
    } catch (err) {
      console.warn(`[characters] ${p.entry.id} rig not usable`, err);
      return false;
    }
  });
  return protos.length;
}

export function characterSources(): CharacterEntry[] {
  return protos.map((p) => p.entry);
}

function lodLevel(name: string): number {
  const m = /LOD_?(\d)/i.exec(name) ?? /_(hipoly|midpoly|lowpoly|ultralowpoly)/i.exec(name);
  if (!m) return 0;
  if (/^\d$/.test(m[1])) return Number(m[1]);
  return { hipoly: 0, midpoly: 1, lowpoly: 2, ultralowpoly: 3 }[m[1].toLowerCase() as 'hipoly'] ?? 0;
}

/** Creates a posable character for a musician. `seed` in [0,1) picks the variant deterministically. */
export function createCharacter(seed: number, section: string, conductor = false): CharacterInstance {
  if (protos.length) {
    const pool = conductor ? protos.filter((p) => p.entry.gender !== 'female') : protos;
    const proto = (pool.length ? pool : protos)[Math.floor(seed * (pool.length || protos.length)) % (pool.length || protos.length)];
    const root = new Group();
    root.name = `character-${proto.entry.id}`;
    const scene = skeletonClone(proto.scene);
    root.add(scene);
    const lods: SkinnedMesh[][] = [];
    scene.traverse((o) => {
      const mesh = o as SkinnedMesh;
      if ((mesh as Mesh).isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          // smooth alpha-clipped hair / lashes with MSAA
          if ((m as Material).alphaTest > 0) (m as Material).alphaToCoverage = true;
        }
        const mapped = mats.map((m) => sectionMaterial(section, m as Material));
        mesh.material = Array.isArray(mesh.material) ? mapped : mapped[0];
        if (mesh.isSkinnedMesh) {
          const level = lodLevel(mesh.name) || lodLevel(mesh.parent?.name ?? '');
          (lods[level] ??= []).push(mesh);
        }
      }
    });
    const compact = lods.filter(Boolean);
    const rig = new Rig(root);
    return { root, rig, lods: compact, source: 'glb', id: proto.entry.id };
  }
  const { root, mesh } = buildMannequinCached(seed, conductor);
  mesh.material = sectionMaterial(section, mesh.material as Material);
  const rig = new Rig(root);
  return { root, rig, lods: [[mesh]], source: 'mannequin', id: 'mannequin' };
}

const mannequinCache = new Map<string, { root: Group; mesh: SkinnedMesh }>();

function buildMannequinCached(seed: number, conductor: boolean): { root: Group; mesh: SkinnedMesh } {
  const variant = conductor ? 'conductor' : String(Math.floor(seed * 12));
  let proto = mannequinCache.get(variant);
  if (!proto) {
    proto = buildMannequin(mannequinStyle(conductor ? 0.5 : (Number(variant) + 0.5) / 12, conductor));
    mannequinCache.set(variant, proto);
  }
  const root = skeletonClone(proto.root) as Group;
  let mesh: SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) mesh = o as SkinnedMesh;
  });
  const m = mesh! as SkinnedMesh;
  m.frustumCulled = false;
  m.castShadow = true;
  m.receiveShadow = true;
  m.boundingSphere = new Sphere(new Vector3(0, 0.9, 0), 1.2);
  return { root, mesh: m };
}
