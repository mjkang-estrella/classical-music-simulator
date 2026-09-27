import { BufferGeometry, CylinderGeometry, Group, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { anchor, bellProfile, lathe, mesh, rod, torus, tube } from './geometry';
import type { Materials } from './materials';
import type { PoseName } from '../../rig/handPose';
import type { Grip, InstrumentModel } from './types';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

function grip(root: Group, name: string, pos: Vector3, dir: Vector3, palm: Vector3, pose: PoseName, pressed?: PoseName): Grip {
  return { anchor: anchor(name, pos.x, pos.y, pos.z, root), dir: dir.normalize(), palm: palm.normalize(), curl: 0.5, pose, pressed };
}

/**
 * Transverse flute (and piccolo via `scale`).
 * Frame: origin at the embouchure hole, +Z along the tube towards the foot (player's right), +Y keys up,
 * +X away from the player.
 */
export function buildFlute(m: Materials, piccolo = false): InstrumentModel {
  const root = new Group();
  root.name = piccolo ? 'piccolo' : 'flute';
  const s = piccolo ? 0.5 : 1;
  const r = piccolo ? 0.0072 : 0.0095;
  const len = 0.67 * s;
  const body = new CylinderGeometry(r, r, len, 16, 1);
  body.rotateX(Math.PI / 2);
  body.translate(0, -r, len / 2 - 0.055 * s);
  mesh(body, piccolo ? m.blackwood : m.silver, root);
  const crown = new CylinderGeometry(r * 1.15, r * 1.15, 0.012, 14);
  crown.rotateX(Math.PI / 2);
  crown.translate(0, -r, -0.058 * s);
  mesh(crown, m.silver, root);
  // lip plate
  const lip = new CylinderGeometry(r * 1.2, r * 1.2, 0.003, 14);
  lip.scale(1, 1, 1.5);
  lip.translate(0, 0.0005, 0);
  mesh(lip, m.silver, root);
  // keys along the top
  const keys: BufferGeometry[] = [];
  const nKeys = piccolo ? 6 : 12;
  for (let i = 0; i < nKeys; i++) {
    const z = (0.2 + (i / nKeys) * 0.38) * s;
    const k = new CylinderGeometry(r * 0.7, r * 0.7, 0.004, 12);
    k.translate(0, 0.001 + r * 0.05, z);
    keys.push(k);
  }
  keys.push(rod(v(r * 0.9, -r * 0.3, 0.19 * s), v(r * 0.9, -r * 0.3, 0.6 * s), 0.0012, 0.0012, 5));
  mesh(mergeGeometries(keys)!, m.silver, root);

  const anchors = { mouthpiece: anchor('mouthpiece', 0, 0.002, 0, root) };
  return {
    kind: piccolo ? 'piccolo' : 'flute',
    root,
    anchors,
    grips: {
      // left hand turned back: the flute rests on the index base, fingers come over from the far side
      L: { ...grip(root, 'grip_L', v(0.016, -0.036, 0.12 * s), v(0.25, 0.95, -0.1), v(-0.95, 0.25, 0.15), 'fluteLeft', 'fluteLeftPressed'), twist: 0.9, wrist: 1.4 },
      // right hand: fingers arch over the top from the player's side, thumb underneath
      R: grip(root, 'grip_R', v(-0.034, -0.016, 0.39 * s), v(0.35, 0.93, 0.06), v(0.95, 0.1, -0.2), 'keys', 'keysPressed'),
    },
  };
}

/**
 * Oboe / clarinet. Frame: origin at the reed / mouthpiece tip, +Z along the body towards the bell,
 * +Y the front (tone holes, facing away from the player), +X the player's left when held.
 */
export function buildReed(m: Materials, kind: 'oboe' | 'clarinet'): InstrumentModel {
  const root = new Group();
  root.name = kind;
  const clar = kind === 'clarinet';
  const len = clar ? 0.66 : 0.65;
  const profile: [number, number][] = clar
    ? [
        [0.001, 0],
        [0.009, 0.01],
        [0.011, 0.06],
        [0.014, 0.075],
        [0.0135, 0.14],
        [0.0145, 0.15],
        [0.0135, 0.155],
        [0.0135, 0.38],
        [0.0145, 0.385],
        [0.0135, 0.39],
        [0.0142, 0.55],
        [0.02, 0.6],
        [0.034, 0.645],
        [0.036, len],
      ]
    : [
        [0.0015, 0],
        [0.003, 0.02],
        [0.0035, 0.05],
        [0.009, 0.06],
        [0.0105, 0.07],
        [0.0115, 0.3],
        [0.0125, 0.31],
        [0.013, 0.52],
        [0.016, 0.58],
        [0.024, 0.625],
        [0.026, len],
      ];
  // lathe revolves around Y; build along Y then rotate to +Z
  const geo = lathe(profile.map(([rr, y]) => [rr, y] as [number, number]), 20);
  geo.rotateX(Math.PI / 2);
  mesh(geo, m.blackwood, root);
  if (clar) {
    const lig = new CylinderGeometry(0.0115, 0.0115, 0.012, 14);
    lig.rotateX(Math.PI / 2);
    lig.translate(0, 0, 0.035);
    mesh(lig, m.silver, root);
  }
  const keys: BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const z = 0.17 + i * 0.045;
    const k = new CylinderGeometry(0.0035, 0.0035, 0.004, 8);
    k.rotateX(Math.PI / 2);
    k.rotateX(Math.PI / 2);
    k.translate(0, 0.0138, z);
    keys.push(k);
  }
  keys.push(rod(v(0.006, 0.012, 0.16), v(0.006, 0.012, 0.52), 0.0011, 0.0011, 5));
  keys.push(rod(v(-0.006, 0.012, 0.18), v(-0.006, 0.012, 0.5), 0.0011, 0.0011, 5));
  mesh(mergeGeometries(keys)!, m.silver, root);

  const anchors = { mouthpiece: anchor('mouthpiece', 0, 0, 0.004, root) };
  return {
    kind,
    root,
    anchors,
    grips: {
      // each hand wraps from its side: fingers reach round to the tone holes on the front, thumb behind
      L: grip(root, 'grip_L', v(0.026, -0.008, 0.21), v(-0.28, 0.88, 0.38), v(-1, 0.1, 0), 'keys', 'keysPressed'),
      R: grip(root, 'grip_R', v(-0.026, -0.008, 0.42), v(0.28, 0.88, 0.38), v(1, 0.1, 0), 'keys', 'keysPressed'),
    },
  };
}

