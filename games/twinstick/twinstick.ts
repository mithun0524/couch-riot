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
// Worst-case draw: 2 shapes per bullet (chicken + beak) + ~135 others (walls, pickups, ships, death bursts) ≤ 2048.
export const MAX_BULLETS = 900;
const HIT_FLASH = 8;
const PICKUP_R = 12;
const BOOMERANG_TURN = 30;
const CHICKEN_BOUNCES = 3;
const CHICKEN_ARM_GAP = 24; // a rebound only counts once the chicken has had real room to come back at you

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
// `armed`: a chicken can only hit its owner once it has bounced and been clear of them since.
export interface Bullet { owner: number; x: number; y: number; vx: number; vy: number; r: number; life: number; age: number; kind: Weapon; bounces: number; hit: number[]; armed: boolean }
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
    for (const w of WALLS) p.box(w.x, w.y, w.hw, w.hh, 6, victory && lead ? lead.color : WALL, victory ? 24 : 10);
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
      const x = s.x + dx * (PLAYER_R + 6), y = s.y + dy * (PLAYER_R + 6);
      // A shot that would start inside a wall is blocked (the boomerang laser passes through walls).
      if (s.weapon !== 'boomerang' && WALLS.some((w) => overlaps(x, y, g.r, w))) continue;
      this.bullets.push({ owner: s.slot, x, y, vx: dx * g.speed, vy: dy * g.speed, r: g.r, life: g.life, age: 0, kind: s.weapon, bounces: 0, hit: [], armed: false });
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
      if (b.kind !== 'boomerang' && this.hitWall(b)) continue; // the boomerang laser passes through walls
      if (b.kind === 'chicken' && b.bounces > 0 && !b.armed) {
        const o = this.ships.find((s) => s.slot === b.owner);
        if (!o?.alive || Math.hypot(o.x - b.x, o.y - b.y) >= b.r + PLAYER_R + CHICKEN_ARM_GAP) b.armed = true;
      }
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
      if (s.slot === b.owner && !b.armed) continue;
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

  private leader(): Ship | undefined {
    return this.ships.reduce<Ship | undefined>((a, b) => (!a || b.score > a.score ? b : a), undefined);
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
