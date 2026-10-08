export function f16(bits: number): number {
  const s = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const m = bits & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function hdrPixel(bytes: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = (y * width + x) * 8;
  return [f16(v.getUint16(o, true)), f16(v.getUint16(o + 2, true)), f16(v.getUint16(o + 4, true)), f16(v.getUint16(o + 6, true))];
}
