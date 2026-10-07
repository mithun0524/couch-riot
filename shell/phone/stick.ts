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
