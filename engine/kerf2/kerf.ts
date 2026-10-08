import kerfSrc from './kerf2.wgsl?raw';
import presentSrc from './present.wgsl?raw';
import { MAX_SHAPES, SHAPE_BYTES, ShapeList } from './shapes';

export const TILE = 16;
const MASK_WORDS = MAX_SHAPES / 32;
const U_BYTES = 144;

export type Vec3 = readonly [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

interface Cam { eye: Vec3; mode: 0 | 1; right: Vec3; sx: number; up: Vec3; sy: number; fwd: Vec3; near: number }

export class Kerf {
  readonly shapes = new ShapeList();
  exposure = 1;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly hdr: GPUTexture;
  private u = new ArrayBuffer(U_BYTES);
  private uf = new Float32Array(this.u);
  private uu = new Uint32Array(this.u);
  private cam!: Cam;
  private sun = { dir: norm([0.35, 1, -0.45]) as Vec3, angle: 0.04, color: [1, 0.95, 0.88] as Vec3, intensity: 3 };
  private skyEnv = { color: [0.22, 0.27, 0.42] as Vec3, intensity: 0.5 };
  private envDirty = true;
  private prevCount = 0;
  private uBuf: GPUBuffer;
  private shapeBuf: GPUBuffer;
  private prevBuf: GPUBuffer;
  private maskBuf: GPUBuffer;
  private dirtyBuf: GPUBuffer;
  private expBuf: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private clearPipe: GPUComputePipeline;
  private binPipe: GPUComputePipeline;
  private shadePipe: GPUComputePipeline;
  private presentPipe: GPURenderPipeline;
  private presentGroup: GPUBindGroup;

  constructor(readonly device: GPUDevice, readonly width: number, readonly height: number, readonly brute = false) {
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    const tiles = this.tilesX * this.tilesY;
    const B = GPUBufferUsage;
    this.uBuf = device.createBuffer({ size: U_BYTES, usage: B.UNIFORM | B.COPY_DST });
    this.shapeBuf = device.createBuffer({ size: MAX_SHAPES * SHAPE_BYTES, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
    this.prevBuf = device.createBuffer({ size: MAX_SHAPES * SHAPE_BYTES, usage: B.STORAGE | B.COPY_DST });
    this.maskBuf = device.createBuffer({ size: tiles * MASK_WORDS * 4, usage: B.STORAGE });
    this.dirtyBuf = device.createBuffer({ size: Math.ceil(tiles / 32) * 4, usage: B.STORAGE });
    this.expBuf = device.createBuffer({ size: 16, usage: B.UNIFORM | B.COPY_DST });
    this.hdr = device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    const C = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uBuf } },
        { binding: 1, resource: { buffer: this.shapeBuf } },
        { binding: 2, resource: { buffer: this.prevBuf } },
        { binding: 3, resource: { buffer: this.maskBuf } },
        { binding: 4, resource: { buffer: this.dirtyBuf } },
        { binding: 5, resource: this.hdr.createView() },
      ],
    });
    const module = device.createShaderModule({ code: kerfSrc });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const compute = (entryPoint: string) => device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
    this.clearPipe = compute('clear');
    this.binPipe = compute('bin');
    this.shadePipe = compute('shade');

    const pm = device.createShaderModule({ code: presentSrc });
    this.presentPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: pm, entryPoint: 'vs' },
      fragment: { module: pm, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
    });
    this.presentGroup = device.createBindGroup({
      layout: this.presentPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.hdr.createView() }, { binding: 1, resource: { buffer: this.expBuf } }],
    });

    this.perspective([800, 1100, 1650], [800, 0, 430], 40);
  }

  perspective(eye: Vec3, target: Vec3, fovYDeg: number): void {
    const fwd = norm(sub(target, eye));
    const side = cross(fwd, [0, 1, 0]);
    if (Math.hypot(...side) < 1e-6) throw new Error('Kerf: perspective camera cannot look straight up or down; use ortho');
    const right = norm(side);
    const up = cross(right, fwd);
    const sy = Math.tan((fovYDeg * Math.PI) / 360);
    this.cam = { eye, mode: 0, right, sx: (sy * this.width) / this.height, up, sy, fwd, near: 0.1 };
    this.envDirty = true;
  }

  // Straight down; world +z points down the screen so 2D (x, y) maps to (x, 0, y).
  ortho(cx: number, cz: number, viewW: number, height = 4000): void {
    const sx = viewW / 2;
    this.cam = { eye: [cx, height, cz], mode: 1, right: [1, 0, 0], sx, up: [0, 0, -1], sy: (sx * this.height) / this.width, fwd: [0, -1, 0], near: 0 };
    this.envDirty = true;
  }

  setSun(s: { dir: Vec3; angle: number; color: Vec3; intensity: number }): void {
    this.sun = { ...s, dir: norm(s.dir) };
    this.envDirty = true;
  }

  setSky(s: { color: Vec3; intensity: number }): void {
    this.skyEnv = { ...s };
    this.envDirty = true;
  }

  // Mirrors `project` in kerf2.wgsl. Pixel coordinates, or null if behind the camera.
  project(p: Vec3): [number, number] | null {
    const c = this.cam;
    const v = sub(p, c.eye);
    const z = dot(v, c.fwd);
    let nx: number, ny: number;
    if (c.mode === 0) {
      if (z < c.near) return null;
      nx = dot(v, c.right) / (z * c.sx);
      ny = dot(v, c.up) / (z * c.sy);
    } else {
      if (z < 0) return null;
      nx = dot(v, c.right) / c.sx;
      ny = dot(v, c.up) / c.sy;
    }
    return [((nx + 1) / 2) * this.width, ((1 - ny) / 2) * this.height];
  }

  frame(): void {
    const f = this.uf, u = this.uu, c = this.cam, s = this.sun, k = this.skyEnv;
    f.set(c.eye, 0); u[3] = c.mode; f.set(c.right, 4); f[7] = c.sx; f.set(c.up, 8); f[11] = c.sy; f.set(c.fwd, 12); f[15] = c.near;
    f.set(s.dir, 16); f[19] = s.angle; f.set(s.color, 20); f[23] = s.intensity; f.set(k.color, 24); f[27] = k.intensity;
    const count = this.shapes.count;
    u[28] = count; u[29] = this.prevCount; u[30] = this.tilesX; u[31] = this.tilesY;
    u[32] = this.brute || this.envDirty ? 1 : 0; u[33] = this.brute ? 1 : 0; u[34] = this.width; u[35] = this.height;

    const q = this.device.queue;
    q.writeBuffer(this.uBuf, 0, this.u);
    if (count) q.writeBuffer(this.shapeBuf, 0, this.shapes.data, 0, count * SHAPE_BYTES);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.clearPipe);
    pass.dispatchWorkgroups(Math.ceil((this.tilesX * this.tilesY * MASK_WORDS) / 256));
    const binN = Math.max(count, this.prevCount);
    if (binN) {
      pass.setPipeline(this.binPipe);
      pass.dispatchWorkgroups(Math.ceil(binN / 64));
    }
    pass.setPipeline(this.shadePipe);
    pass.dispatchWorkgroups(this.tilesX, this.tilesY);
    pass.end();
    if (count) enc.copyBufferToBuffer(this.shapeBuf, 0, this.prevBuf, 0, count * SHAPE_BYTES);
    q.submit([enc.finish()]);
    this.prevCount = count;
    this.envDirty = false;
  }

  async readback(): Promise<Uint8Array> {
    const row = this.width * 8;
    const stride = Math.ceil(row / 256) * 256;
    const buf = this.device.createBuffer({ size: stride * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: this.hdr }, { buffer: buf, bytesPerRow: stride }, [this.width, this.height]);
      this.device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(buf.getMappedRange());
      const out = new Uint8Array(row * this.height);
      for (let y = 0; y < this.height; y++) out.set(src.subarray(y * stride, y * stride + row), y * row);
      return out;
    } finally {
      buf.destroy();
    }
  }

  present(ctx: GPUCanvasContext): void {
    this.device.queue.writeBuffer(this.expBuf, 0, new Float32Array([this.exposure, 0, 0, 0]));
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.presentPipe);
    pass.setBindGroup(0, this.presentGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    for (const b of [this.uBuf, this.shapeBuf, this.prevBuf, this.maskBuf, this.dirtyBuf, this.expBuf]) b.destroy();
    this.hdr.destroy();
  }
}
