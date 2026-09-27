import { Group, Material, Mesh, Object3D, SkinnedMesh, Sphere, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Rig } from '../rig/rig';
import { installShader, personalize, realisticMaterial, type EyeUniforms } from './characterMaterials';
import { registerInstanceMaterial, sectionMaterial } from './instrumentFactory';
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
  /** eye-position uniforms of this character's skin materials (for wet-eye shading) */
  eyeUniforms: EyeUniforms[];
}

const BASE = import.meta.env.BASE_URL ?? '/';
const POSE_BOUNDS = new Sphere(new Vector3(0, 0.85, 0.15), 1.35);
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
  // upgrade the GLB materials once per prototype: skin scattering, fabric sheen, hair highlights
  for (const p of protos) {
    const upgraded = new Map<Material, Material>();
    p.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: Material) => {
        let u = upgraded.get(m);
        if (!u) upgraded.set(m, (u = realisticMaterial(m)));
        return u;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }
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
export function characterVariantCount(): number {
  return protos.length;
}

/**
 * Creates a posable character. `variant` (if given) picks the base avatar explicitly, so the
 * orchestra can avoid seating identical twins side by side; `seed` drives per-person variation.
 */
export function createCharacter(seed: number, section: string, conductor = false, variant?: number): CharacterInstance {
  if (protos.length) {
    const pool = conductor ? protos.filter((p) => p.entry.gender !== 'female') : protos;
    const list = pool.length ? pool : protos;
    const proto = variant !== undefined && !conductor ? protos[variant % protos.length] : list[Math.floor(seed * list.length) % list.length];
    const root = new Group();
    root.name = `character-${proto.entry.id}`;
    const scene = skeletonClone(proto.scene);
    // people differ in size: ±3.5 % overall scale
    const r = Math.sin(seed * 7919.3) * 43758.5453;
    scene.scale.setScalar(0.965 + (r - Math.floor(r)) * 0.07);
    root.add(scene);
    const lods: SkinnedMesh[][] = [];
    const twins: [SkinnedMesh, SkinnedMesh][] = [];
    scene.traverse((o) => {
      const mesh = o as SkinnedMesh;
      if ((mesh as Mesh).isMesh && !mesh.userData.hairTwin) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // conservative bounds that hold for any seated / standing / reaching pose, so off-screen
        // musicians are culled (the bind-pose bounds would be wrong once animated)
        mesh.boundingSphere = POSE_BOUNDS.clone();
        mesh.frustumCulled = true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        // each musician gets their own material instances so skin tone / hair colour can vary
        const mapped = mats.map((m) => instanceMaterial(m as Material, section, seed));
        mesh.material = Array.isArray(mesh.material) ? mapped : mapped[0];
        if (mesh.isSkinnedMesh) {
          const level = lodLevel(mesh.name) || lodLevel(mesh.parent?.name ?? '');
          (lods[level] ??= []).push(mesh);
          // two-pass hair: solid core with a high cutoff + a blended pass for soft strand edges
          const hair = !Array.isArray(mesh.material) && (mesh.material as Material).userData.hair;
          if (hair && level <= 1) {
            const twin = new SkinnedMesh(mesh.geometry, hairBlendMaterial(mesh.material as Material, section, seed));
            twin.userData.hairTwin = true;
            twin.position.copy(mesh.position);
            twin.quaternion.copy(mesh.quaternion);
            twin.scale.copy(mesh.scale);
            twin.boundingSphere = POSE_BOUNDS.clone();
            twin.frustumCulled = true;
            twin.renderOrder = 3;
            twin.castShadow = false;
            twin.bind(mesh.skeleton, mesh.bindMatrix);
            twins.push([mesh, twin]);
            (mesh.material as Material).alphaTest = 0.55;
            (lods[level] ??= []).push(twin);
          }
        }
      }
    });
    for (const [mesh, twin] of twins) mesh.parent?.add(twin);
    const compact = lods.filter(Boolean);
    const rig = new Rig(root);
    const eyeUniforms = new Set<EyeUniforms>();
    for (const list of compact)
      for (const mesh of list) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const e = (m as Material).userData.eyeUniforms as EyeUniforms | undefined;
          if (e && (m as Material).userData.skin) eyeUniforms.add(e);
        }
      }
    return { root, rig, lods: compact, source: 'glb', id: proto.entry.id, eyeUniforms: [...eyeUniforms] };
  }
  const { root, mesh } = buildMannequinCached(seed, conductor);
  mesh.material = sectionMaterial(section, mesh.material as Material);
  const rig = new Rig(root);
  return { root, rig, lods: [[mesh]], source: 'mannequin', id: 'mannequin', eyeUniforms: [] };
}

const instanceCache = new Map<string, Material>();

function instanceMaterial(m: Material, section: string, seed: number): Material {
  const key = `${m.uuid}:${section}:${seed}`;
  let c = instanceCache.get(key);
  if (!c) {
    c = m.clone();
    c.userData.base = m;
    installShader(c);
    personalize(c, seed);
    if ((m as Material).alphaTest > 0) c.alphaToCoverage = true;
    registerInstanceMaterial(section, c);
    instanceCache.set(key, c);
  }
  return c;
}

function hairBlendMaterial(solid: Material, section: string, seed: number): Material {
  const key = `${solid.uuid}:blend`;
  let c = instanceCache.get(key);
  if (!c) {
    c = solid.clone();
    c.userData.base = solid.userData.base ?? solid;
    installShader(c);
    personalize(c, seed);
    c.transparent = true;
    c.alphaTest = 0.02;
    c.alphaToCoverage = false;
    c.depthWrite = false;
    registerInstanceMaterial(section, c);
    instanceCache.set(key, c);
  }
  return c;
}

/** Called when the orchestra is rebuilt. */
export function releaseCharacterInstances() {
  instanceCache.clear();
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
