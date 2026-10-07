import { expect, it } from 'vitest';
import { quantize } from './stick';

const at = (deg: number, dist = 60) =>
  quantize(Math.cos((deg * Math.PI) / 180) * dist, -Math.sin((deg * Math.PI) / 180) * dist, 60);

it('dead zone is centered', () => {
  expect(quantize(5, 5, 60)).toEqual({ dir: 0, mag: 0 });
});

it('cardinal directions (screen y is down)', () => {
  expect(quantize(60, 0, 60)).toEqual({ dir: 0, mag: 3 });
  expect(quantize(0, -60, 60).dir).toBe(4);
  expect(quantize(-60, 0, 60).dir).toBe(8);
  expect(quantize(0, 60, 60).dir).toBe(12);
});

it('rounds to the nearest 22.5° sector', () => {
  expect(at(11).dir).toBe(0);
  expect(at(12).dir).toBe(1);
  expect(at(349).dir).toBe(0);
  expect(at(337).dir).toBe(15);
});

it('magnitude bands', () => {
  expect(quantize(20, 0, 60).mag).toBe(1);
  expect(quantize(40, 0, 60).mag).toBe(2);
  expect(quantize(200, 0, 60).mag).toBe(3);
});
