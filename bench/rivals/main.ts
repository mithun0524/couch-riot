// SPIKE (throwaway): same scene in Kerf, PixiJS v8 + bloom, Three.js + UnrealBloom.
// One engine per page load: ?engine=kerf|pixi|three&w=&h=&scene=worst|calm&frames=
import { AdvancedBloomFilter } from 'pixi-filters';
import { Application, Container, Graphics, Sprite, type Texture } from 'pixi.js';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { getDevice } from '../../engine/kerf/gpu';
import { Kind, MAX_PRIMS, PrimList } from '../../engine/kerf/prims';
import { Renderer } from '../../engine/kerf/renderer';
import { CALM, WORLD, WORST, buildScene } from '../scene';
import { percentile } from '../stats';

const q = new URLSearchParams(location.search);
const ENGINE = q.get('engine') ?? 'kerf';
const W = Number(q.get('w') ?? 1920);
const H = Number(q.get('h') ?? 1080);
const OPTS = q.get('scene') === 'calm' ? CALM : WORST;
const FRAMES = Number(q.get('frames') ?? 600);
const WARMUP = 60;
const SHOT_FRAME = 60;
const S = H / WORLD.h; // world → px

const prims = new PrimList();
const f32 = new Float32Array(prims.data);
const u32 = new Uint32Array(prims.data);

// Iterate the exact shapes Kerf would draw this frame.
function eachPrim(fn: (kind: number, ax: number, ay: number, bx: number, by: number, r: number, color: number, glow: number) => void) {
  for (let i = 0; i < prims.count; i++) {
    const o = i * 8;
    fn(u32[o + 5], f32[o], f32[o + 1], f32[o + 2], f32[o + 3], f32[o + 4], u32[o + 6], f32[o + 7]);
  }
}
const px = new Uint8Array(4);
const rgbOf = (c: number) => (c & 0xff) << 16 | ((c >> 8) & 0xff) << 8 | ((c >> 16) & 0xff);

interface Engine { frame(f: number): void; finish(): Promise<void>; canvas: HTMLCanvasElement }

async function kerf(): Promise<Engine> {
  const device = await getDevice();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('webgpu')!;
  ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
  const r = new Renderer(device, W, H);
  const cam = { x: 0, y: 0, scale: S };
  return {
    canvas,
    frame(f) { buildScene(prims, f, OPTS); r.frame(prims, cam); r.present(ctx); },
    finish: () => device.queue.onSubmittedWorkDone(),
  };
}

async function pixi(): Promise<Engine> {
  const app = new Application();
  await app.init({ width: W, height: H, preference: 'webgl', antialias: true, background: '#05050d', resolution: 1, autoStart: false, preserveDrawingBuffer: true });
  app.ticker.stop();
  const tex = (g: Graphics): Texture => app.renderer.generateTexture(g);
  const circleTex = tex(new Graphics().circle(32, 32, 32).fill(0xffffff));
  const capsuleTex = tex(new Graphics().roundRect(0, 0, 128, 32, 16).fill(0xffffff));
  const boxTex = tex(new Graphics().roundRect(0, 0, 64, 64, 8).fill(0xffffff));
  const layer = new Container();
  layer.filters = [new AdvancedBloomFilter({ threshold: 0.15, bloomScale: 1.2, brightness: 1, blur: 10, quality: 8 })];
  app.stage.addChild(layer);
  const pool: Sprite[] = [];
  for (let i = 0; i < MAX_PRIMS; i++) {
    const s = new Sprite(circleTex);
    s.anchor.set(0.5);
    s.visible = false;
    layer.addChild(s);
    pool.push(s);
  }
  const gl = (app.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  return {
    canvas: app.canvas,
    frame(f) {
      buildScene(prims, f, OPTS);
      let i = 0;
      eachPrim((kind, ax, ay, bx, by, r, color) => {
        const s = pool[i++];
        s.visible = true;
        s.tint = rgbOf(color);
        if (kind === Kind.Circle) {
          s.texture = circleTex; s.position.set(ax * S, ay * S); s.rotation = 0; s.width = s.height = 2 * r * S;
        } else if (kind === Kind.Capsule) {
          const dx = bx - ax, dy = by - ay;
          s.texture = capsuleTex; s.position.set((ax + bx) / 2 * S, (ay + by) / 2 * S);
          s.rotation = Math.atan2(dy, dx); s.width = (Math.hypot(dx, dy) + 2 * r) * S; s.height = 2 * r * S;
        } else {
          s.texture = boxTex; s.position.set(ax * S, ay * S); s.rotation = 0; s.width = 2 * bx * S; s.height = 2 * by * S;
        }
      });
      for (; i < pool.length && pool[i].visible; i++) pool[i].visible = false;
      app.renderer.render(app.stage);
    },
    async finish() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); },
  };
}

