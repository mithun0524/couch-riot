const TILE: u32 = 16u;
const MAX_SHAPES: u32 = 2048u;
const MASK_WORDS: u32 = 64u;
const KIND_NONE: u32 = 0u;
const KIND_SPHERE: u32 = 1u;
const KIND_ELLIPSOID: u32 = 2u;
const KIND_CAPSULE: u32 = 3u;
const KIND_ROUNDBOX: u32 = 4u;
const KIND_CYLINDER: u32 = 5u;
const KIND_PLANE: u32 = 6u;

// Exactness (spec §5): every distance used for stepping is min(d, STEP_CAP); a tile's list holds every
// shape whose bounds grown by REACH_GROW (= STEP_CAP + AO_MAX) reach its rays, so excluded shapes are
// always >= STEP_CAP away at every point any march or AO sample visits.
const STEP_CAP: f32 = 48.0;
const AO_MAX: f32 = 24.0;
const REACH_GROW: f32 = 72.0;
const SWEEP_FLOOR: f32 = -72.0;
const MAX_STEPS: u32 = 160u;
const MAX_DIST: f32 = 8000.0;
const SHADOW_STEPS: u32 = 48u;
const SHADOW_MAX: f32 = 1500.0;
const SURF_EPS: f32 = 0.05;
const PAD_PX: f32 = 2.0;

struct Shape { pos: vec3f, kind: u32, size: vec3f, round: f32, rot: vec4f, color: u32, material: u32, group: u32, emission: f32 }
struct Cam { eye: vec3f, mode: u32, right: vec3f, sx: f32, up: vec3f, sy: f32, fwd: vec3f, near: f32 }
struct Env { sunDir: vec3f, sunAngle: f32, sunColor: vec3f, sunIntensity: f32, skyColor: vec3f, skyIntensity: f32 }
struct Params { count: u32, prevCount: u32, tilesX: u32, tilesY: u32, forceAll: u32, brute: u32, width: u32, height: u32 }
struct Uni { cam: Cam, env: Env, p: Params }

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var<storage, read> prevShapes: array<Shape>;
@group(0) @binding(3) var<storage, read_write> tileMasks: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> dirty: array<atomic<u32>>;
@group(0) @binding(5) var hdr: texture_storage_2d<rgba16float, write>;

// ---------- clear ----------
@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let tiles = U.p.tilesX * U.p.tilesY;
  if (i < tiles * MASK_WORDS) { atomicStore(&tileMasks[i], 0u); }
  if (i < (tiles + 31u) / 32u) { atomicStore(&dirty[i], select(0u, 0xffffffffu, U.p.forceAll != 0u)); }
}

// ---------- geometry ----------
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn sdShape(pw: vec3f, s: Shape) -> f32 {
  if (s.kind == KIND_PLANE) { return pw.y - s.pos.y; }
  if (s.kind == KIND_CAPSULE) {
    let pa = pw - s.pos;
    let h = clamp(dot(pa, s.size) / max(dot(s.size, s.size), 1e-12), 0.0, 1.0);
    return length(pa - s.size * h) - s.round;
  }
  let p = qrot(vec4f(-s.rot.xyz, s.rot.w), pw - s.pos);
  switch s.kind {
    case KIND_SPHERE: { return length(p) - s.size.x; }
    case KIND_ELLIPSOID: {
      let r = s.size;
      // lower bound with the true zero set; second term keeps it >= distance to the bounding sphere (spec §5)
      return max((length(p / r) - 1.0) * min(r.x, min(r.y, r.z)), length(p) - max(r.x, max(r.y, r.z)));
    }
    case KIND_ROUNDBOX: {
      let q = abs(p) - s.size + vec3f(s.round);
      return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - s.round;
    }
    default: { // cylinder along local y
      let d = vec2f(length(p.xz), abs(p.y)) - vec2f(s.size.x, s.size.y) + vec2f(s.round);
      return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - s.round;
    }
  }
}

// Bounding sphere (center, radius); radius < 0 = unbounded (plane).
fn bound(s: Shape) -> vec4f {
  switch s.kind {
    case KIND_SPHERE: { return vec4f(s.pos, s.size.x); }
    case KIND_ELLIPSOID: { return vec4f(s.pos, max(s.size.x, max(s.size.y, s.size.z))); }
    case KIND_CAPSULE: { return vec4f(s.pos + s.size * 0.5, length(s.size) * 0.5 + s.round); }
    case KIND_ROUNDBOX: { return vec4f(s.pos, length(s.size)); }
    case KIND_CYLINDER: { return vec4f(s.pos, length(s.size.xy)); }
    default: { return vec4f(s.pos, -1.0); }
  }
}

