import {
  Bone,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface MannequinStyle {
  height: number;
  feminine: boolean;
  skin: string;
  hair: string;
  hairStyle: 'short' | 'long' | 'bun' | 'bald';
  suit: string;
  /** white shirt front + bow tie (conductor) */
  tails?: boolean;
}

type P = [number, number, number];

/** Joint layout for a 1.75 m figure in T-pose, palms down, facing +Z. */
function joints(feminine: boolean): Record<string, P> {
  const sw = feminine ? 0.155 : 0.175; // half shoulder width
  const hw = feminine ? 0.1 : 0.092; // half hip width
  const j: Record<string, P> = {
    Hips: [0, 0.95, 0],
    Spine: [0, 1.03, 0],
    Spine1: [0, 1.15, 0],
    Spine2: [0, 1.28, 0],
    Neck: [0, 1.47, 0],
    Head: [0, 1.56, 0.01],
    LeftShoulder: [0.03, 1.42, 0],
    LeftArm: [sw, 1.42, -0.01],
    LeftForeArm: [sw + 0.28, 1.42, -0.01],
    LeftHand: [sw + 0.53, 1.42, -0.01],
    LeftUpLeg: [hw, 0.92, 0],
    LeftLeg: [hw, 0.5, 0.005],
    LeftFoot: [hw, 0.085, -0.02],
    LeftToeBase: [hw, 0.02, 0.11],
  };
  const hx = j.LeftHand[0];
  const fingers: Record<string, { base: P; dir: P; len: number[] }> = {
    Index: { base: [hx + 0.09, 1.42, 0.028], dir: [1, 0, 0.02], len: [0.042, 0.026, 0.021] },
    Middle: { base: [hx + 0.094, 1.42, 0.007], dir: [1, 0, 0], len: [0.047, 0.029, 0.023] },
    Ring: { base: [hx + 0.089, 1.42, -0.013], dir: [1, 0, -0.03], len: [0.043, 0.027, 0.021] },
    Pinky: { base: [hx + 0.078, 1.418, -0.031], dir: [1, 0, -0.08], len: [0.033, 0.021, 0.018] },
    Thumb: { base: [hx + 0.025, 1.408, 0.03], dir: [0.62, -0.12, 0.78], len: [0.038, 0.031, 0.026] },
  };
  for (const [f, { base, dir, len }] of Object.entries(fingers)) {
    const d = new Vector3(...dir).normalize();
    const p = new Vector3(...base);
    for (let i = 0; i < 3; i++) {
      j[`LeftHand${f}${i + 1}`] = [p.x, p.y, p.z];
      p.addScaledVector(d, len[i]);
    }
    j[`LeftHand${f}End`] = [p.x, p.y, p.z];
  }
  for (const [k, v] of Object.entries({ ...j })) {
    if (k.startsWith('Left')) j[k.replace('Left', 'Right')] = [-v[0], v[1], v[2]];
  }
  return j;
}

const PARENT: Record<string, string | null> = {
  Hips: null,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Neck: 'Spine2',
  Head: 'Neck',
  LeftUpLeg: 'Hips',
  LeftLeg: 'LeftUpLeg',
  LeftFoot: 'LeftLeg',
  LeftToeBase: 'LeftFoot',
  LeftShoulder: 'Spine2',
  LeftArm: 'LeftShoulder',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
};
for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
  PARENT[`LeftHand${f}1`] = 'LeftHand';
  PARENT[`LeftHand${f}2`] = `LeftHand${f}1`;
  PARENT[`LeftHand${f}3`] = `LeftHand${f}2`;
}
for (const [k, v] of Object.entries({ ...PARENT })) {
  if (k.startsWith('Left')) PARENT[k.replace('Left', 'Right')] = v?.startsWith('Left') ? v.replace('Left', 'Right') : v;
}
const BONE_ORDER = Object.keys(PARENT);

