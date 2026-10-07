# Arena Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phones join a room on the TV by QR, ready up, vote, play the Dots test game with a floating twin-stick controller, see results, and loop — all over local Wi-Fi.

**Architecture:** A Cloudflare Durable Object (run locally by `wrangler dev`) holds only membership and relays messages; its logic lives in a pure `RoomCore` class. The TV page owns all session state through a pure `Session` state machine, runs games at a fixed 60 Hz and draws them with Kerf. Phones are thin: they render whatever screen the host sends and emit 1-byte input events.

**Tech Stack:** TypeScript, Vite 6, Vitest 3, Kerf (existing), Cloudflare Workers + Durable Objects via `wrangler` 4, `qrcode`, Playwright for end-to-end.

**Spec:** `docs/superpowers/specs/2026-10-07-arena-shell-design.md` (parent: `2026-10-07-kerf-couch-riot-design.md`)

## Global Constraints

- Local Wi-Fi only: Vite on `0.0.0.0:5173`, wrangler on `0.0.0.0:8787`. No deploy.
- Room server holds membership only; host page is the single source of truth for session state.
- Max 8 players; room codes are 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ`.
- Slot hold after disconnect: 60 s.
- Phone input: 1 byte per event, sent only on change; frames of 1–16 bytes, anything else dropped.
- Timers sent to phones are `msLeft`, never timestamps.
- Lobby countdown 15 s, vote 10 s, tie wheel 3 s, results 8 s, Dots round 30 s; points 3/2/1.
- Names trimmed and capped at 12 characters; duplicates suffixed (`Sam 2`); blank → `Player`.
- No UI framework; plain HTML/CSS/TS.

## Review Focus

1. A phone that reconnects (new socket) and whose old socket's close event fires late must not be marked as left → test in Task 2.
2. The TV refreshing must kick every phone with `host-gone` and leave no stale slots → test in Task 2.
3. A player who drops mid-round must stand still, not keep running with their last stick input → host resets their pad on `leave` (Task 8), and the end-to-end test releases the stick and checks the dot stops (Task 9).
4. Votes cast during the tie wheel or for a game too big for the room must be ignored → tests in Task 4.
5. Hostile phone input (bad JSON, oversized frames, empty frames) must never reach the host → tests in Task 2.

## File Structure

```
vite.config.ts               LAN IP injection, dev server on all interfaces, multi-page build
index.html                   TV page
play.html                    phone page
server/
  room-core.ts (+ .test.ts)  pure membership + routing logic
  room.ts                    Durable Object adapter around RoomCore
  worker.ts                  HTTP entry: POST /room, WS upgrade
  wrangler.toml, tsconfig.json
  smoke.mjs                  live check against wrangler dev
shell/
  protocol.ts (+ .test.ts)   message types, input bytes, parsers, palette, room codes
  pad.ts (+ .test.ts)        controller state on the host
  game.ts (+ .test.ts)       game contract + colorRgba
  env.d.ts                   __LAN_HOST__ declaration
  host/session.ts (+ .test.ts)  lobby/vote/play/results state machine
  host/overlay.ts            TV HTML overlay
  host/main.ts, host/host.css
  phone/stick.ts (+ .test.ts)   thumb offset → dir/mag
  phone/controller.ts        floating twin-stick DOM
  phone/main.ts, phone/phone.css
games/dots/dots.ts (+ .test.ts)
e2e/arena.mjs                Playwright: TV + 3 phones full loop
```

---

### Task 1: Protocol

**Files:**
- Create: `shell/protocol.ts`, `shell/protocol.test.ts`
- Modify: `tsconfig.json` (include `shell`, `games`)

**Interfaces:**
- Produces:
  - `MAX_PLAYERS = 8`, `MAX_INPUT_FRAME = 16`, `PALETTE_HEX: readonly string[8]`, `CODE_ALPHABET`
  - `newRoomCode(rand?: () => number): string`, `isRoomCode(s: string): boolean`
  - `type Stick = 0 | 1`, `encodeStick(stick, dir, mag): number`, `encodeButton(id, down): number`, `decodeInput(b): InputEvent`
  - Types `ScreenMsg`, `HostToPhone`, `HostOut` (= `{ to: number | 'all' } & HostToPhone`), `RoomToPhone`, `PhoneToHost`, `RoomToHost`
  - `parsePhoneMsg(s: string): PhoneToHost | null`, `parseHostOut(s: string): { to: number | 'all'; msg: HostToPhone } | null`

- [ ] **Step 1: Widen the TS include**

In `tsconfig.json` change `"include": ["engine", "bench"]` to:
```json
  "include": ["engine", "bench", "shell", "games"]
```

- [ ] **Step 2: Write the failing tests**

`shell/protocol.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, PALETTE_HEX, decodeInput, encodeButton, encodeStick, isRoomCode, newRoomCode,
  parseHostOut, parsePhoneMsg, type Stick,
} from './protocol';

describe('input bytes', () => {
  it('stick bytes round-trip for every dir, mag and stick', () => {
    for (const stick of [0, 1] as Stick[])
      for (let dir = 0; dir < 16; dir++)
        for (let mag = 0; mag < 4; mag++) {
          const b = encodeStick(stick, dir, mag);
          expect(b).toBeLessThan(0x80);
          expect(decodeInput(b)).toEqual({ kind: 'stick', stick, dir, mag });
        }
  });

  it('button bytes round-trip for ids 0-63 down and up', () => {
    for (let id = 0; id < 64; id++)
      for (const down of [true, false]) {
        const b = encodeButton(id, down);
        expect(b).toBeGreaterThanOrEqual(0x80);
        expect(decodeInput(b)).toEqual({ kind: 'button', id, down });
      }
  });
});

describe('room codes', () => {
  it('are 4 letters without I or O', () => {
    expect(CODE_ALPHABET).not.toMatch(/[IO]/);
    let i = 0;
    const code = newRoomCode(() => (i++ % 24) / 24);
    expect(code).toBe('ABCD');
    expect(isRoomCode(code)).toBe(true);
    expect(isRoomCode('ABCI')).toBe(false);
    expect(isRoomCode('abcd')).toBe(false);
    expect(isRoomCode('ABCDE')).toBe(false);
  });
});

describe('parsePhoneMsg', () => {
  it('accepts ready and vote', () => {
    expect(parsePhoneMsg('{"t":"ready","v":true}')).toEqual({ t: 'ready', v: true });
    expect(parsePhoneMsg('{"t":"vote","game":"dots"}')).toEqual({ t: 'vote', game: 'dots' });
  });

  it('strips extra fields', () => {
    expect(parsePhoneMsg('{"t":"ready","v":false,"slot":7}')).toEqual({ t: 'ready', v: false });
  });

  it('rejects junk', () => {
    for (const s of ['', 'nope', '[]', 'null', '{"t":"ready"}', '{"t":"ready","v":"yes"}',
      '{"t":"vote","game":""}', `{"t":"vote","game":"${'x'.repeat(33)}"}`, '{"t":"join"}'])
      expect(parsePhoneMsg(s)).toBeNull();
  });
});

describe('parseHostOut', () => {
  it('splits target from message', () => {
    expect(parseHostOut('{"to":3,"t":"buzz","ms":40}')).toEqual({ to: 3, msg: { t: 'buzz', ms: 40 } });
    expect(parseHostOut('{"to":"all","t":"screen","screen":"wait","data":{"reason":"next-round"}}'))
      .toEqual({ to: 'all', msg: { t: 'screen', screen: 'wait', data: { reason: 'next-round' } } });
  });

  it('rejects bad targets and unknown types', () => {
    for (const s of ['{"to":8,"t":"buzz","ms":1}', '{"to":-1,"t":"buzz","ms":1}', '{"to":1.5,"t":"buzz","ms":1}',
      '{"t":"buzz","ms":1}', '{"to":0,"t":"welcome"}', 'x'])
      expect(parseHostOut(s)).toBeNull();
  });
});

