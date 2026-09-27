import { CameraControls, PerformanceMonitor } from '@react-three/drei';
import { BrightnessContrast, DepthOfField, EffectComposer, HueSaturation, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode, type DepthOfFieldEffect } from 'postprocessing';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { Exposure } from './exposure';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Color, EquirectangularReflectionMapping, Fog, Group, Mesh, MeshBasicMaterial, NoToneMapping, PMREMGenerator, RingGeometry, SpotLight, SRGBColorSpace, Vector3 } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { transport } from '../audio/transport';
import { buildStage } from '../assets/props';
import { useApp, type CameraPreset } from '../app/store';
import { orchestra } from './orchestra';
import { SECTIONS } from '../orchestra/sections';
import type { SectionId } from '../music/types';

export function Viewport() {
  // adaptive resolution: drop the pixel ratio if the frame rate can't be held
  const [tier, setTier] = useState(2);
  const [aoOk, setAoOk] = useState(true);
  const dpr = tier >= 2 ? Q.dpr : tier === 1 ? Math.min(Q.dpr, 1.35) : 1;
  return (
    <Canvas
      shadows
      dpr={[1, dpr]}
      camera={{ position: [0, 4.2, 14], fov: 38, near: 0.05, far: 220 }}
      gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      onCreated={({ gl, scene }) => {
        // tone mapping happens in the post-processing chain (AgX)
        gl.toneMapping = NoToneMapping;
        gl.outputColorSpace = SRGBColorSpace;
        scene.background = new Color('#0b0908');
        scene.fog = new Fog('#0b0908', 32, 75);
      }}
    >
      <Environment />
      <Lights />
      <Stage />
      <primitive object={orchestra.group} />
      <Runner />
      <Rings />
      <CameraRig />
      <Picking />
      <PerformanceMonitor
        bounds={() => [56, 59.5]}
        flipflops={3}
        onDecline={() => setTier((t) => Math.max(0, t - 1))}
        onIncline={() => setTier((t) => Math.min(2, t + 1))}
        onFallback={() => {
          // oscillating: settle on a sharp image without close-up ambient occlusion
          setAoOk(false);
          setTier(1);
        }}
      />
      <Post allowAo={tier > 0 && aoOk} />
    </Canvas>
  );
}

