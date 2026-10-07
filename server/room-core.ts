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
