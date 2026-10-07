import type { PrimList } from '../../engine/kerf/prims';
import type { GameInstance, GameModule, Pad } from '../../shell/game';
import { stickVec } from '../../shell/pad';

export const SPEED = 6; // world units per tick at full stick
export const ROUND_TICKS = 30 * 60;
export const EDGE = 30;
const W = 1600;
const H = 900;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Dot { slot: number; color: number; x: number; y: number; ax: number; ay: number; dist: number }

// Throwaway test game: proves input → tick → draw → results end to end.
export class DotsGame implements GameInstance {
  readonly dots: Dot[];
  private t = 0;

  constructor(players: { slot: number; color: number }[]) {
    this.dots = players.map((p, i) => {
      const a = (i / players.length) * Math.PI * 2;
      return { slot: p.slot, color: p.color, x: W / 2 + Math.cos(a) * 250, y: H / 2 + Math.sin(a) * 250, ax: 0, ay: 0, dist: 0 };
    });
  }

  tick(pads: ReadonlyArray<Pad | undefined>): void {
    this.t++;
    for (const d of this.dots) {
      const pad = pads[d.slot];
      if (!pad) continue;
      const v = stickVec(pad.left);
      const nx = clamp(d.x + v.x * SPEED, EDGE, W - EDGE);
      const ny = clamp(d.y + v.y * SPEED, EDGE, H - EDGE);
      d.dist += Math.hypot(nx - d.x, ny - d.y);
      d.x = nx;
      d.y = ny;
      const a = stickVec(pad.right);
      const m = Math.hypot(a.x, a.y);
      d.ax = m ? a.x / m : 0;
      d.ay = m ? a.y / m : 0;
    }
  }

  draw(p: PrimList): void {
    for (const d of this.dots) {
      p.circle(d.x, d.y, 22, d.color, 40);
      if (d.ax || d.ay) p.capsule(d.x + d.ax * 32, d.y + d.ay * 32, d.x + d.ax * 56, d.y + d.ay * 56, 4, d.color, 12);
    }
  }

  isOver(): boolean {
    return this.t >= ROUND_TICKS;
  }

  result(): { slot: number; score: number }[] {
    return this.dots.map((d) => ({ slot: d.slot, score: Math.round(d.dist) }));
  }
}

export const dots: GameModule = {
  meta: { id: 'dots', name: 'Dots', minPlayers: 2 },
  controls: 'twinstick',
  create: (players) => new DotsGame(players),
};
