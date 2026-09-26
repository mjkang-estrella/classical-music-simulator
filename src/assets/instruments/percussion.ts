import { BufferGeometry, CylinderGeometry, Group, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { anchor, lathe, mesh, rod, torus, tube } from './geometry';
import type { Materials } from './materials';
import type { Grip, InstrumentModel } from './types';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** Stick / mallet: origin at the grip, +Z towards the head. */
export function buildStick(m: Materials, length: number, head: number, kind: 'felt' | 'wood' | 'yarn' = 'felt'): Group {
  const g = new Group();
  mesh(rod(v(0, 0, -0.06), v(0, 0, length), 0.0055, 0.004, 8), kind === 'wood' ? m.stickWood : m.stickWood, g);
  const h = new SphereGeometry(head, 12, 10);
  if (kind === 'wood') h.scale(0.8, 0.8, 1.3);
  h.translate(0, 0, length);
  mesh(h, kind === 'yarn' ? m.skin : kind === 'wood' ? m.stickWood : m.felt, g);
  anchor('tip', 0, 0, length + head * 0.8, g);
  return g;
}

function stickGrip(anchorParent: Group): Grip {
  // hand holds the stick with the palm facing down, fingers wrapped around
  return { anchor: anchor('grip', 0, 0.01, 0.0, anchorParent), dir: v(0.9, -0.1, 0.35).normalize(), palm: v(0, -1, 0), curl: 0.95, thumbCurl: 0.6 };
}

function stickGripR(anchorParent: Group): Grip {
  return { anchor: anchor('grip', 0, 0.01, 0.0, anchorParent), dir: v(-0.9, -0.1, 0.35).normalize(), palm: v(0, -1, 0), curl: 0.95, thumbCurl: 0.6 };
}

/**
 * Four pedal timpani in an arc (largest on the player's left), in the player's root frame:
 * +Z forward, +X player's left. Anchors `head_k` mark the beating spot on each drum.
 */
export function buildTimpani(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'timpani';
  const floor = new Group();
  const diam = [0.81, 0.74, 0.66, 0.58];
  const angles = [52, 18, -18, -52];
  const anchors: InstrumentModel['anchors'] = {};
  diam.forEach((dm, k) => {
    const r = dm / 2;
    const a = (angles[k] * Math.PI) / 180;
    const cx = Math.sin(a) * 0.72;
    const cz = Math.cos(a) * 0.72 - 0.05;
    const h = 0.86 - k * 0.02;
    const drum = new Group();
    drum.position.set(cx, 0, cz);
    // copper kettle
    const kettle = lathe(
      Array.from({ length: 12 }, (_, i) => {
        const t = i / 11;
        return [r * 0.98 * Math.sin((t * Math.PI) / 2) + 0.001, h - 0.02 - r * 0.85 * Math.cos((t * Math.PI) / 2)] as [number, number];
      }),
      36,
    );
    mesh(kettle, m.copper, drum);
    const head = new CylinderGeometry(r, r, 0.004, 40);
    head.translate(0, h, 0);
    mesh(head, m.skin, drum);
    const rim = torus(r, 0.008, Math.PI * 2, 6, 48);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, h - 0.004, 0);
    mesh(rim, m.chrome, drum);
    const legs: BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const la = (i / 3) * Math.PI * 2 + 0.5;
      legs.push(rod(v(Math.cos(la) * r * 0.6, h - r * 0.7, Math.sin(la) * r * 0.6), v(Math.cos(la) * r * 0.75, 0.02, Math.sin(la) * r * 0.75), 0.008, 0.008, 6));
    }
    const pedal = new CylinderGeometry(0.05, 0.05, 0.02, 4);
    pedal.translate(0, 0.03, -r * 0.8);
    legs.push(pedal);
    mesh(mergeGeometries(legs)!, m.black, drum);
    floor.add(drum);
    // beating spot: about a hand's width in from the rim nearest the player
    const toPlayer = v(-cx, 0, -cz).normalize();
    const spot = v(cx, h + 0.004, cz).addScaledVector(toPlayer, r - 0.1);
    anchors[`head_${k}`] = anchor(`head_${k}`, spot.x, spot.y, spot.z, floor);
  });
  root.add(floor);
  const L = buildStick(m, 0.35, 0.024);
  const R = buildStick(m, 0.35, 0.024);
  return {
    kind: 'timpani',
    root,
    anchors,
    grips: { L: stickGrip(L), R: stickGripR(R) },
    held: { L, R },
    floor,
  };
}

