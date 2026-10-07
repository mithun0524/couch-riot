// ponytail: fixed 2048-shape cap keeps the per-tile list in workgroup memory; raise via multi-pass lists if a game needs more.
export const MAX_PRIMS = 2048;
export const PRIM_BYTES = 32;
export const Kind = { None: 0, Circle: 1, Capsule: 2, Box: 3 } as const;

export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export class PrimList {
  readonly data = new ArrayBuffer(MAX_PRIMS * PRIM_BYTES);
  private f = new Float32Array(this.data);
  private u = new Uint32Array(this.data);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  circle(x: number, y: number, r: number, color: number, glow = 0): void {
    this.push(Kind.Circle, x, y, 0, 0, r, color, glow);
  }

  capsule(ax: number, ay: number, bx: number, by: number, r: number, color: number, glow = 0): void {
    this.push(Kind.Capsule, ax, ay, bx, by, r, color, glow);
  }

  box(cx: number, cy: number, halfW: number, halfH: number, corner: number, color: number, glow = 0): void {
    this.push(Kind.Box, cx, cy, halfW, halfH, corner, color, glow);
  }

  private push(kind: number, ax: number, ay: number, bx: number, by: number, r: number, color: number, glow: number): void {
    if (this.count >= MAX_PRIMS) throw new Error(`Kerf: shape limit ${MAX_PRIMS} exceeded`);
    // Non-finite values make GPU tile bounds implementation-defined (differs across Metal/D3D/Vulkan).
    if (!Number.isFinite(ax + ay + bx + by + r + glow)) throw new Error('Kerf: shape values must be finite');
    const o = this.count++ * 8;
    this.f[o] = ax;
    this.f[o + 1] = ay;
    this.f[o + 2] = bx;
    this.f[o + 3] = by;
    this.f[o + 4] = r;
    this.u[o + 5] = kind;
    this.u[o + 6] = color;
    this.f[o + 7] = glow;
  }
}
