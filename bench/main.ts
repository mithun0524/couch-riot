import { getDevice } from '../engine/kerf/gpu';
import { PrimList } from '../engine/kerf/prims';
import { Renderer } from '../engine/kerf/renderer';
import { CALM, WORLD, WORST, buildScene, type SceneOpts } from './scene';
import { percentile } from './stats';

const BUDGET_MS = 16.6;
const WARMUP = 120;
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 1920);
const H = Number(q.get('h') ?? 1080);
const out = document.getElementById('out')!;

interface Row { scene: string; mode: string; p50: number; p99: number }

// Per-frame time = build scene + encode + GPU done. Awaiting the GPU each frame
// makes this conservative: it measures real work, not pipelined throughput.
async function run(device: GPUDevice, ctx: GPUCanvasContext, brute: boolean, opts: SceneOpts, frames: number) {
  const r = new Renderer(device, W, H, brute);
  const prims = new PrimList();
  const cam = { x: 0, y: 0, scale: H / WORLD.h };
  const times: number[] = [];
  for (let f = 0; f < frames + WARMUP; f++) {
    const t0 = performance.now();
    buildScene(prims, f, opts);
    r.frame(prims, cam);
    r.present(ctx);
    await device.queue.onSubmittedWorkDone();
    if (f >= WARMUP) times.push(performance.now() - t0);
  }
  r.destroy();
  return { p50: percentile(times, 50), p99: percentile(times, 99) };
}

async function main() {
  const canvas = document.querySelector('canvas')!;
  canvas.width = W;
  canvas.height = H;
  let device: GPUDevice;
  try {
    device = await getDevice();
  } catch (e) {
    out.textContent = (e as Error).message;
    return;
  }
  const ctx = canvas.getContext('webgpu')!;
  ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });

  const rows: Row[] = [];
  for (const [scene, opts] of [['worst', WORST], ['calm', CALM]] as const) {
    rows.push({ scene, mode: 'kerf', ...(await run(device, ctx, false, opts, 2000)) });
    rows.push({ scene, mode: 'brute', ...(await run(device, ctx, true, opts, 30)) });
  }
  const pass = rows.filter((r) => r.mode === 'kerf').every((r) => r.p99 <= BUDGET_MS);
  out.textContent =
    `${W}x${H}\n` +
    rows.map((r) => `${r.scene.padEnd(6)} ${r.mode.padEnd(6)} p50 ${r.p50.toFixed(2)}ms  p99 ${r.p99.toFixed(2)}ms`).join('\n') +
    `\n${pass ? 'PASS' : 'FAIL'} (kerf p99 ≤ ${BUDGET_MS}ms)`;
  (window as unknown as { __bench: unknown }).__bench = { width: W, height: H, rows, pass };
}

main();
