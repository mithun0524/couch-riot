export interface Rect { x: number; y: number; hw: number; hh: number } // centre + half size

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function overlaps(x: number, y: number, r: number, b: Rect): boolean {
  const dx = x - clamp(x, b.x - b.hw, b.x + b.hw);
  const dy = y - clamp(y, b.y - b.hh, b.y + b.hh);
  return dx * dx + dy * dy < r * r;
}

// Moves a circle out of a rect. Returns the unit push normal, or null when they don't touch.
export function pushOut(p: { x: number; y: number }, r: number, b: Rect): [number, number] | null {
  const cx = clamp(p.x, b.x - b.hw, b.x + b.hw);
  const cy = clamp(p.y, b.y - b.hh, b.y + b.hh);
  let dx = p.x - cx;
  let dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    dx /= d;
    dy /= d;
    p.x = cx + dx * r;
    p.y = cy + dy * r;
    return [dx, dy];
  }
  // Centre inside the rect: leave along the shallowest axis.
  const px = b.hw - Math.abs(p.x - b.x);
  const py = b.hh - Math.abs(p.y - b.y);
  if (px < py) {
    const s = Math.sign(p.x - b.x) || 1;
    p.x = b.x + s * (b.hw + r);
    return [s, 0];
  }
  const s = Math.sign(p.y - b.y) || 1;
  p.y = b.y + s * (b.hh + r);
  return [0, s];
}
