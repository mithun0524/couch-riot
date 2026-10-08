# Twin-Stick Arena Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first real Couch Riot game — a neon top-down twin-stick shooter for 2–8 players — playable from the existing vote screen, drawn with Kerf v1.

**Architecture:** A pure game class (`TwinStickGame`) on the existing game contract: fixed 60 Hz `tick(pads)`, `draw(prims)`, `isOver()`, `result()`, plus a new optional `messages()` outbox so a game can buzz a phone and update its health HUD. Collision is circle-vs-rounded-rect against a fixed map. Everything deterministic from a seed, so it's fully unit-testable without a browser.

**Tech Stack:** TypeScript, Kerf v1 (`engine/kerf`), existing arena shell, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-kerf-couch-riot-design.md` §5 (Twin-stick Arena), with `docs/superpowers/specs/2026-10-07-arena-shell-design.md` §4 (protocol) and §6 (game contract).

## Global Constraints

- Players 2–8; controls `twinstick`: left stick moves, right stick aims and auto-fires while held.
- Free-for-all, 3-minute round. +1 per kill, −1 per self-hazard death (a bounced chicken hitting its owner).
- Respawn after 2 s at the spawn point farthest from living enemies, with a 1.5 s spawn shield.
- Health: 3 hits. Phone vibrates on hit; phone HUD shows health.
- Single map: border walls + cover blocks made of rounded boxes.
- Pickups: one spawns every 10 s, max 2 on the map, power lasts 8 s — chicken cannon (slow, big, bouncing), boomerang laser (returns, hits twice), shotgun spray (5-way).
- Round end: the winner's colour floods the arena (walls take the winner's colour, the winner's ship grows) for a 1.5 s victory lap, then results.
- Must stay under Kerf v1's 2048-shape limit in the worst case.

## Review Focus

1. A ship hugging a wall fires a bullet that spawns inside the wall — it must just die, never stick or crash → covered by the wall test in Task 3 (bullets die on walls) and the 8-player stress test.
2. Two players tied on score at round end — the victory lap must still pick one leader and not crash → test in Task 3.
3. A player who leaves mid-round (pad becomes undefined) must stand still and keep their score → test in Task 3.
4. Bullet counts exploding (8 players on shotguns) must never exceed the shape limit → test in Task 3.
5. A HUD update arriving before the phone shows the controller must still appear when the controller opens → Task 1 phone code keeps the last HUD and draws it on open.

## File Structure

```
shell/protocol.ts (+ .test.ts)   add host→phone {t:'hud', hp, max}
shell/game.ts                    GameInstance.messages?()
shell/host/main.ts               forward game messages; register twinstick
shell/phone/main.ts, phone.css   health pips on the controller screen
games/twinstick/physics.ts (+ .test.ts)   circle vs rect overlap / push-out
games/twinstick/arena.ts                  walls, spawns, pickup spots
games/twinstick/twinstick.ts (+ .test.ts) the game
```

---

### Task 1: HUD message + game outbox

**Files:**
- Modify: `shell/protocol.ts`, `shell/protocol.test.ts`, `shell/game.ts`, `shell/host/main.ts`, `shell/phone/main.ts`, `shell/phone/phone.css`

**Interfaces:**
- Produces:
  - `HostToPhone` gains `{ t: 'hud'; hp: number; max: number }`; `parseHostOut` accepts `t: 'hud'`.
  - `GameInstance.messages?(): { to: number; msg: HostToPhone }[]` — drained by the host after each tick.

- [ ] **Step 1: Write the failing test**

Append to `shell/protocol.test.ts` inside `describe('parseHostOut', ...)`, before its closing `});`:
```ts
  it('routes HUD updates', () => {
    expect(parseHostOut('{"to":2,"t":"hud","hp":1,"max":3}')).toEqual({ to: 2, msg: { t: 'hud', hp: 1, max: 3 } });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- protocol`
Expected: FAIL — `expected null to deeply equal { to: 2, … }`.

- [ ] **Step 3: Implement**

In `shell/protocol.ts` replace:
```ts
export type HostToPhone = ScreenMsg | { t: 'buzz'; ms: number };
```
with:
```ts
export type HostToPhone = ScreenMsg | { t: 'buzz'; ms: number } | { t: 'hud'; hp: number; max: number };
```
and replace:
```ts
  if (!okTo || (msg.t !== 'screen' && msg.t !== 'buzz')) return null;
```
with:
```ts
  if (!okTo || (msg.t !== 'screen' && msg.t !== 'buzz' && msg.t !== 'hud')) return null;
```

In `shell/game.ts` replace the `GameInstance` interface with:
```ts
export interface GameInstance {
  tick(pads: ReadonlyArray<Pad | undefined>): void; // fixed 60 Hz, index = slot
  draw(prims: PrimList): void; // Kerf shapes, world 1600×900
  isOver(): boolean;
  result(): { slot: number; score: number }[];
  messages?(): { to: number; msg: HostToPhone }[]; // drained after each tick (buzz, HUD)
}
```
and change its imports to:
```ts
import { rgba, type PrimList } from '../engine/kerf/prims';
import type { Pad } from './pad';
import { PALETTE_HEX, type HostToPhone } from './protocol';
```

In `shell/host/main.ts` replace:
```ts
      game.tick(pads);
      acc -= TICK_MS;
```
with:
```ts
      game.tick(pads);
      for (const m of game.messages?.() ?? []) out([{ to: m.to, ...m.msg }]);
      acc -= TICK_MS;
```

In `shell/phone/main.ts`:
- after `let detach: (() => void) | null = null;` add:
```ts
let hud: { hp: number; max: number } | null = null; // kept so a HUD sent before the controller opens still shows

function drawHud() {
  const el = document.getElementById('hud');
  if (el && hud) el.innerHTML = Array.from({ length: hud.max }, (_, i) => `<i class="${i < hud!.hp ? 'on' : ''}"></i>`).join('');
}
```
- replace:
```ts
      case 'buzz':
        navigator.vibrate?.(m.ms);
        break;
```
with:
```ts
      case 'buzz':
        navigator.vibrate?.(m.ms);
        break;
      case 'hud':
        hud = { hp: m.hp, max: m.max };
        drawHud();
        break;
```
- replace:
```ts
        <p class="tip">Turn your phone sideways</p>
        <div class="pad"><div class="half" id="L" data-label="MOVE"></div><div class="half" id="R" data-label="AIM"></div></div>`);
      detach = attachTwinStick(document.getElementById('L')!, document.getElementById('R')!, (b) => send(new Uint8Array([b])));
```
with:
```ts
        <p class="tip">Turn your phone sideways</p>
        <div class="hud" id="hud"></div>
        <div class="pad"><div class="half" id="L" data-label="MOVE"></div><div class="half" id="R" data-label="AIM"></div></div>`);
      drawHud();
      detach = attachTwinStick(document.getElementById('L')!, document.getElementById('R')!, (b) => send(new Uint8Array([b])));
```

Append to `shell/phone/phone.css`:
```css
.hud { position: fixed; top: 10px; right: 14px; display: flex; gap: 6px; z-index: 2; pointer-events: none; }
.hud i { width: 22px; height: 8px; border-radius: 4px; background: #ffffff22; }
.hud i.on { background: var(--me); box-shadow: 0 0 10px var(--me); }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add shell/protocol.ts shell/protocol.test.ts shell/game.ts shell/host/main.ts shell/phone/main.ts shell/phone/phone.css
git commit -m "feat(shell): game outbox + phone health HUD message"
```

---

### Task 2: Map + collision

**Files:**
- Create: `games/twinstick/physics.ts`, `games/twinstick/physics.test.ts`, `games/twinstick/arena.ts`

**Interfaces:**
- Produces:
  - `interface Rect { x: number; y: number; hw: number; hh: number }` (centre + half size)
  - `overlaps(x, y, r, b: Rect): boolean`
  - `pushOut(p: { x: number; y: number }, r: number, b: Rect): [number, number] | null` — moves `p` out of `b`, returns the unit push normal, or null if clear
  - `arena.ts`: `ARENA = { w: 1600, h: 900 }`, `WALLS: Rect[]`, `SPAWNS: { x: number; y: number }[]` (8), `PICKUP_SPOTS: { x: number; y: number }[]` (4)

- [ ] **Step 1: Write the failing test**

`games/twinstick/physics.test.ts`:
```ts
import { expect, it } from 'vitest';
import { SPAWNS, PICKUP_SPOTS, WALLS } from './arena';
import { overlaps, pushOut } from './physics';

const box = { x: 100, y: 100, hw: 50, hh: 20 };

it('overlaps uses the closest point on the rect', () => {
  expect(overlaps(160, 100, 11, box)).toBe(true);
  expect(overlaps(162, 100, 11, box)).toBe(false);
});

it('pushes a circle out through the side it hit', () => {
  const p = { x: 155, y: 100 };
  expect(pushOut(p, 10, box)).toEqual([1, 0]);
  expect(p.x).toBeCloseTo(160);
});

it('pushes a centre that is inside out along the shallowest axis', () => {
  const p = { x: 140, y: 115 };
  expect(pushOut(p, 10, box)).toEqual([0, 1]);
  expect(p.y).toBe(130);
});

it('leaves a clear circle alone', () => {
  const p = { x: 300, y: 300 };
  expect(pushOut(p, 10, box)).toBeNull();
  expect(p).toEqual({ x: 300, y: 300 });
});

it('spawns and pickup spots are clear of every wall', () => {
  for (const s of [...SPAWNS, ...PICKUP_SPOTS]) for (const w of WALLS) expect(overlaps(s.x, s.y, 30, w)).toBe(false);
  expect(SPAWNS).toHaveLength(8);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- twinstick/physics`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`games/twinstick/physics.ts`:
```ts
export interface Rect { x: number; y: number; hw: number; hh: number } // centre + half size

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function overlaps(x: number, y: number, r: number, b: Rect): boolean {
  const dx = x - clamp(x, b.x - b.hw, b.x + b.hw);
  const dy = y - clamp(y, b.y - b.hh, b.y + b.hh);
  return dx * dx + dy * dy < r * r;
}

// Moves a circle out of a rect. Returns the unit push normal, or null when they don't touch.
export function pushOut(p: { x: number; y: number }, r: number, b: Rect): [number, number] | null {
  const cx = clamp(p.x, b.x - b.hw, b.x + b.hw);
  const cy = clamp(p.y, b.y - b.hh, b.y + b.hh);
  let dx = p.x - cx;
  let dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    dx /= d;
    dy /= d;
    p.x = cx + dx * r;
    p.y = cy + dy * r;
    return [dx, dy];
  }
  // Centre inside the rect: leave along the shallowest axis.
  const px = b.hw - Math.abs(p.x - b.x);
  const py = b.hh - Math.abs(p.y - b.y);
  if (px < py) {
    const s = Math.sign(p.x - b.x) || 1;
    p.x = b.x + s * (b.hw + r);
    return [s, 0];
  }
  const s = Math.sign(p.y - b.y) || 1;
  p.y = b.y + s * (b.hh + r);
  return [0, s];
}
```

`games/twinstick/arena.ts`:
```ts
import type { Rect } from './physics';

export const ARENA = { w: 1600, h: 900 };

export const WALLS: Rect[] = [
  { x: 800, y: 12, hw: 800, hh: 12 },
  { x: 800, y: 888, hw: 800, hh: 12 },
  { x: 12, y: 450, hw: 12, hh: 450 },
  { x: 1588, y: 450, hw: 12, hh: 450 },
  { x: 400, y: 250, hw: 60, hh: 20 },
  { x: 1200, y: 250, hw: 60, hh: 20 },
  { x: 400, y: 650, hw: 60, hh: 20 },
  { x: 1200, y: 650, hw: 60, hh: 20 },
  { x: 800, y: 450, hw: 30, hh: 110 },
  { x: 600, y: 450, hw: 20, hh: 50 },
  { x: 1000, y: 450, hw: 20, hh: 50 },
];

export const SPAWNS = [
  { x: 120, y: 120 }, { x: 1480, y: 780 }, { x: 1480, y: 120 }, { x: 120, y: 780 },
  { x: 800, y: 120 }, { x: 800, y: 780 }, { x: 120, y: 450 }, { x: 1480, y: 450 },
];

export const PICKUP_SPOTS = [{ x: 800, y: 250 }, { x: 800, y: 650 }, { x: 300, y: 450 }, { x: 1300, y: 450 }];
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- twinstick/physics`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add games/twinstick/physics.ts games/twinstick/physics.test.ts games/twinstick/arena.ts
git commit -m "feat(twinstick): arena map and circle-rect collision"
```

---

### Task 3: The game

**Files:**
- Create: `games/twinstick/twinstick.ts`, `games/twinstick/twinstick.test.ts`

**Interfaces:**
- Consumes: `WALLS`, `SPAWNS`, `PICKUP_SPOTS` (Task 2); `overlaps`, `pushOut` (Task 2); `GameInstance`, `GameModule`, `Pad` (`shell/game.ts`, Task 1); `stickVec`, `newPad` (`shell/pad.ts`); `HostToPhone` (Task 1); `rgba`, `PrimList`, `MAX_PRIMS` (`engine/kerf/prims.ts`); `mulberry32` (`bench/scene.ts`).
- Produces: `TwinStickGame` (public `t`, `ships`, `bullets`, `pickups` for tests), constants `ROUND_TICKS`, `VICTORY_TICKS`, `PLAYER_R`, `SPEED`, `MAX_HP`, `RESPAWN_TICKS`, `SHIELD_TICKS`, `PICKUP_EVERY`, `POWER_TICKS`, `GUNS`, `twinstick: GameModule` (`id: 'twinstick'`, `name: 'Twin-Stick Arena'`, `minPlayers: 2`).

- [ ] **Step 1: Write the failing tests**

`games/twinstick/twinstick.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MAX_PRIMS, PrimList } from '../../engine/kerf/prims';
import { newPad, type Pad } from '../../shell/pad';
import { SPAWNS } from './arena';
import {
  GUNS, MAX_HP, PICKUP_EVERY, PLAYER_R, POWER_TICKS, RESPAWN_TICKS, ROUND_TICKS, SHIELD_TICKS, SPEED,
  TwinStickGame, VICTORY_TICKS, twinstick,
} from './twinstick';

const P2 = [{ slot: 0, color: 1 }, { slot: 1, color: 2 }];
const RIGHT = 0, LEFT = 8;

// pad(move, aim): each is [dir 0-15, mag 0-3]
function pad(move?: [number, number], aim?: [number, number]): Pad {
  const p = newPad();
  if (move) p.left = { dir: move[0], mag: move[1] };
  if (aim) p.right = { dir: aim[0], mag: aim[1] };
  return p;
}

function game(players = P2) {
  const g = new TwinStickGame(players, 7);
  for (const s of g.ships) s.shieldUntil = 0;
  g.messages();
  return g;
}

const place = (g: TwinStickGame, slot: number, x: number, y: number) => Object.assign(g.ships.find((s) => s.slot === slot)!, { x, y });

describe('movement', () => {
  it('left stick moves at SPEED', () => {
    const g = game();
    place(g, 0, 300, 160);
    g.tick([pad([RIGHT, 3])]);
    expect(g.ships[0].x).toBeCloseTo(300 + SPEED);
  });

  it('walls stop ships', () => {
    const g = game();
    place(g, 0, 60, 160);
    for (let i = 0; i < 60; i++) g.tick([pad([LEFT, 3])]);
    expect(g.ships[0].x).toBeGreaterThanOrEqual(24 + PLAYER_R - 1e-6);
  });

  it('a player who left (no pad) stands still and keeps their score', () => {
    const g = game();
    place(g, 1, 500, 160);
    g.ships[1].score = 4;
    for (let i = 0; i < 30; i++) g.tick([pad([RIGHT, 3])]);
    expect(g.ships[1]).toMatchObject({ x: 500, y: 160, score: 4 });
  });
});

describe('shooting', () => {
  it('aiming fires at the gun cooldown', () => {
    const g = game();
    place(g, 0, 300, 160);
    g.tick([pad(undefined, [RIGHT, 3])]);
    expect(g.bullets).toHaveLength(1);
    for (let i = 1; i < GUNS.blaster.cooldown; i++) g.tick([pad(undefined, [RIGHT, 3])]);
    expect(g.bullets).toHaveLength(1);
    g.tick([pad(undefined, [RIGHT, 3])]);
    expect(g.bullets).toHaveLength(2);
  });

  it('bullets die on walls', () => {
    const g = game();
    place(g, 0, 60, 160);
    g.tick([pad(undefined, [LEFT, 3])]);
    for (let i = 0; i < 10; i++) g.tick([]);
    expect(g.bullets).toHaveLength(0);
  });

  it('three hits kill; the killer scores; the victim respawns shielded at the farthest spawn', () => {
    const g = game();
    place(g, 0, 300, 160);
    place(g, 1, 500, 160);
    for (let i = 0; i < 200 && g.ships[1].alive; i++) g.tick([pad(undefined, [RIGHT, 3])]);
    expect(g.ships[1].alive).toBe(false);
    expect(g.ships[0].score).toBe(1);
    for (let i = 0; i < RESPAWN_TICKS; i++) g.tick([]);
    const s1 = g.ships[1];
    expect(s1).toMatchObject({ alive: true, hp: MAX_HP, shieldUntil: g.t + SHIELD_TICKS });
    const far = SPAWNS.reduce((a, b) => (Math.hypot(b.x - 300, b.y - 160) > Math.hypot(a.x - 300, a.y - 160) ? b : a));
    expect([s1.x, s1.y]).toEqual([far.x, far.y]);
  });

  it('a hit buzzes the victim and updates its health HUD', () => {
    const g = game();
    place(g, 0, 300, 160);
    place(g, 1, 500, 160);
    for (let i = 0; i < 40 && g.ships[1].hp === MAX_HP; i++) g.tick([pad(undefined, [RIGHT, 3])]);
    const m = g.messages().filter((x) => x.to === 1);
    expect(m).toContainEqual({ to: 1, msg: { t: 'buzz', ms: 60 } });
    expect(m).toContainEqual({ to: 1, msg: { t: 'hud', hp: MAX_HP - 1, max: MAX_HP } });
  });

  it('a shielded ship takes no damage', () => {
    const g = game();
    place(g, 0, 300, 160);
    place(g, 1, 500, 160);
    g.ships[1].shieldUntil = 10_000;
    for (let i = 0; i < 90; i++) g.tick([pad(undefined, [RIGHT, 3])]);
    expect(g.ships[1].hp).toBe(MAX_HP);
  });
});

describe('pickups and weapons', () => {
  it('spawns a pickup every PICKUP_EVERY ticks; walking over it arms the weapon until it runs out', () => {
    const g = game();
    for (let i = 0; i < PICKUP_EVERY; i++) g.tick([]);
    expect(g.pickups).toHaveLength(1);
    const k = g.pickups[0];
    place(g, 0, k.x, k.y);
    g.tick([]);
    expect(g.pickups).toHaveLength(0);
    expect(g.ships[0].weapon).toBe(k.kind);
    for (let i = 0; i < POWER_TICKS; i++) g.tick([pad()]);
    expect(g.ships[0].weapon).toBe('blaster');
  });

  it('never has more than two pickups', () => {
    const g = game();
    for (let i = 0; i < PICKUP_EVERY * 5; i++) g.tick([]);
    expect(g.pickups).toHaveLength(2);
  });

  it('shotgun fires five pellets', () => {
    const g = game();
    place(g, 0, 300, 160);
    Object.assign(g.ships[0], { weapon: 'shotgun', weaponUntil: 10_000 });
    g.tick([pad(undefined, [RIGHT, 3])]);
    expect(g.bullets).toHaveLength(5);
  });

  it('a chicken that bounces back can kill its owner, costing a point', () => {
    const g = game();
    place(g, 0, 100, 160);
    const s = g.ships[0];
    Object.assign(s, { weapon: 'chicken', weaponUntil: 10_000, hp: 1 });
    g.tick([pad(undefined, [LEFT, 3])]);
    for (let i = 0; i < 60 && s.alive; i++) g.tick([]);
    expect(s.alive).toBe(false);
    expect(s.score).toBe(-1);
  });

  it('a boomerang hits on the way out and again on the way back', () => {
    const g = game();
    place(g, 0, 300, 160);
    place(g, 1, 450, 160);
    Object.assign(g.ships[0], { weapon: 'boomerang', weaponUntil: 10_000 });
    g.tick([pad(undefined, [RIGHT, 3])]);
    for (let i = 0; i < 80; i++) g.tick([]);
    expect(g.ships[1].hp).toBe(MAX_HP - 2);
  });
});

describe('round', () => {
  it('freezes for the victory lap and ends after it', () => {
    const g = game();
    g.t = ROUND_TICKS;
    place(g, 0, 300, 160);
    g.tick([pad([RIGHT, 3])]);
    expect(g.ships[0].x).toBe(300);
    expect(g.isOver()).toBe(false);
    for (let i = 1; i < VICTORY_TICKS; i++) g.tick([]);
    expect(g.isOver()).toBe(true);
  });

  it('a tied score still draws a victory lap', () => {
    const g = game();
    g.ships[0].score = 2;
    g.ships[1].score = 2;
    g.t = ROUND_TICKS;
    g.tick([]);
    const p = new PrimList();
    g.draw(p);
    expect(p.count).toBeGreaterThan(0);
  });

  it('result reports every ship score', () => {
    const g = game();
    g.ships[0].score = 3;
    g.ships[1].score = -1;
    expect(g.result()).toEqual([{ slot: 0, score: 3 }, { slot: 1, score: -1 }]);
  });

  it('8 players spamming shotguns stay under the shape limit', () => {
    const players = Array.from({ length: 8 }, (_, i) => ({ slot: i, color: i + 1 }));
    const g = new TwinStickGame(players, 3);
    for (const s of g.ships) Object.assign(s, { weapon: 'shotgun', weaponUntil: 1e9 });
    const pads = g.ships.map((_, i) => pad([(i * 2) % 16, 2], [(i * 2 + 8) % 16, 3]));
    const p = new PrimList();
    for (let i = 0; i < 600; i++) {
      g.tick(pads);
      p.clear();
      g.draw(p); // throws past MAX_PRIMS
    }
    expect(p.count).toBeLessThan(MAX_PRIMS);
  });

  it('module metadata', () => {
    expect(twinstick.meta).toEqual({ id: 'twinstick', name: 'Twin-Stick Arena', minPlayers: 2 });
    expect(twinstick.controls).toBe('twinstick');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- twinstick/twinstick`
Expected: FAIL — `Cannot find module './twinstick'`.

- [ ] **Step 3: Implement**

`games/twinstick/twinstick.ts`:
```ts
import { rgba, type PrimList } from '../../engine/kerf/prims';
import { mulberry32 } from '../../bench/scene';
import type { GameInstance, GameModule, Pad } from '../../shell/game';
import { stickVec } from '../../shell/pad';
import type { HostToPhone } from '../../shell/protocol';
import { PICKUP_SPOTS, SPAWNS, WALLS } from './arena';
import { overlaps, pushOut } from './physics';

export const ROUND_TICKS = 180 * 60;
export const VICTORY_TICKS = 90;
export const PLAYER_R = 18;
export const SPEED = 5.2;
export const MAX_HP = 3;
export const RESPAWN_TICKS = 120;
export const SHIELD_TICKS = 90;
export const PICKUP_EVERY = 600;
export const MAX_PICKUPS = 2;
export const POWER_TICKS = 480;
export const MAX_BULLETS = 1500; // keeps draw() under Kerf v1's 2048-shape limit
const HIT_FLASH = 8;
const PICKUP_R = 12;
const BOOMERANG_TURN = 30;
const CHICKEN_BOUNCES = 3;

export type Weapon = 'blaster' | 'shotgun' | 'chicken' | 'boomerang';
type Power = Exclude<Weapon, 'blaster'>;
const POWERS: Power[] = ['chicken', 'boomerang', 'shotgun'];

export const GUNS: Record<Weapon, { cooldown: number; speed: number; r: number; life: number }> = {
  blaster: { cooldown: 10, speed: 14, r: 4, life: 70 },
  shotgun: { cooldown: 26, speed: 13, r: 3.5, life: 28 },
  chicken: { cooldown: 30, speed: 7, r: 14, life: 150 },
  boomerang: { cooldown: 40, speed: 13, r: 6, life: 90 },
};

const WHITE = rgba(255, 255, 255);
const WALL = rgba(70, 90, 150);
const BEAK = rgba(255, 130, 40);
const POWER_COLOR: Record<Power, number> = { chicken: rgba(255, 220, 60), boomerang: rgba(220, 90, 255), shotgun: rgba(255, 130, 40) };

export interface Ship {
  slot: number; color: number; x: number; y: number; ax: number; ay: number;
  alive: boolean; hp: number; respawnAt: number; shieldUntil: number; cooldown: number;
  weapon: Weapon; weaponUntil: number; score: number; flashUntil: number; diedAt: number;
}
export interface Bullet { owner: number; x: number; y: number; vx: number; vy: number; r: number; life: number; age: number; kind: Weapon; bounces: number; hit: number[] }
export interface Pickup { x: number; y: number; kind: Power }

export class TwinStickGame implements GameInstance {
  t = 0;
  readonly ships: Ship[];
  bullets: Bullet[] = [];
  pickups: Pickup[] = [];
  private outbox: { to: number; msg: HostToPhone }[] = [];
  private rand: () => number;

  constructor(players: { slot: number; color: number }[], seed = 1) {
    this.rand = mulberry32(seed);
    this.ships = players.map((p, i) => {
      const sp = SPAWNS[i % SPAWNS.length];
      return {
        slot: p.slot, color: p.color, x: sp.x, y: sp.y, ax: 1, ay: 0, alive: true, hp: MAX_HP, respawnAt: 0,
        shieldUntil: SHIELD_TICKS, cooldown: 0, weapon: 'blaster', weaponUntil: 0, score: 0, flashUntil: 0, diedAt: -1,
      };
    });
    for (const s of this.ships) this.hud(s);
  }

  tick(pads: ReadonlyArray<Pad | undefined>): void {
    this.t++;
    if (this.t > ROUND_TICKS) return; // victory lap: the world freezes
    for (const s of this.ships) this.tickShip(s, pads[s.slot]);
    this.tickPickups();
    this.tickBullets();
  }

  isOver(): boolean {
    return this.t >= ROUND_TICKS + VICTORY_TICKS;
  }

  result(): { slot: number; score: number }[] {
    return this.ships.map((s) => ({ slot: s.slot, score: s.score }));
  }

  messages(): { to: number; msg: HostToPhone }[] {
    const m = this.outbox;
    this.outbox = [];
    return m;
  }

  draw(p: PrimList): void {
    const victory = this.t > ROUND_TICKS;
    const lead = this.leader();
    for (const w of WALLS) p.box(w.x, w.y, w.hw, w.hh, 6, victory ? lead.color : WALL, victory ? 24 : 10);
    for (const k of this.pickups) {
      p.circle(k.x, k.y, PICKUP_R * (1 + 0.15 * Math.sin(this.t * 0.15)), POWER_COLOR[k.kind], 34);
      p.circle(k.x, k.y, 4, WHITE);
    }
    for (const b of this.bullets) {
      if (b.kind === 'chicken') {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        p.circle(b.x, b.y, b.r, POWER_COLOR.chicken, 22);
        p.circle(b.x + (b.vx / sp) * b.r, b.y + (b.vy / sp) * b.r, 4, BEAK);
      } else if (b.kind === 'boomerang') {
        const dx = Math.cos(b.age * 0.5) * 10;
        const dy = Math.sin(b.age * 0.5) * 10;
        p.capsule(b.x - dx, b.y - dy, b.x + dx, b.y + dy, 4, this.colorOf(b.owner), 18);
      } else {
        p.capsule(b.x, b.y, b.x - b.vx * 1.6, b.y - b.vy * 1.6, b.r, this.colorOf(b.owner), 14);
      }
    }
    for (const s of this.ships) {
      if (!s.alive) {
        const age = this.t - s.diedAt;
        if (age < 30) {
          for (let i = 0; i < 12; i++) {
            const a = (i * Math.PI) / 6, r0 = age * 4, r1 = r0 + 10;
            p.capsule(s.x + Math.cos(a) * r0, s.y + Math.sin(a) * r0, s.x + Math.cos(a) * r1, s.y + Math.sin(a) * r1, 2, s.color, 12);
          }
        }
        continue;
      }
      const big = victory && s === lead ? 2 : 1;
      if (this.t < s.shieldUntil) p.circle(s.x, s.y, PLAYER_R * big + 7, WHITE, 20);
      p.circle(s.x, s.y, PLAYER_R * big, this.t < s.flashUntil ? WHITE : s.color, 34 * big);
      const gun = s.weapon === 'blaster' ? s.color : POWER_COLOR[s.weapon];
      p.capsule(s.x + s.ax * 12 * big, s.y + s.ay * 12 * big, s.x + s.ax * 30 * big, s.y + s.ay * 30 * big, 5, gun, 10);
    }
  }

  private tickShip(s: Ship, pad: Pad | undefined): void {
    if (!s.alive) {
      if (this.t >= s.respawnAt) this.respawn(s);
      return;
    }
    if (s.weapon !== 'blaster' && this.t >= s.weaponUntil) s.weapon = 'blaster';
    if (s.cooldown > 0) s.cooldown--;
    if (!pad) return; // player left: stands still
    const v = stickVec(pad.left);
    s.x += v.x * SPEED;
    s.y += v.y * SPEED;
    for (const w of WALLS) pushOut(s, PLAYER_R, w);
    const a = stickVec(pad.right);
    const m = Math.hypot(a.x, a.y);
    if (m > 0) {
      s.ax = a.x / m;
      s.ay = a.y / m;
      if (s.cooldown <= 0) this.fire(s);
    }
  }

  private fire(s: Ship): void {
    const g = GUNS[s.weapon];
    s.cooldown = g.cooldown;
    const spread = s.weapon === 'shotgun' ? [-0.35, -0.175, 0, 0.175, 0.35] : [0];
    const base = Math.atan2(s.ay, s.ax);
    for (const da of spread) {
      const dx = Math.cos(base + da), dy = Math.sin(base + da);
      this.bullets.push({
        owner: s.slot, x: s.x + dx * (PLAYER_R + 6), y: s.y + dy * (PLAYER_R + 6), vx: dx * g.speed, vy: dy * g.speed,
        r: g.r, life: g.life, age: 0, kind: s.weapon, bounces: 0, hit: [],
      });
    }
    if (this.bullets.length > MAX_BULLETS) this.bullets.splice(0, this.bullets.length - MAX_BULLETS);
  }

  private tickPickups(): void {
    if (this.t % PICKUP_EVERY === 0 && this.pickups.length < MAX_PICKUPS) {
      const free = PICKUP_SPOTS.filter((sp) => !this.pickups.some((q) => q.x === sp.x && q.y === sp.y));
      const spot = free[Math.floor(this.rand() * free.length)];
      this.pickups.push({ x: spot.x, y: spot.y, kind: POWERS[Math.floor(this.rand() * POWERS.length)] });
    }
    for (const s of this.ships) {
      if (!s.alive) continue;
      const i = this.pickups.findIndex((k) => Math.hypot(k.x - s.x, k.y - s.y) < PLAYER_R + PICKUP_R);
      if (i < 0) continue;
      s.weapon = this.pickups[i].kind;
      s.weaponUntil = this.t + POWER_TICKS;
      s.cooldown = 0;
      this.pickups.splice(i, 1);
      this.send(s.slot, { t: 'buzz', ms: 30 });
    }
  }

  private tickBullets(): void {
    const keep: Bullet[] = [];
    for (const b of this.bullets) {
      b.age++;
      b.life--;
      if (b.kind === 'boomerang' && b.age >= BOOMERANG_TURN) {
        if (b.age === BOOMERANG_TURN) b.hit = []; // the way back can hit again
        const o = this.ships.find((s) => s.slot === b.owner);
        if (o?.alive) {
          const dx = o.x - b.x, dy = o.y - b.y, d = Math.hypot(dx, dy);
          if (d < PLAYER_R) continue; // caught
          b.vx = (dx / d) * GUNS.boomerang.speed;
          b.vy = (dy / d) * GUNS.boomerang.speed;
        }
      }
      b.x += b.vx;
      b.y += b.vy;
      if (b.life <= 0) continue;
      if (b.kind !== 'boomerang' && this.hitWall(b)) continue; // the laser passes through walls
      if (this.hitShips(b)) continue;
      keep.push(b);
    }
    this.bullets = keep;
  }

  // True when the bullet is destroyed. Chickens bounce a few times first.
  private hitWall(b: Bullet): boolean {
    for (const w of WALLS) {
      if (!overlaps(b.x, b.y, b.r, w)) continue;
      if (b.kind !== 'chicken' || b.bounces >= CHICKEN_BOUNCES) return true;
      const n = pushOut(b, b.r, w);
      if (!n) continue;
      const dot = b.vx * n[0] + b.vy * n[1];
      if (dot < 0) {
        b.vx -= 2 * dot * n[0];
        b.vy -= 2 * dot * n[1];
      }
      b.bounces++;
    }
    return false;
  }

  // True when the bullet is used up.
  private hitShips(b: Bullet): boolean {
    for (const s of this.ships) {
      if (!s.alive || b.hit.includes(s.slot)) continue;
      if (s.slot === b.owner && !(b.kind === 'chicken' && b.bounces > 0)) continue;
      if (Math.hypot(s.x - b.x, s.y - b.y) >= b.r + PLAYER_R) continue;
      if (this.t >= s.shieldUntil) this.damage(s, b.owner);
      if (b.kind === 'boomerang') {
        b.hit.push(s.slot);
        continue;
      }
      return true; // a shield eats the shot too
    }
    return false;
  }

  private damage(s: Ship, by: number): void {
    s.hp--;
    s.flashUntil = this.t + HIT_FLASH;
    this.send(s.slot, { t: 'buzz', ms: 60 });
    if (s.hp <= 0) {
      s.alive = false;
      s.diedAt = this.t;
      s.respawnAt = this.t + RESPAWN_TICKS;
      if (by === s.slot) s.score -= 1;
      else {
        const k = this.ships.find((x) => x.slot === by);
        if (k) k.score += 1;
      }
      this.send(s.slot, { t: 'buzz', ms: 200 });
    }
    this.hud(s);
  }

  private respawn(s: Ship): void {
    const enemies = this.ships.filter((o) => o.alive && o !== s);
    let best = SPAWNS[0];
    let bestD = -1;
    for (const sp of SPAWNS) {
      const d = enemies.length ? Math.min(...enemies.map((o) => Math.hypot(o.x - sp.x, o.y - sp.y))) : 0;
      if (d > bestD) {
        bestD = d;
        best = sp;
      }
    }
    Object.assign(s, { x: best.x, y: best.y, alive: true, hp: MAX_HP, shieldUntil: this.t + SHIELD_TICKS, weapon: 'blaster', cooldown: 0 });
    this.hud(s);
  }

  private leader(): Ship {
    return this.ships.reduce((a, b) => (b.score > a.score ? b : a));
  }

  private colorOf(slot: number): number {
    return this.ships.find((s) => s.slot === slot)?.color ?? WHITE;
  }

  private send(to: number, msg: HostToPhone): void {
    this.outbox.push({ to, msg });
  }

  private hud(s: Ship): void {
    this.send(s.slot, { t: 'hud', hp: s.alive ? s.hp : 0, max: MAX_HP });
  }
}

export const twinstick: GameModule = {
  meta: { id: 'twinstick', name: 'Twin-Stick Arena', minPlayers: 2 },
  controls: 'twinstick',
  create: (players) => new TwinStickGame(players, Date.now() & 0xffff),
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- twinstick && npm run typecheck`
Expected: all twinstick tests PASS; typecheck clean. A failing test means fix the game, not the test — unless the test's own arithmetic is wrong, in which case ledger a ruling.

- [ ] **Step 5: Commit**

```bash
git add games/twinstick/twinstick.ts games/twinstick/twinstick.test.ts
git commit -m "feat(twinstick): twin-stick arena game"
```

---

### Task 4: Register it and play it

**Files:**
- Modify: `shell/host/main.ts`

**Interfaces:**
- Consumes: `twinstick` (Task 3).

- [ ] **Step 1: Register the game**

In `shell/host/main.ts` replace:
```ts
import { dots } from '../../games/dots/dots';
```
with:
```ts
import { dots } from '../../games/dots/dots';
import { twinstick } from '../../games/twinstick/twinstick';
```
and replace:
```ts
const GAMES: GameModule[] = [dots];
```
with:
```ts
const GAMES: GameModule[] = [twinstick, dots];
```

- [ ] **Step 2: Full suite + typecheck**

Run: `npm run test:unit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 3: End-to-end still green (light)**

Start `npm run dev` in the background. Run: `npm run e2e`
Expected: `PASS (room XXXX)` — the vote now offers two games; the test votes Dots and must still pass. Stop the dev server afterwards.

- [ ] **Step 4: Visual check (light, no GPU benchmark)**

With `npm run dev` running, open the TV page plus 2 phone pages in Playwright (as `e2e/arena.mjs` does), vote `[data-game=twinstick]`, drive phone 1's right stick with `window.__phone.stick(1, 0, 3)` for 2 s, take one TV screenshot, then close everything and stop the dev server. Expected: neon walls and cover blocks, two glowing ships with guns, a stream of glowing bullets; the HUD pips visible on phone 2 after it is hit. Report the screenshot to the Director.

- [ ] **Step 5: Commit**

```bash
git add shell/host/main.ts
git commit -m "feat(arena): offer Twin-Stick Arena in the vote"
```

- [ ] **Step 6: Real play (Director)**

`npm run dev`, open `localhost:5173` on the laptop, scan with 2+ phones on the same Wi-Fi, vote Twin-Stick Arena, play a round.
