import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { InstrumentKind } from '../../orchestra/sections';
import { anchor, bodyOutline, mesh, rod, torus, violinBody } from './geometry';
import type { Materials } from './materials';
import type { BowedSpec, InstrumentModel } from './types';

interface Dims {
  body: number;
  lower: number;
  waist: number;
  upper: number;
  ribs: number;
  arch: number;
  stringLen: number;
  neck: number;
  bridgeH: number;
  bridgeW: number;
  nutW: number;
  fbWidth: [number, number];
  endpin: number;
  bow: number;
  bassShoulders?: boolean;
  chinrest: boolean;
}

const DIMS: Record<'violin' | 'viola' | 'cello' | 'bass', Dims> = {
  violin: { body: 0.356, lower: 0.206, waist: 0.11, upper: 0.168, ribs: 0.031, arch: 0.0075, stringLen: 0.328, neck: 0.13, bridgeH: 0.033, bridgeW: 0.034, nutW: 0.017, fbWidth: [0.024, 0.042], endpin: 0, bow: 0.75, chinrest: true },
  viola: { body: 0.405, lower: 0.235, waist: 0.128, upper: 0.19, ribs: 0.038, arch: 0.008, stringLen: 0.37, neck: 0.148, bridgeH: 0.037, bridgeW: 0.038, nutW: 0.019, fbWidth: [0.026, 0.046], endpin: 0, bow: 0.74, chinrest: true },
  cello: { body: 0.755, lower: 0.44, waist: 0.235, upper: 0.345, ribs: 0.118, arch: 0.014, stringLen: 0.69, neck: 0.285, bridgeH: 0.09, bridgeW: 0.064, nutW: 0.033, fbWidth: [0.04, 0.074], endpin: 0.34, bow: 0.72, chinrest: false },
  bass: { body: 1.1, lower: 0.66, waist: 0.37, upper: 0.5, ribs: 0.19, arch: 0.014, stringLen: 1.05, neck: 0.44, bridgeH: 0.16, bridgeW: 0.09, nutW: 0.05, fbWidth: [0.058, 0.1], endpin: 0.26, bow: 0.7, bassShoulders: true, chinrest: false },
};

