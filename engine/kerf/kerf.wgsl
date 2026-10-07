const TILE: u32 = 16u;
const MAX_PRIMS: u32 = 2048u;
const MASK_WORDS: u32 = 64u; // MAX_PRIMS / 32
const KIND_NONE: u32 = 0u;
const KIND_CIRCLE: u32 = 1u;
const KIND_CAPSULE: u32 = 2u;
const GLOW_GAIN: f32 = 0.6;
const PAD_PX: f32 = 2.0; // conservative margin: fill AA reaches 0.5px past the edge

struct Prim { a: vec2f, b: vec2f, r: f32, kind: u32, color: u32, glow: f32 }

struct Params {
  origin: vec2f, scale: f32, count: u32,
  prevCount: u32, tilesX: u32, tilesY: u32, forceAll: u32,
  brute: u32, width: u32, height: u32, pad: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> prims: array<Prim>;
@group(0) @binding(2) var<storage, read> prevPrims: array<Prim>;
@group(0) @binding(3) var<storage, read_write> tileMasks: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> dirty: array<atomic<u32>>;
@group(0) @binding(5) var outTex: texture_storage_2d<rgba8unorm, write>;

// ---- clear: zero tile masks, reset dirty bits ----
@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let tiles = P.tilesX * P.tilesY;
  if (i < tiles * MASK_WORDS) { atomicStore(&tileMasks[i], 0u); }
  if (i < (tiles + 31u) / 32u) { atomicStore(&dirty[i], select(0u, 0xffffffffu, P.forceAll != 0u)); }
}

// ---- bin: shapes -> tile masks; changed shapes -> dirty tiles ----
fn worldBounds(q: Prim) -> vec4f {
  var lo: vec2f;
  var hi: vec2f;
  switch q.kind {
    case KIND_CIRCLE: { lo = q.a - vec2f(q.r); hi = q.a + vec2f(q.r); }
    case KIND_CAPSULE: { lo = min(q.a, q.b) - vec2f(q.r); hi = max(q.a, q.b) + vec2f(q.r); }
    default: { lo = q.a - q.b; hi = q.a + q.b; } // box: b = half size
  }
  let g = max(q.glow, 0.0); // shade treats glow <= 0 as none; never shrink bounds below the fill
  return vec4f(lo - vec2f(g), hi + vec2f(g));
}

// Inclusive tile rect (x0, y0, x1, y1); empty when x0 > x1 or y0 > y1.
fn tileRect(q: Prim) -> vec4i {
  let mx = vec2i(i32(P.tilesX) - 1, i32(P.tilesY) - 1);
  if (P.brute != 0u) { return vec4i(0, 0, mx.x, mx.y); }
  let wb = worldBounds(q);
  let t = f32(TILE);
  let lim = vec2f(f32(P.width), f32(P.height)) + t;
  let lo = clamp((wb.xy - P.origin) * P.scale - PAD_PX, vec2f(-t), lim);
  let hi = clamp((wb.zw - P.origin) * P.scale + PAD_PX, vec2f(-t), lim);
  let t0 = max(vec2i(floor(lo / t)), vec2i(0));
  let t1 = min(vec2i(floor(hi / t)), mx);
  return vec4i(t0, t1);
}

fn markMask(rc: vec4i, idx: u32) {
  for (var y = rc.y; y <= rc.w; y++) {
    for (var x = rc.x; x <= rc.z; x++) {
      let tile = u32(y) * P.tilesX + u32(x);
      atomicOr(&tileMasks[tile * MASK_WORDS + idx / 32u], 1u << (idx % 32u));
    }
  }
}

fn markDirty(rc: vec4i) {
  for (var y = rc.y; y <= rc.w; y++) {
    for (var x = rc.x; x <= rc.z; x++) {
      let tile = u32(y) * P.tilesX + u32(x);
      atomicOr(&dirty[tile / 32u], 1u << (tile % 32u));
    }
  }
}

