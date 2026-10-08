import { getDevice } from '../../engine/kerf/gpu';
import { Kerf } from '../../engine/kerf2/kerf';
import { percentile } from '../stats';
import { BUSY, CALM, LOBBY_CAM, buildLobby, type LobbyOpts } from './scene';

const BUDGET_MS = 16.6;
const BATCH = 10; // same throughput method as the head-to-head spike: sync once per batch
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 1920);
const H = Number(q.get('h') ?? 1080);
const out = document.getElementById('out')!;

async function run(device: GPUDevice, ctx: GPUCanvasContext, brute: boolean, opts: LobbyOpts, frames: number) {
  const k = new Kerf(device, W, H, brute);
  k.perspective(LOBBY_CAM.eye, LOBBY_CAM.target, LOBBY_CAM.fov);
  const times: number[] = [];
  const warm = 3 * BATCH;
  for (let f = 0; f < frames + warm; f += BATCH) {
    const t0 = performance.now();
    for (let i = 0; i < BATCH; i++) {
      buildLobby(k.shapes, f + i, opts);
      k.frame();
      k.present(ctx);
    }
    await device.queue.onSubmittedWorkDone();
    if (f >= warm) times.push((performance.now() - t0) / BATCH);
  }
  k.destroy();
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
    (window as unknown as { __bench2: unknown }).__bench2 = { error: (e as Error).message };
    return;
  }
  const ctx = canvas.getContext('webgpu')!;
  ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
  const rows: { scene: string; mode: string; p50: number; p99: number }[] = [];
  for (const [scene, opts] of [['busy', BUSY], ['calm', CALM]] as const) {
    rows.push({ scene, mode: 'kerf2', ...(await run(device, ctx, false, opts, 600)) });
    rows.push({ scene, mode: 'brute', ...(await run(device, ctx, true, opts, 20)) });
  }
  const pass = rows.filter((r) => r.mode === 'kerf2').every((r) => r.p99 <= BUDGET_MS);
  out.textContent = `${W}x${H}\n` + rows.map((r) => `${r.scene.padEnd(5)} ${r.mode.padEnd(6)} p50 ${r.p50.toFixed(2)}ms  p99 ${r.p99.toFixed(2)}ms`).join('\n') + `\n${pass ? 'PASS' : 'FAIL'} (p99 ≤ ${BUDGET_MS}ms)`;
  (window as unknown as { __bench2: unknown }).__bench2 = { width: W, height: H, rows, pass };
}

main();
