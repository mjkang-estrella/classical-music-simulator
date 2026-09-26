import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Shape,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RISERS, STAGE, type Seat } from '../orchestra/seating';
import { rod } from './instruments/geometry';
import { materials } from './instruments/materials';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

function chairParts(): { frame: BufferGeometry; seat: BufferGeometry } {
  const h = 0.46;
  const frame: BufferGeometry[] = [];
  for (const [x, z] of [
    [0.19, 0.17],
    [-0.19, 0.17],
    [0.19, -0.17],
    [-0.19, -0.17],
  ]) {
    frame.push(rod(v(x, 0, z), v(x, h - 0.02, z), 0.011, 0.011, 6));
  }
  frame.push(rod(v(0.19, h - 0.02, -0.19), v(0.2, h + 0.4, -0.24), 0.011, 0.011, 6));
  frame.push(rod(v(-0.19, h - 0.02, -0.19), v(-0.2, h + 0.4, -0.24), 0.011, 0.011, 6));
  const seat = new BoxGeometry(0.44, 0.05, 0.42);
  seat.translate(0, h, 0);
  const back = new BoxGeometry(0.42, 0.2, 0.03);
  back.rotateX(0.12);
  back.translate(0, h + 0.3, -0.225);
  return { frame: mergeGeometries(frame)!, seat: mergeGeometries([seat.toNonIndexed(), back.toNonIndexed()])! };
}

function stoolParts(): { frame: BufferGeometry; seat: BufferGeometry } {
  const h = 0.74;
  const frame: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    frame.push(rod(v(Math.cos(a) * 0.12, h - 0.03, Math.sin(a) * 0.12), v(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2), 0.011, 0.011, 6));
  }
  const ring = new CylinderGeometry(0.17, 0.17, 0.015, 24, 1, true);
  ring.translate(0, 0.3, 0);
  frame.push(ring);
  const seat = new CylinderGeometry(0.17, 0.16, 0.05, 24);
  seat.translate(0, h, 0);
  return { frame: mergeGeometries(frame.map((g) => g.toNonIndexed()))!, seat };
}

function standParts(height: number): { metal: BufferGeometry; paper: BufferGeometry } {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    parts.push(rod(v(0, 0.22, 0), v(Math.cos(a) * 0.22, 0.005, Math.sin(a) * 0.22), 0.007, 0.007, 5));
  }
  parts.push(rod(v(0, 0, 0), v(0, height - 0.12, 0), 0.01, 0.009, 8));
  const desk = new BoxGeometry(0.5, 0.34, 0.012);
  desk.translate(0, 0.17, 0);
  desk.rotateX(-0.42);
  desk.translate(0, height - 0.16, 0.02);
  parts.push(desk);
  const lip = new BoxGeometry(0.5, 0.012, 0.05);
  lip.translate(0, height - 0.16, 0.04);
  parts.push(lip);
  const paper = new BoxGeometry(0.46, 0.3, 0.003);
  paper.translate(0, 0.17, 0.009);
  paper.rotateX(-0.42);
  paper.translate(0, height - 0.155, 0.02);
  return { metal: mergeGeometries(parts.map((g) => g.toNonIndexed()))!, paper };
}

