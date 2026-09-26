import type { Group, Object3D, Vector3 } from 'three';
import type { InstrumentKind } from '../../orchestra/sections';

/** How a hand holds something: palm centre, finger direction and palm normal, all in the holder's local frame. */
export interface Grip {
  anchor: Object3D;
  dir: Vector3;
  palm: Vector3;
  /** 0 = open hand, 1 = fist */
  curl: number;
  thumbCurl?: number;
  spread?: number;
}

export interface BowedSpec {
  scale: number;
  bridgeZ: number;
  nutZ: number;
  /** bow contact point distance from the bridge towards the fingerboard */
  contactZ: number;
  /** open-string x at bridge / nut (low → high) */
  bridgeX: number[];
  nutX: number[];
  bridgeY: number;
  nutY: number;
  /** radius of the bridge arch, sets bow tilt per string */
  arch: number;
  /** +1 violin/viola (frog on the treble side), -1 cello/bass */
  frogSide: 1 | -1;
  bowLength: number;
  hairGap: number;
  hairStart: number;
  hairEnd: number;
}

export interface InstrumentModel {
  kind: InstrumentKind;
  root: Group;
  anchors: Record<string, Object3D>;
  grips: Partial<Record<'L' | 'R', Grip>>;
  bowed?: BowedSpec;
  /** bow for strings: origin at the frog, +Z towards the tip, hair on -Y */
  bow?: Group;
  /** mallets / beaters / cymbal plates held in each hand: origin at the grip, +Z towards the head */
  held?: Partial<Record<'L' | 'R', Group>>;
  /** trombone outer slide (moves along +Z) */
  slide?: Object3D;
  /** timpani heads / drums etc. that stay on the floor independent of the player */
  floor?: Group;
}
