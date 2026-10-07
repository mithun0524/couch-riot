import { expect, it } from 'vitest';
import { rgba } from '../engine/kerf/prims';
import { colorRgba } from './game';

it('colorRgba matches the palette', () => {
  expect(colorRgba(0)).toBe(rgba(0xff, 0x3c, 0x5a));
  expect(colorRgba(7)).toBe(rgba(255, 255, 255));
});
