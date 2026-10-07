import { expect, it } from 'vitest';
import { percentile } from './stats';

it('nearest-rank percentile on unsorted input', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1
  expect(percentile(xs, 50)).toBe(51);
  expect(percentile(xs, 99)).toBe(100);
  expect(percentile([7], 99)).toBe(7);
});
