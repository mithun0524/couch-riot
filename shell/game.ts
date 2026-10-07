import { rgba, type PrimList } from '../engine/kerf/prims';
import type { Pad } from './pad';
import { PALETTE_HEX } from './protocol';

export type { Pad };

export interface GameModule {
  meta: { id: string; name: string; minPlayers: number };
  controls: 'twinstick';
  create(players: { slot: number; color: number }[]): GameInstance;
}

export interface GameInstance {
  tick(pads: ReadonlyArray<Pad | undefined>): void; // fixed 60 Hz, index = slot
  draw(prims: PrimList): void; // Kerf shapes, world 1600×900
  isOver(): boolean;
  result(): { slot: number; score: number }[];
}

export function colorRgba(slot: number): number {
  const h = PALETTE_HEX[slot];
  return rgba(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
}