/**
 * Bassoon. Frame: origin at the reed, body runs along +Y (up), bocal reaches back towards the player (−Z).
 * +X = player's left when held.
 */
export function buildBassoon(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'bassoon';
  const W = v(0, -0.12, 0.2); // where the bocal meets the wing joint
  const bottom = W.y - 0.5;
  const top = W.y + 0.85;
  // boot joint (double bore) + wing + long joint + bell
  mesh(rod(v(0, bottom, W.z), v(0, W.y - 0.02, W.z), 0.034, 0.034, 16), m.bassoonWood, root);
  const cap = new CylinderGeometry(0.036, 0.036, 0.03, 16);
  cap.translate(0, bottom + 0.015, W.z);
  mesh(cap, m.silver, root);
  mesh(rod(v(0.012, W.y - 0.02, W.z + 0.004), v(0.012, W.y + 0.36, W.z + 0.004), 0.019, 0.02, 14), m.bassoonWood, root);
  mesh(rod(v(-0.018, W.y - 0.02, W.z - 0.004), v(-0.018, top - 0.14, W.z - 0.004), 0.021, 0.024, 14), m.bassoonWood, root);
  mesh(lathe([
    [0.024, 0],
    [0.027, 0.12],
    [0.03, 0.14],
    [0.026, 0.145],
  ], 16).translate(-0.018, top - 0.145, W.z - 0.004), m.bassoonWood, root);
  // bocal: from the reed curving down into the wing joint
  mesh(tube([[0, 0, 0], [0, -0.01, 0.06], [0, -0.035, 0.12], [0.004, -0.07, 0.17], [0.01, W.y + 0.02, W.z - 0.01]], 0.0035, 28, 8), m.silver, root);
  const reed = new CylinderGeometry(0.004, 0.002, 0.03, 8);
  reed.rotateX(Math.PI / 2);
  reed.translate(0, 0, 0.01);
  mesh(reed, m.stickWood, root);
  const keys: BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) keys.push(rod(v(-0.035, bottom + 0.12 + i * 0.05, W.z), v(-0.035, bottom + 0.14 + i * 0.05, W.z + 0.02), 0.002, 0.002, 5));
  mesh(mergeGeometries(keys)!, m.silver, root);

  return {
    kind: 'bassoon',
    root,
    anchors: { mouthpiece: anchor('mouthpiece', 0, 0, 0.0, root) },
    grips: {
      L: grip(root, 'grip_L', v(0.034, W.y + 0.22, W.z - 0.03), v(-0.25, 0.25, 0.94), v(-0.9, 0, 0.15), 'keys', 'keysPressed'),
      R: grip(root, 'grip_R', v(-0.045, bottom + 0.3, W.z - 0.03), v(0.3, 0.3, 0.9), v(0.9, 0, 0.15), 'keys', 'keysPressed'),
    },
  };
}

