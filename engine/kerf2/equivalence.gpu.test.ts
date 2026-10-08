import { afterAll, beforeAll, it } from 'vitest';
import { BUSY, CALM, LOBBY_CAM, buildLobby, qy, type LobbyOpts } from '../../bench/v2/scene';
import { getDevice } from '../kerf/gpu';
import { Kerf, type Vec3 } from './kerf';
import { IDENTITY, rgba, type ShapeList } from './shapes';

let device: GPUDevice;
beforeAll(async () => { device = await getDevice(); });
afterAll(() => device.destroy());

const W = 640, H = 360;

interface Frame { fill: (s: ShapeList) => void; setup?: (k: Kerf) => void }

function diffCount(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

async function expectEquivalent(frames: Frame[], width = W, height = H) {
  const fast = new Kerf(device, width, height, false);
  const ref = new Kerf(device, width, height, true);
  try {
    for (let f = 0; f < frames.length; f++) {
      for (const k of [fast, ref]) {
        frames[f].setup?.(k);
        frames[f].fill(k.shapes);
        k.frame();
      }
      const [a, b] = await Promise.all([fast.readback(), ref.readback()]);
      const d = diffCount(a, b);
      if (d) throw new Error(`frame ${f}: ${d} bytes differ`);
    }
  } finally {
    fast.destroy();
    ref.destroy();
  }
}

const lobby = (o: LobbyOpts, n: number): Frame[] =>
  Array.from({ length: n }, (_, f) => ({ fill: (s) => buildLobby(s, f, o), setup: (k) => f === 0 && k.perspective(LOBBY_CAM.eye, LOBBY_CAM.target, LOBBY_CAM.fov) }));

it('calm lobby: 8 moving blobs with sun shadows, 24 frames', async () => {
  await expectEquivalent(lobby(CALM, 24));
});

it('busy lobby: blobs + 120 sparks, 12 frames', async () => {
  await expectEquivalent(lobby({ blobs: 8, sparks: 120 }, 12));
});

it('removed shapes leave no ghost (count shrink, index shift, zero)', async () => {
  const blob = (s: ShapeList, x: number) => s.ellipsoid(x, 40, 450, 60, 40, 40, IDENTITY, rgba(255, 60, 90), { emission: 0.5 });
  await expectEquivalent([
    { fill: (s) => { s.clear(); s.plane(0, rgba(40, 44, 60)); blob(s, 600); blob(s, 1000); } },
    { fill: (s) => { s.clear(); s.plane(0, rgba(40, 44, 60)); blob(s, 1000); } },
    { fill: (s) => { s.clear(); s.plane(0, rgba(40, 44, 60)); } },
    { fill: (s) => { s.clear(); } },
  ]);
});

it('tall pillar under a low sun: long shadow far from the pillar redraws as it moves', async () => {
  const frames: Frame[] = Array.from({ length: 10 }, (_, f) => ({
    setup: (k) => f === 0 && k.setSun({ dir: [1, 0.25, 0.2], angle: 0.03, color: [1, 1, 1], intensity: 3 }),
    fill: (s) => { s.clear(); s.plane(0, rgba(90, 90, 90)); s.cylinder(500 + f * 6, 200, 450, 20, 200, 4, IDENTITY, rgba(200, 200, 200)); },
  }));
  await expectEquivalent(frames);
});

it('long thin rotating ellipsoid near tile edges (lower-bound distance) stays exact', async () => {
  const frames: Frame[] = Array.from({ length: 10 }, (_, f) => ({
    fill: (s) => { s.clear(); s.plane(0, rgba(60, 60, 70)); s.ellipsoid(800, 30, 450, 400, 12, 12, qy(f * 0.17), rgba(60, 200, 255), { emission: 1 }); },
  }));
  await expectEquivalent(frames);
});

it('shapes straddling and behind the near plane', async () => {
  const eye: Vec3 = [800, 300, 1100];
  const frames: Frame[] = Array.from({ length: 6 }, (_, f) => ({
    setup: (k) => f === 0 && k.perspective(eye, [800, 0, 400], 50),
    fill: (s) => {
      s.clear();
      s.plane(0, rgba(60, 60, 70));
      s.sphere(800 + f * 3, 300, 1100, 40, rgba(255, 200, 40), { emission: 0.5 }); // camera inside its bounds
      s.sphere(800, 300, 1300, 40, rgba(255, 0, 0)); // fully behind the camera
      s.sphere(700 + f * 10, 40, 500, 40, rgba(120, 255, 90));
    },
  }));
  await expectEquivalent(frames);
});

it('sun and camera changes redraw everything', async () => {
  const fill = (s: ShapeList) => buildLobby(s, 0, CALM);
  await expectEquivalent([
    { fill, setup: (k) => k.perspective(LOBBY_CAM.eye, LOBBY_CAM.target, LOBBY_CAM.fov) },
    { fill, setup: (k) => k.setSun({ dir: [-0.5, 1, 0.3], angle: 0.06, color: [1, 0.8, 0.7], intensity: 2 }) },
    { fill, setup: (k) => k.setSky({ color: [0.5, 0.2, 0.3], intensity: 0.8 }) },
    { fill, setup: (k) => k.perspective([600, 900, 1500], [800, 0, 450], 45) },
    { fill, setup: (k) => k.ortho(800, 450, 1600) },
  ]);
});

it('1366x768 partial tiles: fast == brute', async () => {
  await expectEquivalent(lobby(CALM, 4).map((fr, f) => ({ ...fr, setup: (k: Kerf) => f === 0 && k.perspective(LOBBY_CAM.eye, LOBBY_CAM.target, LOBBY_CAM.fov) })), 1366, 768);
});
