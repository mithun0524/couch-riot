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
