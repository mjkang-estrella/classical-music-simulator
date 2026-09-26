import type { SectionId } from '../music/types';

export type SeatKind = 'chair' | 'stool' | 'standing';

export interface Seat {
  section: SectionId;
  index: number;
  x: number;
  y: number;
  z: number;
  /** rotation about +Y; the player's local +Z faces the podium */
  yaw: number;
  kind: SeatKind;
  /** 1-based stand number (string sections) */
  stand: number;
  /** outside = the player nearer the audience at a shared stand */
  inside: boolean;
  /** where the stand/music desk is, if any */
  desk: { x: number; z: number; yaw: number; shared: boolean } | null;
}

export interface Riser {
  inner: number;
  outer: number;
  height: number;
  from: number;
  to: number;
}

/**
 * Stage coordinates: the conductor stands at the origin facing -Z, the audience is at +Z.
 * Angle φ is measured from -Z; negative φ = audience-left.
 */
export function polar(r: number, phiDeg: number, y = 0): [number, number, number] {
  const p = (phiDeg * Math.PI) / 180;
  return [r * Math.sin(p), y, -r * Math.cos(p)];
}

export function yawToward(x: number, z: number, tx = 0, tz = 0.4): number {
  return Math.atan2(tx - x, tz - z);
}

export const RISERS: Riser[] = [
  { inner: 6.4, outer: 7.6, height: 0.25, from: -40, to: 40 },
  { inner: 7.6, outer: 8.8, height: 0.5, from: -42, to: 42 },
  { inner: 8.8, outer: 10.1, height: 0.75, from: -44, to: 44 },
  { inner: 10.1, outer: 11.8, height: 1.0, from: -44, to: 44 },
];

export function riserHeight(r: number, phiDeg: number): number {
  for (let i = RISERS.length - 1; i >= 0; i--) {
    const rs = RISERS[i];
    if (r >= rs.inner && r < rs.outer + 0.3 && phiDeg >= rs.from && phiDeg <= rs.to) return rs.height;
  }
  return 0;
}

interface StringWedge {
  from: number;
  to: number;
  r0: number;
  /** principal sits at the `from` edge of the front row */
  kind: SeatKind;
  rowGap: number;
  maxRows?: number;
}

const STRING_WEDGES: Partial<Record<SectionId, StringWedge>> = {
  violin1: { from: -89, to: -39, r0: 2.4, kind: 'chair', rowGap: 1.1 },
  violin2: { from: -37, to: -4, r0: 2.6, kind: 'chair', rowGap: 1.1 },
  viola: { from: 4, to: 34, r0: 2.6, kind: 'chair', rowGap: 1.1 },
  cello: { from: 88, to: 36, r0: 2.3, kind: 'chair', rowGap: 1.15 },
};

const STAND_WIDTH = 1.1;

function placeStrings(section: SectionId, count: number, w: StringWedge): Seat[] {
  const seats: Seat[] = [];
  const stands = Math.ceil(count / 2);
  const dir = Math.sign(w.to - w.from);
  const span = Math.abs(w.to - w.from);
  let placed = 0;
  let row = 0;
  // fill rows from the front; the first stand of every row is on the `from` edge
  while (placed < stands) {
    const r = w.r0 + row * w.rowGap;
    const arc = (r * span * Math.PI) / 180;
    const perRow = Math.max(1, Math.min(stands - placed, Math.floor(arc / STAND_WIDTH)));
    const step = span / Math.max(perRow, Math.floor(arc / STAND_WIDTH));
    for (let j = 0; j < perRow; j++) {
      const phi = w.from + dir * step * (j + 0.5);
      const standNo = placed + 1;
      const [cx, , cz] = polar(r, phi);
      const deskPos = polar(r - 0.55, phi);
      const yaw = yawToward(cx, cz);
      // players sit side by side, tangential to the arc
      const tangent: [number, number] = [Math.cos((phi * Math.PI) / 180), Math.sin((phi * Math.PI) / 180)];
      for (let k = 0; k < 2 && seats.length < count; k++) {
        // outside player = further from the stage centre line
        const outwardSign = Math.sign(phi) || 1;
        const side = k === 0 ? outwardSign : -outwardSign;
        const x = cx + tangent[0] * 0.34 * side;
        const z = cz + tangent[1] * 0.34 * side;
        seats.push({
          section,
          index: seats.length,
          x,
          y: 0,
          z,
          yaw: yawToward(x, z),
          kind: w.kind,
          stand: standNo,
          inside: k === 1,
          desk: k === 0 ? { x: deskPos[0], z: deskPos[2], yaw, shared: true } : null,
        });
      }
      placed++;
    }
    row++;
  }
  return seats;
}

