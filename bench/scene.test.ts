import { expect, it } from 'vitest';
import { MAX_PRIMS, PrimList } from '../engine/kerf/prims';
import { WORST, buildScene } from './scene';

it('is deterministic for a given frame', () => {
  const a = new PrimList();
  const b = new PrimList();
  buildScene(a, 42);
  buildScene(b, 42);
  expect(a.count).toBe(b.count);
  expect(new Uint8Array(a.data)).toEqual(new Uint8Array(b.data));
});

it('worst case fits under MAX_PRIMS', () => {
  const p = new PrimList();
  buildScene(p, 0, WORST);
  expect(p.count).toBe(4 + 12 + WORST.players + WORST.bullets + WORST.particles);
  expect(p.count).toBeLessThanOrEqual(MAX_PRIMS);
});