fn same(a: Prim, b: Prim) -> bool {
  return all(a.a == b.a) && all(a.b == b.b) && a.r == b.r
      && a.kind == b.kind && a.color == b.color && a.glow == b.glow;
}

@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let live = i < P.count && prims[i].kind != KIND_NONE;
  let wasLive = i < P.prevCount && prevPrims[i].kind != KIND_NONE;
  if (live) { markMask(tileRect(prims[i]), i); }
  if (P.forceAll != 0u) { return; }
  if (live && wasLive && same(prims[i], prevPrims[i])) { return; }
  if (live) { markDirty(tileRect(prims[i])); }
  if (wasLive) { markDirty(tileRect(prevPrims[i])); }
}

// ---- shade: one workgroup per tile; skip clean tiles ----
var<workgroup> wordStart: array<u32, MASK_WORDS>;
var<workgroup> list: array<u32, MAX_PRIMS>;
var<workgroup> listLen: u32;
var<workgroup> tileDirty: u32;

fn sdf(p: vec2f, q: Prim) -> f32 {
  switch q.kind {
    case KIND_CIRCLE: { return length(p - q.a) - q.r; }
    case KIND_CAPSULE: {
      let pa = p - q.a;
      let ba = q.b - q.a;
      let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
      return length(pa - ba * h) - q.r;
    }
    default: {
      let d = abs(p - q.a) - q.b + vec2f(q.r);
      return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - q.r;
    }
  }
}

fn background(p: vec2f) -> vec3f {
  let g = abs(fract(p / 40.0 + 0.5) - 0.5) * 40.0 * P.scale; // px to nearest grid line
  let line = clamp(1.0 - min(g.x, g.y), 0.0, 1.0);
  return vec3f(0.02, 0.02, 0.05) + vec3f(0.05, 0.05, 0.12) * line;
}

@compute @workgroup_size(16, 16)
fn shade(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) li: u32,
  @builtin(global_invocation_id) gid: vec3u,
) {
  let tile = wid.y * P.tilesX + wid.x;
  if (li == 0u) { tileDirty = (atomicLoad(&dirty[tile / 32u]) >> (tile % 32u)) & 1u; }
  if (workgroupUniformLoad(&tileDirty) == 0u) { return; }

  // Build this tile's shape list in ascending index order.
  if (li < MASK_WORDS) { wordStart[li] = countOneBits(atomicLoad(&tileMasks[tile * MASK_WORDS + li])); }
  workgroupBarrier();
  if (li == 0u) {
    var s = 0u;
    for (var w = 0u; w < MASK_WORDS; w++) { let c = wordStart[w]; wordStart[w] = s; s += c; }
    listLen = s;
  }
  workgroupBarrier();
  if (li < MASK_WORDS) {
    var bits = atomicLoad(&tileMasks[tile * MASK_WORDS + li]);
    var o = wordStart[li];
    while (bits != 0u) {
      list[o] = li * 32u + firstTrailingBit(bits);
      o++;
      bits &= bits - 1u;
    }
  }
  let n = workgroupUniformLoad(&listLen);
  if (gid.x >= P.width || gid.y >= P.height) { return; }

  let p = P.origin + (vec2f(gid.xy) + 0.5) / P.scale;
  var c = background(p);
  for (var k = 0u; k < n; k++) {
    let q = prims[list[k]];
    let col = unpack4x8unorm(q.color).rgb;
    let dpx = sdf(p, q) * P.scale;
    let gpx = q.glow * P.scale;
    if (dpx > 0.0 && dpx < gpx) { let t = 1.0 - dpx / gpx; c += col * (t * t * GLOW_GAIN); }
    let cov = clamp(0.5 - dpx, 0.0, 1.0);
    if (cov > 0.0) { c = c * (1.0 - cov) + col * cov; }
  }
  textureStore(outTex, gid.xy, vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0));
}
