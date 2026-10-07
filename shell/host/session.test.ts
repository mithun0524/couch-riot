import { describe, expect, it } from 'vitest';
import type { HostOut } from '../protocol';
import { LOBBY_COUNTDOWN_MS, RESULTS_MS, Session, VOTE_MS, WHEEL_MS, type GameInfo } from './session';

const DOTS: GameInfo = { id: 'dots', name: 'Dots', minPlayers: 2 };
const ZAP: GameInfo = { id: 'zap', name: 'Zap', minPlayers: 2 };
const BIG: GameInfo = { id: 'big', name: 'Big', minPlayers: 5 };

const screensTo = (outs: HostOut[], to: number) =>
  outs.filter((o) => o.to === to && o.t === 'screen').map((o) => (o as Extract<HostOut, { t: 'screen' }>).screen);

function lobbyWith(n: number, games: GameInfo[] = [DOTS, ZAP]) {
  const s = new Session(games, () => 0);
  for (let i = 0; i < n; i++) s.join(i, `P${i}`, false, 0);
  return s;
}

function toVote(s: Session, now = 0) {
  for (const p of s.connected()) s.ready(p.slot, true, now);
  expect(s.phase).toBe('vote');
}

function toPlay(n = 3) {
  const s = lobbyWith(n, [DOTS]);
  toVote(s);
  for (const p of s.connected()) s.vote(p.slot, 'dots', 1);
  expect(s.phase).toBe('play');
  return s;
}

describe('lobby', () => {
  it('sends lobby screens to everyone on join', () => {
    const s = new Session([DOTS], () => 0);
    s.join(0, 'A', false, 0);
    const outs = s.join(1, 'B', false, 0);
    expect(screensTo(outs, 0)).toEqual(['lobby']);
    expect(screensTo(outs, 1)).toEqual(['lobby']);
  });

  it('all ready with 2+ players starts the vote', () => {
    const s = lobbyWith(2);
    s.ready(0, true, 0);
    expect(s.phase).toBe('lobby');
    const outs = s.ready(1, true, 5);
    expect(s.phase).toBe('vote');
    expect(outs.find((o) => o.to === 1)).toMatchObject({ t: 'screen', screen: 'vote', data: { msLeft: VOTE_MS, mine: null } });
  });

  it('a lone ready player starts nothing', () => {
    const s = lobbyWith(1);
    s.ready(0, true, 0);
    expect(s.phase).toBe('lobby');
    expect(s.countdownEndsAt).toBeNull();
  });

  it('majority ready starts a 15 s countdown that can be cancelled', () => {
    const s = lobbyWith(3);
    s.ready(0, true, 0);
    expect(s.countdownEndsAt).toBeNull();
    s.ready(1, true, 1000);
    expect(s.countdownEndsAt).toBe(1000 + LOBBY_COUNTDOWN_MS);
    s.tick(1000 + LOBBY_COUNTDOWN_MS - 1);
    expect(s.phase).toBe('lobby');
    s.ready(1, false, 2000);
    expect(s.countdownEndsAt).toBeNull();
    s.ready(1, true, 3000);
    s.tick(3000 + LOBBY_COUNTDOWN_MS);
    expect(s.phase).toBe('vote');
  });
});

describe('vote', () => {
  it('majority wins as soon as everyone voted', () => {
    const s = lobbyWith(3);
    toVote(s);
    s.vote(0, 'zap', 1);
    s.vote(1, 'zap', 2);
    const outs = s.vote(2, 'dots', 3);
    expect(s.phase).toBe('play');
    expect(s.currentGame).toBe('zap');
    expect(screensTo(outs, 2)).toContain('controller');
  });

  it('changing a vote replaces it', () => {
    const s = lobbyWith(3);
    toVote(s);
    s.vote(0, 'dots', 1);
    s.vote(0, 'zap', 2);
    expect(s.voteCounts().get('zap')).toBe(1);
    expect(s.voteCounts().get('dots')).toBeUndefined();
  });

  it('tie spins the wheel among tied games only, then plays the winner', () => {
    const s = lobbyWith(2, [DOTS, ZAP, { id: 'x', name: 'X', minPlayers: 2 }]);
    toVote(s);
    s.vote(0, 'zap', 1);
    s.vote(1, 'x', 2);
    expect(s.phase).toBe('vote');
    expect(s.wheel).toEqual({ options: ['zap', 'x'], winner: 'zap', endsAt: 2 + WHEEL_MS });
    expect(s.vote(0, 'dots', 3)).toEqual([]); // locked during the wheel
    s.tick(2 + WHEEL_MS);
    expect(s.phase).toBe('play');
    expect(s.currentGame).toBe('zap');
  });

  it('timeout with no votes spins among all eligible games', () => {
    const s = lobbyWith(2);
    toVote(s, 0);
    s.tick(VOTE_MS);
    expect(s.wheel?.options).toEqual(['dots', 'zap']);
  });

  it('timeout with some votes uses the votes cast', () => {
    const s = lobbyWith(3);
    toVote(s, 0);
    s.vote(0, 'zap', 1);
    s.tick(VOTE_MS);
    expect(s.phase).toBe('play');
    expect(s.currentGame).toBe('zap');
  });

  it('a single eligible game with no votes plays straight away', () => {
    const s = lobbyWith(2, [DOTS, BIG]);
    toVote(s, 0);
    s.tick(VOTE_MS);
    expect(s.phase).toBe('play');
    expect(s.currentGame).toBe('dots');
  });

  it('ignores votes for games the room is too small for', () => {
    const s = lobbyWith(2, [DOTS, BIG]);
    toVote(s);
    expect(s.vote(0, 'big', 1)).toEqual([]);
    expect(s.voteCounts().size).toBe(0);
  });

  it('ignores votes outside the vote phase', () => {
    const s = lobbyWith(2);
    expect(s.vote(0, 'dots', 0)).toEqual([]);
  });

  it('dropping below 2 players returns to the lobby', () => {
    const s = lobbyWith(2);
    toVote(s);
    const outs = s.leave(1, 5);
    expect(s.phase).toBe('lobby');
    expect(screensTo(outs, 0)).toEqual(['lobby']);
  });

  it('a leaver who had not voted lets the vote resolve', () => {
    const s = lobbyWith(3);
    toVote(s);
    s.vote(0, 'zap', 1);
    s.vote(1, 'zap', 2);
    s.leave(2, 3);
    expect(s.phase).toBe('play');
  });
});