/** Concert bass drum on a stand, head facing the player's left/right; beater in the right hand. */
export function buildBassDrum(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'bassdrum';
  const floor = new Group();
  const r = 0.4;
  const depth = 0.42;
  const drum = new Group();
  drum.position.set(0.46, 0.62 + r * 0.2, 0.5);
  const shell = new CylinderGeometry(r, r, depth, 40, 1, true);
  shell.rotateZ(Math.PI / 2);
  mesh(shell, m.drumShell, drum);
  for (const s of [1, -1]) {
    const head = new CylinderGeometry(r * 0.99, r * 0.99, 0.004, 40);
    head.rotateZ(Math.PI / 2);
    head.translate((s * depth) / 2, 0, 0);
    mesh(head, m.skin, drum);
    const hoop = torus(r, 0.014, Math.PI * 2, 6, 48);
    hoop.rotateY(Math.PI / 2);
    hoop.translate((s * depth) / 2, 0, 0);
    mesh(hoop, m.drumShell, drum);
  }
  const stand: BufferGeometry[] = [];
  for (const s of [1, -1]) {
    stand.push(rod(v(s * 0.15, -r - 0.02, 0.25), v(s * 0.18, -drum.position.y + 0.01, 0.35), 0.01, 0.01, 6));
    stand.push(rod(v(s * 0.15, -r - 0.02, -0.25), v(s * 0.18, -drum.position.y + 0.01, -0.35), 0.01, 0.01, 6));
  }
  mesh(mergeGeometries(stand)!, m.black, drum);
  floor.add(drum);
  root.add(floor);
  // the player stands to the drum's right side (−X) and hits the right-hand head
  const spot = drum.position.clone().add(v(-depth / 2 - 0.01, 0.08, -0.05));
  const R = buildStick(m, 0.36, 0.05);
  return {
    kind: 'bassdrum',
    root,
    anchors: { head_0: anchor('head_0', spot.x, spot.y, spot.z, floor), rest_L: anchor('rest_L', drum.position.x - depth / 2 - 0.03, drum.position.y + r * 0.6, drum.position.z + 0.05, floor) },
    grips: { R: stickGripR(R) },
    held: { R },
    floor,
  };
}

/** Pair of clash cymbals, one in each hand: origin at the strap, plate faces +Z. */
export function buildCymbals(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'cymbals';
  const plate = (): Group => {
    const g = new Group();
    const prof: [number, number][] = [
      [0.001, 0.035],
      [0.03, 0.03],
      [0.045, 0.02],
      [0.1, 0.012],
      [0.23, 0.0],
    ];
    const geo = lathe(prof, 40);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, 0.035);
    mesh(geo, m.cymbal, g);
    const strap = new CylinderGeometry(0.012, 0.012, 0.03, 8);
    strap.rotateX(Math.PI / 2);
    strap.translate(0, 0, -0.005);
    mesh(strap, m.black, g);
    return g;
  };
  const L = plate();
  const R = plate();
  return {
    kind: 'cymbals',
    root,
    anchors: {},
    grips: {
      L: { anchor: anchor('grip', 0, 0, -0.03, L), dir: v(0, 1, 0), palm: v(0, 0, 1), curl: 0.9, thumbCurl: 0.6 },
      R: { anchor: anchor('grip', 0, 0, -0.03, R), dir: v(0, 1, 0), palm: v(0, 0, 1), curl: 0.9, thumbCurl: 0.6 },
    },
    held: { L, R },
  };
}

export function buildSuspended(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'suspended';
  const floor = new Group();
  const h = 1.0;
  const prof: [number, number][] = [
    [0.001, 0.03],
    [0.04, 0.02],
    [0.23, 0.0],
  ];
  const plate = lathe(prof, 40);
  plate.translate(0, h, 0.45);
  mesh(plate, m.cymbal, floor);
  const stand: BufferGeometry[] = [rod(v(0, 0.02, 0.45), v(0, h, 0.45), 0.009, 0.009, 6)];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    stand.push(rod(v(0, 0.35, 0.45), v(Math.cos(a) * 0.28, 0.01, 0.45 + Math.sin(a) * 0.28), 0.007, 0.007, 5));
  }
  mesh(mergeGeometries(stand)!, m.black, floor);
  root.add(floor);
  const L = buildStick(m, 0.36, 0.025, 'yarn');
  const R = buildStick(m, 0.36, 0.025, 'yarn');
  return {
    kind: 'suspended',
    root,
    anchors: { head_0: anchor('head_0', 0.12, h + 0.02, 0.4, floor), head_1: anchor('head_1', -0.12, h + 0.02, 0.4, floor) },
    grips: { L: stickGrip(L), R: stickGripR(R) },
    held: { L, R },
    floor,
  };
}

