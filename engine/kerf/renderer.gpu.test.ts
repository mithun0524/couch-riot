import { afterAll, beforeAll, expect, it } from 'vitest';
import { getDevice } from './gpu';
import { PrimList, rgba } from './prims';
import { Renderer } from './renderer';

let device: GPUDevice;
beforeAll(async () => { device = await getDevice(); });
afterAll(() => device.destroy());

const cam = { x: 0, y: 0, scale: 1 };
const BG = [5, 5, 13, 255];

function px(img: Uint8Array, w: number, x: number, y: number): number[] {
  const o = (y * w + x) * 4;
  return [img[o], img[o + 1], img[o + 2], img[o + 3]];
}
function near(a: number[], b: number[]) {
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(1));
}

for (const brute of [false, true]) {
  it(`fills a circle and leaves far pixels as background (brute=${brute})`, async () => {
    const r = new Renderer(device, 640, 384, brute);
    const p = new PrimList();
    p.circle(100, 100, 20, rgba(255, 0, 0));
    r.frame(p, cam);
    const img = await r.readback();
    expect(px(img, 640, 100, 100)).toEqual([255, 0, 0, 255]);
    near(px(img, 640, 500, 300), BG);
    r.destroy();
  });
}

it('glow brightens pixels just outside the shape and stops at its reach', async () => {
  const r = new Renderer(device, 640, 384);
  const p = new PrimList();
  p.circle(200, 220, 10, rgba(0, 255, 0), 20); // y=220 keeps samples off the 40-unit grid lines
  r.frame(p, cam);
  const img = await r.readback();
  expect(px(img, 640, 215, 220)[1]).toBeGreaterThan(BG[1] + 20); // 5px outside edge
  near(px(img, 640, 235, 220), BG); // 25px outside edge, past 20 reach
  r.destroy();
});

it('reads back widths not divisible by 64 without row skew (1366x768)', async () => {
  const r = new Renderer(device, 1366, 768);
  const p = new PrimList();
  p.circle(683, 384, 30, rgba(255, 0, 0));
  r.frame(p, cam);
  const img = await r.readback();
  expect(img.length).toBe(1366 * 768 * 4);
  expect(px(img, 1366, 683, 384)).toEqual([255, 0, 0, 255]);
  near(px(img, 1366, 1365, 1), BG);
  near(px(img, 1366, 5, 767), BG);
  r.destroy();
});