function instanced(geo: BufferGeometry, mat: Material, matrices: Matrix4[]): InstancedMesh | null {
  if (!matrices.length) return null;
  const im = new InstancedMesh(geo, mat, matrices.length);
  matrices.forEach((m, i) => im.setMatrixAt(i, m));
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = true;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

/** Chairs, stools and music stands for every seat — a handful of draw calls. */
export function buildSeatingProps(seats: Seat[]): Group {
  const m = materials();
  const g = new Group();
  g.name = 'seating-props';
  const chair = chairParts();
  const stool = stoolParts();
  const standLow = standParts(1.08);
  const standHigh = standParts(1.34);
  const chairs: Matrix4[] = [];
  const stools: Matrix4[] = [];
  const low: Matrix4[] = [];
  const high: Matrix4[] = [];
  const q = new Quaternion();
  const up = v(0, 1, 0);
  for (const s of seats) {
    q.setFromAxisAngle(up, s.yaw);
    const mat = new Matrix4().compose(v(s.x, s.y, s.z), q, v(1, 1, 1));
    if (s.kind === 'chair') chairs.push(mat);
    else if (s.kind === 'stool') stools.push(mat);
    if (s.desk) {
      const dq = new Quaternion().setFromAxisAngle(up, s.desk.yaw + Math.PI);
      const dm = new Matrix4().compose(v(s.desk.x, s.y, s.desk.z), dq, v(1, 1, 1));
      (s.kind === 'chair' ? low : high).push(dm);
    }
  }
  for (const im of [
    instanced(chair.frame, m.chair, chairs),
    instanced(chair.seat, m.chairSeat, chairs),
    instanced(stool.frame, m.chair, stools),
    instanced(stool.seat, m.chairSeat, stools),
    instanced(standLow.metal, m.stand, low),
    instanced(standLow.paper, m.paper, low),
    instanced(standHigh.metal, m.stand, high),
    instanced(standHigh.paper, m.paper, high),
  ]) {
    if (im) g.add(im);
  }
  return g;
}

/** Stage floor, back wall shell, risers and podium. */
export function buildStage(): Group {
  const g = new Group();
  g.name = 'stage';
  const floorMat = new MeshStandardMaterial({ color: '#2e1f15', roughness: 0.38, metalness: 0 });
  const woodMat = new MeshStandardMaterial({ color: '#4a2d19', roughness: 0.5 });
  const shellMat = new MeshStandardMaterial({ color: '#2a1d14', roughness: 0.8, side: DoubleSide });
  const darkMat = new MeshStandardMaterial({ color: '#0b0908', roughness: 1 });

  // stage deck with a curved apron
  const deck = new Shape();
  const hw = STAGE.halfWidth;
  deck.moveTo(-hw, STAGE.back);
  deck.lineTo(hw, STAGE.back);
  deck.lineTo(hw, 1.5);
  deck.quadraticCurveTo(hw * 0.55, STAGE.front + 1.2, 0, STAGE.front + 0.6);
  deck.quadraticCurveTo(-hw * 0.55, STAGE.front + 1.2, -hw, 1.5);
  deck.lineTo(-hw, STAGE.back);
  const deckGeo = new ExtrudeGeometry(deck, { depth: 1.1, bevelEnabled: false, curveSegments: 24 });
  deckGeo.rotateX(Math.PI / 2);
  const deckMesh = new Mesh(deckGeo, [floorMat, darkMat]);
  deckMesh.receiveShadow = true;
  deckMesh.name = 'deck';
  g.add(deckMesh);

  // risers
  for (const r of RISERS) {
    const s = new Shape();
    const a0 = (r.from * Math.PI) / 180;
    const a1 = (r.to * Math.PI) / 180;
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const [x, y] = [r.outer * Math.sin(a), r.outer * Math.cos(a)];
      if (i === 0) s.moveTo(x, y);
      else s.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i--) {
      const a = a0 + ((a1 - a0) * i) / steps;
      s.lineTo(r.inner * Math.sin(a), r.inner * Math.cos(a));
    }
    const geo = new ExtrudeGeometry(s, { depth: r.height, bevelEnabled: false });
    // shape y (distance) → -z (towards the back); extrusion → +y
    geo.rotateX(-Math.PI / 2);
    const mesh = new Mesh(geo, [woodMat, darkMat]);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    g.add(mesh);
  }

  // acoustic shell: curved panels behind the orchestra
  const shellR = 13.4;
  const panels = 18;
  for (let i = 0; i < panels; i++) {
    const a = -1.25 + (2.5 * (i + 0.5)) / panels;
    const width = (2.5 / panels) * shellR * 1.02;
    const panel = new BoxGeometry(width, 9, 0.2);
    const mesh = new Mesh(panel, shellMat);
    mesh.position.set(shellR * Math.sin(a), 4.5, -shellR * Math.cos(a) + 0.6);
    mesh.rotation.y = -a;
    mesh.rotation.x = 0.06;
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  // podium
  const pod = new BoxGeometry(1.0, 0.22, 0.9);
  pod.translate(0, 0.11, 0.45);
  const podium = new Mesh(pod, new MeshStandardMaterial({ color: '#2a1a12', roughness: 0.8 }));
  podium.castShadow = podium.receiveShadow = true;
  g.add(podium);
  const rail: BufferGeometry[] = [];
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    const a0 = Math.PI * (0.15 + (0.7 * i) / steps);
    const a1 = Math.PI * (0.15 + (0.7 * (i + 1)) / steps);
    rail.push(rod(v(Math.cos(a0) * 0.48, 1.12, 0.45 + Math.sin(a0) * 0.42), v(Math.cos(a1) * 0.48, 1.12, 0.45 + Math.sin(a1) * 0.42), 0.012, 0.012, 6));
  }
  for (const a of [0.15, 0.5, 0.85]) rail.push(rod(v(Math.cos(Math.PI * a) * 0.48, 0.22, 0.45 + Math.sin(Math.PI * a) * 0.42), v(Math.cos(Math.PI * a) * 0.48, 1.12, 0.45 + Math.sin(Math.PI * a) * 0.42), 0.012, 0.012, 6));
  const railMesh = new Mesh(mergeGeometries(rail)!, materials().chrome);
  g.add(railMesh);
  // conductor's score desk
  const desk = standParts(1.12);
  const deskG = new Group();
  deskG.add(new Mesh(desk.metal, materials().stand), new Mesh(desk.paper, materials().paper));
  deskG.position.set(0, 0.22, -0.05);
  deskG.rotation.y = Math.PI;
  deskG.scale.set(1.3, 1, 1.1);
  g.add(deskG);

  // dark auditorium floor in front of the stage
  const hall = new BoxGeometry(60, 0.1, 40);
  const hallMesh = new Mesh(hall, new MeshStandardMaterial({ color: '#120d0b', roughness: 1 }));
  hallMesh.position.set(0, -1.15, STAGE.front + 20);
  hallMesh.receiveShadow = true;
  g.add(hallMesh);
  addAudienceSeats(g);
  return g;
}