export function buildSnare(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'snare';
  const floor = new Group();
  const h = 0.8;
  const r = 0.18;
  const shell = new CylinderGeometry(r, r, 0.14, 32);
  shell.translate(0, h - 0.07, 0.42);
  mesh(shell, m.chrome, floor);
  const head = new CylinderGeometry(r, r, 0.004, 32);
  head.translate(0, h + 0.002, 0.42);
  mesh(head, m.skin, floor);
  const stand: BufferGeometry[] = [rod(v(0, 0.02, 0.42), v(0, h - 0.14, 0.42), 0.009, 0.009, 6)];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    stand.push(rod(v(0, 0.3, 0.42), v(Math.cos(a) * 0.25, 0.01, 0.42 + Math.sin(a) * 0.25), 0.007, 0.007, 5));
  }
  mesh(mergeGeometries(stand)!, m.black, floor);
  root.add(floor);
  const L = buildStick(m, 0.38, 0.008, 'wood');
  const R = buildStick(m, 0.38, 0.008, 'wood');
  return {
    kind: 'snare',
    root,
    anchors: { head_0: anchor('head_0', 0.06, h + 0.01, 0.4, floor), head_1: anchor('head_1', -0.06, h + 0.01, 0.4, floor) },
    grips: { L: stickGrip(L), R: stickGripR(R) },
    held: { L, R },
    floor,
  };
}

export function buildTriangle(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'triangle';
  const L = new Group();
  const s = 0.17;
  const pts: [number, number, number][] = [
    [0, -0.02, 0],
    [s / 2, -0.02 - s * 0.87, 0],
    [-s / 2, -0.02 - s * 0.87, 0],
    [-0.01, -0.03, 0],
  ];
  mesh(tube(pts, 0.004, 24, 6), m.chrome, L);
  const R = buildStick(m, 0.2, 0.004, 'wood');
  return {
    kind: 'triangle',
    root,
    anchors: {},
    grips: {
      L: { anchor: anchor('grip', 0, 0.01, 0, L), dir: v(0, 0.3, 1), palm: v(1, 0, 0), curl: 0.7, thumbCurl: 0.9 },
      R: stickGripR(R),
    },
    held: { L, R },
  };
}

/**
 * Concert harp. Frame: origin at the base, +Y up (column), +Z away from the player, +X player's left.
 * The strings lie in the Y–Z plane.
 */
export function buildHarp(m: Materials): InstrumentModel {
  const root = new Group();
  root.name = 'harp';
  const H = 1.78;
  // base
  const base = new CylinderGeometry(0.2, 0.22, 0.1, 6);
  base.scale(0.8, 1, 1.4);
  base.translate(0, 0.05, 0.15);
  mesh(base, m.harpWood, root);
  // column (front pillar)
  mesh(rod(v(0, 0.08, 0.5), v(0, H - 0.06, 0.52), 0.035, 0.03, 16), m.gold, root);
  const crown = new CylinderGeometry(0.05, 0.035, 0.12, 12);
  crown.translate(0, H, 0.52);
  mesh(crown, m.gold, root);
  // soundboard: from the base rising back towards the player's shoulder
  const sbBottom = v(0, 0.12, 0.05);
  const sbTop = v(0, H - 0.3, -0.22);
  const sb = rod(sbBottom, sbTop, 0.14, 0.06, 4);
  mesh(sb, m.harpWood, root);
  // neck: S-curve from the soundboard top to the column top
  mesh(tube([[0, sbTop.y, sbTop.z], [0, H - 0.18, -0.05], [0, H - 0.05, 0.15], [0, H - 0.14, 0.33], [0, H - 0.02, 0.5]], 0.035, 40, 10), m.harpWood, root);
  // strings
  const strings: BufferGeometry[] = [];
  const n = 26;
  const neckY = (z: number) => H - 0.12 + 0.07 * Math.sin(((z + 0.22) / 0.72) * Math.PI * 1.5);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const bottom = sbBottom.clone().lerp(sbTop, 0.08 + 0.85 * (1 - t));
    const z = bottom.z + 0.02;
    strings.push(rod(v(0, bottom.y + 0.03, z), v(0, neckY(z), z), 0.0012, 0.0012, 3));
  }
  mesh(mergeGeometries(strings)!, m.string, root);
  // hands pluck either side of the string plane at mid height
  const mid = sbBottom.clone().lerp(sbTop, 0.5);
  return {
    kind: 'harp',
    root,
    anchors: { pluck_L: anchor('pluck_L', 0.03, mid.y + 0.15, mid.z + 0.2, root), pluck_R: anchor('pluck_R', -0.03, mid.y + 0.25, mid.z + 0.05, root), top: anchor('top', 0, sbTop.y, sbTop.z, root) },
    grips: {},
  };
}