/** Brass bell along +Z, throat at `at`. */
function bellZ(at: Vector3, throat: number, mouth: number, length: number, flare: number, mat: Materials['brass'], parent: Group) {
  const g = lathe(bellProfile(throat, mouth, length, flare), 32);
  // profile has the mouth at y=0 and throat at y=length: flip so the mouth is at +Z
  g.rotateX(-Math.PI / 2);
  g.translate(at.x, at.y, at.z + length);
  mesh(g, mat, parent);
}

/** Trumpet. Frame: origin at the mouthpiece rim, +Z forward (bell), +Y up (valve buttons), +X left. */
export function buildTrumpet(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'trumpet';
  const mp = new CylinderGeometry(0.0085, 0.003, 0.08, 12);
  mp.rotateX(Math.PI / 2);
  mp.translate(0, 0, 0.04);
  mesh(mp, m.silver, root);
  mesh(rod(v(0, 0, 0.075), v(0, 0, 0.19), 0.0045, 0.0055, 10), m.brass, root);
  for (let i = 0; i < 3; i++) {
    const z = 0.19 + i * 0.026;
    mesh(rod(v(0, -0.045, z), v(0, 0.04, z), 0.0085, 0.0085, 14), m.brass, root);
    mesh(rod(v(0, 0.04, z), v(0, 0.06, z), 0.003, 0.003, 6), m.silver, root);
    const btn = new CylinderGeometry(0.008, 0.008, 0.005, 12);
    btn.translate(0, 0.063, z);
    mesh(btn, m.silver, root);
  }
  // tuning slide loop below / behind the valves
  mesh(tube([[0, -0.03, 0.18], [0, -0.05, 0.12], [0, -0.07, 0.09], [0, -0.075, 0.13], [0, -0.07, 0.19]], 0.0048, 24, 8), m.brass, root);
  // bell section
  mesh(tube([[0, -0.03, 0.245], [0.004, -0.02, 0.28], [0.006, -0.02, 0.32]], 0.0055, 12, 8), m.brass, root);
  bellZ(v(0.006, -0.02, 0.32), 0.0058, 0.061, 0.2, 3.5, m.brass, root);
  return {
    kind: 'trumpet',
    root,
    anchors: { mouthpiece: anchor('mouthpiece', 0, 0, 0, root) },
    grips: {
      // left hand wraps the valve casings, right fingertips sit on the valve caps
      L: grip(root, 'grip_L', v(0.03, -0.012, 0.212), v(0.05, 0.35, 0.94), v(-1, 0.05, 0), 'wrap'),
      R: grip(root, 'grip_R', v(-0.004, 0.082, 0.17), v(0, -0.28, 0.96), v(0.05, -1, 0.1), 'valves', 'valvesPressed'),
    },
  };
}

