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

describe('review fixes', () => {
  it('a chicken fired into an adjacent wall never spawns, so it cannot hurt its owner or leave the map', () => {
    const g = game();
    place(g, 0, 42, 160);
    Object.assign(g.ships[0], { weapon: 'chicken', weaponUntil: 10_000 });
    for (let i = 0; i < 20; i++) g.tick([pad(undefined, [LEFT, 3])]);
    expect(g.ships[0].hp).toBe(MAX_HP);
    expect(g.bullets.every((b) => b.x > 0)).toBe(true);
  });

  it('a chicken that bounces off a nearby wall and passes back through its owner does not hit them', () => {
    const g = game();
    place(g, 0, 70, 160);
    Object.assign(g.ships[0], { weapon: 'chicken', weaponUntil: 10_000 });
    g.tick([pad(undefined, [LEFT, 3])]);
    for (let i = 0; i < 40; i++) g.tick([]);
    expect(g.ships[0].hp).toBe(MAX_HP);
  });

  it('8 players spamming chickens stay under the shape limit', () => {
    const players = Array.from({ length: 8 }, (_, i) => ({ slot: i, color: i + 1 }));
    const g = new TwinStickGame(players, 5);
    for (const s of g.ships) Object.assign(s, { weapon: 'chicken', weaponUntil: 1e9 });
    const pads = g.ships.map((_, i) => pad([(i * 2) % 16, 1], [(i * 2 + 8) % 16, 3]));
    const p = new PrimList();
    for (let i = 0; i < 900; i++) { g.tick(pads); p.clear(); g.draw(p); }
    expect(p.count).toBeLessThan(MAX_PRIMS);
  });

  it('a game with no players draws without throwing', () => {
    const g = new TwinStickGame([], 1);
    g.tick([]);
    expect(() => g.draw(new PrimList())).not.toThrow();
  });
});

