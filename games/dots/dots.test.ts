import { expect, it } from 'vitest';
import { PrimList } from '../../engine/kerf/prims';
import { newPad } from '../../shell/pad';
import { DotsGame, EDGE, ROUND_TICKS, SPEED, dots } from './dots';

const players = [{ slot: 0, color: 1 }, { slot: 3, color: 2 }];

it('left stick moves the dot and counts distance', () => {
  const g = new DotsGame(players);
  const pad = newPad();
  pad.left = { dir: 0, mag: 3 };
  const x0 = g.dots[0].x;
  g.tick([pad]);
  expect(g.dots[0].x).toBeCloseTo(x0 + SPEED);
  expect(g.result().find((r) => r.slot === 0)!.score).toBe(SPEED);
});

it('a missing pad stands still', () => {
  const g = new DotsGame(players);
  const { x, y } = g.dots[1];
  g.tick([]);
  expect(g.dots[1]).toMatchObject({ x, y, dist: 0 });
});

it('stays inside the arena', () => {
  const g = new DotsGame(players);
  const pad = newPad();
  pad.left = { dir: 0, mag: 3 };
  for (let i = 0; i < 600; i++) g.tick([pad]);
  expect(g.dots[0].x).toBe(1600 - EDGE);
});

it('ends after ROUND_TICKS', () => {
  const g = new DotsGame(players);
  for (let i = 0; i < ROUND_TICKS - 1; i++) g.tick([]);
  expect(g.isOver()).toBe(false);
  g.tick([]);
  expect(g.isOver()).toBe(true);
});

it('draws a circle per dot and an aim line when aiming', () => {
  const g = new DotsGame(players);
  const pad = newPad();
  pad.right = { dir: 4, mag: 3 };
  g.tick([pad]);
  const p = new PrimList();
  g.draw(p);
  expect(p.count).toBe(3);
});

it('module metadata', () => {
  expect(dots.meta).toEqual({ id: 'dots', name: 'Dots', minPlayers: 2 });
  expect(dots.create(players).isOver()).toBe(false);
});