/** French horn. Frame: origin at the mouthpiece, +Z forward, +Y up, +X player's left; bell faces back-right. */
export function buildHorn(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'horn';
  const C = v(-0.07, -0.18, 0.2);
  const coil = [0.14, 0.123, 0.106];
  coil.forEach((rad, i) => {
    const t = torus(rad, 0.0065 + i * 0.001, Math.PI * 2, 8, 56);
    t.translate(C.x, C.y, C.z + (i - 1) * 0.014);
    mesh(t, m.brass, root);
  });
  const mp = new CylinderGeometry(0.008, 0.003, 0.07, 12);
  mp.rotateX(Math.PI / 2);
  mp.translate(0, 0, 0.035);
  mesh(mp, m.silver, root);
  mesh(tube([[0, 0, 0.065], [0.005, -0.015, 0.12], [0.03, -0.04, 0.17], [0.05, -0.06, 0.2], [C.x + 0.1, C.y + 0.1, C.z]], 0.005, 28, 8), m.brass, root);
  // rotary valves
  for (let i = 0; i < 3; i++) {
    const g = new CylinderGeometry(0.013, 0.013, 0.045, 14);
    g.rotateX(Math.PI / 2);
    g.translate(C.x + 0.11 - i * 0.004, C.y + 0.02 - i * 0.032, C.z + 0.002);
    mesh(g, m.brassDark, root);
  }
  mesh(rod(v(C.x + 0.13, C.y + 0.03, C.z - 0.04), v(C.x + 0.16, C.y - 0.06, C.z - 0.04), 0.004, 0.004, 6), m.silver, root);
  // bell: from the bottom of the coil, flaring back and to the player's right
  const throat = v(C.x - 0.07, C.y - 0.1, C.z);
  const axis = v(-0.42, -0.2, -0.88).normalize();
  const bell = lathe(bellProfile(0.012, 0.152, 0.3, 3.2), 36);
  bell.rotateX(-Math.PI / 2); // mouth towards +Z
  const holder = new Group();
  holder.position.copy(throat);
  holder.quaternion.setFromUnitVectors(v(0, 0, 1), axis);
  bell.translate(0, 0, 0.3);
  mesh(bell, m.brass, holder);
  root.add(holder);
  mesh(tube([[C.x - 0.14, C.y - 0.02, C.z], [C.x - 0.12, C.y - 0.09, C.z], [throat.x, throat.y, throat.z]], 0.008, 14, 8), m.brass, root);
  const bellMouth = throat.clone().addScaledVector(axis, 0.24);
  return {
    kind: 'horn',
    root,
    anchors: { mouthpiece: anchor('mouthpiece', 0, 0, 0, root), bell: anchor('bell', bellMouth.x, bellMouth.y, bellMouth.z, root) },
    grips: {
      L: grip(root, 'grip_L', v(C.x + 0.15, C.y + 0.03, C.z - 0.06), v(-0.35, -0.2, 0.9), v(-0.6, -0.75, -0.1), 'valves', 'valvesPressed'),
      // right hand cupped inside the bell
      R: grip(root, 'grip_R', bellMouth.clone().addScaledVector(axis, -0.02).add(v(0.02, 0.05, 0)), axis.clone().negate(), v(-0.3, -1, 0.2), 'relaxed'),
    },
  };
}

/**
 * Trombone. Frame: origin at the mouthpiece, +Z forward along the slide, +Y up, +X player's left.
 * The outer slide is a child that moves along +Z.
 */
