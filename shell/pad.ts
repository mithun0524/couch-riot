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
