# Kerf Core + Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Kerf's neon-2D renderer (analytic shapes, tile-incremental shading) plus the brute-force reference, prove they are byte-identical, and measure frame time on a throttled machine.

**Architecture:** Shapes are packed into a GPU buffer each frame. One WGSL module has three compute entry points — `clear`, `bin` (each shape marks the tiles its bounds touch, and marks old+new tiles dirty if it changed), `shade` (one workgroup per dirty tile builds an ordered shape list in workgroup memory and shades exact SDF fill + compact glow). The reference renderer is the *same pipeline* with `brute=1` (every shape in every tile, every tile dirty), so both paths run identical shading code and differ only in which shapes/tiles they skip.

**Tech Stack:** TypeScript, Vite 6, WGSL/WebGPU, Vitest 3 (node + browser mode via Playwright/Chrome), `@webgpu/types`.

**Spec:** `docs/superpowers/specs/2026-10-07-kerf-couch-riot-design.md` (§4.1, §4.2, §4.5, §6, §7)

**Plan series:** 1) this plan — Kerf core + bench (gate). 2) Arena shell (room server, host, controller). 3) Kerf GPU-resident sim + fixed-point (§4.3, §4.4) + Twin-stick Arena. 3D mode is planned with Floor is Lava.

## Global Constraints

- WebGPU only; unsupported browser → clear message. No WebGL fallback.
- No Three.js, no runtime framework.
- Vite + TypeScript + WGSL.
- Tile size starts at 16×16.
- Optimized output must be byte-identical to the brute-force reference; a difference is a bug, never a tolerance.
- Budget: worst-case scene p99 ≤ 16.6 ms at 1920×1080 and 3840×2160, Chrome with 4× CPU throttle.
- Max 2048 shapes per frame (`MAX_PRIMS`) — exceeding it throws, never silently drops.

## Review Focus

1. A shape removed between frames (count shrinks) must leave no ghost pixels → test in Task 4.
2. Glow that crosses tile and screen edges must not be clipped → test in Task 4.
3. Camera change must redraw everything → test in Task 4.
4. Widths not divisible by 64 (e.g. 1366 laptop screens) must read back without row skew → test in Task 3.
5. Adding the 2049th shape must throw a clear error → test in Task 2.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore
engine/kerf/gpu.ts                 getDevice() + unsupported message
engine/kerf/gpu.test.ts            node: unsupported message
engine/kerf/gpu.gpu.test.ts        browser: device smoke test
engine/kerf/prims.ts               PrimList, rgba(), Kind, MAX_PRIMS, PRIM_BYTES
engine/kerf/prims.test.ts
engine/kerf/kerf.wgsl              clear / bin / shade compute entry points
engine/kerf/blit.wgsl              output texture → canvas
engine/kerf/renderer.ts            Renderer (frame, readback, present, destroy)
engine/kerf/renderer.gpu.test.ts   single-frame correctness, readback stride
engine/kerf/equivalence.gpu.test.ts  multi-frame fast == brute, ghosts, edges, camera
bench/scene.ts                     deterministic worst/calm scenes
bench/scene.test.ts
bench/stats.ts, bench/stats.test.ts
bench/index.html, bench/main.ts    bench page
bench/run.mjs                      Playwright runner with 4× CPU throttle
```

---

### Task 1: Scaffold, test harness, WebGPU device

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `engine/kerf/gpu.ts`, `engine/kerf/gpu.test.ts`, `engine/kerf/gpu.gpu.test.ts`

**Interfaces:**
- Produces: `getDevice(): Promise<GPUDevice>` — throws `Error` whose message starts with `"Kerf needs WebGPU"` when unavailable.

- [ ] **Step 1: Create project files**

`package.json`:
```json
{
  "name": "couch-riot",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:gpu": "vitest run --project gpu",
    "typecheck": "tsc --noEmit",
    "bench": "node bench/run.mjs"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["@webgpu/types", "vite/client"]
  },
  "include": ["engine", "bench"]
}
```

`vitest.config.ts`:
```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.gpu.test.ts'],
        },
      },
      {
        test: {
          name: 'gpu',
          include: ['**/*.gpu.test.ts'],
          testTimeout: 60_000,
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: false, // real GPU; headless Chrome may lack a WebGPU adapter
            instances: [
              { browser: 'chromium', launch: { channel: 'chrome', args: ['--enable-unsafe-webgpu'] } },
            ],
          },
        },
      },
    ],
  },
});
```

`.gitignore`:
```
node_modules
dist
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm i -D typescript@5 vite@6 vitest@3 @vitest/browser@3 playwright @webgpu/types
```
Expected: installs with no peer-dependency errors. `channel: 'chrome'` uses the installed Google Chrome; if Chrome isn't installed, run `npx playwright install chrome`.

- [ ] **Step 3: Write the failing tests**

`engine/kerf/gpu.test.ts`:
```ts
import { expect, it } from 'vitest';
import { getDevice } from './gpu';

