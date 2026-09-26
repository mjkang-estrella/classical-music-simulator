/** Canonical (Mixamo-style) bone names every rig is mapped onto. */
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;
export type Finger = (typeof FINGERS)[number];
export type Side = 'Left' | 'Right';

export const CORE_BONES = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
] as const;

export type CoreBone = (typeof CORE_BONES)[number];
export type FingerBone = `${Side}Hand${Finger}${1 | 2 | 3}`;
export type CanonBone = CoreBone | FingerBone | 'LeftToeBase' | 'RightToeBase' | 'Jaw';

const BIP_FINGER: Record<string, Finger> = { '0': 'Thumb', '1': 'Index', '2': 'Middle', '3': 'Ring', '4': 'Pinky' };

/**
 * Maps a node name from any supported rig onto the canonical skeleton.
 * Supports: 3ds Max Biped (Microsoft Rocketbox `Bip01 …`), Mixamo / MPFB (`mixamorig:…`),
 * and our own placeholder mannequin (already canonical).
 * three.js sanitises names (spaces → `_`, `:` removed) so both spellings are accepted.
 */
export function canonicalName(raw: string): CanonBone | null {
  let name = raw.replace(/\s+/g, '_');
  name = name.replace(/^mixamorig[:_]?/i, '').replace(/^(Armature|Skeleton|Rig)[_|]/i, '');

  const bip = /^Bip0?1_?(.*)$/i.exec(name);
  if (bip) return fromBiped(bip[1]);

  // strip trailing ".001" style suffixes (sanitised to "001")
  name = name.replace(/_?\d{3}$/, '');
  if ((CORE_BONES as readonly string[]).includes(name)) return name as CanonBone;
  if (/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[123]$/.test(name)) return name as CanonBone;
  if (/^(Left|Right)ToeBase$/.test(name)) return name as CanonBone;
  if (/^Jaw$/i.test(name)) return 'Jaw';
  return null;
}

function fromBiped(rest: string): CanonBone | null {
  const r = rest.replace(/^_/, '');
  switch (r) {
    case 'Pelvis':
      return 'Hips';
    case 'Spine':
      return 'Spine';
    case 'Spine1':
      return 'Spine1';
    case 'Spine2':
      return 'Spine2';
    case 'Neck':
      return 'Neck';
    case 'Head':
      return 'Head';
    case 'MJaw':
      return 'Jaw';
  }
  const m = /^([LR])_(Clavicle|UpperArm|Forearm|Hand|Thigh|Calf|Foot|Toe0|Finger(\d)(\d?))$/.exec(r);
  if (!m) return null;
  const side: Side = m[1] === 'L' ? 'Left' : 'Right';
  switch (m[2]) {
    case 'Clavicle':
      return `${side}Shoulder`;
    case 'UpperArm':
      return `${side}Arm`;
    case 'Forearm':
      return `${side}ForeArm`;
    case 'Hand':
      return `${side}Hand`;
    case 'Thigh':
      return `${side}UpLeg`;
    case 'Calf':
      return `${side}Leg`;
    case 'Foot':
      return `${side}Foot`;
    case 'Toe0':
      return `${side}ToeBase`;
  }
  const finger = BIP_FINGER[m[3]];
  if (!finger) return null;
  // Finger0 → 1, Finger01 → 2, Finger02 → 3
  const seg = m[4] === '' ? 1 : Number(m[4]) + 1;
  if (seg > 3) return null;
  return `${side}Hand${finger}${seg as 1 | 2 | 3}`;
}