function placeRow(section: SectionId, count: number, r: number, phiStart: number, spacingM: number, direction: 1 | -1, kind: SeatKind = 'chair'): Seat[] {
  const seats: Seat[] = [];
  const stepDeg = (spacingM / r) * (180 / Math.PI);
  for (let i = 0; i < count; i++) {
    const phi = phiStart + direction * stepDeg * i;
    const y = riserHeight(r, phi);
    const [x, , z] = polar(r, phi);
    const yaw = yawToward(x, z);
    const desk = polar(r - 0.62, phi);
    seats.push({
      section,
      index: i,
      x,
      y,
      z,
      yaw,
      kind,
      stand: i + 1,
      inside: false,
      desk: kind === 'standing' && section === 'timpani' ? null : { x: desk[0], z: desk[2], yaw, shared: false },
    });
  }
  return seats;
}

/** Deterministic American-style seating for the given head-count per section. */
export function generateSeating(counts: Partial<Record<SectionId, number>>): Seat[] {
  const seats: Seat[] = [];
  const n = (s: SectionId) => counts[s] ?? 0;

  for (const s of ['violin1', 'violin2', 'viola', 'cello'] as const) {
    if (n(s)) seats.push(...placeStrings(s, n(s), STRING_WEDGES[s]!));
  }
  if (n('bass')) {
    // basses in a curved line just behind the cellos, on stools
    const cellos = seats.filter((s) => s.section === 'cello');
    const celloR = cellos.length ? Math.max(...cellos.map((s) => Math.hypot(s.x, s.z))) : 3.5;
    const r = Math.min(6.3, Math.max(4.2, celloR + 1.3));
    const bassSeats = placeRow('bass', n('bass'), r, 70, 1.0, -1, 'stool');
    if (n('bass') > 5) bassSeats.splice(5, bassSeats.length - 5, ...placeRow('bass', n('bass') - 5, r + 1.0, 64, 1.0, -1, 'stool'));
    bassSeats.forEach((s, i) => (s.index = i));
    seats.push(...bassSeats);
  }
  if (n('harp')) seats.push(...placeRow('harp', n('harp'), 5.6, -80, 1.2, 1));

  // woodwinds: principals meet in the middle
  if (n('flute')) seats.push(...placeRow('flute', n('flute'), 7.0, -3.5, 0.95, -1));
  if (n('piccolo')) {
    const start = -3.5 - ((n('flute') * 0.95) / 7.0) * (180 / Math.PI);
    seats.push(...placeRow('piccolo', n('piccolo'), 7.0, start, 0.95, -1));
  }
  if (n('oboe')) seats.push(...placeRow('oboe', n('oboe'), 7.0, 3.5, 0.95, 1));
  if (n('clarinet')) seats.push(...placeRow('clarinet', n('clarinet'), 8.2, -3.3, 0.95, -1));
  if (n('bassoon')) seats.push(...placeRow('bassoon', n('bassoon'), 8.2, 3.3, 1.0, 1));

  // brass on the top riser: horns left, trumpets centre, trombones + tuba right
  if (n('horn')) seats.push(...placeRow('horn', n('horn'), 9.4, -12, 0.95, -1));
  if (n('trumpet')) seats.push(...placeRow('trumpet', n('trumpet'), 9.4, -2.5, 0.95, 1));
  const tpEnd = 2.5 + (n('trumpet') - 1) * ((0.95 / 9.4) * (180 / Math.PI));
  if (n('trombone')) seats.push(...placeRow('trombone', n('trombone'), 9.4, tpEnd + 7, 1.0, 1));
  if (n('tuba')) {
    const tbEnd = tpEnd + 7 + Math.max(0, n('trombone') - 1) * ((1.0 / 9.4) * (180 / Math.PI));
    seats.push(...placeRow('tuba', n('tuba'), 9.4, tbEnd + 7.5, 1.0, 1));
  }

  if (n('timpani')) seats.push(...placeRow('timpani', 1, 10.9, 6, 1.2, 1, 'standing'));
  if (n('percussion')) seats.push(...placeRow('percussion', n('percussion'), 10.9, -14, 1.6, -1, 'standing'));
  return seats;
}

/** Conductor's podium, at the front centre. */
export const PODIUM = { x: 0, z: 0.4, height: 0.22, radius: 0.55 };

export const STAGE = {
  front: 3.4,
  back: -12.8,
  halfWidth: 13.5,
};
