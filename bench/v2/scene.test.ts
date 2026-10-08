import { expect, it } from 'vitest';
import { MAX_SHAPES, ShapeList } from '../../engine/kerf2/shapes';
import { BUSY, buildLobby } from './scene';

it('is deterministic per frame', () => {
  const a = new ShapeList();
  const b = new ShapeList();
  buildLobby(a, 17);
  buildLobby(b, 17);
  expect(new Uint8Array(a.data, 0, a.count * 64)).toEqual(new Uint8Array(b.data, 0, b.count * 64));
});

it('busy lobby has floor + 4 walls + blobs + sparks, under the cap', () => {
  const s = new ShapeList();
  buildLobby(s, 0, BUSY);
  expect(s.count).toBe(1 + 4 + BUSY.blobs + BUSY.sparks);
  expect(s.count).toBeLessThanOrEqual(MAX_SHAPES);
});
