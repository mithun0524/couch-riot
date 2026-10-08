// ponytail: 2048-shape cap keeps a tile's list in workgroup memory (same as v1).
export const MAX_SHAPES = 2048;
export const SHAPE_BYTES = 64;
export const SHAPE_FLOATS = 16;
export const Kind = { None: 0, Sphere: 1, Ellipsoid: 2, Capsule: 3, RoundBox: 4, Cylinder: 5, Plane: 6 } as const;

export type Quat = readonly [number, number, number, number];
export const IDENTITY: Quat = [0, 0, 0, 1];
export interface ShapeOpts { material?: number; group?: number; emission?: number }

export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export class ShapeList {
  readonly data = new ArrayBuffer(MAX_SHAPES * SHAPE_BYTES);
  private f = new Float32Array(this.data);
  private u = new Uint32Array(this.data);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  sphere(x: number, y: number, z: number, r: number, color: number, o: ShapeOpts = {}): void {
    this.push(Kind.Sphere, x, y, z, r, 0, 0, 0, IDENTITY, color, o);
  }

  ellipsoid(x: number, y: number, z: number, ax: number, ay: number, az: number, rot: Quat, color: number, o: ShapeOpts = {}): void {
    this.push(Kind.Ellipsoid, x, y, z, ax, ay, az, 0, rot, color, o);
  }

  capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, color: number, o: ShapeOpts = {}): void {
    this.push(Kind.Capsule, ax, ay, az, bx - ax, by - ay, bz - az, r, IDENTITY, color, o);
  }

  roundbox(x: number, y: number, z: number, hx: number, hy: number, hz: number, round: number, rot: Quat, color: number, o: ShapeOpts = {}): void {
    this.push(Kind.RoundBox, x, y, z, hx, hy, hz, round, rot, color, o);
  }

  cylinder(x: number, y: number, z: number, r: number, halfH: number, round: number, rot: Quat, color: number, o: ShapeOpts = {}): void {
    this.push(Kind.Cylinder, x, y, z, r, halfH, 0, round, rot, color, o);
  }

  plane(y: number, color: number, o: ShapeOpts = {}): void {
    this.push(Kind.Plane, 0, y, 0, 0, 0, 0, 0, IDENTITY, color, o);
  }

  private push(kind: number, px: number, py: number, pz: number, sx: number, sy: number, sz: number, round: number, q: Quat, color: number, o: ShapeOpts): void {
    if (this.count >= MAX_SHAPES) throw new Error(`Kerf: shape limit ${MAX_SHAPES} exceeded`);
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    const em = o.emission ?? 0;
    if (!Number.isFinite(px + py + pz + sx + sy + sz + round + ql + em) || ql === 0) {
      throw new Error('Kerf: shape values must be finite');
    }
    const i = this.count++ * SHAPE_FLOATS;
    const f = this.f;
    f[i] = px; f[i + 1] = py; f[i + 2] = pz;
    this.u[i + 3] = kind;
    f[i + 4] = sx; f[i + 5] = sy; f[i + 6] = sz; f[i + 7] = round;
    f[i + 8] = q[0] / ql; f[i + 9] = q[1] / ql; f[i + 10] = q[2] / ql; f[i + 11] = q[3] / ql;
    this.u[i + 12] = color >>> 0;
    this.u[i + 13] = o.material ?? 0;
    this.u[i + 14] = o.group ?? 0;
    f[i + 15] = em;
  }
}
