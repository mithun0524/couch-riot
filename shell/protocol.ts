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
export type HostToPhone = ScreenMsg | { t: 'buzz'; ms: number } | { t: 'hud'; hp: number; max: number };
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
  if (!okTo || (msg.t !== 'screen' && msg.t !== 'buzz' && msg.t !== 'hud')) return null;
  return { to: to as number | 'all', msg: msg as HostToPhone };
}
