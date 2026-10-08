import { expect, it } from 'vitest';
import { SPAWNS, PICKUP_SPOTS, WALLS } from './arena';
import { overlaps, pushOut } from './physics';

const box = { x: 100, y: 100, hw: 50, hh: 20 };

it('overlaps uses the closest point on the rect', () => {
  expect(overlaps(160, 100, 11, box)).toBe(true);
  expect(overlaps(162, 100, 11, box)).toBe(false);
});

it('pushes a circle out through the side it hit', () => {
  const p = { x: 155, y: 100 };
  expect(pushOut(p, 10, box)).toEqual([1, 0]);
  expect(p.x).toBeCloseTo(160);
});

it('pushes a centre that is inside out along the shallowest axis', () => {
  const p = { x: 140, y: 115 };
  expect(pushOut(p, 10, box)).toEqual([0, 1]);
  expect(p.y).toBe(130);
});

it('leaves a clear circle alone', () => {
  const p = { x: 300, y: 300 };
  expect(pushOut(p, 10, box)).toBeNull();
  expect(p).toEqual({ x: 300, y: 300 });
});

it('spawns and pickup spots are clear of every wall', () => {
  for (const s of [...SPAWNS, ...PICKUP_SPOTS]) for (const w of WALLS) expect(overlaps(s.x, s.y, 30, w)).toBe(false);
  expect(SPAWNS).toHaveLength(8);
});
