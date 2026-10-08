import { afterAll, beforeAll, expect, it } from 'vitest';
import { getDevice } from '../kerf/gpu';
import { hdrPixel } from './half';
import { Kerf, type Vec3 } from './kerf';
import { rgba } from './shapes';

let device: GPUDevice;
beforeAll(async () => { device = await getDevice(); });
afterAll(() => device.destroy());

const W = 640, H = 384;
const SUN: Vec3 = [0.3, 1, -0.6]; // from behind the sphere, so its shadow falls toward the camera

function stage(k: Kerf) {
  k.perspective([0, 300, 400], [0, 40, 0], 50);
  k.setSun({ dir: SUN, angle: 0.04, color: [1, 1, 1], intensity: 3 });
  k.setSky({ color: [0.4, 0.5, 0.8], intensity: 0.3 });
}

function px(k: Kerf, img: Uint8Array, p: Vec3) {
  const s = k.project(p)!;
  return hdrPixel(img, W, Math.floor(s[0]), Math.floor(s[1]));
}

it('a red sphere on a gray floor: centre pixel is red and lit by the sun', async () => {
  const centre = async (sun: number) => {
    const k = new Kerf(device, W, H);
    stage(k);
    k.setSun({ dir: SUN, angle: 0.04, color: [1, 1, 1], intensity: sun });
    k.shapes.plane(0, rgba(128, 128, 128));
    k.shapes.sphere(0, 40, 0, 40, rgba(255, 0, 0));
    k.frame();
    const c = hdrPixel(await k.readback(), W, W / 2, H / 2);
    k.destroy();
    return c;
  };
  const lit = await centre(3);
  const skyOnly = await centre(0);
  expect(lit[0]).toBeGreaterThan(skyOnly[0] * 1.3); // the sun adds light (centre faces the camera, near the terminator)
  expect(lit[1]).toBeLessThan(lit[0] * 0.05);
});

it('the sphere shadows the floor on the far side from the sun', async () => {
  const L = Math.hypot(...SUN);
  const dir: Vec3 = [SUN[0] / L, SUN[1] / L, SUN[2] / L];
  const shadowAt: Vec3 = [-dir[0] * (40 / dir[1]), 0, -dir[2] * (40 / dir[1])];
  const bare = new Kerf(device, W, H);
  stage(bare);
  bare.shapes.plane(0, rgba(128, 128, 128));
  bare.frame();
  const lit = px(bare, await bare.readback(), shadowAt);
  const k = new Kerf(device, W, H);
  stage(k);
  k.shapes.plane(0, rgba(128, 128, 128));
  k.shapes.sphere(0, 40, 0, 40, rgba(255, 255, 255));
  k.frame();
  const dark = px(k, await k.readback(), shadowAt);
  expect(dark[1]).toBeLessThan(lit[1] * 0.5);
  bare.destroy();
  k.destroy();
});

it('emission glows in a dark world', async () => {
  const k = new Kerf(device, W, H);
  stage(k);
  k.setSun({ dir: SUN, angle: 0.04, color: [1, 1, 1], intensity: 0 });
  k.setSky({ color: [1, 1, 1], intensity: 0 });
  k.shapes.sphere(0, 40, 0, 40, rgba(0, 255, 0), { emission: 2 });
  k.frame();
  const c = hdrPixel(await k.readback(), W, W / 2, H / 2);
  expect(c[1]).toBeGreaterThan(1.5);
  expect(c[0]).toBe(0);
  k.destroy();
});

it('fast and brute agree on a single frame', async () => {
  const run = async (brute: boolean) => {
    const k = new Kerf(device, W, H, brute);
    stage(k);
    k.shapes.plane(0, rgba(128, 128, 128));
    k.shapes.sphere(0, 40, 0, 40, rgba(255, 0, 0));
    k.shapes.roundbox(90, 30, -40, 30, 30, 30, 6, [0, 0.38, 0, 0.92], rgba(60, 200, 255));
    k.frame();
    const img = await k.readback();
    k.destroy();
    return img;
  };
  expect(await run(false)).toEqual(await run(true));
});

it('1366 wide: partial tiles shade and HDR readback has no row skew', async () => {
  const k = new Kerf(device, 1366, 768);
  k.perspective([0, 300, 400], [0, 40, 0], 50);
  k.shapes.sphere(0, 40, 0, 40, rgba(255, 0, 0), { emission: 1 });
  k.frame();
  const img = await k.readback();
  expect(img.length).toBe(1366 * 768 * 8);
  const c = k.project([0, 40, 0])!;
  expect(hdrPixel(img, 1366, Math.floor(c[0]), Math.floor(c[1]))[0]).toBeGreaterThan(0.5);
  expect(hdrPixel(img, 1366, 1365, 767)[3]).toBe(1); // last pixel of a partial tile was written
  k.destroy();
});
