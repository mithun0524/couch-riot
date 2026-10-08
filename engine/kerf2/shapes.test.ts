import { describe, expect, it } from 'vitest';
import { IDENTITY, Kind, MAX_SHAPES, SHAPE_BYTES, ShapeList, rgba } from './shapes';

const rec = (s: ShapeList, i = 0) => ({ f: new Float32Array(s.data, i * SHAPE_BYTES, 16), u: new Uint32Array(s.data, i * SHAPE_BYTES, 16) });

describe('ShapeList', () => {
  it('writes the 64-byte WGSL layout', () => {
    const s = new ShapeList();
    s.roundbox(1, 2, 3, 4, 5, 6, 0.5, [0, 0, 0, 2], rgba(9, 8, 7), { material: 3, group: 2, emission: 1.5 });
    const { f, u } = rec(s);
    expect([f[0], f[1], f[2]]).toEqual([1, 2, 3]);
    expect(u[3]).toBe(Kind.RoundBox);
    expect([f[4], f[5], f[6], f[7]]).toEqual([4, 5, 6, 0.5]);
    expect([f[8], f[9], f[10], f[11]]).toEqual([0, 0, 0, 1]); // normalized
    expect([u[12], u[13], u[14]]).toEqual([rgba(9, 8, 7), 3, 2]);
    expect(f[15]).toBe(1.5);
    expect(SHAPE_BYTES).toBe(64);
  });

  it('capsule stores a and b - a', () => {
    const s = new ShapeList();
    s.capsule(1, 1, 1, 4, 5, 1, 2, 0);
    const { f, u } = rec(s);
    expect(u[3]).toBe(Kind.Capsule);
    expect([f[0], f[1], f[2], f[4], f[5], f[6], f[7]]).toEqual([1, 1, 1, 3, 4, 0, 2]);
  });

  it('plane stores its height; sphere has identity rotation and default opts', () => {
    const s = new ShapeList();
    s.plane(-2, 0);
    s.sphere(0, 0, 0, 5, 0);
    expect(rec(s, 0).u[3]).toBe(Kind.Plane);
    expect(rec(s, 0).f[1]).toBe(-2);
    const { f, u } = rec(s, 1);
    expect([f[8], f[9], f[10], f[11]]).toEqual([...IDENTITY]);
    expect([u[13], u[14], f[15]]).toEqual([0, 0, 0]);
  });

  it('rejects non-finite values and zero quaternions', () => {
    const s = new ShapeList();
    expect(() => s.sphere(NaN, 0, 0, 1, 0)).toThrow('Kerf: shape values must be finite');
    expect(() => s.ellipsoid(0, 0, 0, 1, 1, 1, [0, 0, 0, 0], 0)).toThrow('Kerf: shape values must be finite');
    expect(() => s.sphere(0, 0, 0, 1, 0, { emission: Infinity })).toThrow('Kerf: shape values must be finite');
    expect(s.count).toBe(0);
  });

  it('throws past MAX_SHAPES and clear resets', () => {
    const s = new ShapeList();
    for (let i = 0; i < MAX_SHAPES; i++) s.sphere(0, 0, 0, 1, 0);
    expect(() => s.sphere(0, 0, 0, 1, 0)).toThrow(`Kerf: shape limit ${MAX_SHAPES} exceeded`);
    s.clear();
    expect(s.count).toBe(0);
  });
});