// ---------- camera ----------
fn ndcToPixel(n: vec2f) -> vec2f {
  return vec2f((n.x + 1.0) * 0.5 * f32(U.p.width), (1.0 - n.y) * 0.5 * f32(U.p.height));
}

// World point -> pixel. Sets *ok = false if the point is behind the camera plane.
fn project(w: vec3f, ok: ptr<function, bool>) -> vec2f {
  let v = w - U.cam.eye;
  let z = dot(v, U.cam.fwd);
  if (U.cam.mode == 0u) {
    if (z < U.cam.near) { *ok = false; return vec2f(0.0); }
    return ndcToPixel(vec2f(dot(v, U.cam.right) / (z * U.cam.sx), dot(v, U.cam.up) / (z * U.cam.sy)));
  }
  if (z < 0.0) { *ok = false; return vec2f(0.0); }
  return ndcToPixel(vec2f(dot(v, U.cam.right) / U.cam.sx, dot(v, U.cam.up) / U.cam.sy));
}

struct Ray { o: vec3f, d: vec3f }

fn pixelRay(pix: vec2u) -> Ray {
  let n = vec2f((f32(pix.x) + 0.5) / f32(U.p.width) * 2.0 - 1.0, 1.0 - (f32(pix.y) + 0.5) / f32(U.p.height) * 2.0);
  if (U.cam.mode == 0u) {
    return Ray(U.cam.eye, normalize(U.cam.fwd + n.x * U.cam.sx * U.cam.right + n.y * U.cam.sy * U.cam.up));
  }
  return Ray(U.cam.eye + n.x * U.cam.sx * U.cam.right + n.y * U.cam.sy * U.cam.up, U.cam.fwd);
}

// ---------- bin ----------
// Inclusive tile rect; empty when x0 > x1 or y0 > y1.
fn reach(s: Shape) -> vec4i {
  let mx = vec2i(i32(U.p.tilesX) - 1, i32(U.p.tilesY) - 1);
  let whole = vec4i(0, 0, mx.x, mx.y);
  if (U.p.brute != 0u) { return whole; }
  let b = bound(s);
  let L = U.env.sunDir;
  if (b.w < 0.0 || L.y < 0.05) { return whole; }
  let r = b.w + REACH_GROW;
  let lo = b.xyz - vec3f(r);
  let hi = b.xyz + vec3f(r);
  var mn = vec2f(1e30);
  var mxp = vec2f(-1e30);
  var ok = true;
  for (var i = 0u; i < 8u; i++) {
    let c = vec3f(select(lo.x, hi.x, (i & 1u) != 0u), select(lo.y, hi.y, (i & 2u) != 0u), select(lo.z, hi.z, (i & 4u) != 0u));
    let onFloor = c - L * ((c.y - SWEEP_FLOOR) / L.y); // the corner swept along -sun to below the floor
    let a = project(c, &ok);
    let f = project(onFloor, &ok);
    mn = min(mn, min(a, f));
    mxp = max(mxp, max(a, f));
  }
  if (!ok) { return whole; }
  let t = f32(TILE);
  let lim = vec2f(f32(U.p.width), f32(U.p.height)) + t;
  let l = clamp(mn - PAD_PX, vec2f(-t), lim);
  let h = clamp(mxp + PAD_PX, vec2f(-t), lim);
  return vec4i(max(vec2i(floor(l / t)), vec2i(0)), min(vec2i(floor(h / t)), mx));
}

fn markMask(rc: vec4i, idx: u32) {
  for (var y = rc.y; y <= rc.w; y++) {
    for (var x = rc.x; x <= rc.z; x++) {
      let tile = u32(y) * U.p.tilesX + u32(x);
      atomicOr(&tileMasks[tile * MASK_WORDS + idx / 32u], 1u << (idx % 32u));
    }
  }
}

fn markDirty(rc: vec4i) {
  for (var y = rc.y; y <= rc.w; y++) {
    for (var x = rc.x; x <= rc.z; x++) {
      let tile = u32(y) * U.p.tilesX + u32(x);
      atomicOr(&dirty[tile / 32u], 1u << (tile % 32u));
    }
  }
}

fn same(a: Shape, b: Shape) -> bool {
  return all(a.pos == b.pos) && a.kind == b.kind && all(a.size == b.size) && a.round == b.round
      && all(a.rot == b.rot) && a.color == b.color && a.material == b.material && a.group == b.group
      && a.emission == b.emission;
}

