import { expect, it } from 'vitest';
import { f16, hdrPixel } from './half';

it('decodes float16 bit patterns', () => {
  expect(f16(0x3c00)).toBe(1);
  expect(f16(0xc000)).toBe(-2);
  expect(f16(0x0000)).toBe(0);
  expect(f16(0x3555)).toBeCloseTo(0.333, 3);
  expect(f16(0x7bff)).toBe(65504);
  expect(f16(0x0001)).toBeCloseTo(5.96e-8, 10);
  expect(f16(0x7c00)).toBe(Infinity);
});

it('reads an rgba16float pixel from tightly packed bytes', () => {
  const b = new Uint8Array(2 * 1 * 8);
  new Uint16Array(b.buffer).set([0x3c00, 0x4000, 0x0000, 0x3c00, 0x3800, 0x3800, 0x3800, 0x3c00]);
  expect(hdrPixel(b, 2, 0, 0)).toEqual([1, 2, 0, 1]);
  expect(hdrPixel(b, 2, 1, 0)).toEqual([0.5, 0.5, 0.5, 1]);
});
