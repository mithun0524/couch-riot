import { afterAll, beforeAll, expect, it } from 'vitest';
import { CALM, WORLD, buildScene, type SceneOpts } from '../../bench/scene';
import { getDevice } from './gpu';
import { PrimList, rgba } from './prims';
import { Renderer, type Camera } from './renderer';

let device: GPUDevice;
beforeAll(async () => { device = await getDevice(); });
afterAll(() => device.destroy());

const W = 640, H = 360;
const sceneCam: Camera = { x: 0, y: 0, scale: H / WORLD.h };

function diffCount(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

// Drives fast + brute renderers with the same frames; any byte difference fails.
async function expectEquivalent(frames: Array<{ fill: (p: PrimList) => void; cam: Camera }>) {
  const fast = new Renderer(device, W, H, false);
  const ref = new Renderer(device, W, H, true);
  const p = new PrimList();
  try {
    for (let f = 0; f < frames.length; f++) {
      frames[f].fill(p);
      fast.frame(p, frames[f].cam);
      ref.frame(p, frames[f].cam);
      const [a, b] = await Promise.all([fast.readback(), ref.readback()]);
      const d = diffCount(a, b);
      if (d) throw new Error(`frame ${f}: ${d} bytes differ`);
    }
  } finally {
    fast.destroy();
    ref.destroy();
  }
}

const sceneFrames = (o: SceneOpts, n: number) =>
  Array.from({ length: n }, (_, f) => ({ fill: (p: PrimList) => buildScene(p, f, o), cam: sceneCam }));

it('busy scene: fast == brute for 60 frames', async () => {
  await expectEquivalent(sceneFrames({ players: 8, bullets: 120, particles: 200 }, 60));
});

it('calm scene (mostly clean tiles): fast == brute for 60 frames', async () => {
  await expectEquivalent(sceneFrames(CALM, 60));
});

it('removed shapes leave no ghost', async () => {
  const cam = { x: 0, y: 0, scale: 1 };
  await expectEquivalent([
    { fill: (p) => { p.clear(); p.circle(100, 100, 20, rgba(255, 0, 0), 30); p.circle(300, 200, 10, rgba(0, 255, 0), 15); }, cam },
    { fill: (p) => { p.clear(); p.circle(300, 200, 10, rgba(0, 255, 0), 15); }, cam }, // count shrinks, index shifts
    { fill: (p) => { p.clear(); }, cam },                                            // count 0
  ]);
});

it('glow crossing tile corners and screen edges is not clipped', async () => {
  const cam = { x: 0, y: 0, scale: 1 };
  const frames = Array.from({ length: 12 }, (_, f) => ({
    fill: (p: PrimList) => {
      p.clear();
      p.circle(16 + f * 0.3, 16 + f * 0.3, 3, rgba(255, 255, 0), 20); // straddles tile corner
      p.circle(-5 + f * 0.7, 200, 8, rgba(0, 200, 255), 25);           // half off the left edge
      p.capsule(W - 4, 10, W + 30, 50 + f, 4, rgba(255, 0, 255), 18);  // mostly off the right edge
    },
    cam,
  }));
  await expectEquivalent(frames);
});

it('camera change redraws everything', async () => {
  const fill = (p: PrimList) => buildScene(p, 0, CALM);
  await expectEquivalent([
    { fill, cam: sceneCam },
    { fill, cam: { x: 37, y: -12, scale: sceneCam.scale } },
    { fill, cam: { x: 37, y: -12, scale: sceneCam.scale * 1.5 } },
  ]);
});
