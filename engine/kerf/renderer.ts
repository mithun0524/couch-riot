import blitSrc from './blit.wgsl?raw';
import kerfSrc from './kerf.wgsl?raw';
import { MAX_PRIMS, PRIM_BYTES, type PrimList } from './prims';

export const TILE = 16;
const MASK_WORDS = MAX_PRIMS / 32;

export interface Camera { x: number; y: number; scale: number }

export class Renderer {
  readonly tilesX: number;
  readonly tilesY: number;
  readonly output: GPUTexture;
  private params = new ArrayBuffer(48);
  private paramsBuf: GPUBuffer;
  private primBuf: GPUBuffer;
  private prevBuf: GPUBuffer;
  private maskBuf: GPUBuffer;
  private dirtyBuf: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private clearPipe: GPUComputePipeline;
  private binPipe: GPUComputePipeline;
  private shadePipe: GPUComputePipeline;
  private blitPipe: GPURenderPipeline;
  private blitGroup: GPUBindGroup;
  private prevCount = 0;
  private lastCam: Camera | null = null;

  constructor(readonly device: GPUDevice, readonly width: number, readonly height: number, readonly brute = false) {
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    const tiles = this.tilesX * this.tilesY;
    const B = GPUBufferUsage;

    this.paramsBuf = device.createBuffer({ size: 48, usage: B.UNIFORM | B.COPY_DST });
    this.primBuf = device.createBuffer({ size: MAX_PRIMS * PRIM_BYTES, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
    this.prevBuf = device.createBuffer({ size: MAX_PRIMS * PRIM_BYTES, usage: B.STORAGE | B.COPY_DST });
    this.maskBuf = device.createBuffer({ size: tiles * MASK_WORDS * 4, usage: B.STORAGE });
    this.dirtyBuf = device.createBuffer({ size: Math.ceil(tiles / 32) * 4, usage: B.STORAGE });
    this.output = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
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
        { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.primBuf } },
        { binding: 2, resource: { buffer: this.prevBuf } },
        { binding: 3, resource: { buffer: this.maskBuf } },
        { binding: 4, resource: { buffer: this.dirtyBuf } },
        { binding: 5, resource: this.output.createView() },
      ],
    });
    const module = device.createShaderModule({ code: kerfSrc });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const compute = (entryPoint: string) =>
      device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    this.clearPipe = compute('clear');
    this.binPipe = compute('bin');
    this.shadePipe = compute('shade');

    const blit = device.createShaderModule({ code: blitSrc });
    this.blitPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blit, entryPoint: 'vs' },
      fragment: { module: blit, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
    });
    this.blitGroup = device.createBindGroup({
      layout: this.blitPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.output.createView() }],
    });
  }

  frame(prims: PrimList, cam: Camera): void {
    const last = this.lastCam;
    const camChanged = !last || last.x !== cam.x || last.y !== cam.y || last.scale !== cam.scale;
    this.lastCam = { ...cam };
    const forceAll = this.brute || camChanged;

    const f = new Float32Array(this.params);
    const u = new Uint32Array(this.params);
    f[0] = cam.x;
    f[1] = cam.y;
    f[2] = cam.scale;
    u[3] = prims.count;
    u[4] = this.prevCount;
    u[5] = this.tilesX;
    u[6] = this.tilesY;
    u[7] = forceAll ? 1 : 0;
    u[8] = this.brute ? 1 : 0;
    u[9] = this.width;
    u[10] = this.height;

    const q = this.device.queue;
    q.writeBuffer(this.paramsBuf, 0, this.params);
    if (prims.count) q.writeBuffer(this.primBuf, 0, prims.data, 0, prims.count * PRIM_BYTES);

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.clearPipe);
    pass.dispatchWorkgroups(Math.ceil((this.tilesX * this.tilesY * MASK_WORDS) / 256));
    const binN = Math.max(prims.count, this.prevCount);
    if (binN) {
      pass.setPipeline(this.binPipe);
      pass.dispatchWorkgroups(Math.ceil(binN / 64));
    }
    pass.setPipeline(this.shadePipe);
    pass.dispatchWorkgroups(this.tilesX, this.tilesY);
    pass.end();
    if (prims.count) enc.copyBufferToBuffer(this.primBuf, 0, this.prevBuf, 0, prims.count * PRIM_BYTES);
    q.submit([enc.finish()]);
    this.prevCount = prims.count;
  }

  async readback(): Promise<Uint8Array> {
    const row = this.width * 4;
    const stride = Math.ceil(row / 256) * 256;
    const buf = this.device.createBuffer({ size: stride * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.output }, { buffer: buf, bytesPerRow: stride }, [this.width, this.height]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(row * this.height);
    for (let y = 0; y < this.height; y++) out.set(src.subarray(y * stride, y * stride + row), y * row);
    buf.unmap();
    buf.destroy();
    return out;
  }

  present(ctx: GPUCanvasContext): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.blitPipe);
    pass.setBindGroup(0, this.blitGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    for (const b of [this.paramsBuf, this.primBuf, this.prevBuf, this.maskBuf, this.dirtyBuf]) b.destroy();
    this.output.destroy();
  }
}