it('rejects with a clear message when WebGPU is missing', async () => {
  await expect(getDevice()).rejects.toThrow('Kerf needs WebGPU');
});
```

`engine/kerf/gpu.gpu.test.ts`:
```ts
import { expect, it } from 'vitest';
import { getDevice } from './gpu';

it('gets a WebGPU device in the test browser', async () => {
  const device = await getDevice();
  expect(device).toBeTruthy();
  device.destroy();
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: both FAIL — `Failed to resolve import "./gpu"`.

- [ ] **Step 5: Implement**

`engine/kerf/gpu.ts`:
```ts
export async function getDevice(): Promise<GPUDevice> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('Kerf needs WebGPU. Use a recent Chrome or Edge on desktop.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Kerf needs WebGPU, but no GPU adapter is available.');
  return adapter.requestDevice();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for both projects (a Chrome window opens briefly for `gpu`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Kerf with node + WebGPU browser test harness"
```

---

### Task 2: Shape list (PrimList)

**Files:**
- Create: `engine/kerf/prims.ts`, `engine/kerf/prims.test.ts`

**Interfaces:**
- Produces:
  - `MAX_PRIMS = 2048`, `PRIM_BYTES = 32`
  - `Kind = { None: 0, Circle: 1, Capsule: 2, Box: 3 }`
  - `rgba(r, g, b, a = 255): number` — packed so WGSL `unpack4x8unorm` yields `(r, g, b, a)`
  - `class PrimList { readonly data: ArrayBuffer; count: number; clear(); circle(x, y, r, color, glow = 0); capsule(ax, ay, bx, by, r, color, glow = 0); box(cx, cy, halfW, halfH, corner, color, glow = 0) }`
  - Per-shape layout (8 × 4 bytes, matches WGSL `Prim`): `a.x a.y b.x b.y r kind color glow`. Circle: `a`=center. Capsule: `a`,`b`=endpoints. Box: `a`=center, `b`=half size, `r`=corner radius. `glow`=glow reach in world units.

- [ ] **Step 1: Write the failing tests**

`engine/kerf/prims.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Kind, MAX_PRIMS, PRIM_BYTES, PrimList, rgba } from './prims';

describe('rgba', () => {
  it('packs r into the lowest byte', () => {
    expect(rgba(0x11, 0x22, 0x33, 0x44)).toBe(0x44332211);
    expect(rgba(255, 255, 255)).toBe(0xffffffff);
  });
});

describe('PrimList', () => {
  it('writes the WGSL Prim layout', () => {
    const p = new PrimList();
    p.capsule(1, 2, 3, 4, 5, rgba(9, 8, 7), 6);
    const f = new Float32Array(p.data, 0, 8);
    const u = new Uint32Array(p.data, 0, 8);
    expect([f[0], f[1], f[2], f[3], f[4]]).toEqual([1, 2, 3, 4, 5]);
    expect(u[5]).toBe(Kind.Capsule);
    expect(u[6]).toBe(rgba(9, 8, 7));
    expect(f[7]).toBe(6);
    expect(p.count).toBe(1);
    expect(PRIM_BYTES).toBe(32);
  });

  it('box stores center, half size and corner', () => {
    const p = new PrimList();
    p.box(10, 20, 30, 40, 5, 0);
    const f = new Float32Array(p.data, 0, 8);
    expect([f[0], f[1], f[2], f[3], f[4]]).toEqual([10, 20, 30, 40, 5]);
    expect(new Uint32Array(p.data, 0, 8)[5]).toBe(Kind.Box);
  });

  it('clear resets count', () => {
    const p = new PrimList();
    p.circle(0, 0, 1, 0);
    p.clear();
    expect(p.count).toBe(0);
  });

  it('throws a clear error past MAX_PRIMS', () => {
    const p = new PrimList();
    for (let i = 0; i < MAX_PRIMS; i++) p.circle(0, 0, 1, 0);
    expect(() => p.circle(0, 0, 1, 0)).toThrow(`Kerf: shape limit ${MAX_PRIMS} exceeded`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- prims`
Expected: FAIL — `Failed to resolve import "./prims"`.

- [ ] **Step 3: Implement**

`engine/kerf/prims.ts`:
```ts
// ponytail: fixed 2048-shape cap keeps the per-tile list in workgroup memory; raise via multi-pass lists if a game needs more.
export const MAX_PRIMS = 2048;
export const PRIM_BYTES = 32;
export const Kind = { None: 0, Circle: 1, Capsule: 2, Box: 3 } as const;

export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export class PrimList {
  readonly data = new ArrayBuffer(MAX_PRIMS * PRIM_BYTES);
  private f = new Float32Array(this.data);
  private u = new Uint32Array(this.data);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  circle(x: number, y: number, r: number, color: number, glow = 0): void {
    this.push(Kind.Circle, x, y, 0, 0, r, color, glow);
  }

  capsule(ax: number, ay: number, bx: number, by: number, r: number, color: number, glow = 0): void {
    this.push(Kind.Capsule, ax, ay, bx, by, r, color, glow);
  }

  box(cx: number, cy: number, halfW: number, halfH: number, corner: number, color: number, glow = 0): void {
    this.push(Kind.Box, cx, cy, halfW, halfH, corner, color, glow);
  }

  private push(kind: number, ax: number, ay: number, bx: number, by: number, r: number, color: number, glow: number): void {
    if (this.count >= MAX_PRIMS) throw new Error(`Kerf: shape limit ${MAX_PRIMS} exceeded`);
    const o = this.count++ * 8;
    this.f[o] = ax;
    this.f[o + 1] = ay;
    this.f[o + 2] = bx;
    this.f[o + 3] = by;
    this.f[o + 4] = r;
    this.u[o + 5] = kind;
    this.u[o + 6] = color;
    this.f[o + 7] = glow;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- prims`
Expected: PASS (4 tests + rgba).

- [ ] **Step 5: Commit**

```bash
git add engine/kerf/prims.ts engine/kerf/prims.test.ts
git commit -m "feat(kerf): shape list packed in WGSL layout"
```

---

### Task 3: Renderer + shaders

**Files:**
- Create: `engine/kerf/kerf.wgsl`, `engine/kerf/blit.wgsl`, `engine/kerf/renderer.ts`, `engine/kerf/renderer.gpu.test.ts`

**Interfaces:**
- Consumes: `getDevice()` (Task 1); `PrimList`, `MAX_PRIMS`, `PRIM_BYTES`, `rgba` (Task 2).
- Produces:
  - `TILE = 16`
  - `interface Camera { x: number; y: number; scale: number }` — world point `(x, y)` maps to pixel `(0, 0)`; `scale` = pixels per world unit.
  - `class Renderer { constructor(device: GPUDevice, width: number, height: number, brute = false); frame(prims: PrimList, cam: Camera): void; readback(): Promise<Uint8Array> /* tightly packed RGBA, width*height*4 */; present(ctx: GPUCanvasContext): void; destroy(): void }`

- [ ] **Step 1: Write the failing tests**

`engine/kerf/renderer.gpu.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:gpu -- renderer`
Expected: FAIL — `Failed to resolve import "./renderer"`.

- [ ] **Step 3: Write the compute shader**

`engine/kerf/kerf.wgsl`:
```wgsl
const TILE: u32 = 16u;
const MAX_PRIMS: u32 = 2048u;
const MASK_WORDS: u32 = 64u; // MAX_PRIMS / 32
const KIND_NONE: u32 = 0u;
const KIND_CIRCLE: u32 = 1u;
const KIND_CAPSULE: u32 = 2u;
const GLOW_GAIN: f32 = 0.6;
const PAD_PX: f32 = 2.0; // conservative margin: fill AA reaches 0.5px past the edge

struct Prim { a: vec2f, b: vec2f, r: f32, kind: u32, color: u32, glow: f32 }

struct Params {
  origin: vec2f, scale: f32, count: u32,
  prevCount: u32, tilesX: u32, tilesY: u32, forceAll: u32,
  brute: u32, width: u32, height: u32, pad: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> prims: array<Prim>;
@group(0) @binding(2) var<storage, read> prevPrims: array<Prim>;
@group(0) @binding(3) var<storage, read_write> tileMasks: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> dirty: array<atomic<u32>>;
@group(0) @binding(5) var outTex: texture_storage_2d<rgba8unorm, write>;

// ---- clear: zero tile masks, reset dirty bits ----
@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let tiles = P.tilesX * P.tilesY;
  if (i < tiles * MASK_WORDS) { atomicStore(&tileMasks[i], 0u); }
  if (i < (tiles + 31u) / 32u) { atomicStore(&dirty[i], select(0u, 0xffffffffu, P.forceAll != 0u)); }
}

// ---- bin: shapes -> tile masks; changed shapes -> dirty tiles ----
fn worldBounds(q: Prim) -> vec4f {
  var lo: vec2f;
  var hi: vec2f;
  switch q.kind {
    case KIND_CIRCLE: { lo = q.a - vec2f(q.r); hi = q.a + vec2f(q.r); }
    case KIND_CAPSULE: { lo = min(q.a, q.b) - vec2f(q.r); hi = max(q.a, q.b) + vec2f(q.r); }
    default: { lo = q.a - q.b; hi = q.a + q.b; } // box: b = half size
  }
  return vec4f(lo - vec2f(q.glow), hi + vec2f(q.glow));
}

// Inclusive tile rect (x0, y0, x1, y1); empty when x0 > x1 or y0 > y1.
fn tileRect(q: Prim) -> vec4i {
  let mx = vec2i(i32(P.tilesX) - 1, i32(P.tilesY) - 1);
  if (P.brute != 0u) { return vec4i(0, 0, mx.x, mx.y); }
  let wb = worldBounds(q);
  let t = f32(TILE);
  let lim = vec2f(f32(P.width), f32(P.height)) + t;
  let lo = clamp((wb.xy - P.origin) * P.scale - PAD_PX, vec2f(-t), lim);
  let hi = clamp((wb.zw - P.origin) * P.scale + PAD_PX, vec2f(-t), lim);
  let t0 = max(vec2i(floor(lo / t)), vec2i(0));
  let t1 = min(vec2i(floor(hi / t)), mx);
  return vec4i(t0, t1);
}

fn markMask(rc: vec4i, idx: u32) {
  for (var y = rc.y; y <= rc.w; y++) {
    for (var x = rc.x; x <= rc.z; x++) {
      let tile = u32(y) * P.tilesX + u32(x);
      atomicOr(&tileMasks[tile * MASK_WORDS + idx / 32u], 1u << (idx % 32u));
    }
  }
}

fn markDirty(rc: vec4i) {
  for (var y = rc.y; y <= rc.w; y++) {
    for (var x = rc.x; x <= rc.z; x++) {
      let tile = u32(y) * P.tilesX + u32(x);
      atomicOr(&dirty[tile / 32u], 1u << (tile % 32u));
    }
  }
}

fn same(a: Prim, b: Prim) -> bool {
  return all(a.a == b.a) && all(a.b == b.b) && a.r == b.r
      && a.kind == b.kind && a.color == b.color && a.glow == b.glow;
}

@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let live = i < P.count && prims[i].kind != KIND_NONE;
  let wasLive = i < P.prevCount && prevPrims[i].kind != KIND_NONE;
  if (live) { markMask(tileRect(prims[i]), i); }
  if (P.forceAll != 0u) { return; }
  if (live && wasLive && same(prims[i], prevPrims[i])) { return; }
  if (live) { markDirty(tileRect(prims[i])); }
  if (wasLive) { markDirty(tileRect(prevPrims[i])); }
}

// ---- shade: one workgroup per tile; skip clean tiles ----
var<workgroup> wordStart: array<u32, MASK_WORDS>;
var<workgroup> list: array<u32, MAX_PRIMS>;
var<workgroup> listLen: u32;
var<workgroup> tileDirty: u32;

fn sdf(p: vec2f, q: Prim) -> f32 {
  switch q.kind {
    case KIND_CIRCLE: { return length(p - q.a) - q.r; }
    case KIND_CAPSULE: {
      let pa = p - q.a;
      let ba = q.b - q.a;
      let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
      return length(pa - ba * h) - q.r;
    }
    default: {
      let d = abs(p - q.a) - q.b + vec2f(q.r);
      return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - q.r;
    }
  }
}

fn background(p: vec2f) -> vec3f {
  let g = abs(fract(p / 40.0 + 0.5) - 0.5) * 40.0 * P.scale; // px to nearest grid line
  let line = clamp(1.0 - min(g.x, g.y), 0.0, 1.0);
  return vec3f(0.02, 0.02, 0.05) + vec3f(0.05, 0.05, 0.12) * line;
}

@compute @workgroup_size(16, 16)
fn shade(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) li: u32,
  @builtin(global_invocation_id) gid: vec3u,
) {
  let tile = wid.y * P.tilesX + wid.x;
  if (li == 0u) { tileDirty = (atomicLoad(&dirty[tile / 32u]) >> (tile % 32u)) & 1u; }
  if (workgroupUniformLoad(&tileDirty) == 0u) { return; }

  // Build this tile's shape list in ascending index order.
  if (li < MASK_WORDS) { wordStart[li] = countOneBits(atomicLoad(&tileMasks[tile * MASK_WORDS + li])); }
  workgroupBarrier();
  if (li == 0u) {
    var s = 0u;
    for (var w = 0u; w < MASK_WORDS; w++) { let c = wordStart[w]; wordStart[w] = s; s += c; }
    listLen = s;
  }
  workgroupBarrier();
  if (li < MASK_WORDS) {
    var bits = atomicLoad(&tileMasks[tile * MASK_WORDS + li]);
    var o = wordStart[li];
    while (bits != 0u) {
      list[o] = li * 32u + firstTrailingBit(bits);
      o++;
      bits &= bits - 1u;
    }
  }
  let n = workgroupUniformLoad(&listLen);
  if (gid.x >= P.width || gid.y >= P.height) { return; }

  let p = P.origin + (vec2f(gid.xy) + 0.5) / P.scale;
  var c = background(p);
  for (var k = 0u; k < n; k++) {
    let q = prims[list[k]];
    let col = unpack4x8unorm(q.color).rgb;
    let dpx = sdf(p, q) * P.scale;
    let gpx = q.glow * P.scale;
    if (dpx > 0.0 && dpx < gpx) { let t = 1.0 - dpx / gpx; c += col * (t * t * GLOW_GAIN); }
    let cov = clamp(0.5 - dpx, 0.0, 1.0);
    if (cov > 0.0) { c = c * (1.0 - cov) + col * cov; }
  }
  textureStore(outTex, gid.xy, vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0));
}
```

`engine/kerf/blit.wgsl`:
```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}
```

- [ ] **Step 4: Write the renderer**

`engine/kerf/renderer.ts`:
```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:gpu -- renderer && npm run typecheck`
Expected: 4 tests PASS, typecheck clean. If a shader fails to compile, the WGSL error appears in the browser console output of the run — fix the WGSL, don't change the tests.

- [ ] **Step 6: Commit**

```bash
git add engine/kerf
git commit -m "feat(kerf): tile-incremental SDF renderer with brute-force mode"
```

---

### Task 4: Bench scenes + equivalence proof

**Files:**
- Create: `bench/scene.ts`, `bench/scene.test.ts`, `engine/kerf/equivalence.gpu.test.ts`

**Interfaces:**
- Consumes: `PrimList`, `rgba`, `MAX_PRIMS` (Task 2); `Renderer`, `Camera` (Task 3); `getDevice` (Task 1).
- Produces: `WORLD = { w: 1600, h: 900 }`, `interface SceneOpts { players; bullets; particles }`, `WORST`, `CALM`, `mulberry32(seed): () => number`, `buildScene(p: PrimList, frame: number, o?: SceneOpts): void` — pure function of `(frame, o)`.

- [ ] **Step 1: Write the failing scene test**

`bench/scene.test.ts`:
```ts
import { expect, it } from 'vitest';
import { MAX_PRIMS, PrimList } from '../engine/kerf/prims';
import { WORST, buildScene } from './scene';

it('is deterministic for a given frame', () => {
  const a = new PrimList();
  const b = new PrimList();
  buildScene(a, 42);
  buildScene(b, 42);
  expect(a.count).toBe(b.count);
  expect(new Uint8Array(a.data)).toEqual(new Uint8Array(b.data));
});

it('worst case fits under MAX_PRIMS', () => {
  const p = new PrimList();
  buildScene(p, 0, WORST);
  expect(p.count).toBe(4 + 12 + WORST.players + WORST.bullets + WORST.particles);
  expect(p.count).toBeLessThanOrEqual(MAX_PRIMS);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- scene`
Expected: FAIL — `Failed to resolve import "./scene"`.

- [ ] **Step 3: Implement the scene**

`bench/scene.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- scene`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the equivalence tests**

`engine/kerf/equivalence.gpu.test.ts`:
```ts
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
```

- [ ] **Step 6: Run the equivalence tests**

Run: `npm run test:gpu -- equivalence`
Expected: 5 tests PASS. If any fail, use superpowers:systematic-debugging. Fix the renderer/shader (usually a bounds or dirty-marking bug). Never loosen the byte-exact comparison; if a difference turns out to come from the GPU compiling the two modes differently rather than from logic, stop and escalate to the Director — that breaks spec §4.2's invariant.

- [ ] **Step 7: Commit**

```bash
git add bench/scene.ts bench/scene.test.ts engine/kerf/equivalence.gpu.test.ts
git commit -m "test(kerf): byte-exact equivalence of incremental vs brute renderer"
```

---

### Task 5: Bench page + throttled runner

**Files:**
- Create: `bench/stats.ts`, `bench/stats.test.ts`, `bench/index.html`, `bench/main.ts`, `bench/run.mjs`

**Interfaces:**
- Consumes: `getDevice` (Task 1), `PrimList` (Task 2), `Renderer` (Task 3), `buildScene`, `WORLD`, `WORST`, `CALM`, `SceneOpts` (Task 4).
- Produces: `percentile(xs: number[], p: number): number`; page sets `window.__bench = { width, height, rows: Array<{ scene, mode, p50, p99 }>, pass }`.

- [ ] **Step 1: Write the failing stats test**

`bench/stats.test.ts`:
```ts
import { expect, it } from 'vitest';
import { percentile } from './stats';

it('nearest-rank percentile on unsorted input', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1
  expect(percentile(xs, 50)).toBe(51);
  expect(percentile(xs, 99)).toBe(100);
  expect(percentile([7], 99)).toBe(7);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- stats`
Expected: FAIL — `Failed to resolve import "./stats"`.

- [ ] **Step 3: Implement stats**

`bench/stats.ts`:
```ts
export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- stats`
Expected: PASS.

- [ ] **Step 5: Write the bench page**

`bench/index.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Kerf Bench</title>
    <style>
      body { margin: 0; background: #000; color: #ccc; font: 14px monospace; }
      canvas { display: block; width: 100vw; height: auto; }
      #out { position: fixed; top: 8px; left: 8px; white-space: pre; background: #000a; padding: 8px; }
    </style>
  </head>
  <body>
    <canvas></canvas>
    <div id="out">running…</div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`bench/main.ts`:
```ts
import { getDevice } from '../engine/kerf/gpu';
import { PrimList } from '../engine/kerf/prims';
import { Renderer } from '../engine/kerf/renderer';
import { CALM, WORLD, WORST, buildScene, type SceneOpts } from './scene';
import { percentile } from './stats';

const BUDGET_MS = 16.6;
const WARMUP = 10;
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
    rows.push({ scene, mode: 'kerf', ...(await run(device, ctx, false, opts, 300)) });
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
```

- [ ] **Step 6: Write the throttled runner**

`bench/run.mjs`:
```js
// Usage: npm run dev   (in another terminal)   then   npm run bench [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/bench/';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

let allPass = true;
for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
  await page.goto(`${url}?w=${w}&h=${h}`);
  const handle = await page.waitForFunction(() => window.__bench, null, { timeout: 15 * 60_000 });
  const r = await handle.jsonValue();
  console.log(`\n${r.width}x${r.height} (CPU throttle 4x) — ${r.pass ? 'PASS' : 'FAIL'}`);
  console.table(r.rows.map((x) => ({ ...x, p50: +x.p50.toFixed(2), p99: +x.p99.toFixed(2) })));
  allPass &&= r.pass;
}
await browser.close();
process.exit(allPass ? 0 : 1);
```

- [ ] **Step 7: Smoke-test the page manually**

Run: `npm run dev`, open `http://localhost:5173/bench/?w=1280&h=720`.
Expected: the neon scene animates (walls, 8 orbiting players, bullets, particles), then the overlay shows 4 rows and PASS/FAIL. No console errors.

- [ ] **Step 8: Run the throttled bench**

Run (with `npm run dev` still running): `npm run bench`
Expected: two tables (1080p, 4K) with kerf and brute rows. Record the output verbatim for the Director. A FAIL here is a result, not a test failure to patch: per spec §8, a kerf p99 over budget means revisiting §4.2 before any game work.

- [ ] **Step 9: Full suite + commit**

Run: `npm test && npm run typecheck`
Expected: all PASS.

```bash
git add bench
git commit -m "feat(bench): Kerf frame-time bench with 4x CPU-throttled runner"
```