function Environment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    // start with a procedural room so reflections exist immediately, then swap in the real hall
    let env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.28;
    let disposed = false;
    new HDRLoader().load(`${import.meta.env.BASE_URL}assets/env/music_hall_01_1k.hdr`, (hdr) => {
      if (disposed) return;
      hdr.mapping = EquirectangularReflectionMapping;
      const next = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      env.dispose();
      env = next;
      scene.environment = env;
      scene.environmentIntensity = 0.45;
    });
    return () => {
      disposed = true;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** Post-processing: ambient occlusion, depth of field on the followed musician, AgX tone mapping. */
/** Render-quality switches (URL: ?ao=0&dof=0&msaa=0&post=0&shadow=2048&dpr=1) for profiling. */
const Q = (() => {
  const p = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const flag = (k: string, d: boolean) => (p.has(k) ? p.get(k) !== '0' : d);
  return {
    post: flag('post', true),
    ao: flag('ao', true),
    dof: flag('dof', true),
    msaa: Number(p.get('msaa') ?? 4),
    shadow: Number(p.get('shadow') ?? 4096),
    dpr: Number(p.get('dpr') ?? 1.75),
    aoQuality: (p.get('aoq') ?? 'performance') as 'performance' | 'low' | 'medium',
  };
})();

function Post({ allowAo }: { allowAo: boolean }) {
  const dof = useRef<DepthOfFieldEffect>(null);
  const following = useApp((s) => !!s.selectedId && s.follow);
  const focus = useMemo(() => new Vector3(), []);
  const blur = useRef(0);
  useFrame((_, dt) => {
    const e = dof.current;
    if (!e) return;
    const { selectedId, follow } = useApp.getState();
    const actor = follow ? orchestra.actorById(selectedId) : null;
    const target = actor ? 1 : 0;
    blur.current += (target - blur.current) * (1 - Math.exp(-4 * dt));
    if (actor) {
      actor.headWorld(focus);
      e.target = focus;
    }
    e.bokehScale = blur.current * 2.6;
  });
  if (!Q.post) return null;
  // close-up effects only while a musician is followed: depth of field, and ambient occlusion
  // (N8AO re-renders the scene; in a close-up frustum culling keeps that cheap)
  const dofOn = Q.dof && following;
  const ao = following && allowAo;
  return (
    <EffectComposer multisampling={Q.msaa}>
      {Q.ao && ao ? <N8AO aoRadius={0.35} distanceFalloff={0.5} intensity={2.2} aoSamples={8} denoiseSamples={4} denoiseRadius={8} halfRes /> : <></>}
      {dofOn ? <DepthOfField ref={dof} worldFocusRange={1.4} bokehScale={0} resolutionScale={0.5} /> : <></>}
      <Vignette offset={0.32} darkness={0.55} />
      <Exposure exposure={0.58} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <HueSaturation saturation={-0.1} />
      <BrightnessContrast contrast={0.06} />
    </EffectComposer>
  );
}

function Lights() {
  const group = useMemo(() => {
    const g = new Group();
    const spot = (pos: [number, number, number], target: [number, number, number], intensity: number, color: string, angle = 0.55) => {
      const l = new SpotLight(color, intensity, 45, angle, 0.85, 1.2);
      l.position.set(...pos);
      l.target.position.set(...target);
      g.add(l, l.target);
      return l;
    };
    spot([-9, 12, 7], [-3.5, 0, -3], 300, '#ffeedd', 0.5);
    spot([9, 12, 7], [3.5, 0, -3], 300, '#fff0e2', 0.5);
    spot([0, 13, 3], [0, 0, -7.5], 300, '#fff4ea', 0.6);
    // back / top light from behind the orchestra: rims hair and shoulders as seen from the hall
    spot([-4, 11, -15], [-2, 1.2, -6], 150, '#ffe6c8', 0.5);
    spot([4, 11, -15], [2, 1.2, -6], 150, '#ffe6c8', 0.5);
    return g;
  }, []);
  return (
    <>
      <hemisphereLight args={['#fff1e4', '#1a120c', 0.2]} />
      <ambientLight intensity={0.06} />
      {/* key light from above the audience */}
      <directionalLight
        position={[4, 14, 12]}
        intensity={1.25}
        color="#fff0e0"
        castShadow
        shadow-mapSize={[Q.shadow, Q.shadow]}
        shadow-radius={4}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={14}
        shadow-camera-bottom={-10}
        shadow-camera-near={2}
        shadow-camera-far={45}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <primitive object={group} />
      {/* back wall glow */}
      <pointLight position={[0, 6, -11]} intensity={30} distance={20} color="#ffc08a" />
    </>
  );
}

function Stage() {
  const stage = useMemo(() => buildStage(), []);
  return <primitive object={stage} />;
}

/** Drives every performer from the transport clock. */
function Runner() {
  const camera = useThree((s) => s.camera);
  useFrame((state) => {
    const t = transport.visualTime();
    const { selectedId } = useApp.getState();
    orchestra.update(t, state.clock.elapsedTime, transport.playing, camera, selectedId);
  });
  return null;
}

/** Floor rings under the hovered / selected musician. */
function Rings() {
  const group = useMemo(() => {
    const g = new Group();
    const mk = (color: string, opacity: number) => {
      const m = new Mesh(new RingGeometry(0.42, 0.5, 48), new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 2;
      return m;
    };
    g.add(mk('#f3c46b', 0.95), mk('#ffffff', 0.35));
    return g;
  }, []);
  useFrame((state) => {
    const { selectedId, hoveredId } = useApp.getState();
    const [sel, hov] = group.children as Mesh[];
    for (const [ring, id] of [
      [sel, selectedId],
      [hov, hoveredId !== selectedId ? hoveredId : null],
    ] as const) {
      const actor = orchestra.actorById(id);
      ring.visible = !!actor;
      if (actor) {
        ring.position.set(actor.root.position.x, actor.root.position.y + 0.012, actor.root.position.z);
        const pulse = 1 + Math.sin(state.clock.elapsedTime * 3) * 0.04;
        ring.scale.setScalar(ring === sel ? pulse : 1);
      }
    }
  });
  return <primitive object={group} />;
}

const PRESETS: Record<CameraPreset, { pos: [number, number, number]; target: [number, number, number] | SectionId[] }> = {
  audience: { pos: [0, 4.2, 14], target: [0, 0.9, -4.6] },
  balcony: { pos: [0, 13, 24], target: [0, 0.4, -4.5] },
  overhead: { pos: [0, 23, -3.5], target: [0, 0, -4.8] },
  conductor: { pos: [0.45, 2.35, 1.5], target: [0, 1.05, -6] },
  strings: { pos: [0.4, 3.2, 3.2], target: ['violin1', 'violin2', 'viola', 'cello'] },
  woodwinds: { pos: [0, 3.4, -1.6], target: ['flute', 'oboe', 'clarinet', 'bassoon'] },
  brass: { pos: [4.2, 4.2, -2.2], target: ['horn', 'trumpet', 'trombone', 'tuba'] },
  percussion: { pos: [-3.6, 4.3, -4.2], target: ['timpani', 'percussion'] },
};

/** Imperative camera handle for tests / debugging. */
export const cameraHandle: { controls: CameraControls | null } = { controls: null };

function CameraRig() {
  const ref = useRef<CameraControls>(null);
  const lastSelected = useRef<string | null>(null);
  const tmp = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    cameraHandle.controls = c;
    c.minDistance = 0.4;
    c.maxDistance = 60;
    c.maxPolarAngle = Math.PI * 0.49;
    c.smoothTime = 0.35;
    c.dollyToCursor = true;
    void c.setLookAt(0, 4.2, 14, 0, 0.9, -4.6, false);
    return useApp.subscribe((s, prev) => {
      if (s.cameraPreset && s.cameraPreset !== prev.cameraPreset) {
        const p = PRESETS[s.cameraPreset.name];
        let target: Vector3;
        if (Array.isArray(p.target) && typeof p.target[0] === 'string') {
          const pts = (p.target as SectionId[]).map((sec) => orchestra.sectionCentroid(sec)).filter(Boolean) as Vector3[];
          target = pts.length ? pts.reduce((a, b) => a.add(b), new Vector3()).divideScalar(pts.length).setY(1.2) : new Vector3(0, 1.2, -4);
        } else target = new Vector3(...(p.target as [number, number, number]));
        void c.setLookAt(...p.pos, target.x, target.y, target.z, true);
      }
    });
  }, []);

  useFrame(() => {
    const c = ref.current;
    if (!c) return;
    const { selectedId, follow } = useApp.getState();
    const actor = orchestra.actorById(selectedId);
    if (selectedId !== lastSelected.current) {
      lastSelected.current = selectedId;
      if (actor) {
        // fly to a three-quarter close-up in front of the musician
        const head = actor.headWorld(new Vector3());
        const yaw = actor.root.rotation.y;
        const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
        const side = new Vector3(fwd.z, 0, -fwd.x);
        const focus = head.clone().add(new Vector3(0, -0.28, 0));
        const cam = focus.clone().addScaledVector(fwd, 1.55).addScaledVector(side, 1.25).add(new Vector3(0, 0.8, 0));
        void c.setLookAt(cam.x, cam.y, cam.z, focus.x, focus.y, focus.z, true);
      }
      return;
    }
    if (actor && follow && !c.active) {
      // keep the musician framed while the user orbits / zooms
      const focus = actor.headWorld(tmp).add(new Vector3(0, -0.28, 0));
      const current = c.getTarget(new Vector3());
      if (current.distanceTo(focus) > 0.01) void c.moveTo(focus.x, focus.y, focus.z, true);
    }
  });

  return <CameraControls ref={ref} makeDefault />;
}

function Picking() {
  const { gl, camera } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const ndc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1] as const;
    };
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const [x, y] = ndc(e);
        const hit = orchestra.pick(x, y, camera);
        const id = hit ? (hit.musician?.id ?? 'conductor') : null;
        if (useApp.getState().hoveredId !== id) useApp.getState().set({ hoveredId: id });
        el.style.cursor = hit ? 'pointer' : '';
      });
    };
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const [x, y] = ndc(e);
      const hit = orchestra.pick(x, y, camera);
      if (hit) useApp.getState().select(hit.musician?.id ?? 'conductor');
    };
    const onLeave = () => useApp.getState().set({ hoveredId: null });
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [gl, camera]);
  return null;
}

export function sectionColor(s: SectionId) {
  return SECTIONS[s].color;
}