it('palette has 8 colors', () => {
  expect(PALETTE_HEX).toHaveLength(8);
  for (const c of PALETTE_HEX) expect(c).toMatch(/^#[0-9a-f]{6}$/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:unit -- protocol`
Expected: FAIL — `Cannot find module './protocol'`.

- [ ] **Step 4: Implement**

`shell/protocol.ts`:
```ts
export const MAX_PLAYERS = 8;
export const MAX_INPUT_FRAME = 16;
export const PALETTE_HEX = ['#ff3c5a', '#3cc8ff', '#78ff5a', '#ffc828', '#c85aff', '#ff8228', '#28ffc8', '#ffffff'] as const;

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export function isRoomCode(s: string): boolean {
  return /^[A-HJ-NP-Z]{4}$/.test(s);
}

// ---- 1-byte input events (phone -> host) ----
export type Stick = 0 | 1;
export type InputEvent =
  | { kind: 'stick'; stick: Stick; dir: number; mag: number }
  | { kind: 'button'; id: number; down: boolean };

export function encodeStick(stick: Stick, dir: number, mag: number): number {
  return (stick << 6) | ((mag & 3) << 4) | (dir & 15);
}

export function encodeButton(id: number, down: boolean): number {
  return 0x80 | (down ? 0x40 : 0) | (id & 63);
}

export function decodeInput(b: number): InputEvent {
  if (b & 0x80) return { kind: 'button', id: b & 63, down: (b & 0x40) !== 0 };
  return { kind: 'stick', stick: ((b >> 6) & 1) as Stick, dir: b & 15, mag: (b >> 4) & 3 };
}

// ---- JSON messages ----
export type ScreenMsg =
  | { t: 'screen'; screen: 'lobby'; data: { ready: boolean; players: { name: string; color: string; ready: boolean }[] } }
  | { t: 'screen'; screen: 'vote'; data: { games: { id: string; name: string; again: boolean }[]; msLeft: number; mine: string | null } }
  | { t: 'screen'; screen: 'controller'; data: { layout: 'twinstick' } }
  | { t: 'screen'; screen: 'results'; data: { place: number; score: number } }
  | { t: 'screen'; screen: 'wait'; data: { reason: 'next-round' } };
export type HostToPhone = ScreenMsg | { t: 'buzz'; ms: number };
export type HostOut = { to: number | 'all' } & HostToPhone;

export type RoomToPhone =
  | { t: 'welcome'; slot: number; token: string; color: string }
  | { t: 'host-gone' }
  | { t: 'error'; code: 'room-full' | 'no-room' };

export type PhoneToHost = { t: 'ready'; v: boolean } | { t: 'vote'; game: string };

export type RoomToHost =
  | { t: 'join'; slot: number; name: string; back: boolean }
  | { t: 'leave'; slot: number }
  | { t: 'gone'; slot: number }
  | (PhoneToHost & { slot: number });

function json(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parsePhoneMsg(s: string): PhoneToHost | null {
  const v = json(s);
  if (!isObj(v)) return null;
  if (v.t === 'ready' && typeof v.v === 'boolean') return { t: 'ready', v: v.v };
  if (v.t === 'vote' && typeof v.game === 'string' && v.game.length > 0 && v.game.length <= 32) return { t: 'vote', game: v.game };
  return null;
}

// Host is our own page, so this is a routing check, not deep validation.
export function parseHostOut(s: string): { to: number | 'all'; msg: HostToPhone } | null {
  const v = json(s);
  if (!isObj(v)) return null;
  const { to, ...msg } = v;
  const okTo = to === 'all' || (Number.isInteger(to) && (to as number) >= 0 && (to as number) < MAX_PLAYERS);
  if (!okTo || (msg.t !== 'screen' && msg.t !== 'buzz')) return null;
  return { to: to as number | 'all', msg: msg as HostToPhone };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:unit -- protocol && npm run typecheck`
Expected: all protocol tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add tsconfig.json shell/protocol.ts shell/protocol.test.ts
git commit -m "feat(shell): wire protocol — input bytes, messages, parsers"
```

---

### Task 2: RoomCore (membership + routing)

**Files:**
- Create: `server/room-core.ts`, `server/room-core.test.ts`

**Interfaces:**
- Consumes: `MAX_PLAYERS`, `MAX_INPUT_FRAME`, `PALETTE_HEX`, `parsePhoneMsg`, `parseHostOut` (Task 1).
- Produces:
  - `HOLD_MS = 60_000`
  - `interface Conn { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void }`
  - `interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }`
  - `class RoomCore { constructor(timers: Timers, makeToken?: () => string); get hasHost(): boolean; attachHost(c: Conn): boolean; hostMessage(data: string): void; hostClosed(): void; attachPhone(c: Conn, name: string, token: string | null): number | null; phoneMessage(slot: number, data: string | Uint8Array): void; phoneClosed(slot: number, c: Conn): void }`

- [ ] **Step 1: Write the failing tests**

`server/room-core.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HOLD_MS, RoomCore, type Conn, type Timers } from './room-core';

class FakeConn implements Conn {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(d: string | Uint8Array) { this.sent.push(d); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  json() { return this.sent.filter((x): x is string => typeof x === 'string').map((x) => JSON.parse(x)); }
  last() { return this.json().at(-1); }
  bins() { return this.sent.filter((x): x is Uint8Array => typeof x !== 'string').map((x) => [...x]); }
}

class FakeTimers implements Timers {
  private n = 0;
  pending = new Map<number, { fn: () => void; ms: number }>();
  set = (fn: () => void, ms: number) => { this.pending.set(++this.n, { fn, ms }); return this.n; };
  clear = (h: unknown) => { this.pending.delete(h as number); };
  fireAll() { const all = [...this.pending.values()]; this.pending.clear(); all.forEach((t) => t.fn()); }
}

function setup() {
  const timers = new FakeTimers();
  let t = 0;
  const room = new RoomCore(timers, () => `tok${++t}`);
  const host = new FakeConn();
  expect(room.attachHost(host)).toBe(true);
  return { room, host, timers };
}

describe('host', () => {
  it('phones are refused before a host attaches', () => {
    const room = new RoomCore(new FakeTimers());
    const p = new FakeConn();
    expect(room.attachPhone(p, 'A', null)).toBeNull();
    expect(p.last()).toEqual({ t: 'error', code: 'no-room' });
    expect(p.closed?.code).toBe(4001);
  });

  it('only one host per room', () => {
    const { room } = setup();
    expect(room.hasHost).toBe(true);
    expect(room.attachHost(new FakeConn())).toBe(false);
  });

  it('host leaving kicks every phone and resets the room', () => {
    const { room, host } = setup();
    const a = new FakeConn(), b = new FakeConn();
    room.attachPhone(a, 'A', null);
    room.attachPhone(b, 'B', null);
    room.phoneClosed(1, b); // b is in its hold window
    room.hostClosed();
    expect(a.last()).toEqual({ t: 'host-gone' });
    expect(a.closed).not.toBeNull();
    expect(room.hasHost).toBe(false);
    const host2 = new FakeConn();
    expect(room.attachHost(host2)).toBe(true);
    expect(room.attachPhone(new FakeConn(), 'C', 'tok1')).toBe(0); // old token no longer valid, fresh slot 0
    expect(host2.last()).toMatchObject({ t: 'join', slot: 0, back: false });
    void host;
  });
});

describe('joining', () => {
  it('assigns slots in order and announces them', () => {
    const { room, host } = setup();
    const a = new FakeConn(), b = new FakeConn();
    expect(room.attachPhone(a, 'Ana', null)).toBe(0);
    expect(room.attachPhone(b, 'Bo', null)).toBe(1);
    expect(a.last()).toEqual({ t: 'welcome', slot: 0, token: 'tok1', color: '#ff3c5a' });
    expect(host.json()).toEqual([
      { t: 'join', slot: 0, name: 'Ana', back: false },
      { t: 'join', slot: 1, name: 'Bo', back: false },
    ]);
  });

  it('9th phone gets room-full', () => {
    const { room } = setup();
    for (let i = 0; i < 8; i++) room.attachPhone(new FakeConn(), `P${i}`, null);
    const p = new FakeConn();
    expect(room.attachPhone(p, 'Late', null)).toBeNull();
    expect(p.last()).toEqual({ t: 'error', code: 'room-full' });
  });

  it('cleans names: trim, cap at 12, blank, duplicates', () => {
    const { room, host } = setup();
    room.attachPhone(new FakeConn(), '  Sam  ', null);
    room.attachPhone(new FakeConn(), 'Sam', null);
    room.attachPhone(new FakeConn(), 'Sam', null);
    room.attachPhone(new FakeConn(), 'Abcdefghijklmnop', null);
    room.attachPhone(new FakeConn(), '   ', null);
    room.attachPhone(new FakeConn(), 'Abcdefghijkl', null);
    expect(host.json().map((m) => m.name)).toEqual(['Sam', 'Sam 2', 'Sam 3', 'Abcdefghijkl', 'Player', 'Abcdefghij 2']);
  });
});

describe('routing', () => {
  it('phone input bytes reach the host prefixed with the slot', () => {
    const { room, host } = setup();
    room.attachPhone(new FakeConn(), 'A', null);
    room.attachPhone(new FakeConn(), 'B', null);
    room.phoneMessage(1, new Uint8Array([0x13, 0x95]));
    expect(host.bins()).toEqual([[1, 0x13, 0x95]]);
  });

  it('drops empty and oversized input frames', () => {
    const { room, host } = setup();
    room.attachPhone(new FakeConn(), 'A', null);
    room.phoneMessage(0, new Uint8Array([]));
    room.phoneMessage(0, new Uint8Array(17));
    expect(host.bins()).toEqual([]);
  });

  it('phone JSON reaches the host with slot; junk is dropped', () => {
    const { room, host } = setup();
    room.attachPhone(new FakeConn(), 'A', null);
    const before = host.json().length;
    room.phoneMessage(0, '{"t":"ready","v":true}');
    room.phoneMessage(0, '{"t":"ready","v":"x"}');
    room.phoneMessage(0, 'garbage');
    room.phoneMessage(0, '{"t":"welcome","slot":3}');
    expect(host.json().slice(before)).toEqual([{ t: 'ready', v: true, slot: 0 }]);
  });

  it('host messages go to one phone or all, without the target field', () => {
    const { room } = setup();
    const a = new FakeConn(), b = new FakeConn();
    room.attachPhone(a, 'A', null);
    room.attachPhone(b, 'B', null);
    room.hostMessage('{"to":1,"t":"buzz","ms":30}');
    expect(b.last()).toEqual({ t: 'buzz', ms: 30 });
    expect(a.last().t).toBe('welcome');
    room.hostMessage('{"to":"all","t":"buzz","ms":5}');
    expect(a.last()).toEqual({ t: 'buzz', ms: 5 });
    expect(b.last()).toEqual({ t: 'buzz', ms: 5 });
    room.hostMessage('{"to":9,"t":"buzz","ms":5}');
    room.hostMessage('not json');
    expect(a.json()).toHaveLength(2);
  });
});

describe('disconnect and reconnect', () => {
  it('reconnect within the hold keeps the slot', () => {
    const { room, host, timers } = setup();
    const a = new FakeConn();
    room.attachPhone(a, 'Ana', null);
    room.phoneClosed(0, a);
    expect(host.last()).toEqual({ t: 'leave', slot: 0 });
    expect([...timers.pending.values()][0].ms).toBe(HOLD_MS);
    const a2 = new FakeConn();
    expect(room.attachPhone(a2, 'whatever', 'tok1')).toBe(0);
    expect(host.last()).toEqual({ t: 'join', slot: 0, name: 'Ana', back: true });
    expect(timers.pending.size).toBe(0);
  });

  it('after the hold the slot is freed and the host hears gone', () => {
    const { room, host, timers } = setup();
    const a = new FakeConn();
    room.attachPhone(a, 'Ana', null);
    room.phoneClosed(0, a);
    timers.fireAll();
    expect(host.last()).toEqual({ t: 'gone', slot: 0 });
    expect(room.attachPhone(new FakeConn(), 'New', 'tok1')).toBe(0);
    expect(host.last()).toMatchObject({ name: 'New', back: false });
  });

  it("a late close from a replaced socket is ignored", () => {
    const { room, host, timers } = setup();
    const a = new FakeConn();
    room.attachPhone(a, 'Ana', null);
    const a2 = new FakeConn();
    room.attachPhone(a2, 'Ana', 'tok1'); // same phone, new socket, old one not closed yet
    expect(a.closed).not.toBeNull();
    const n = host.json().length;
    room.phoneClosed(0, a); // old socket's close event arrives late
    expect(host.json()).toHaveLength(n);
    expect(timers.pending.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- room-core`
Expected: FAIL — `Cannot find module './room-core'`.

- [ ] **Step 3: Implement**

`server/room-core.ts`:
```ts
import { MAX_INPUT_FRAME, MAX_PLAYERS, PALETTE_HEX, parseHostOut, parsePhoneMsg } from '../shell/protocol';

export const HOLD_MS = 60_000;
const NAME_MAX = 12;

export interface Conn {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface Slot { name: string; token: string; conn: Conn | null; hold: unknown }

export class RoomCore {
  private host: Conn | null = null;
  private slots: (Slot | null)[] = Array(MAX_PLAYERS).fill(null);

  constructor(private timers: Timers, private makeToken: () => string = () => crypto.randomUUID()) {}

  get hasHost(): boolean {
    return this.host !== null;
  }

  attachHost(conn: Conn): boolean {
    if (this.host) return false;
    this.host = conn;
    return true;
  }

  hostClosed(): void {
    for (const s of this.slots) {
      if (!s) continue;
      if (s.hold !== null) this.timers.clear(s.hold);
      s.conn?.send(JSON.stringify({ t: 'host-gone' }));
      s.conn?.close(1000, 'host-gone');
    }
    this.slots.fill(null);
    this.host = null;
  }

  hostMessage(data: string): void {
    const out = parseHostOut(data);
    if (!out) return;
    const json = JSON.stringify(out.msg);
    if (out.to === 'all') for (const s of this.slots) s?.conn?.send(json);
    else this.slots[out.to]?.conn?.send(json);
  }

  attachPhone(conn: Conn, rawName: string, token: string | null): number | null {
    if (!this.host) return this.reject(conn, 'no-room');
    let slot = token ? this.slots.findIndex((s) => s?.token === token) : -1;
    const back = slot >= 0;
    if (back) {
      const s = this.slots[slot]!;
      if (s.hold !== null) this.timers.clear(s.hold);
      s.hold = null;
      s.conn?.close(1000, 'replaced');
      s.conn = conn;
    } else {
      slot = this.slots.indexOf(null);
      if (slot < 0) return this.reject(conn, 'room-full');
      this.slots[slot] = { name: this.uniqueName(rawName), token: this.makeToken(), conn, hold: null };
    }
    const s = this.slots[slot]!;
    conn.send(JSON.stringify({ t: 'welcome', slot, token: s.token, color: PALETTE_HEX[slot] }));
    this.host.send(JSON.stringify({ t: 'join', slot, name: s.name, back }));
    return slot;
  }

  phoneMessage(slot: number, data: string | Uint8Array): void {
    if (!this.host || !this.slots[slot]) return;
    if (typeof data === 'string') {
      const msg = parsePhoneMsg(data);
      if (msg) this.host.send(JSON.stringify({ ...msg, slot }));
      return;
    }
    if (data.length < 1 || data.length > MAX_INPUT_FRAME) return;
    const frame = new Uint8Array(data.length + 1);
    frame[0] = slot;
    frame.set(data, 1);
    this.host.send(frame);
  }

  phoneClosed(slot: number, conn: Conn): void {
    const s = this.slots[slot];
    if (!s || s.conn !== conn) return; // replaced socket or already gone
    s.conn = null;
    this.host?.send(JSON.stringify({ t: 'leave', slot }));
    s.hold = this.timers.set(() => {
      this.slots[slot] = null;
      this.host?.send(JSON.stringify({ t: 'gone', slot }));
    }, HOLD_MS);
  }

  private reject(conn: Conn, code: 'no-room' | 'room-full'): null {
    conn.send(JSON.stringify({ t: 'error', code }));
    conn.close(4001, code);
    return null;
  }

  private uniqueName(raw: string): string {
    const base = raw.trim().slice(0, NAME_MAX) || 'Player';
    const taken = new Set(this.slots.filter((s): s is Slot => s !== null).map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const name = base.slice(0, NAME_MAX - suffix.length) + suffix;
      if (!taken.has(name)) return name;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- room-core`
Expected: all 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/room-core.ts server/room-core.test.ts
git commit -m "feat(server): RoomCore membership, slot hold and routing"
```

---

### Task 3: Worker + Durable Object + dev script

**Files:**
- Create: `server/room.ts`, `server/worker.ts`, `server/wrangler.toml`, `server/tsconfig.json`, `server/smoke.mjs`
- Modify: `package.json` (scripts, deps)

**Interfaces:**
- Consumes: `RoomCore`, `Conn` (Task 2); `newRoomCode`, `isRoomCode` (Task 1).
- Produces: HTTP `POST /room` → `{ code }` (CORS `*`); WS `GET /room/:code/ws?role=host|phone&name=&token=`; `npm run dev` runs wrangler on `0.0.0.0:8787` plus Vite.

- [ ] **Step 1: Install**

Run:
```bash
npm i -D wrangler@4 @cloudflare/workers-types
```
If npm reports blocked install scripts (`workerd`, `esbuild`, `sharp`), approve each with `npm install-scripts approve <pkg>` then `npm rebuild <pkg>` — wrangler cannot run without `workerd`'s binary.

- [ ] **Step 2: Write the server files**

`server/wrangler.toml`:
```toml
name = "couch-riot"
main = "worker.ts"
compatibility_date = "2025-09-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]
```

`server/tsconfig.json`:
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
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["*.ts"]
}
```

`server/room.ts`:
```ts
import { DurableObject } from 'cloudflare:workers';
import { RoomCore, type Conn } from './room-core';

// ponytail: non-hibernating sockets keep the object (and its in-memory membership + hold timers) alive while
// the host is connected; switch to the hibernation API + storage if rooms must survive eviction.
export class Room extends DurableObject {
  private core = new RoomCore({
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/status') return Response.json({ host: this.core.hasHost });

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const conn: Conn = {
      send: (d) => server.send(d),
      close: (code, reason) => server.close(code ?? 1000, reason ?? ''),
    };

    if (url.searchParams.get('role') === 'host') {
      if (!this.core.attachHost(conn)) {
        server.close(4000, 'host-exists');
      } else {
        server.addEventListener('message', (e) => {
          if (typeof e.data === 'string') this.core.hostMessage(e.data);
        });
        server.addEventListener('close', () => this.core.hostClosed());
      }
    } else {
      const slot = this.core.attachPhone(conn, url.searchParams.get('name') ?? '', url.searchParams.get('token'));
      if (slot !== null) {
        server.addEventListener('message', (e) => {
          this.core.phoneMessage(slot, typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
        });
        server.addEventListener('close', () => this.core.phoneClosed(slot, conn));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}
```

`server/worker.ts`:
```ts
import { isRoomCode, newRoomCode } from '../shell/protocol';
import { Room } from './room';

export { Room };

interface Env { ROOM: DurableObjectNamespace<Room> }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (req.method === 'POST' && url.pathname === '/room') {
      for (let i = 0; i < 20; i++) {
        const code = newRoomCode();
        const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch('https://room/status');
        const { host } = await res.json<{ host: boolean }>();
        if (!host) return Response.json({ code }, { headers: CORS });
      }
      return new Response('no free room code', { status: 503, headers: CORS });
    }

    const m = url.pathname.match(/^\/room\/([A-Z]{4})\/ws$/);
    if (m && isRoomCode(m[1]) && req.headers.get('Upgrade') === 'websocket') {
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
};
```

`server/smoke.mjs`:
```js
// Live check against `wrangler dev`. Usage: node server/smoke.mjs [http://localhost:8787]
const API = process.argv[2] ?? 'http://localhost:8787';
const WS = API.replace(/^http/, 'ws');
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timed out'), 5000).unref();

function open(path) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(WS + path);
    s.binaryType = 'arraybuffer';
    const box = [];
    let wake = null;
    s.onmessage = (e) => { box.push(e.data); wake?.(); };
    s.next = async () => { while (!box.length) await new Promise((r) => (wake = r)); return box.shift(); };
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('socket error ' + path));
  });
}

const res = await fetch(`${API}/room`, { method: 'POST' });
if (!res.ok) fail(`POST /room → ${res.status}`);
const { code } = await res.json();
const host = await open(`/room/${code}/ws?role=host`);
const phone = await open(`/room/${code}/ws?role=phone&name=Smoke`);

const welcome = JSON.parse(await phone.next());
if (welcome.t !== 'welcome' || welcome.slot !== 0) fail('bad welcome ' + JSON.stringify(welcome));
const join = JSON.parse(await host.next());
if (join.t !== 'join' || join.name !== 'Smoke') fail('bad join ' + JSON.stringify(join));

phone.send(new Uint8Array([0x35]));
const bin = [...new Uint8Array(await host.next())];
if (bin.join() !== '0,53') fail('bad input relay ' + bin);

host.send(JSON.stringify({ to: 0, t: 'buzz', ms: 50 }));
const buzz = JSON.parse(await phone.next());
if (buzz.t !== 'buzz' || buzz.ms !== 50 || 'to' in buzz) fail('bad host relay ' + JSON.stringify(buzz));

host.close();
const gone = JSON.parse(await phone.next());
if (gone.t !== 'host-gone') fail('no host-gone ' + JSON.stringify(gone));
console.log(`PASS (room ${code})`);
process.exit(0);
```

- [ ] **Step 3: Scripts**

In `package.json` `scripts`, replace `"dev"` and `"typecheck"`, and add `"smoke:server"`:
```json
    "dev": "wrangler dev -c server/wrangler.toml --ip 0.0.0.0 --port 8787 & vite",
    "typecheck": "tsc --noEmit && tsc --noEmit -p server",
    "smoke:server": "node server/smoke.mjs",
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean for both projects.

- [ ] **Step 5: Live smoke test**

Run wrangler in the background: `npx wrangler dev -c server/wrangler.toml --ip 0.0.0.0 --port 8787` (wait until it prints `Ready on`). Then run: `npm run smoke:server`
Expected: `PASS (room XXXX)`. Stop wrangler afterwards.

- [ ] **Step 6: Commit**

```bash
git add server package.json package-lock.json
git commit -m "feat(server): worker + Room durable object, local dev + smoke test"
```

---

### Task 4: Session state machine

**Files:**
- Create: `shell/host/session.ts`, `shell/host/session.test.ts`

**Interfaces:**
- Consumes: `HostOut`, `ScreenMsg`, `PALETTE_HEX` (Task 1).
- Produces:
  - `LOBBY_COUNTDOWN_MS = 15_000`, `VOTE_MS = 10_000`, `WHEEL_MS = 3_000`, `RESULTS_MS = 8_000`
  - `type Phase = 'lobby' | 'vote' | 'play' | 'results'`
  - `interface Player { slot; name; connected; ready; vote: string | null; points; playing }`
  - `interface GameInfo { id: string; name: string; minPlayers: number }`
  - `interface Placing { slot: number; score: number; place: number }`
  - `class Session { phase; players: Map<number, Player>; countdownEndsAt: number | null; voteEndsAt: number; wheel: { options: string[]; winner: string; endsAt: number } | null; currentGame: string | null; lastGame: string | null; lastPlacings: Placing[]; resultsEndsAt: number; constructor(games: GameInfo[], rand?: () => number); connected(): Player[]; eligible(): GameInfo[]; voteCounts(): Map<string, number>; join(slot, name, back, now): HostOut[]; leave(slot, now): HostOut[]; gone(slot, now): HostOut[]; ready(slot, v, now): HostOut[]; vote(slot, game, now): HostOut[]; roundOver(scores: { slot: number; score: number }[], now): HostOut[]; tick(now): HostOut[] }`

- [ ] **Step 1: Write the failing tests**

`shell/host/session.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- session`
Expected: FAIL — `Cannot find module './session'`.

- [ ] **Step 3: Implement**

`shell/host/session.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- session && npm run typecheck`
Expected: all session tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add shell/host/session.ts shell/host/session.test.ts
git commit -m "feat(shell): session state machine — lobby, vote, play, results"
```

---

### Task 5: Pad state + stick quantizer + game contract

**Files:**
- Create: `shell/pad.ts`, `shell/pad.test.ts`, `shell/phone/stick.ts`, `shell/phone/stick.test.ts`, `shell/game.ts`, `shell/game.test.ts`

**Interfaces:**
- Consumes: `decodeInput`, `encodeStick`, `encodeButton`, `PALETTE_HEX` (Task 1); `rgba`, `PrimList` (Kerf).
- Produces:
  - `pad.ts`: `interface StickState { dir; mag }`, `interface Pad { left; right; buttons }`, `newPad(): Pad`, `applyInput(pad: Pad, byte: number): void`, `stickVec(s: StickState): { x: number; y: number }` (unit circle × mag/3, y down)
  - `phone/stick.ts`: `DEAD_ZONE = 0.15`, `quantize(dx, dy, radius): { dir: number; mag: number }`
  - `game.ts`: `GameModule`, `GameInstance` (spec §6), re-export `Pad`, `colorRgba(slot): number`

- [ ] **Step 1: Write the failing tests**

`shell/pad.test.ts`:
```ts
import { expect, it } from 'vitest';
import { applyInput, newPad, stickVec } from './pad';
import { encodeButton, encodeStick } from './protocol';

it('applies stick and button bytes', () => {
  const p = newPad();
  applyInput(p, encodeStick(1, 5, 2));
  expect(p.right).toEqual({ dir: 5, mag: 2 });
  expect(p.left).toEqual({ dir: 0, mag: 0 });
  applyInput(p, encodeButton(3, true));
  expect(p.buttons).toBe(8);
  applyInput(p, encodeButton(3, false));
  expect(p.buttons).toBe(0);
});

it('ignores button ids above 31', () => {
  const p = newPad();
  applyInput(p, encodeButton(40, true));
  expect(p.buttons).toBe(0);
});

it('stickVec: dir 0 is right, dir 4 is up (screen y down), mag scales', () => {
  const r = stickVec({ dir: 0, mag: 3 });
  expect(r.x).toBeCloseTo(1);
  expect(r.y).toBeCloseTo(0);
  const u = stickVec({ dir: 4, mag: 3 });
  expect(u.x).toBeCloseTo(0);
  expect(u.y).toBeCloseTo(-1);
  expect(stickVec({ dir: 8, mag: 1 }).x).toBeCloseTo(-1 / 3);
  expect(stickVec({ dir: 7, mag: 0 })).toEqual({ x: 0, y: 0 });
});
```

`shell/phone/stick.test.ts`:
```ts
import { expect, it } from 'vitest';
import { quantize } from './stick';

const at = (deg: number, dist = 60) =>
  quantize(Math.cos((deg * Math.PI) / 180) * dist, -Math.sin((deg * Math.PI) / 180) * dist, 60);

it('dead zone is centered', () => {
  expect(quantize(5, 5, 60)).toEqual({ dir: 0, mag: 0 });
});

it('cardinal directions (screen y is down)', () => {
  expect(quantize(60, 0, 60)).toEqual({ dir: 0, mag: 3 });
  expect(quantize(0, -60, 60).dir).toBe(4);
  expect(quantize(-60, 0, 60).dir).toBe(8);
  expect(quantize(0, 60, 60).dir).toBe(12);
});

it('rounds to the nearest 22.5° sector', () => {
  expect(at(11).dir).toBe(0);
  expect(at(12).dir).toBe(1);
  expect(at(349).dir).toBe(0);
  expect(at(337).dir).toBe(15);
});

it('magnitude bands', () => {
  expect(quantize(20, 0, 60).mag).toBe(1);
  expect(quantize(40, 0, 60).mag).toBe(2);
  expect(quantize(200, 0, 60).mag).toBe(3);
});
```

`shell/game.test.ts`:
```ts
import { expect, it } from 'vitest';
import { rgba } from '../engine/kerf/prims';
import { colorRgba } from './game';

it('colorRgba matches the palette', () => {
  expect(colorRgba(0)).toBe(rgba(0xff, 0x3c, 0x5a));
  expect(colorRgba(7)).toBe(rgba(255, 255, 255));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -- pad stick game`
Expected: 3 files FAIL — modules not found.

- [ ] **Step 3: Implement**

`shell/pad.ts`:
```ts
import { decodeInput } from './protocol';

export interface StickState { dir: number; mag: number }
export interface Pad { left: StickState; right: StickState; buttons: number }

export const newPad = (): Pad => ({ left: { dir: 0, mag: 0 }, right: { dir: 0, mag: 0 }, buttons: 0 });

// ponytail: buttons live in a 32-bit mask, so ids 32-63 are ignored; widen if a game needs more than 32 buttons.
export function applyInput(pad: Pad, byte: number): void {
  const e = decodeInput(byte);
  if (e.kind === 'stick') {
    const s = e.stick === 0 ? pad.left : pad.right;
    s.dir = e.dir;
    s.mag = e.mag;
  } else if (e.id < 32) {
    pad.buttons = e.down ? pad.buttons | (1 << e.id) : pad.buttons & ~(1 << e.id);
  }
}

export function stickVec(s: StickState): { x: number; y: number } {
  if (s.mag === 0) return { x: 0, y: 0 };
  const a = (s.dir * Math.PI) / 8;
  const m = s.mag / 3;
  return { x: Math.cos(a) * m, y: -Math.sin(a) * m };
}
```

`shell/phone/stick.ts`:
```ts
export const DEAD_ZONE = 0.15;

// Thumb offset from where it landed (screen px, y down) → 16 directions × 3 strengths.
export function quantize(dx: number, dy: number, radius: number): { dir: number; mag: number } {
  const d = Math.hypot(dx, dy) / radius;
  if (d < DEAD_ZONE) return { dir: 0, mag: 0 };
  const ang = Math.atan2(-dy, dx);
  const dir = ((Math.round(ang / (Math.PI / 8)) % 16) + 16) % 16;
  const mag = d < 0.45 ? 1 : d < 0.8 ? 2 : 3;
  return { dir, mag };
}
```

`shell/game.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -- pad stick game && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add shell/pad.ts shell/pad.test.ts shell/phone/stick.ts shell/phone/stick.test.ts shell/game.ts shell/game.test.ts
git commit -m "feat(shell): pad state, stick quantizer, game contract"
```

---

### Task 6: Dots test game

**Files:**
- Create: `games/dots/dots.ts`, `games/dots/dots.test.ts`

**Interfaces:**
- Consumes: `GameModule`, `GameInstance`, `Pad` (Task 5); `stickVec` (Task 5); `PrimList` (Kerf).
- Produces: `SPEED = 6`, `ROUND_TICKS = 1800`, `EDGE = 30`, `class DotsGame implements GameInstance { readonly dots: { slot; color; x; y; ax; ay; dist }[] }`, `dots: GameModule` (`id: 'dots'`, `minPlayers: 2`).

- [ ] **Step 1: Write the failing tests**

`games/dots/dots.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- dots`
Expected: FAIL — `Cannot find module './dots'`.

- [ ] **Step 3: Implement**

`games/dots/dots.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- dots && npm run typecheck`
Expected: 6 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add games/dots
git commit -m "feat(games): Dots test game"
```

---

### Task 7: Phone page

**Files:**
- Create: `play.html`, `shell/phone/main.ts`, `shell/phone/controller.ts`, `shell/phone/phone.css`

**Interfaces:**
- Consumes: `encodeStick`, `isRoomCode`, `HostToPhone`, `RoomToPhone`, `ScreenMsg` (Task 1); `quantize` (Task 5).
- Produces: `attachTwinStick(left: HTMLElement, right: HTMLElement, send: (byte: number) => void): () => void`; page sets `document.body.dataset.screen`; test hook `window.__phone.stick(stick: 0 | 1, dir: number, mag: number)`; DOM ids `#code`, `#name`, `#ready`, vote tiles `[data-game=<id>]`.

No unit tests here; the touch layer is checked by hand (Step 3) and the flow by the end-to-end test (Task 9).

- [ ] **Step 1: Write the page**

`play.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <meta name="theme-color" content="#07070f" />
    <title>Couch Riot</title>
    <link rel="stylesheet" href="/shell/phone/phone.css" />
  </head>
  <body data-screen="join">
    <main id="app"></main>
    <script type="module" src="/shell/phone/main.ts"></script>
  </body>
</html>
```

`shell/phone/phone.css`:
```css
:root { --bg: #07070f; --fg: #e8ecff; --dim: #8a90b0; --line: #2a2f4a; --me: #3cc8ff; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; background: var(--bg); color: var(--fg); overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 24px 16px; text-align: center; }
h1 { font-size: 40px; letter-spacing: 4px; color: var(--me); text-shadow: 0 0 18px var(--me); }
h2 { font-size: 32px; }
p { color: var(--dim); }
form { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 320px; }
label { display: flex; flex-direction: column; gap: 6px; text-align: left; color: var(--dim); font-size: 14px; }
input { font-size: 22px; padding: 12px; border-radius: 12px; border: 2px solid var(--line); background: #10121f; color: var(--fg); }
#code { text-transform: uppercase; letter-spacing: 6px; }
button { font: inherit; font-size: 22px; font-weight: 700; padding: 16px; border-radius: 14px; border: 0; background: var(--me); color: var(--bg); }
.err { color: #ff5a6e; min-height: 1.2em; }
.big { width: 100%; max-width: 360px; min-height: 40vh; font-size: 40px; background: transparent; color: var(--me); border: 4px solid var(--me); box-shadow: 0 0 24px var(--me) inset; }
.big.on { background: var(--me); color: var(--bg); box-shadow: 0 0 40px var(--me); }
.players { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.players li { padding: 6px 12px; border-radius: 999px; border: 2px solid var(--c); color: var(--c); }
.players li.on { background: var(--c); color: var(--bg); }
.tiles { display: grid; gap: 12px; width: 100%; max-width: 360px; }
.tile { padding: 22px; font-size: 26px; background: #10121f; color: var(--fg); border: 3px solid var(--line); }
.tile.mine { border-color: var(--me); box-shadow: 0 0 20px var(--me); }
.tile small { display: block; font-size: 13px; color: var(--me); letter-spacing: 2px; }
.bar { width: 100%; max-width: 360px; height: 8px; background: #1a1d30; border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--me); animation: drain var(--ms) linear forwards; }
@keyframes drain { from { width: 100%; } to { width: 0; } }
body[data-screen='controller'] main { padding: 0; }
.pad { position: fixed; inset: 0; display: flex; touch-action: none; }
.half { flex: 1; position: relative; touch-action: none; }
.half + .half { border-left: 1px dashed var(--line); }
.half::after { content: attr(data-label); position: absolute; bottom: 16px; left: 0; width: 100%; color: var(--dim); font-size: 13px; letter-spacing: 2px; }
.ring { position: fixed; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%; border: 3px solid var(--me); opacity: 0.7; display: none; pointer-events: none; }
.thumb { position: absolute; left: 50%; top: 50%; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%; background: var(--me); box-shadow: 0 0 20px var(--me); }
.tip { position: fixed; top: 10px; left: 0; width: 100%; color: var(--dim); font-size: 12px; pointer-events: none; }
@media (orientation: landscape) { .tip { display: none; } }
```

`shell/phone/controller.ts`:
```ts
import { encodeStick, type Stick } from '../protocol';
import { quantize } from './stick';

const RADIUS = 60; // px of thumb travel for full strength

// Floating sticks: each half of the screen spawns a stick where the thumb lands.
export function attachTwinStick(left: HTMLElement, right: HTMLElement, send: (byte: number) => void): () => void {
  const offs = [bindStick(left, 0, send), bindStick(right, 1, send)];
  return () => offs.forEach((off) => off());
}

function bindStick(el: HTMLElement, stick: Stick, send: (byte: number) => void): () => void {
  let id: number | null = null;
  let ox = 0;
  let oy = 0;
  let last = -1;
  const ring = document.createElement('div');
  ring.className = 'ring';
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  ring.append(thumb);
  el.append(ring);

  const emit = (dir: number, mag: number) => {
    const b = encodeStick(stick, dir, mag);
    if (b !== last) {
      last = b;
      send(b);
    }
  };
  const down = (e: PointerEvent) => {
    if (id !== null) return;
    id = e.pointerId;
    el.setPointerCapture(id);
    ox = e.clientX;
    oy = e.clientY;
    ring.style.cssText = `display:block;left:${ox}px;top:${oy}px`;
    thumb.style.transform = '';
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - ox;
    const dy = e.clientY - oy;
    const k = Math.min(1, RADIUS / (Math.hypot(dx, dy) || 1));
    thumb.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const { dir, mag } = quantize(dx, dy, RADIUS);
    emit(dir, mag);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    ring.style.display = 'none';
    emit(0, 0);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    ring.remove();
  };
}
```

`shell/phone/main.ts`:
```ts
import { encodeStick, isRoomCode, type HostToPhone, type RoomToPhone, type ScreenMsg, type Stick } from '../protocol';
import { attachTwinStick } from './controller';

const app = document.getElementById('app')!;
const ROOM_PORT = 8787;
const RETRY_MS = 1000;
const GIVE_UP_MS = 60_000;

let room = (new URLSearchParams(location.search).get('c') ?? '').toUpperCase();
let ws: WebSocket | null = null;
let giveUpAt = 0;
let detach: (() => void) | null = null;

const tokenKey = () => `couch-token-${room}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (s: Storage, k: string) => { try { return s.getItem(k); } catch { return null; } },
  set: (s: Storage, k: string, v: string) => { try { s.setItem(k, v); } catch { /* private mode */ } },
  del: (s: Storage, k: string) => { try { s.removeItem(k); } catch { /* private mode */ } },
};

function show(screen: string, html: string) {
  detach?.();
  detach = null;
  document.body.dataset.screen = screen;
  app.innerHTML = html;
}

function send(msg: object | Uint8Array) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(msg instanceof Uint8Array ? msg : JSON.stringify(msg));
}

function message(title: string, body: string) {
  show('message', `<h2>${esc(title)}</h2><p>${esc(body)}</p>`);
}

function joinScreen(err = '') {
  show('join', `
    <h1>COUCH RIOT</h1>
    <form id="f">
      <label>Room<input id="code" maxlength="4" value="${esc(room)}" autocomplete="off" required></label>
      <label>Name<input id="name" maxlength="12" value="${esc(store.get(localStorage, 'couch-name') ?? '')}" autocomplete="nickname" required></label>
      <button type="submit">JOIN</button>
      <p class="err">${esc(err)}</p>
    </form>`);
  document.getElementById('f')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = (document.getElementById('code') as HTMLInputElement).value.trim().toUpperCase();
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    if (!isRoomCode(code)) return joinScreen('Room codes are 4 letters');
    if (!name) return joinScreen('Pick a name');
    room = code;
    store.set(localStorage, 'couch-name', name);
    connect(name);
  });
}

function connect(name: string) {
  const token = store.get(sessionStorage, tokenKey());
  const q = `role=phone&name=${encodeURIComponent(name)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const sock = new WebSocket(`ws://${location.hostname}:${ROOM_PORT}/room/${room}/ws?${q}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let ended = false;
  sock.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data) as RoomToPhone | HostToPhone;
    switch (m.t) {
      case 'welcome':
        giveUpAt = 0;
        store.set(sessionStorage, tokenKey(), m.token);
        document.documentElement.style.setProperty('--me', m.color);
        message("You're in!", 'Look at the TV');
        break;
      case 'error':
        ended = true;
        message(m.code === 'room-full' ? 'Room full' : 'No room with that code', 'Check the code on the TV.');
        break;
      case 'host-gone':
        ended = true;
        store.del(sessionStorage, tokenKey());
        message('Host left', 'Scan the new code on the TV.');
        break;
      case 'buzz':
        navigator.vibrate?.(m.ms);
        break;
      case 'screen':
        render(m);
        break;
    }
  };
  sock.onclose = () => {
    if (ended || ws !== sock) return;
    if (!giveUpAt) giveUpAt = Date.now() + GIVE_UP_MS;
    if (Date.now() > giveUpAt) return message('Lost connection', 'Scan the code on the TV to rejoin.');
    show('reconnecting', '<h2>Reconnecting…</h2>');
    setTimeout(() => connect(name), RETRY_MS);
  };
}

function render(m: ScreenMsg) {
  switch (m.screen) {
    case 'lobby': {
      const { ready, players } = m.data;
      show('lobby', `
        <button id="ready" class="big ${ready ? 'on' : ''}">${ready ? 'READY ✓' : 'READY?'}</button>
        <ul class="players">${players.map((p) => `<li style="--c:${p.color}" class="${p.ready ? 'on' : ''}">${esc(p.name)}</li>`).join('')}</ul>`);
      document.getElementById('ready')!.addEventListener('click', () => send({ t: 'ready', v: !ready }));
      break;
    }
    case 'vote': {
      const { games, msLeft, mine } = m.data;
      show('vote', `
        <h2>VOTE</h2>
        <div class="bar"><i style="--ms:${msLeft}ms"></i></div>
        <div class="tiles">${games.map((g) => `
          <button class="tile ${g.id === mine ? 'mine' : ''}" data-game="${esc(g.id)}">${g.again ? '<small>RUN IT BACK</small>' : ''}${esc(g.name)}</button>`).join('')}
        </div>`);
      for (const b of app.querySelectorAll<HTMLButtonElement>('[data-game]')) {
        b.addEventListener('click', () => send({ t: 'vote', game: b.dataset.game! }));
      }
      break;
    }
    case 'controller': {
      show('controller', `
        <p class="tip">Turn your phone sideways</p>
        <div class="pad"><div class="half" id="L" data-label="MOVE"></div><div class="half" id="R" data-label="AIM"></div></div>`);
      detach = attachTwinStick(document.getElementById('L')!, document.getElementById('R')!, (b) => send(new Uint8Array([b])));
      document.documentElement.requestFullscreen?.().catch(() => { /* needs a gesture; best effort */ });
      break;
    }
    case 'results':
      show('results', `<h2>#${m.data.place}</h2><p>${m.data.score} pts</p><p>Next vote soon…</p>`);
      break;
    case 'wait':
      show('wait', '<h2>Next round soon</h2><p>Watch the TV</p>');
      break;
  }
}

// Test hook for the end-to-end script (touch is hard to drive from Playwright).
(window as unknown as { __phone: unknown }).__phone = {
  stick: (stick: Stick, dir: number, mag: number) => send(new Uint8Array([encodeStick(stick, dir, mag)])),
};

joinScreen();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Hand check the controller**

Run `npx vite --host` and open `http://<laptop-ip>:5173/play.html?c=TEST` on a phone (or Chrome DevTools device mode with touch). Expected: join form with `TEST` filled in; JOIN leads to "No room with that code" (no server running) — this confirms the error path renders. The controller is driven for real in Task 9.

- [ ] **Step 4: Commit**

```bash
git add play.html shell/phone
git commit -m "feat(phone): join, lobby, vote, results screens + floating twin-stick"
```

---

### Task 8: TV page

**Files:**
- Create: `vite.config.ts`, `index.html`, `shell/env.d.ts`, `shell/host/overlay.ts`, `shell/host/main.ts`, `shell/host/host.css`
- Modify: `package.json` (dependency `qrcode`, devDependency `@types/qrcode`)

**Interfaces:**
- Consumes: `Session` (Task 4); `newPad`, `applyInput`, `Pad` (Task 5); `GameModule`, `GameInstance`, `colorRgba` (Task 5); `dots` (Task 6); `RoomToHost`, `HostOut`, `PALETTE_HEX` (Task 1); Kerf `getDevice`, `Renderer`, `PrimList`.
- Produces: TV at `/`; test hook `window.__couch = { code, session, game }` (`game` is a getter for the live `GameInstance | null`).

- [ ] **Step 1: Install QR**

Run: `npm i qrcode && npm i -D @types/qrcode`
Expected: installs cleanly.

- [ ] **Step 2: Write config and pages**

`vite.config.ts`:
```ts
import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';

// The QR code must point at an address phones on the same Wi-Fi can reach.
function lanIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  define: { __LAN_HOST__: JSON.stringify(lanIp()) },
  build: { rollupOptions: { input: { tv: 'index.html', play: 'play.html', bench: 'bench/index.html' } } },
});
```

`shell/env.d.ts`:
```ts
declare const __LAN_HOST__: string;
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Couch Riot</title>
    <link rel="stylesheet" href="/shell/host/host.css" />
  </head>
  <body>
    <canvas id="stage"></canvas>
    <div id="overlay"></div>
    <script type="module" src="/shell/host/main.ts"></script>
  </body>
</html>
```

`shell/host/host.css`:
```css
:root { --bg: #05050c; --fg: #e8ecff; --dim: #7d84a8; --line: #2a2f4a; --accent: #3cc8ff; --gold: #ffc828; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; background: var(--bg); color: var(--fg); overflow: hidden; }
#stage { position: fixed; inset: 0; width: 100vw; height: 100vh; }
#overlay { position: fixed; inset: 0; pointer-events: none; }
section { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4vh; background: radial-gradient(ellipse at center, #0c0f24cc, #05050cee); }
.lobby { flex-direction: row; gap: 8vw; }
.join { display: flex; flex-direction: column; align-items: center; gap: 1.5vh; }
.join img { width: min(34vh, 340px); filter: drop-shadow(0 0 12px var(--accent)); }
.code { font-size: 12vh; font-weight: 800; letter-spacing: 2vh; color: var(--accent); text-shadow: 0 0 30px var(--accent); }
.url { color: var(--dim); font-size: 2vh; }
.warn { color: var(--gold); font-size: 2vh; max-width: 40vw; text-align: center; }
.roster { display: grid; grid-template-columns: repeat(2, minmax(14vw, 1fr)); gap: 2vh; }
.p { padding: 2vh 2vw; border: 3px solid var(--c); border-radius: 2vh; color: var(--c); font-size: 4vh; font-weight: 700; text-shadow: 0 0 12px var(--c); }
.p.on { background: var(--c); color: var(--bg); text-shadow: none; box-shadow: 0 0 30px var(--c); }
.p.off { opacity: 0.35; }
.empty { color: var(--dim); font-size: 3vh; }
.hint { position: absolute; bottom: 6vh; font-size: 3.5vh; color: var(--dim); }
.hint b { color: var(--fg); font-size: 6vh; }
h1 { font-size: 9vh; letter-spacing: 1.5vh; color: var(--accent); text-shadow: 0 0 30px var(--accent); }
.tiles { display: flex; gap: 3vw; }
.tile { min-width: 22vw; padding: 4vh 2vw; border: 3px solid var(--line); border-radius: 2vh; text-align: center; font-size: 5vh; font-weight: 700; }
.tile .n { display: block; font-size: 10vh; color: var(--accent); }
.tile small { display: block; font-size: 2vh; letter-spacing: 0.5vh; color: var(--gold); }
.tile.hot { border-color: var(--accent); box-shadow: 0 0 40px var(--accent); }
.timer { font-size: 8vh; font-weight: 800; }
.cols { display: flex; gap: 6vw; align-items: flex-start; }
.cols h2 { font-size: 3vh; color: var(--dim); letter-spacing: 0.6vh; margin-bottom: 2vh; }
.rank { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 1.5vh; min-width: 34vw; }
.rank li { display: flex; justify-content: space-between; gap: 4vw; font-size: 4.5vh; padding: 1vh 2vw; border-left: 1vh solid var(--c); background: #0c0f24; }
.badge { position: absolute; top: 2vh; right: 2vw; display: flex; align-items: center; gap: 1vw; background: #05050ccc; padding: 1vh 1vw; border-radius: 1.5vh; }
.badge img { width: 10vh; }
.badge b { font-size: 4vh; letter-spacing: 0.8vh; color: var(--accent); }
.fatal { position: absolute; inset: 0; display: grid; place-items: center; font-size: 3vh; color: #ff5a6e; padding: 10vw; text-align: center; }
```

`shell/host/overlay.ts`:
```ts
import { PALETTE_HEX } from '../protocol';
import type { Session } from './session';

export interface OverlayView { code: string; qr: string; joinUrl: string; lanOk: boolean; now: number }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

export function overlayHtml(s: Session, v: OverlayView): string {
  const name = (slot: number) => esc(s.players.get(slot)?.name ?? '?');
  const badge = `<div class="badge"><img src="${v.qr}" alt=""><b>${v.code}</b></div>`;
  const gameName = (id: string) => esc(s.games.find((g) => g.id === id)?.name ?? id);

  switch (s.phase) {
    case 'lobby': {
      const all = [...s.players.values()].sort((a, b) => a.slot - b.slot);
      const n = s.connected().length;
      const hint = s.countdownEndsAt !== null
        ? `Starting in <b>${secs(s.countdownEndsAt - v.now)}</b>`
        : n < 2 ? 'Need at least 2 players' : 'Everyone tap READY';
      return `<section class="lobby">
        <div class="join">
          <img src="${v.qr}" alt="QR code">
          <div class="code">${v.code}</div>
          <div class="url">${esc(v.joinUrl)}</div>
          ${v.lanOk ? '' : '<div class="warn">No Wi-Fi address found — phones can’t reach this laptop. Connect to Wi-Fi and refresh.</div>'}
        </div>
        <div class="roster">${all.length
          ? all.map((p) => `<div class="p ${p.ready ? 'on' : ''} ${p.connected ? '' : 'off'}" style="--c:${PALETTE_HEX[p.slot]}">${esc(p.name)}</div>`).join('')
          : '<div class="empty">Scan to join</div>'}</div>
        <div class="hint">${hint}</div>
      </section>`;
    }
    case 'vote': {
      if (s.wheel) {
        const w = s.wheel;
        const hi = v.now >= w.endsAt - 600 ? w.options.indexOf(w.winner) : Math.floor(v.now / 120) % w.options.length;
        return `<section><h1>TIE!</h1><div class="tiles">${w.options.map((id, i) => `<div class="tile ${i === hi ? 'hot' : ''}">${gameName(id)}</div>`).join('')}</div>${badge}</section>`;
      }
      const counts = s.voteCounts();
      const top = Math.max(0, ...counts.values());
      return `<section><h1>VOTE</h1>
        <div class="tiles">${s.eligible().map((g) => {
          const c = counts.get(g.id) ?? 0;
          return `<div class="tile ${c && c === top ? 'hot' : ''}">${g.id === s.lastGame ? '<small>RUN IT BACK</small>' : ''}${esc(g.name)}<span class="n">${c}</span></div>`;
        }).join('')}</div>
        <div class="timer">${secs(s.voteEndsAt - v.now)}</div>${badge}</section>`;
    }
    case 'play':
      return badge;
    case 'results': {
      const board = [...s.players.values()].sort((a, b) => b.points - a.points);
      return `<section><div class="cols">
        <div><h2>THIS ROUND</h2><ol class="rank">${s.lastPlacings.map((p) => `<li style="--c:${PALETTE_HEX[p.slot]}"><span>${p.place}. ${name(p.slot)}</span><span>${p.score}</span></li>`).join('')}</ol></div>
        <div><h2>SESSION</h2><ol class="rank">${board.map((p) => `<li style="--c:${PALETTE_HEX[p.slot]}"><span>${esc(p.name)}</span><span>${p.points}</span></li>`).join('')}</ol></div>
      </div>${badge}</section>`;
    }
  }
}

// Only touch the DOM when the markup actually changes (timers change once a second).
export function overlayRenderer(el: HTMLElement): (s: Session, v: OverlayView) => void {
  let last = '';
  return (s, v) => {
    const html = overlayHtml(s, v);
    if (html !== last) el.innerHTML = last = html;
  };
}
```

`shell/host/main.ts`:
```ts
import QRCode from 'qrcode';
import { dots } from '../../games/dots/dots';
import { getDevice } from '../../engine/kerf/gpu';
import { PrimList } from '../../engine/kerf/prims';
import { Renderer } from '../../engine/kerf/renderer';
import { colorRgba, type GameInstance, type GameModule } from '../game';
import { applyInput, newPad, type Pad } from '../pad';
import type { HostOut, RoomToHost } from '../protocol';
import { overlayRenderer } from './overlay';
import { Session } from './session';

const GAMES: GameModule[] = [dots];
const WORLD = { w: 1600, h: 900 };
const TICK_MS = 1000 / 60;
const ROOM = `${location.hostname}:8787`;

const overlay = document.getElementById('overlay')!;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const fatal = (msg: string) => { overlay.innerHTML = `<div class="fatal">${msg}</div>`; };

async function main() {
  let device: GPUDevice;
  try {
    device = await getDevice();
  } catch (e) {
    return fatal((e as Error).message);
  }

  const res = await fetch(`http://${ROOM}/room`, { method: 'POST' }).catch(() => null);
  if (!res?.ok) return fatal('Room server not reachable. Is <code>npm run dev</code> running?');
  const { code } = (await res.json()) as { code: string };
  const joinUrl = `http://${__LAN_HOST__}:${location.port}/play.html?c=${code}`;
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 340, color: { dark: '#e8ecffff', light: '#00000000' } });

  const session = new Session(GAMES.map((g) => g.meta));
  const pads: (Pad | undefined)[] = [];
  let game: GameInstance | null = null;

  const ws = new WebSocket(`ws://${ROOM}/room/${code}/ws?role=host`);
  ws.binaryType = 'arraybuffer';
  const out = (msgs: HostOut[]) => { for (const m of msgs) ws.send(JSON.stringify(m)); };
  ws.onmessage = (e) => {
    const now = Date.now();
    if (typeof e.data !== 'string') {
      const f = new Uint8Array(e.data as ArrayBuffer);
      const pad = (pads[f[0]] ??= newPad());
      for (let i = 1; i < f.length; i++) applyInput(pad, f[i]);
      return;
    }
    const m = JSON.parse(e.data) as RoomToHost;
    switch (m.t) {
      case 'join':
        if (!m.back) pads[m.slot] = newPad();
        return out(session.join(m.slot, m.name, m.back, now));
      case 'leave':
        pads[m.slot] = newPad(); // dropped player stands still
        return out(session.leave(m.slot, now));
      case 'gone':
        pads[m.slot] = undefined;
        return out(session.gone(m.slot, now));
      case 'ready':
        return out(session.ready(m.slot, m.v, now));
      case 'vote':
        return out(session.vote(m.slot, m.game, now));
    }
  };
  ws.onclose = () => fatal('Lost the room server. Refresh to start a new room.');

  // ponytail: canvas size is fixed at load; resizing the window needs a refresh.
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
  const renderer = new Renderer(device, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / WORLD.w, canvas.height / WORLD.h);
  const cam = { x: -(canvas.width / scale - WORLD.w) / 2, y: -(canvas.height / scale - WORLD.h) / 2, scale };
  const ctx = canvas.getContext('webgpu')!;
  ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
  const prims = new PrimList();
  const drawOverlay = overlayRenderer(overlay);
  const lanOk = __LAN_HOST__ !== 'localhost';

  (window as unknown as { __couch: unknown }).__couch = { code, session, get game() { return game; } };

  let acc = 0;
  let last = performance.now();
  const frame = (t: number) => {
    const now = Date.now();
    out(session.tick(now));
    if (session.phase === 'play' && !game) {
      const mod = GAMES.find((g) => g.meta.id === session.currentGame)!;
      const players = [...session.players.values()].filter((p) => p.playing).map((p) => ({ slot: p.slot, color: colorRgba(p.slot) }));
      for (const p of players) pads[p.slot] = newPad();
      game = mod.create(players);
      acc = 0;
    }
    acc += Math.min(t - last, 250);
    last = t;
    while (game && acc >= TICK_MS) {
      game.tick(pads);
      acc -= TICK_MS;
      if (game.isOver()) {
        out(session.roundOver(game.result(), now));
        game = null;
      }
    }
    if (!game) acc = 0;
    prims.clear();
    game?.draw(prims);
    renderer.frame(prims, cam);
    renderer.present(ctx);
    drawOverlay(session, { code, qr, joinUrl, lanOk, now });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
```

- [ ] **Step 3: Typecheck and unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: clean; all unit tests PASS.

- [ ] **Step 4: Hand check**

Run `npm run dev`, open `http://localhost:5173/` in Chrome. Expected: neon grid background, big 4-letter code, QR, join URL with the laptop's Wi-Fi IP, "Scan to join". No console errors.

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts index.html shell/env.d.ts shell/host package.json package-lock.json
git commit -m "feat(tv): host page — room, QR lobby, vote, results overlay, game loop on Kerf"
```

---

### Task 9: End-to-end loop

**Files:**
- Create: `e2e/arena.mjs`
- Modify: `package.json` (script `e2e`)

**Interfaces:**
- Consumes: `window.__couch` (Task 8), `window.__phone` (Task 7), DOM ids from Task 7.

- [ ] **Step 1: Write the test**

`e2e/arena.mjs`:
```js
// Full loop: TV + 3 phones → join → ready → vote → play → results → next vote.
// Usage: npm run dev   (in another terminal)   then   npm run e2e
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const fail = async (msg) => { console.error('FAIL:', msg); await browser.close(); process.exit(1); };

try {
  const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
  await tv.goto(BASE + '/');
  const code = await (await tv.waitForFunction(() => window.__couch?.code, null, { timeout: 15_000 })).jsonValue();

  const phones = [];
  for (const name of ['Ana', 'Bo', 'Cy']) {
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await p.goto(`${BASE}/play.html?c=${code}`);
    await p.fill('#name', name);
    await p.click('button[type=submit]');
    await p.waitForSelector('body[data-screen=lobby]');
    phones.push(p);
  }

  for (const p of phones) await p.click('#ready');
  await tv.waitForFunction(() => window.__couch.session.phase === 'vote');

  for (const p of phones) await p.click('[data-game=dots]');
  await tv.waitForFunction(() => window.__couch.session.phase === 'play' && window.__couch.game !== null);
  await phones[0].waitForSelector('body[data-screen=controller]');

  const x = () => tv.evaluate(() => window.__couch.game.dots.find((d) => d.slot === 0).x);
  const x0 = await x();
  await phones[0].evaluate(() => window.__phone.stick(0, 0, 3)); // full right
  await tv.waitForTimeout(1000);
  await phones[0].evaluate(() => window.__phone.stick(0, 0, 0)); // let go
  const x1 = await x();
  if (!(x1 - x0 > 100)) await fail(`dot did not move right: ${x0} → ${x1}`);
  await tv.waitForTimeout(300); // a few ticks for the release to land
  const x2 = await x();
  await tv.waitForTimeout(300);
  if ((await x()) !== x2) await fail(`dot kept moving after release: ${x2} → ${await x()}`);

  await tv.waitForFunction(() => window.__couch.session.phase === 'results', null, { timeout: 40_000 });
  await phones[0].waitForSelector('body[data-screen=results]');
  await tv.waitForFunction(() => window.__couch.session.phase === 'vote', null, { timeout: 15_000 });
  await phones[0].waitForSelector('body[data-screen=vote] [data-game=dots] small'); // "RUN IT BACK"

  if (errors.length) await fail('page errors:\n' + errors.join('\n'));
  console.log(`PASS (room ${code})`);
  await browser.close();
  process.exit(0);
} catch (e) {
  await fail(e.message);
}
```

In `package.json` scripts add:
```json
    "e2e": "node e2e/arena.mjs",
```

- [ ] **Step 2: Run it**

Start `npm run dev` in the background; wait for both `Ready on http://0.0.0.0:8787` and Vite's `Local:` line. Then run: `npm run e2e`
Expected: `PASS (room XXXX)` within ~70 s (30 s round + 8 s results). If it fails, use superpowers:systematic-debugging — fix the code, not the assertions.

- [ ] **Step 3: Full suite**

Run: `npm test && npm run typecheck && npm run smoke:server`
Expected: all PASS (smoke needs wrangler still running).

- [ ] **Step 4: Commit**

```bash
git add e2e package.json
git commit -m "test(e2e): TV + 3 phones full arena loop"
```

- [ ] **Step 5: Real-phone check (Director)**

With `npm run dev` running, open `http://localhost:5173/` on the laptop, scan the QR with two real phones on the same Wi-Fi, and play one Dots round. This is the only check of real touch input and router reachability; report what happened.
