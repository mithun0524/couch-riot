import { PrimList, rgba } from '../engine/kerf/prims';

export const WORLD = { w: 1600, h: 900 };
export interface SceneOpts { players: number; bullets: number; particles: number }
export const WORST: SceneOpts = { players: 8, bullets: 600, particles: 1200 };
export const CALM: SceneOpts = { players: 8, bullets: 40, particles: 0 };

const COLORS = [
  rgba(255, 60, 90), rgba(60, 200, 255), rgba(120, 255, 90), rgba(255, 200, 40),
  rgba(200, 90, 255), rgba(255, 130, 40), rgba(40, 255, 200), rgba(255, 255, 255),
];
const WALL = rgba(90, 110, 160);

export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (v: number, m: number) => ((v % m) + m) % m;

export function buildScene(p: PrimList, frame: number, o: SceneOpts = WORST): void {
  const rnd = mulberry32(1337);
  const { w, h } = WORLD;
  p.clear();

  p.box(w / 2, 10, w / 2, 10, 4, WALL, 8);
  p.box(w / 2, h - 10, w / 2, 10, 4, WALL, 8);
  p.box(10, h / 2, 10, h / 2, 4, WALL, 8);
  p.box(w - 10, h / 2, 10, h / 2, 4, WALL, 8);
  for (let i = 0; i < 12; i++) {
    p.box(100 + rnd() * (w - 200), 100 + rnd() * (h - 200), 20 + rnd() * 40, 20 + rnd() * 40, 6, WALL, 10);
  }

  for (let i = 0; i < o.players; i++) {
    const a = frame * 0.02 + i * ((Math.PI * 2) / o.players);
    const rad = 250 + 80 * Math.sin(frame * 0.01 + i);
    p.circle(w / 2 + Math.cos(a) * rad, h / 2 + Math.sin(a) * rad, 18, COLORS[i % 8], 30);
  }

  for (let i = 0; i < o.bullets; i++) {
    const x0 = rnd() * w, y0 = rnd() * h, ang = rnd() * Math.PI * 2, sp = 4 + rnd() * 6;
    const vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;
    const x = wrap(x0 + vx * frame, w), y = wrap(y0 + vy * frame, h);
    p.capsule(x, y, x - vx * 3, y - vy * 3, 3, COLORS[i % 8], 12);
  }

  for (let i = 0; i < o.particles; i++) {
    const x0 = rnd() * w, y0 = rnd() * h, ph = rnd() * Math.PI * 2;
    p.circle(x0 + Math.cos(frame * 0.05 + ph) * 20, y0 + Math.sin(frame * 0.07 + ph) * 20, 1.5, COLORS[i % 8], 6);
  }
}