describe('play and results', () => {
  it('marks connected players as playing', () => {
    const s = toPlay();
    expect(s.connected().every((p) => p.playing)).toBe(true);
  });

  it('mid-play joiner waits; a returning player gets the controller', () => {
    const s = toPlay(2);
    expect(screensTo(s.join(5, 'Late', false, 10), 5)).toEqual(['wait']);
    s.leave(1, 11);
    expect(s.phase).toBe('play');
    expect(screensTo(s.join(1, 'P1', true, 12), 1)).toEqual(['controller']);
  });

  it('ranks scores, awards 3/2/1 and shows results', () => {
    const s = toPlay(4);
    const outs = s.roundOver([{ slot: 0, score: 10 }, { slot: 1, score: 30 }, { slot: 2, score: 20 }, { slot: 3, score: 5 }], 100);
    expect(s.phase).toBe('results');
    expect(s.lastPlacings.map((p) => p.slot)).toEqual([1, 2, 0, 3]);
    expect([0, 1, 2, 3].map((i) => s.players.get(i)!.points)).toEqual([1, 3, 2, 0]);
    expect(outs.find((o) => o.to === 1)).toMatchObject({ screen: 'results', data: { place: 1, score: 30 } });
  });

  it('results lead to a new vote with the last game flagged', () => {
    const s = toPlay(2);
    s.roundOver([{ slot: 0, score: 1 }, { slot: 1, score: 2 }], 100);
    s.tick(100 + RESULTS_MS - 1);
    expect(s.phase).toBe('results');
    const outs = s.tick(100 + RESULTS_MS);
    expect(s.phase).toBe('vote');
    expect(outs.find((o) => o.to === 0)).toMatchObject({ data: { games: [{ id: 'dots', again: true }] } });
  });

  it('gone removes the player', () => {
    const s = lobbyWith(2);
    s.gone(1, 0);
    expect(s.players.has(1)).toBe(false);
  });
});

describe('review fixes', () => {
  const A: GameInfo = { id: 'a', name: 'A', minPlayers: 2 };
  const B: GameInfo = { id: 'b', name: 'B', minPlayers: 3 };

  it('votes for a game that stops being eligible are not counted', () => {
    const s = lobbyWith(3, [A, B]);
    toVote(s, 0);
    s.vote(0, 'b', 1);
    s.vote(1, 'b', 2);
    const outs = s.leave(1, 3);
    expect(outs.find((o) => o.to === 0)).toMatchObject({ screen: 'vote', data: { games: [{ id: 'a' }] } });
    s.tick(VOTE_MS);
    expect(s.phase).toBe('play');
    expect(s.currentGame).toBe('a');
  });

  it('tied scores share a place and its points', () => {
    const s = toPlay(4);
    s.roundOver([{ slot: 0, score: 10 }, { slot: 1, score: 5 }, { slot: 2, score: 5 }, { slot: 3, score: 1 }], 100);
    expect(s.lastPlacings.map((p) => [p.slot, p.place])).toEqual([[0, 1], [1, 2], [2, 2], [3, 4]]);
    expect([0, 1, 2, 3].map((i) => s.players.get(i)!.points)).toEqual([3, 2, 2, 0]);
  });

  it('everyone tied on zero all get first', () => {
    const s = toPlay(2);
    s.roundOver([{ slot: 0, score: 0 }, { slot: 1, score: 0 }], 100);
    expect(s.lastPlacings.map((p) => p.place)).toEqual([1, 1]);
    expect([0, 1].map((i) => s.players.get(i)!.points)).toEqual([3, 3]);
  });
});
