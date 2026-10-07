import { PALETTE_HEX, type HostOut, type ScreenMsg } from '../protocol';

export const LOBBY_COUNTDOWN_MS = 15_000;
export const VOTE_MS = 10_000;
export const WHEEL_MS = 3_000;
export const RESULTS_MS = 8_000;
const POINTS = [3, 2, 1];

export type Phase = 'lobby' | 'vote' | 'play' | 'results';
export interface Player { slot: number; name: string; connected: boolean; ready: boolean; vote: string | null; points: number; playing: boolean }
export interface GameInfo { id: string; name: string; minPlayers: number }
export interface Placing { slot: number; score: number; place: number }

const screen = (to: number, s: ScreenMsg): HostOut => ({ to, ...s });

// Pure: no timers, no I/O. The host feeds events + `now` and sends the returned messages.
export class Session {
  phase: Phase = 'lobby';
  readonly players = new Map<number, Player>();
  countdownEndsAt: number | null = null;
  voteEndsAt = 0;
  wheel: { options: string[]; winner: string; endsAt: number } | null = null;
  currentGame: string | null = null;
  lastGame: string | null = null;
  lastPlacings: Placing[] = [];
  resultsEndsAt = 0;

  constructor(readonly games: GameInfo[], private rand: () => number = Math.random) {}

  connected(): Player[] {
    return [...this.players.values()].filter((p) => p.connected).sort((a, b) => a.slot - b.slot);
  }

  eligible(): GameInfo[] {
    const n = this.connected().length;
    return this.games.filter((g) => g.minPlayers <= n);
  }

  voteCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of this.connected()) if (p.vote) counts.set(p.vote, (counts.get(p.vote) ?? 0) + 1);
    return counts;
  }

  join(slot: number, name: string, back: boolean, now: number): HostOut[] {
    const existing = this.players.get(slot);
    if (back && existing) existing.connected = true;
    else this.players.set(slot, { slot, name, connected: true, ready: false, vote: null, points: 0, playing: false });
    if (this.phase === 'lobby') return this.lobbyCheck(now);
    return [this.screenFor(slot, now), ...this.phaseCheck(now)];
  }

  leave(slot: number, now: number): HostOut[] {
    const p = this.players.get(slot);
    if (!p) return [];
    p.connected = false;
    p.ready = false;
    return this.phaseCheck(now);
  }

  gone(slot: number, now: number): HostOut[] {
    this.players.delete(slot);
    return this.phaseCheck(now);
  }

  ready(slot: number, v: boolean, now: number): HostOut[] {
    const p = this.players.get(slot);
    if (this.phase !== 'lobby' || !p) return [];
    p.ready = v;
    return this.lobbyCheck(now);
  }

  vote(slot: number, game: string, now: number): HostOut[] {
    const p = this.players.get(slot);
    if (this.phase !== 'vote' || this.wheel || !p?.connected) return [];
    if (!this.eligible().some((g) => g.id === game)) return [];
    p.vote = game;
    const outs = [this.voteScreen(slot, now)];
    if (this.connected().every((q) => q.vote !== null)) outs.push(...this.resolveVote(now));
    return outs;
  }

  roundOver(scores: { slot: number; score: number }[], now: number): HostOut[] {
    this.lastPlacings = [...scores].sort((a, b) => b.score - a.score).map((s, i) => ({ ...s, place: i + 1 }));
    this.lastPlacings.forEach((pl, i) => {
      const p = this.players.get(pl.slot);
      if (p && i < POINTS.length) p.points += POINTS[i];
    });
    this.phase = 'results';
    this.resultsEndsAt = now + RESULTS_MS;
    this.currentGame = null;
    for (const p of this.players.values()) p.playing = false;
    return this.connected().map((p) => this.screenFor(p.slot, now));
  }

  tick(now: number): HostOut[] {
    if (this.phase === 'lobby' && this.countdownEndsAt !== null && now >= this.countdownEndsAt) return this.startVote(now);
    if (this.phase === 'vote') {
      if (this.wheel) return now >= this.wheel.endsAt ? this.startPlay(this.wheel.winner) : [];
      if (now >= this.voteEndsAt) return this.resolveVote(now);
    }
    if (this.phase === 'results' && now >= this.resultsEndsAt) {
      return this.connected().length >= 2 ? this.startVote(now) : this.toLobby();
    }
    return [];
  }

  private phaseCheck(now: number): HostOut[] {
    const n = this.connected().length;
    switch (this.phase) {
      case 'lobby':
        return this.lobbyCheck(now);
      case 'vote':
        if (n < 2) return this.toLobby();
        if (!this.wheel && this.connected().every((p) => p.vote !== null)) return this.resolveVote(now);
        return [];
      case 'results':
        return n < 2 ? this.toLobby() : [];
      case 'play':
        return [];
    }
  }

  private lobbyCheck(now: number): HostOut[] {
    const c = this.connected();
    const r = c.filter((p) => p.ready).length;
    if (c.length >= 2 && r === c.length) return this.startVote(now);
    if (c.length >= 2 && r > c.length / 2) this.countdownEndsAt ??= now + LOBBY_COUNTDOWN_MS;
    else this.countdownEndsAt = null;
    return this.lobbyScreens();
  }

  private lobbyScreens(): HostOut[] {
    const c = this.connected();
    const players = c.map((q) => ({ name: q.name, color: PALETTE_HEX[q.slot], ready: q.ready }));
    return c.map((p) => screen(p.slot, { t: 'screen', screen: 'lobby', data: { ready: p.ready, players } }));
  }

  private startVote(now: number): HostOut[] {
    this.phase = 'vote';
    this.countdownEndsAt = null;
    this.wheel = null;
    this.voteEndsAt = now + VOTE_MS;
    for (const p of this.players.values()) {
      p.ready = false;
      p.vote = null;
    }
    return this.connected().map((p) => this.voteScreen(p.slot, now));
  }

  private voteScreen(slot: number, now: number): HostOut {
    const games = this.eligible().map((g) => ({ id: g.id, name: g.name, again: g.id === this.lastGame }));
    const msLeft = Math.max(0, this.voteEndsAt - now);
    return screen(slot, { t: 'screen', screen: 'vote', data: { games, msLeft, mine: this.players.get(slot)?.vote ?? null } });
  }

  private resolveVote(now: number): HostOut[] {
    const games = this.eligible();
    if (games.length === 0) return this.toLobby();
    const counts = this.voteCounts();
    let options = games.map((g) => g.id);
    if (counts.size > 0) {
      const top = Math.max(...counts.values());
      options = options.filter((id) => counts.get(id) === top);
    }
    if (options.length === 1) return this.startPlay(options[0]);
    this.wheel = { options, winner: options[Math.floor(this.rand() * options.length)], endsAt: now + WHEEL_MS };
    return [];
  }

  private startPlay(id: string): HostOut[] {
    this.phase = 'play';
    this.wheel = null;
    this.currentGame = id;
    this.lastGame = id;
    for (const p of this.players.values()) p.playing = p.connected;
    return this.connected().map((p) => screen(p.slot, { t: 'screen', screen: 'controller', data: { layout: 'twinstick' } }));
  }

  private toLobby(): HostOut[] {
    this.phase = 'lobby';
    this.countdownEndsAt = null;
    this.wheel = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.vote = null;
    }
    return this.lobbyScreens();
  }

  private screenFor(slot: number, now: number): HostOut {
    const p = this.players.get(slot);
    switch (this.phase) {
      case 'vote':
        return this.voteScreen(slot, now);
      case 'play':
        return p?.playing
          ? screen(slot, { t: 'screen', screen: 'controller', data: { layout: 'twinstick' } })
          : screen(slot, { t: 'screen', screen: 'wait', data: { reason: 'next-round' } });
      case 'results': {
        const pl = this.lastPlacings.find((x) => x.slot === slot);
        return pl
          ? screen(slot, { t: 'screen', screen: 'results', data: { place: pl.place, score: pl.score } })
          : screen(slot, { t: 'screen', screen: 'wait', data: { reason: 'next-round' } });
      }
      case 'lobby':
        return this.lobbyScreens().find((o) => o.to === slot)!;
    }
  }
}