@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let live = i < U.p.count && shapes[i].kind != KIND_NONE;
  let wasLive = i < U.p.prevCount && prevShapes[i].kind != KIND_NONE;
  if (live) { markMask(reach(shapes[i]), i); }
  if (U.p.forceAll != 0u) { return; }
  if (live && wasLive && same(shapes[i], prevShapes[i])) { return; }
  if (live) { markDirty(reach(shapes[i])); }
  if (wasLive) { markDirty(reach(prevShapes[i])); }
}

// ---------- shade ----------
var<workgroup> wordStart: array<u32, MASK_WORDS>;
var<workgroup> list: array<u32, MAX_SHAPES>;
var<workgroup> listLen: u32;
var<workgroup> tileDirty: u32;

struct Near { d: f32, id: u32 }

fn nearest(p: vec3f, n: u32) -> Near {
  var best = Near(1e30, 0xffffffffu);
  for (var k = 0u; k < n; k++) {
    let i = list[k];
    let d = sdShape(p, shapes[i]);
    if (d < best.d) { best = Near(d, i); }
  }
  return best;
}

struct Trace { t: f32, id: u32, hit: bool }

fn march(r: Ray, n: u32) -> Trace {
  var t = 0.0;
  for (var s = 0u; s < MAX_STEPS; s++) {
    let h = nearest(r.o + r.d * t, n);
    if (h.d < 0.0005 * t + 0.02) { return Trace(t, h.id, true); }
    t += min(h.d, STEP_CAP);
    if (t > MAX_DIST) { break; }
  }
  return Trace(t, 0u, false);
}

fn normalAt(p: vec3f, n: u32) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.02;
  return normalize(e.xyy * nearest(p + e.xyy, n).d + e.yyx * nearest(p + e.yyx, n).d
                 + e.yxy * nearest(p + e.yxy, n).d + e.xxx * nearest(p + e.xxx, n).d);
}

fn softShadow(p: vec3f, L: vec3f, n: u32) -> f32 {
  let k = 1.0 / max(U.env.sunAngle, 1e-3);
  var res = 1.0;
  var t = 0.5;
  for (var s = 0u; s < SHADOW_STEPS; s++) {
    let d = min(nearest(p + L * t, n).d, STEP_CAP);
    res = min(res, k * d / t);
    if (res < 0.001 || t > SHADOW_MAX) { break; }
    t += clamp(d, 0.5, STEP_CAP);
  }
  return clamp(res, 0.0, 1.0);
}

fn ambientOcclusion(p: vec3f, nrm: vec3f, n: u32) -> f32 {
  var occ = 0.0;
  var w = 1.0;
  for (var i = 1u; i <= 4u; i++) {
    let h = AO_MAX * f32(i) / 4.0;
    let d = min(nearest(p + nrm * h, n).d, STEP_CAP);
    occ += max(h - d, 0.0) * w;
    w *= 0.6;
  }
  return clamp(1.0 - occ / AO_MAX, 0.0, 1.0);
}

fn sky(d: vec3f) -> vec3f {
  return U.env.skyColor * U.env.skyIntensity * (0.3 + 0.7 * max(d.y, 0.0));
}

fn shadePixel(pix: vec2u, n: u32) -> vec3f {
  let r = pixelRay(pix);
  let tr = march(r, n);
  if (!tr.hit) { return sky(r.d); }
  let p = r.o + r.d * tr.t;
  let s = shapes[tr.id];
  let nrm = normalAt(p, n);
  let base = pow(unpack4x8unorm(s.color).rgb, vec3f(2.2));
  let L = U.env.sunDir;
  let ndl = max(dot(nrm, L), 0.0);
  var sh = 0.0;
  if (ndl > 0.0) { sh = softShadow(p + nrm * SURF_EPS, L, n); }
  let ao = ambientOcclusion(p, nrm, n);
  let lit = U.env.sunColor * U.env.sunIntensity * ndl * sh + U.env.skyColor * U.env.skyIntensity * ao;
  return base * lit + base * s.emission;
}

@compute @workgroup_size(16, 16)
fn shade(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) li: u32,
  @builtin(global_invocation_id) gid: vec3u,
) {
  let tile = wid.y * U.p.tilesX + wid.x;
  if (li == 0u) { tileDirty = (atomicLoad(&dirty[tile / 32u]) >> (tile % 32u)) & 1u; }
  if (workgroupUniformLoad(&tileDirty) == 0u) { return; }

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
  if (gid.x >= U.p.width || gid.y >= U.p.height) { return; }
  textureStore(hdr, gid.xy, vec4f(shadePixel(gid.xy, n), 1.0));
}