export function buildTrombone(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'trombone';
  const mp = new CylinderGeometry(0.012, 0.004, 0.09, 12);
  mp.rotateX(Math.PI / 2);
  mp.translate(0, 0, 0.045);
  mesh(mp, m.silver, root);
  // inner slide (fixed)
  const low = -0.085;
  mesh(rod(v(0, 0, 0.085), v(0, 0, 0.5), 0.0065, 0.0065, 10), m.brass, root);
  mesh(rod(v(0, low, 0.1), v(0, low, 0.5), 0.0065, 0.0065, 10), m.brass, root);
  // brace near the mouthpiece
  mesh(rod(v(0, 0, 0.13), v(0.07, -0.01, 0.13), 0.004, 0.004, 6), m.brass, root);
  // bell section: gooseneck back over the shoulder, then forward to the bell on the left
  const bx = 0.075;
  mesh(tube([[0, low, 0.1], [0.02, low - 0.01, 0.02], [bx, -0.03, -0.12], [bx, 0.02, -0.28], [bx, 0.06, -0.3], [bx, 0.06, -0.2], [bx, 0.04, 0.1], [bx, 0.035, 0.28]], 0.0075, 60, 8), m.brass, root);
  bellZ(v(bx, 0.035, 0.28), 0.0078, 0.108, 0.34, 3.4, m.brass, root);
  // outer slide (moves)
  const slide = new Group();
  slide.name = 'slide';
  mesh(rod(v(0, 0, 0.3), v(0, 0, 0.72), 0.0078, 0.0078, 10), m.brass, slide);
  mesh(rod(v(0, low, 0.3), v(0, low, 0.72), 0.0078, 0.0078, 10), m.brass, slide);
  const bend = torus(-low / 2, 0.0078, Math.PI, 8, 20);
  bend.rotateY(Math.PI / 2);
  bend.rotateX(-Math.PI / 2);
  bend.translate(0, low / 2, 0.72);
  mesh(bend, m.brass, slide);
  mesh(rod(v(0, 0, 0.63), v(0, low, 0.63), 0.0045, 0.0045, 6), m.brass, slide);
  root.add(slide);
  const gripR = grip(slide as Group, 'grip_R', v(-0.014, low / 2, 0.635), v(0, 0.3, 0.95), v(1, 0, 0), 'stick');
  return {
    kind: 'trombone',
    root,
    anchors: { mouthpiece: anchor('mouthpiece', 0, 0, 0, root) },
    grips: {
      L: grip(root, 'grip_L', v(0.045, -0.03, 0.12), v(-0.1, 0.95, 0.1), v(-0.95, 0, 0.1), 'wrap'),
      R: gripR,
    },
    slide,
  };
}

/** Tuba. Frame: origin at the mouthpiece, body stands on the lap along +Y, +Z forward, +X player's left. */
export function buildTuba(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'tuba';
  const bx = 0.03;
  const bz = 0.2;
  // bottom bow and conical body
  mesh(tube([[bx - 0.08, -0.25, bz], [bx - 0.1, -0.55, bz], [bx - 0.04, -0.66, bz], [bx + 0.05, -0.62, bz], [bx + 0.07, -0.45, bz]], 0.04, 30, 14), m.brass, root);
  mesh(lathe([
    [0.045, -0.45],
    [0.06, -0.1],
  ], 24).translate(bx + 0.07, 0, bz), m.brass, root);
  const bell = lathe(bellProfile(0.06, 0.22, 0.42, 2.8), 40);
  bell.rotateX(Math.PI); // mouth up
  bell.translate(bx + 0.07, -0.1 + 0.42, bz);
  mesh(bell, m.brass, root);
  for (let i = 0; i < 2; i++) {
    const t = torus(0.13 + i * 0.03, 0.013, Math.PI * 1.6, 8, 40);
    t.rotateY(Math.PI / 2);
    t.translate(bx - 0.02, -0.38, bz + 0.005 * i);
    mesh(t, m.brass, root);
  }
  // leadpipe and valves on the player's right
  const mp = new CylinderGeometry(0.016, 0.006, 0.1, 12);
  mp.rotateX(Math.PI / 2);
  mp.translate(0, 0, 0.05);
  mesh(mp, m.silver, root);
  mesh(tube([[0, 0, 0.09], [-0.01, -0.03, 0.13], [-0.06, -0.12, 0.15], [-0.09, -0.2, bz - 0.02]], 0.009, 24, 8), m.brass, root);
  for (let i = 0; i < 4; i++) {
    const z = bz - 0.06 + i * 0.03;
    mesh(rod(v(-0.1, -0.3, z), v(-0.1, -0.16, z), 0.013, 0.013, 12), m.brass, root);
    const btn = new CylinderGeometry(0.01, 0.01, 0.006, 12);
    btn.translate(-0.1, -0.14, z);
    mesh(btn, m.silver, root);
  }
  return {
    kind: 'tuba',
    root,
    anchors: { mouthpiece: anchor('mouthpiece', 0, 0, 0, root) },
    grips: {
      L: grip(root, 'grip_L', v(bx + 0.14, -0.2, bz - 0.02), v(-0.2, 0.5, 0.84), v(-0.9, 0, -0.2), 'wrap'),
      R: grip(root, 'grip_R', v(-0.1, -0.1, bz - 0.07), v(0, -0.25, 0.97), v(0, -1, 0), 'valves', 'valvesPressed'),
    },
  };
}