export function buildBowed(kind: 'violin' | 'viola' | 'cello' | 'bass', m: Materials): InstrumentModel {
  const d = DIMS[kind];
  const root = new Group();
  root.name = kind;
  const anchors: InstrumentModel['anchors'] = {};

  // body: top plate surface at y ≈ arch, long axis +Z from the tail (z = 0)
  const body = violinBody(bodyOutline(d.body, d.lower, d.waist, d.upper, d.bassShoulders), d.ribs, d.arch);
  mesh(body, m.varnish, root);

  const top = d.arch;
  const bridgeZ = d.body * 0.445;
  const nutZ = bridgeZ + d.stringLen;
  const fbLen = d.stringLen * 0.8;
  const fbEnd = nutZ - fbLen;
  const bridgeY = top + d.bridgeH;
  const nutY = top + d.bridgeH * 0.62;
  const stringY = (z: number) => bridgeY + ((z - bridgeZ) / (nutZ - bridgeZ)) * (nutY - bridgeY);

  // f-holes (dark slits)
  for (const s of [1, -1]) {
    const f = new BoxGeometry(d.lower * 0.02, 0.002, d.body * 0.2);
    f.rotateY(s * 0.12);
    f.translate(s * d.waist * 0.36, top + 0.001, bridgeZ);
    mesh(f, m.ebony, root);
  }

  // neck, fingerboard, pegbox, scroll
  const neckGeo = new BoxGeometry(d.fbWidth[0] * 0.95, d.bridgeH * 0.45, d.neck + d.body * 0.02);
  neckGeo.translate(0, top + d.bridgeH * 0.1, d.body + d.neck / 2 - d.body * 0.01);
  mesh(neckGeo, m.varnishDark, root);
  const fb = taperedBox(fbLen, d.fbWidth[1], d.fbWidth[0], d.bridgeH * 0.12);
  fb.translate(0, 0, fbEnd);
  // follow the string line with a little clearance
  const pos = fb.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const clearance = 0.0025 + 0.004 * (1 - (z - fbEnd) / fbLen);
    pos.setY(i, pos.getY(i) + stringY(z) - clearance * (d.stringLen / 0.33) * 0.5 - d.bridgeH * 0.06);
  }
  fb.computeVertexNormals();
  mesh(fb, m.ebony, root);
  const peg = new BoxGeometry(d.nutW * 1.1, d.bridgeH * 0.5, d.neck * 0.55);
  peg.translate(0, nutY - d.bridgeH * 0.35, nutZ + d.neck * 0.27);
  peg.rotateX(0);
  mesh(peg, m.varnishDark, root);
  const scroll = torus(d.nutW * 0.55, d.nutW * 0.28, Math.PI * 1.7, 8, 20);
  scroll.rotateY(Math.PI / 2);
  scroll.translate(0, nutY - d.bridgeH * 0.25, nutZ + d.neck * 0.6);
  mesh(scroll, m.varnishDark, root);
  for (let i = 0; i < 4; i++) {
    const side = i % 2 ? 1 : -1;
    const pg = new CylinderGeometry(d.nutW * 0.12, d.nutW * 0.15, d.nutW * 2.2, 6);
    pg.rotateZ(Math.PI / 2);
    pg.translate(side * d.nutW * 1.1, nutY - d.bridgeH * 0.35, nutZ + d.neck * (0.1 + 0.12 * i));
    mesh(pg, m.ebony, root);
  }

  // bridge & tailpiece
  const bridge = new BoxGeometry(d.bridgeW * 1.15, d.bridgeH, d.bridgeH * 0.12);
  bridge.translate(0, top + d.bridgeH / 2, bridgeZ);
  mesh(bridge, m.skin, root);
  const tailEnd = bridgeZ - d.body * 0.07;
  const tail = taperedBox(tailEnd - d.body * 0.03, d.bridgeW * 0.45, d.bridgeW * 1.05, d.bridgeH * 0.12);
  tail.translate(0, top + d.bridgeH * 0.3, d.body * 0.03);
  mesh(tail, m.ebony, root);

  // strings
  const bridgeX = [1.5, 0.5, -0.5, -1.5].map((k) => (k * d.bridgeW) / 3);
  const nutX = [1.5, 0.5, -0.5, -1.5].map((k) => (k * d.nutW) / 3);
  const strings: BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const r = (0.0006 + 0.00025 * (3 - k)) * (d.stringLen / 0.33) ** 0.6;
    strings.push(rod(new Vector3(bridgeX[k] * 0.9, top + d.bridgeH * 0.35, tailEnd), new Vector3(bridgeX[k], bridgeY, bridgeZ), r, r, 4));
    strings.push(rod(new Vector3(bridgeX[k], bridgeY, bridgeZ), new Vector3(nutX[k], nutY, nutZ), r, r, 4));
  }
  mesh(mergeGeometries(strings)!, m.string, root);

  if (d.chinrest) {
    const cr = new CylinderGeometry(0.035, 0.038, 0.012, 16);
    cr.scale(1, 1, 0.75);
    cr.translate(0.028, top + 0.012, 0.03);
    mesh(cr, m.ebony, root);
    anchors.chinrest = anchor('chinrest', 0.028, top + 0.02, 0.035, root);
  }
  if (d.endpin) {
    mesh(rod(new Vector3(0, -d.ribs * 0.5, 0.01), new Vector3(0, -d.ribs * 0.5, -d.endpin), 0.006 * (d.body / 0.75), 0.003, 8), m.chrome, root);
    anchors.endpin = anchor('endpin', 0, -d.ribs * 0.5, -d.endpin, root);
  }

  anchors.bridge = anchor('bridge', 0, bridgeY, bridgeZ, root);
  anchors.nut = anchor('nut', 0, nutY, nutZ, root);
  anchors.fingerboard_end = anchor('fingerboard_end', 0, stringY(fbEnd), fbEnd, root);
  anchors.neck_heel = anchor('neck_heel', 0, top, d.body, root);
  const contactZ = bridgeZ + d.stringLen * 0.085;
  for (let k = 0; k < 4; k++) {
    const u = (contactZ - bridgeZ) / (nutZ - bridgeZ);
    anchors[`string_${k}`] = anchor(`string_${k}`, bridgeX[k] + (nutX[k] - bridgeX[k]) * u, stringY(contactZ), contactZ, root);
  }
  // moving left-hand anchor (positioned each frame along the fingerboard)
  anchors.left_hand = anchor('left_hand', 0, nutY, nutZ - 0.04, root);

  const bowed: BowedSpec = {
    scale: d.body / 0.356,
    bridgeZ,
    nutZ,
    contactZ,
    bridgeX,
    nutX,
    bridgeY,
    nutY,
    arch: d.bridgeW * 1.3,
    frogSide: kind === 'violin' || kind === 'viola' ? 1 : -1,
    bowLength: d.bow,
    hairGap: kind === 'bass' ? 0.024 : kind === 'cello' ? 0.02 : 0.015,
    hairStart: 0.035,
    hairEnd: d.bow - 0.02,
  };

  const bow = buildBow(d.bow, bowed.hairGap, m);
  return {
    kind: kind as InstrumentKind,
    root,
    anchors,
    grips: {},
    bowed,
    bow,
  };
}

/** Box along +Z from 0..len, width w0 at z=0 tapering to w1, height h. */
function taperedBox(len: number, w0: number, w1: number, h: number): BufferGeometry {
  const g = new BoxGeometry(1, h, len, 1, 1, 4);
  g.translate(0, 0, len / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const w = w0 + (w1 - w0) * (z / len);
    pos.setX(i, pos.getX(i) * w);
  }
  g.computeVertexNormals();
  return g;
}

export function buildBow(length: number, gap: number, m: Materials): Group {
  const bow = new Group();
  bow.name = 'bow';
  // stick with a gentle camber toward the hair
  const pts: Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new Vector3(0, -gap * 0.35 * Math.sin(Math.PI * t) + gap * 0.15 * t, -0.03 + t * (length + 0.03)));
  }
  const stick: BufferGeometry[] = [];
  for (let i = 0; i < pts.length - 1; i++) stick.push(rod(pts[i], pts[i + 1], 0.0045 - 0.0018 * (i / 8), 0.0045 - 0.0018 * ((i + 1) / 8), 6));
  mesh(mergeGeometries(stick)!, m.bowStick, bow);
  // frog
  const frog = new BoxGeometry(0.012, gap * 0.9, 0.045);
  frog.translate(0, -gap * 0.5, 0.012);
  mesh(frog, m.ebony, bow);
  // tip
  const tip = new SphereGeometry(0.006, 8, 6);
  tip.scale(1, 2.2, 1.4);
  tip.translate(0, -gap * 0.4, length);
  mesh(tip, m.skin, bow);
  // hair ribbon
  const hair = new BoxGeometry(0.009, 0.0012, length - 0.05);
  hair.translate(0, -gap, 0.035 + (length - 0.05) / 2);
  mesh(hair, m.hair, bow);
  anchor('grip', 0, 0, 0.02, bow);
  return bow;
}
