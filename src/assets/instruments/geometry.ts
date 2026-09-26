import {
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Mesh,
  Object3D,
  Shape,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';

/** Small helpers for building instruments out of primitives. */

export function mesh(geo: BufferGeometry, mat: Material, parent?: Object3D): Mesh {
  const m = new Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  parent?.add(m);
  return m;
}

export function anchor(name: string, x: number, y: number, z: number, parent: Object3D): Object3D {
  const a = new Object3D();
  a.name = `anchor_${name}`;
  a.position.set(x, y, z);
  parent.add(a);
  return a;
}

/** Cylinder from a to b. */
export function rod(a: Vector3, b: Vector3, r0: number, r1 = r0, segs = 10): BufferGeometry {
  const len = a.distanceTo(b);
  const geo = new CylinderGeometry(r1, r0, len, segs, 1);
  geo.translate(0, len / 2, 0);
  const dir = b.clone().sub(a).normalize();
  const m = new Object3D();
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
  m.position.copy(a);
  m.updateMatrix();
  geo.applyMatrix4(m.matrix);
  return geo;
}

/** Tube along a smooth path. */
export function tube(points: [number, number, number][], radius: number, segs = 48, radial = 10, closed = false): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)), closed, 'centripetal');
  return new TubeGeometry(curve, segs, radius, radial, closed);
}

/** Lathe around +Y from a list of [radius, y] pairs. */
export function lathe(profile: [number, number][], segs = 28): BufferGeometry {
  return new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, y)),
    segs,
  );
}

/** Exponential flare bell profile, mouth at y = 0 opening downward toward -y. */
export function bellProfile(throatR: number, mouthR: number, length: number, flare = 4, steps = 18): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = throat, 1 = mouth
    const r = throatR + (mouthR - throatR) * Math.pow(t, flare);
    pts.push([r, length * (1 - t)]);
  }
  // roll the rim
  pts.push([mouthR + 0.003, -0.002]);
  pts.push([mouthR - 0.002, -0.004]);
  return pts;
}

export function torus(radius: number, tubeR: number, arc = Math.PI * 2, radial = 10, tubular = 48): BufferGeometry {
  return new TorusGeometry(radius, tubeR, radial, tubular, arc);
}

/**
 * Violin-family body outline (x across, y along the body, 0 = tail end), built from a
 * normalised half-profile through the lower bout, corners, C-bouts and upper bout.
 * `bass` gives the double bass its sloping shoulders.
 */
export function bodyOutline(length: number, lower: number, waist: number, upper: number, bass = false): Shape {
  const w = waist / lower;
  const u = upper / lower;
  const profile: [number, number][] = bass
    ? [
        [0, 0],
        [0.012, 0.36],
        [0.045, 0.68],
        [0.11, 0.92],
        [0.22, 1.0],
        [0.33, 0.95],
        [0.4, 0.84],
        [0.43, 0.7],
        [0.5, w + 0.02],
        [0.56, w],
        [0.62, w + 0.06],
        [0.65, u * 0.95],
        [0.72, u],
        [0.8, u * 0.88],
        [0.88, u * 0.62],
        [0.95, u * 0.4],
        [0.99, u * 0.22],
        [1, 0],
      ]
    : [
        [0, 0],
        [0.01, 0.34],
        [0.04, 0.64],
        [0.1, 0.9],
        [0.2, 1.0],
        [0.3, 0.97],
        [0.36, 0.88],
        [0.395, 0.84],
        [0.41, 0.7],
        [0.46, w + 0.04],
        [0.52, w],
        [0.58, w + 0.04],
        [0.625, w + 0.16],
        [0.64, u * 0.97],
        [0.68, u * 0.95],
        [0.76, u],
        [0.84, u * 0.97],
        [0.91, u * 0.82],
        [0.96, u * 0.56],
        [0.99, u * 0.28],
        [1, 0],
      ];
  const pts = profile.map(([t, hw]) => new Vector2((hw * lower) / 2, t * length));
  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.splineThru(pts.slice(1));
  const back = pts
    .slice(0, -1)
    .reverse()
    .map((p) => new Vector2(-p.x, p.y));
  shape.splineThru(back);
  return shape;
}

/** Extrudes the outline so the top plate is at y = 0, body below, long axis +Z. */
export function violinBody(shape: Shape, ribs: number, arch: number): BufferGeometry {
  const geo = new ExtrudeGeometry(shape, {
    depth: ribs,
    bevelEnabled: true,
    bevelThickness: arch,
    bevelSize: arch * 0.8,
    bevelSegments: 3,
    curveSegments: 8,
  });
  // shape y (along) → +z; extrusion z → -y
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, 0);
  return geo;
}