function addAudienceSeats(g: Group) {
  const seatGeo = new BoxGeometry(0.5, 0.5, 0.5);
  seatGeo.translate(0, 0.25, 0);
  const backGeo = new BoxGeometry(0.5, 0.55, 0.08);
  backGeo.translate(0, 0.65, -0.22);
  const geo = mergeGeometries([seatGeo, backGeo])!;
  const mat = new MeshStandardMaterial({ color: '#4a0f12', roughness: 0.9 });
  const matrices: Matrix4[] = [];
  const up = v(0, 1, 0);
  for (let row = 0; row < 14; row++) {
    const r = 9 + row * 1.0;
    const n = Math.floor((r * 1.6) / 0.56);
    for (let i = 0; i < n; i++) {
      const a = -0.8 + (1.6 * (i + 0.5)) / n;
      if (Math.abs(a) < 0.05) continue;
      const x = r * Math.sin(a);
      const z = STAGE.front - 3 + r * Math.cos(a);
      const y = -1.1 + row * 0.18;
      matrices.push(new Matrix4().compose(v(x, y, z), new Quaternion().setFromAxisAngle(up, Math.PI + a), v(1, 1, 1)));
    }
  }
  const im = instanced(geo, mat, matrices);
  if (im) {
    im.castShadow = false;
    g.add(im);
  }
}

export function place(obj: Object3D, x: number, y: number, z: number, yaw: number) {
  obj.position.set(x, y, z);
  obj.rotation.set(0, yaw, 0);
}
