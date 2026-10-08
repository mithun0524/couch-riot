import type { Vec3 } from '../../engine/kerf2/kerf';
import { IDENTITY, ShapeList, rgba, type Quat } from '../../engine/kerf2/shapes';
import { mulberry32 } from '../scene';

export const ARENA = { w: 1600, d: 900 };
export interface LobbyOpts { blobs: number; sparks: number }
export const BUSY: LobbyOpts = { blobs: 8, sparks: 400 };
export const CALM: LobbyOpts = { blobs: 8, sparks: 0 };
export const LOBBY_CAM: { eye: Vec3; target: Vec3; fov: number } = { eye: [800, 1100, 1650], target: [800, 0, 430], fov: 40 };

const COLORS = [
  rgba(255, 60, 90), rgba(60, 200, 255), rgba(120, 255, 90), rgba(255, 200, 40),
  rgba(200, 90, 255), rgba(255, 130, 40), rgba(40, 255, 200), rgba(255, 255, 255),
];

export const qy = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

// Pure function of (frame, opts): deterministic for equivalence tests and the bench.
export function buildLobby(s: ShapeList, frame: number, o: LobbyOpts = BUSY): void {
  const rnd = mulberry32(2026);
  const { w, d } = ARENA;
  const wall = rgba(70, 80, 120);
  s.clear();
  s.plane(0, rgba(40, 44, 60));
  s.roundbox(w / 2, 30, 10, w / 2, 30, 10, 6, IDENTITY, wall);
  s.roundbox(w / 2, 30, d - 10, w / 2, 30, 10, 6, IDENTITY, wall);
  s.roundbox(10, 30, d / 2, 10, 30, d / 2, 6, IDENTITY, wall);
  s.roundbox(w - 10, 30, d / 2, 10, 30, d / 2, 6, IDENTITY, wall);

  for (let i = 0; i < o.blobs; i++) {
    const a = frame * 0.015 + (i * Math.PI * 2) / o.blobs;
    const r = 280 + 60 * Math.sin(frame * 0.02 + i);
    const squash = 1 + 0.15 * Math.sin(frame * 0.2 + i);
    const ry = 40 / squash;
    s.ellipsoid(w / 2 + Math.cos(a) * r, ry, d / 2 + Math.sin(a) * r * 0.8, 40 * Math.sqrt(squash), ry, 40 * Math.sqrt(squash), qy(a), COLORS[i % 8], { emission: 0.6 });
  }

  for (let i = 0; i < o.sparks; i++) {
    const x0 = 60 + rnd() * (w - 120), z0 = 60 + rnd() * (d - 120), h = 20 + rnd() * 180, ph = rnd() * Math.PI * 2;
    s.sphere(x0 + Math.cos(frame * 0.03 + ph) * 25, h + Math.sin(frame * 0.05 + ph) * 10, z0 + Math.sin(frame * 0.03 + ph) * 25, 3, COLORS[i % 8], { emission: 4 });
  }
}