function paint(geo: BufferGeometry, color: Color, bone: number): BufferGeometry {
  const g = geo;
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    idx[i * 4] = bone;
    w[i * 4] = 1;
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setAttribute('skinIndex', new Uint16BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new Float32BufferAttribute(w, 4));
  if (!g.attributes.uv) g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

const _up = new Vector3(0, 1, 0);

/** Capsule between two points. */
function limb(a: P, b: P, r: number, color: Color, bone: number, scale: P = [1, 1, 1]): BufferGeometry {
  const va = new Vector3(...a);
  const vb = new Vector3(...b);
  const len = va.distanceTo(vb);
  const geo = new CapsuleGeometry(r, Math.max(0.001, len), 4, 10);
  geo.scale(...scale);
  const q = new Quaternion().setFromUnitVectors(_up, vb.clone().sub(va).normalize());
  geo.applyMatrix4(new Matrix4().compose(va.clone().add(vb).multiplyScalar(0.5), q, new Vector3(1, 1, 1)));
  return paint(geo, color, bone);
}

function blob(center: P, radii: P, color: Color, bone: number, segs = 16): BufferGeometry {
  const geo = new SphereGeometry(1, segs, Math.round(segs * 0.75));
  geo.scale(...radii);
  geo.translate(...center);
  return paint(geo, color, bone);
}

function box(center: P, size: P, color: Color, bone: number, rotX = 0): BufferGeometry {
  const geo = new BoxGeometry(...size);
  if (rotX) geo.rotateX(rotX);
  geo.translate(...center);
  return paint(geo, color, bone);
}

export function buildMannequin(style: MannequinStyle): { root: Group; mesh: SkinnedMesh } {
  const j = joints(style.feminine);
  const bones = new Map<string, Bone>();
  for (const name of BONE_ORDER) {
    const b = new Bone();
    b.name = name;
    bones.set(name, b);
  }
  for (const name of BONE_ORDER) {
    const b = bones.get(name)!;
    const parent = PARENT[name];
    const p = j[name];
    if (parent) {
      const pp = j[parent];
      b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      bones.get(parent)!.add(b);
    } else {
      b.position.set(...p);
    }
  }
  const bi = (name: string) => BONE_ORDER.indexOf(name);

  const suit = new Color(style.suit);
  const suitLight = new Color(style.suit).offsetHSL(0, 0, 0.03);
  const shirt = new Color('#efece4');
  const skin = new Color(style.skin);
  const hair = new Color(style.hair);
  const shoe = new Color('#0a0a0b');
  const tie = new Color('#0b0b0d');
  const parts: BufferGeometry[] = [];
  const fem = style.feminine;

  // torso
  parts.push(blob([0, 0.97, 0], [fem ? 0.165 : 0.155, 0.12, 0.115], suit, bi('Hips')));
  parts.push(limb([0, 1.02, 0], [0, 1.17, 0], fem ? 0.125 : 0.135, suit, bi('Spine'), [1, 1, 0.78]));
  parts.push(limb([0, 1.17, 0], [0, 1.3, 0], fem ? 0.13 : 0.145, suit, bi('Spine1'), [1.02, 1, 0.8]));
  parts.push(blob([0, 1.33, -0.005], [fem ? 0.165 : 0.19, 0.13, 0.115], suitLight, bi('Spine2')));
  parts.push(limb([-(fem ? 0.14 : 0.16), 1.405, -0.01], [fem ? 0.14 : 0.16, 1.405, -0.01], 0.058, suit, bi('Spine2')));
  // shirt front, collar and tie
  parts.push(box([0, 1.37, 0.098], [0.075, 0.13, 0.02], shirt, bi('Spine2'), -0.18));
  parts.push(limb([-0.045, 1.46, 0.015], [0.045, 1.46, 0.015], 0.026, shirt, bi('Neck')));
  if (style.tails) parts.push(box([0, 1.445, 0.052], [0.07, 0.022, 0.018], tie, bi('Neck')));
  else if (!fem) parts.push(box([0, 1.37, 0.11], [0.028, 0.12, 0.012], tie, bi('Spine2'), -0.18));
  // neck & head
  parts.push(limb([0, 1.45, 0.005], [0, 1.57, 0.012], 0.047, skin, bi('Neck')));
  parts.push(blob([0, 1.655, 0.012], [0.083, 0.108, 0.098], skin, bi('Head'), 20));
  parts.push(blob([0, 1.6, 0.06], [0.06, 0.05, 0.055], skin, bi('Head'))); // jaw
  parts.push(box([0, 1.64, 0.105], [0.018, 0.035, 0.02], skin, bi('Head'), 0.3)); // nose
  parts.push(blob([0.084, 1.645, 0.0], [0.012, 0.024, 0.016], skin, bi('Head'), 8));
  parts.push(blob([-0.084, 1.645, 0.0], [0.012, 0.024, 0.016], skin, bi('Head'), 8));
  const eye = new Color('#1b1512');
  parts.push(blob([0.032, 1.668, 0.093], [0.011, 0.007, 0.006], eye, bi('Head'), 8));
  parts.push(blob([-0.032, 1.668, 0.093], [0.011, 0.007, 0.006], eye, bi('Head'), 8));
  // hair
  if (style.hairStyle !== 'bald') parts.push(blob([0, 1.69, -0.008], [0.089, 0.085, 0.1], hair, bi('Head'), 20));
  if (style.hairStyle === 'long') parts.push(blob([0, 1.6, -0.055], [0.095, 0.15, 0.065], hair, bi('Head'), 16));
  if (style.hairStyle === 'bun') parts.push(blob([0, 1.69, -0.1], [0.045, 0.045, 0.04], hair, bi('Head'), 12));

  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1;
    const P = (n: string) => j[`${side}${n}`];
    parts.push(blob([s * (fem ? 0.15 : 0.172), 1.405, -0.01], [0.068, 0.062, 0.066], suit, bi(`${side}Arm`)));
    parts.push(limb(P('Arm'), P('ForeArm'), fem ? 0.047 : 0.054, suit, bi(`${side}Arm`)));
    parts.push(limb(P('ForeArm'), [P('Hand')[0] - s * 0.03, P('Hand')[1], P('Hand')[2]], fem ? 0.04 : 0.046, suit, bi(`${side}ForeArm`)));
    parts.push(limb([P('Hand')[0] - s * 0.035, P('Hand')[1], P('Hand')[2]], [P('Hand')[0] - s * 0.01, P('Hand')[1], P('Hand')[2]], 0.037, shirt, bi(`${side}ForeArm`)));
    // palm
    parts.push(box([P('Hand')[0] + s * 0.05, P('Hand')[1] - 0.002, P('Hand')[2]], [0.095, 0.03, 0.078], skin, bi(`${side}Hand`)));
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      const r = f === 'Thumb' ? 0.0115 : f === 'Pinky' ? 0.0085 : 0.0098;
      for (let i = 1; i <= 3; i++) {
        const a = P(`Hand${f}${i}`);
        const b = i < 3 ? P(`Hand${f}${i + 1}`) : P(`Hand${f}End`);
        parts.push(limb(a, b, r, skin, bi(`${side}Hand${f}${i}`)));
      }
    }
    // legs
    parts.push(limb(P('UpLeg'), P('Leg'), fem ? 0.074 : 0.078, suit, bi(`${side}UpLeg`)));
    parts.push(limb(P('Leg'), P('Foot'), fem ? 0.052 : 0.056, suit, bi(`${side}Leg`)));
    parts.push(box([P('Foot')[0], 0.04, P('Foot')[2] + 0.06], [0.095, 0.08, 0.27], shoe, bi(`${side}Foot`)));
  }

  const geometry = mergeGeometries(parts, false)!;
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.0 });
  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = 'mannequin';
  const root = new Group();
  root.name = 'character';
  const hips = bones.get('Hips')!;
  root.add(hips);
  root.add(mesh);
  // bake the height into bones + geometry so the rig works in metres at unit root scale
  const scale = style.height / 1.75;
  const skeleton = new Skeleton(BONE_ORDER.map((n) => bones.get(n)!));
  for (const b of skeleton.bones) b.position.multiplyScalar(scale);
  geometry.scale(scale, scale, scale);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { root, mesh };
}

const SKIN = ['#f1d0b5', '#e2b595', '#c98f67', '#a36a45', '#7a4b30', '#f5dcc8', '#d7a27c'];
const HAIR = ['#1a1310', '#3b2618', '#5a3b22', '#8a6139', '#b9b3aa', '#2a2320', '#6d4a2f', '#d8cfc0'];

export function mannequinStyle(seed: number, conductor = false): MannequinStyle {
  const r = (k: number) => {
    const x = Math.sin((seed * 9301 + k * 49297) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const feminine = !conductor && r(1) < 0.45;
  const hairStyles: MannequinStyle['hairStyle'][] = feminine ? ['long', 'bun', 'long', 'short'] : ['short', 'short', 'bald', 'short'];
  return {
    height: feminine ? 1.63 + r(2) * 0.1 : 1.72 + r(2) * 0.12,
    feminine,
    skin: SKIN[Math.floor(r(3) * SKIN.length)],
    hair: HAIR[Math.floor(r(4) * HAIR.length)],
    hairStyle: hairStyles[Math.floor(r(5) * hairStyles.length)],
    suit: conductor ? '#0c0c10' : ['#141418', '#17171c', '#111114', '#1a1a20'][Math.floor(r(6) * 4)],
    tails: conductor,
  };
}
