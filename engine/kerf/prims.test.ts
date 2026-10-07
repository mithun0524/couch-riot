import { describe, expect, it } from 'vitest';
import { Kind, MAX_PRIMS, PRIM_BYTES, PrimList, rgba } from './prims';

describe('rgba', () => {
  it('packs r into the lowest byte', () => {
    expect(rgba(0x11, 0x22, 0x33, 0x44)).toBe(0x44332211);
    expect(rgba(255, 255, 255)).toBe(0xffffffff);
  });
});

describe('PrimList', () => {
  it('writes the WGSL Prim layout', () => {
    const p = new PrimList();
    p.capsule(1, 2, 3, 4, 5, rgba(9, 8, 7), 6);
    const f = new Float32Array(p.data, 0, 8);
    const u = new Uint32Array(p.data, 0, 8);
    expect([f[0], f[1], f[2], f[3], f[4]]).toEqual([1, 2, 3, 4, 5]);
    expect(u[5]).toBe(Kind.Capsule);
    expect(u[6]).toBe(rgba(9, 8, 7));
    expect(f[7]).toBe(6);
    expect(p.count).toBe(1);
    expect(PRIM_BYTES).toBe(32);
  });

  it('box stores center, half size and corner', () => {
    const p = new PrimList();
    p.box(10, 20, 30, 40, 5, 0);
    const f = new Float32Array(p.data, 0, 8);
    expect([f[0], f[1], f[2], f[3], f[4]]).toEqual([10, 20, 30, 40, 5]);
    expect(new Uint32Array(p.data, 0, 8)[5]).toBe(Kind.Box);
  });

  it('clear resets count', () => {
    const p = new PrimList();
    p.circle(0, 0, 1, 0);
    p.clear();
    expect(p.count).toBe(0);
  });

  it('throws a clear error past MAX_PRIMS', () => {
    const p = new PrimList();
    for (let i = 0; i < MAX_PRIMS; i++) p.circle(0, 0, 1, 0);
    expect(() => p.circle(0, 0, 1, 0)).toThrow(`Kerf: shape limit ${MAX_PRIMS} exceeded`);
  });

  it('rejects non-finite values', () => {
    const p = new PrimList();
    expect(() => p.circle(NaN, 0, 1, 0)).toThrow('Kerf: shape values must be finite');
    expect(() => p.capsule(0, 0, Infinity, 0, 1, 0)).toThrow('Kerf: shape values must be finite');
    expect(() => p.box(0, 0, 1, 1, 0, 0, NaN)).toThrow('Kerf: shape values must be finite');
    expect(p.count).toBe(0);
  });
});
