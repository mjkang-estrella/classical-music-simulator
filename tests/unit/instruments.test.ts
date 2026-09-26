import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box3, Mesh, Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createInstrument } from '../../src/assets/instrumentFactory';
import type { InstrumentModel } from '../../src/assets/instruments/types';
import type { InstrumentKind } from '../../src/orchestra/sections';

const KINDS: InstrumentKind[] = ['violin', 'viola', 'cello', 'bass', 'flute', 'piccolo', 'oboe', 'clarinet', 'bassoon', 'horn', 'trumpet', 'trombone', 'tuba', 'timpani', 'bassdrum', 'cymbals', 'suspended', 'snare', 'triangle', 'harp'];

function anchorsOf(obj: Object3D | undefined) {
  const out: Record<string, number[]> = {};
  obj?.updateMatrixWorld(true);
  obj?.traverse((o) => {
    if (o.name.startsWith('anchor_')) {
      // position relative to `obj`
      const p = o.getWorldPosition(new Vector3()).applyMatrix4(obj.matrixWorld.clone().invert());
      out[o.name] = p.toArray().map((n) => +n.toFixed(5));
    }
  });
  return out;
}

function bounds(obj: Object3D) {
  const b = new Box3().setFromObject(obj);
  return { min: b.min.toArray().map((n) => +n.toFixed(4)), max: b.max.toArray().map((n) => +n.toFixed(4)) };
}

describe('procedural instruments (tier 1)', () => {
  const models = new Map<InstrumentKind, InstrumentModel>();
  for (const k of KINDS) models.set(k, createInstrument(k, 'test'));

  it('every instrument builds with meshes and resolvable grips', () => {
    for (const [kind, m] of models) {
      let meshes = 0;
      for (const obj of [m.root, m.bow, ...Object.values(m.held ?? {})]) obj?.traverse((o) => ((o as Mesh).isMesh ? meshes++ : 0));
      expect(meshes, kind).toBeGreaterThan(0);
      for (const g of Object.values(m.grips)) if (g) expect(g.anchor.name, kind).toMatch(/^anchor_/);
    }
  });

  it('bowed strings expose four string contact points, a nut and a bow', () => {
    for (const k of ['violin', 'viola', 'cello', 'bass'] as const) {
      const m = models.get(k)!;
      for (let i = 0; i < 4; i++) expect(m.anchors[`string_${i}`], `${k} string_${i}`).toBeDefined();
      expect(m.anchors.nut).toBeDefined();
      expect(m.bow).toBeDefined();
      expect(m.bowed!.nutZ).toBeGreaterThan(m.bowed!.bridgeZ);
    }
  });

  it('winds and brass have a mouthpiece anchor at the origin', () => {
    for (const k of ['flute', 'oboe', 'clarinet', 'bassoon', 'trumpet', 'horn', 'trombone', 'tuba'] as const) {
      const a = models.get(k)!.anchors.mouthpiece;
      expect(a, k).toBeDefined();
      expect(a.position.length(), k).toBeLessThan(0.01);
    }
  });

  it('writes the anchor contract for the Blender pipeline (DUMP_ANCHORS=1)', () => {
    if (!process.env.DUMP_ANCHORS) return;
    const contract: Record<string, unknown> = {};
    for (const [kind, m] of models) {
      contract[kind] = {
        root: { anchors: anchorsOf(m.root), bounds: bounds(m.root) },
        bow: m.bow ? { anchors: anchorsOf(m.bow), bounds: bounds(m.bow) } : undefined,
        slide: m.slide ? { anchors: anchorsOf(m.slide), bounds: bounds(m.slide), restPosition: m.slide.position.toArray() } : undefined,
        held: m.held ? Object.fromEntries(Object.entries(m.held).map(([s, h]) => [s, { anchors: anchorsOf(h!), bounds: bounds(h!) }])) : undefined,
        bowed: m.bowed,
        grips: Object.fromEntries(Object.entries(m.grips).filter(([, g]) => g).map(([s, g]) => [s, { anchor: g!.anchor.name, dir: g!.dir.toArray(), palm: g!.palm.toArray(), curl: g!.curl }])),
      };
    }
    const dir = join(__dirname, '..', '..', 'tools', 'blender', 'instruments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'anchor_contract.json'), JSON.stringify(contract, null, 1));
  });
});
