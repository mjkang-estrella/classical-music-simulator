import { transport } from '../audio/transport';
import { orchestra } from '../scene/orchestra';
import { cameraHandle } from '../scene/Viewport';
import { loadPiece, play, pause, seek } from './controller';
import { useApp } from './store';
import { Actor } from '../animation/actor';
import { setPoreStrength, setSkinScattering } from '../assets/characterMaterials';

/** Test / debugging hooks (used by the Playwright end-to-end tests). */
const api = {
  time: () => transport.visualTime(),
  state: () => transport.state,
  status: () => useApp.getState().status,
  load: (id: string, autoplay = false) => loadPiece(id, autoplay),
  play,
  pause,
  seek,
  select: (id: string | null) => useApp.getState().select(id),
  camera: (name: Parameters<ReturnType<typeof useApp.getState>['setCamera']>[0]) => useApp.getState().setCamera(name),
  musicians: () => orchestra.musicians.map((m) => ({ id: m.id, section: m.section, label: m.label })),
  activeNotes: () => {
    const t = transport.visualTime();
    let n = 0;
    for (const idx of orchestra.indexes.values()) n += idx.active(t).length;
    return n;
  },
  actors: () => orchestra.actors.length,
  /** place the camera relative to a musician's root frame (x = their left, z = their front) */
  lookAt: (id: string, cx: number, cy: number, cz: number, tx = 0, ty = 1.0, tz = 0.2) => {
    const a = orchestra.actorById(id);
    const c = cameraHandle.controls;
    if (!a || !c) return;
    useApp.getState().set({ follow: false });
    const p = a.root.localToWorld(a.root.position.clone().set(cx, cy, cz));
    const t = a.root.localToWorld(a.root.position.clone().set(tx, ty, tz));
    void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
  },
  audioLevel: () => transport.engine?.level() ?? 0,
  silent: () => transport.silent,
  /** frame a canonical bone of a musician; offset (ox, oy, oz) is in the musician's root frame */
  lookAtBone: (id: string, bone: string, ox: number, oy: number, oz: number) => {
    const a = orchestra.actorById(id);
    const c = cameraHandle.controls;
    const b = a?.rig.bones[bone as 'Head'];
    if (!a || !c || !b) return;
    useApp.getState().set({ follow: false });
    const t = b.getWorldPosition(a.root.position.clone());
    const off = a.root.position.clone().set(ox, oy, oz).applyQuaternion(a.root.quaternion);
    const p = t.clone().add(off);
    void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
  },
  blink: (id: string, v: number | null) => {
    const a = orchestra.actorById(id);
    if (a) a.debugBlink = v;
  },
  faceTest: (id: string, list: { key: string; pitch?: number; yaw?: number; roll?: number; x?: number; y?: number; z?: number }[]) => {
    const a = orchestra.actorById(id);
    if (a) a.debugFace = list;
  },
  face: (id: string) => {
    const a = orchestra.actorById(id);
    return a ? Object.fromEntries(Object.entries(a.rig.face).map(([k, b]) => [k, b?.name])) : null;
  },
  skin: (v: number) => setSkinScattering(v),
  eyeProbe: (id: string) => {
    const a = orchestra.actorById(id);
    const e = a?.rig.face.eyeL;
    if (!a || !e) return null;
    const r = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z].map((n) => +n.toFixed(3));
    const q = e.getWorldQuaternion(e.quaternion.clone());
    const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map(([x, y, z]) => r(e.position.clone().set(x, y, z).applyQuaternion(q)));
    const head = a.rig.bones.Head!;
    const hq = head.getWorldQuaternion(head.quaternion.clone());
    const hAxes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map(([x, y, z]) => r(e.position.clone().set(x, y, z).applyQuaternion(hq)));
    return { last: a.rig.lastEye, eyeWorld: r(e.getWorldPosition(e.position.clone())), eyeAxes: axes, headAxes: hAxes, rootYaw: +a.root.rotation.y.toFixed(3), children: e.children.map((c) => c.name) };
  },
  eyeGloss: (v: number) => (Actor.eyeGloss = v),
  gazeAtCamera: (on: boolean) => {
    const c = cameraHandle.controls;
    Actor.gazeOverride = on && c ? c.camera.position : null;
  },
  eyeAim: (v: boolean) => (Actor.eyeAim = v),
  pores: (v: number) => setPoreStrength(v),
  stands: (v: boolean) => orchestra.setStandsVisible(v),
  perf: () => ({ updateMs: +orchestra.lastUpdateMs.toFixed(2) }),
  /** raw access for debugging in the console */
  orchestra,
  probe: (id: string) => {
    const a = orchestra.actorById(id);
    if (!a) return null;
    const r = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z].map((n) => +n.toFixed(3));
    const inv = a.root.matrixWorld.clone().invert();
    const toLocal = (v: { x: number; y: number; z: number; clone?: () => unknown }) => {
      const c = (v as never as { clone(): { applyMatrix4(m: unknown): { x: number; y: number; z: number } } }).clone().applyMatrix4(inv);
      return r(c);
    };
    const dirLocal = (v: { x: number; y: number; z: number }) => {
      const q = a.root.quaternion.clone().invert();
      const c = (v as never as { clone(): { applyQuaternion(q: unknown): { x: number; y: number; z: number } } }).clone().applyQuaternion(q);
      return r(c);
    };
    const T = a.torso;
    const out: Record<string, unknown> = { torsoX: dirLocal(T.x), torsoY: dirLocal(T.y), torsoZ: dirLocal(T.z), torsoO: toLocal(T.o) };
    for (const b of ['Hips', 'Head', 'LeftArm', 'RightArm', 'LeftHand', 'RightHand', 'LeftForeArm'] as const) {
      const bone = a.rig.bones[b];
      if (bone) out[b] = toLocal(bone.getWorldPosition(bone.position.clone()));
    }
    if (a.inst) {
      const q = a.inst.root.quaternion;
      const zAxis = a.inst.root.position.clone().set(0, 0, 1).applyQuaternion(q);
      const yAxis = a.inst.root.position.clone().set(0, 1, 0).applyQuaternion(q);
      out.instPos = toLocal(a.inst.root.position);
      out.instZ = dirLocal(zAxis);
      out.instY = dirLocal(yAxis);
      if (a.inst.bow) {
        out.bowPos = toLocal(a.inst.bow.position);
        out.bowZ = dirLocal(a.inst.bow.position.clone().set(0, 0, 1).applyQuaternion(a.inst.bow.quaternion));
      }
    }
    return out;
  },
};

declare global {
  interface Window {
    __orchestra: typeof api;
  }
}

window.__orchestra = api;
