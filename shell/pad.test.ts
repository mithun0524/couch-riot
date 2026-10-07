import { expect, it } from 'vitest';
import { applyInput, newPad, stickVec } from './pad';
import { encodeButton, encodeStick } from './protocol';

it('applies stick and button bytes', () => {
  const p = newPad();
  applyInput(p, encodeStick(1, 5, 2));
  expect(p.right).toEqual({ dir: 5, mag: 2 });
  expect(p.left).toEqual({ dir: 0, mag: 0 });
  applyInput(p, encodeButton(3, true));
  expect(p.buttons).toBe(8);
  applyInput(p, encodeButton(3, false));
  expect(p.buttons).toBe(0);
});

it('ignores button ids above 31', () => {
  const p = newPad();
  applyInput(p, encodeButton(40, true));
  expect(p.buttons).toBe(0);
});

it('stickVec: dir 0 is right, dir 4 is up (screen y down), mag scales', () => {
  const r = stickVec({ dir: 0, mag: 3 });
  expect(r.x).toBeCloseTo(1);
  expect(r.y).toBeCloseTo(0);
  const u = stickVec({ dir: 4, mag: 3 });
  expect(u.x).toBeCloseTo(0);
  expect(u.y).toBeCloseTo(-1);
  expect(stickVec({ dir: 8, mag: 1 }).x).toBeCloseTo(-1 / 3);
  expect(stickVec({ dir: 7, mag: 0 })).toEqual({ x: 0, y: 0 });
});