async function three(): Promise<Engine> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x05050d);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, WORLD.w, 0, WORLD.h, -1, 1); // y down like Kerf
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); // y-down camera flips winding
  const mk = (geo: THREE.BufferGeometry) => {
    const m = new THREE.InstancedMesh(geo, mat, MAX_PRIMS);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color());
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const circles = mk(new THREE.CircleGeometry(1, 24));
  const caps = mk(new THREE.PlaneGeometry(1, 1));
  const boxes = mk(new THREE.PlaneGeometry(1, 1));
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.9, 0.35, 0.55));
  composer.addPass(new OutputPass());
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1), col = new THREE.Color();
  const gl = renderer.getContext();
  return {
    canvas: renderer.domElement,
    frame(f) {
      buildScene(prims, f, OPTS);
      let nc = 0, np = 0, nb = 0;
      eachPrim((kind, ax, ay, bx, by, r, color) => {
        col.setHex(rgbOf(color), THREE.SRGBColorSpace);
        if (kind === Kind.Circle) {
          m4.compose(pos.set(ax, ay, 0), quat.identity(), scl.set(r, r, 1));
          circles.setMatrixAt(nc, m4); circles.setColorAt(nc++, col);
        } else if (kind === Kind.Capsule) {
          const dx = bx - ax, dy = by - ay;
          m4.compose(pos.set((ax + bx) / 2, (ay + by) / 2, 0), quat.setFromAxisAngle(z, Math.atan2(dy, dx)), scl.set(Math.hypot(dx, dy) + 2 * r, 2 * r, 1));
          caps.setMatrixAt(np, m4); caps.setColorAt(np++, col);
        } else {
          m4.compose(pos.set(ax, ay, 0), quat.identity(), scl.set(2 * bx, 2 * by, 1));
          boxes.setMatrixAt(nb, m4); boxes.setColorAt(nb++, col);
        }
      });
      for (const [m, n] of [[circles, nc], [caps, np], [boxes, nb]] as const) {
        m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      composer.render();
    },
    async finish() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); },
  };
}

async function main() {
  const out = document.getElementById('out')!;
  try {
    const eng = await ({ kerf, pixi, three } as Record<string, () => Promise<Engine>>)[ENGINE]();
    eng.canvas.style.cssText = 'width:100vw;height:auto;display:block';
    document.body.prepend(eng.canvas);
    // Throughput, same for every engine: render BATCH frames back to back, sync once, divide.
    const BATCH = 10;
    const times: number[] = [];
    let shot = '';
    for (let f = 0; f < FRAMES + WARMUP; f += BATCH) {
      const t0 = performance.now();
      for (let k = 0; k < BATCH; k++) eng.frame(f + k);
      await eng.finish();
      if (f >= WARMUP) times.push((performance.now() - t0) / BATCH);
    }
    eng.frame(SHOT_FRAME); // screenshot outside the timed window
    shot = eng.canvas.toDataURL('image/png');
    const res = { engine: ENGINE, w: W, h: H, scene: q.get('scene') ?? 'worst', p50: percentile(times, 50), p99: percentile(times, 99), shot };
    out.textContent = `${ENGINE} ${W}x${H} p50 ${res.p50.toFixed(2)} p99 ${res.p99.toFixed(2)}`;
    (window as unknown as { __rival: unknown }).__rival = res;
  } catch (e) {
    (window as unknown as { __rival: unknown }).__rival = { engine: ENGINE, error: String(e) };
  }
}

main();
