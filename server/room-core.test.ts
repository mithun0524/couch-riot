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
