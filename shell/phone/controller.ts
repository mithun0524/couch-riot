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
