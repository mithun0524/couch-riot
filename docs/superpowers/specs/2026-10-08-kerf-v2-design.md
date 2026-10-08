# Kerf v2 — Physically Based 3D SDF Engine — Design

Date: 2026-10-08
Status: draft, awaiting review
Supersedes: Kerf v1 rendering model (parent spec `2026-10-07-kerf-couch-riot-design.md` §4.1–4.2). Keeps v1's
core contract: optimized output is byte-identical to a brute-force reference, and only changed tiles are
recomputed.

## 1. Intent

The Director chose a premium "Neon Noir world × jelly characters" art direction and ruled: build true 3D now
(no cheap fake-3D to migrate later) and make light and materials **physically based**.

Success:
- Glossy, translucent jelly blobs that read as real material: thin edges glow, thick centers saturate,
  merged blobs mix color.
- Players are real light sources: their light falls on the floor and each other with physical falloff.
- Blobs that touch melt together (smooth union) and separate.
- Neon 2D games (Twin-stick, Dogfight, Bee Swarm) render through the same engine with a top-down
  orthographic camera.
- Byte-identical to the brute-force reference on every test scene.
- Same perf gate as v1: worst-case scene p99 ≤ 16.6 ms at 1080p and 4K on the reference machine.

Out of scope (v2): multi-bounce global illumination, shadows from player lights, refraction (bending) through
jelly, textures, skinned meshes, audio. A lobby-time path-traced bake of static scenery is a possible v3.

## 2. Coordinate system & cameras

- Right-handed, **y up**, floor plane `y = 0`, ground plane x/z. Units: world units (Couch Riot arena is
  1600 × 900 on x/z).
- Camera is **fixed per scene** (a change forces a full redraw, as in v1).
  - `perspective`: position, target, vertical FOV. Default 3/4 view ≈ 55° pitch for 3D games and the lobby.
  - `ortho`: straight down, world rect → screen. Used by neon 2D games.

## 3. Shapes

### 3.1 Kinds

All evaluated in the shape's local frame (inverse rotation applied to `p − pos`).

| Kind | Params | Distance function |
|---|---|---|
| sphere | radius | exact |
| ellipsoid | half-axes | `max((|p/r| − 1)·min(r), |p| − max(r))` — a lower bound (1-Lipschitz), same zero set as the true surface; normal = `normalize(p / r²)` exact. The second term keeps it ≥ the distance to its bounding sphere, which §5 relies on |
| capsule | endpoint offset, radius | exact |
| roundbox | half-extents, corner radius | exact |
| cylinder | radius, half-height, edge round | exact |
| plane | (floor only) | exact |

### 3.2 Groups (melting)

- Shapes with the same non-zero `group` combine with polynomial smooth-min of width `k` (per-group table).
- Smooth-min lowers distance by at most `k/4`; every group member's bounds grow by `k/4`.
- Colors and materials blend with the same weight smooth-min uses, so merged blobs mix.

### 3.3 Shape record (64 bytes, WGSL-aligned)

```
pos: vec3f, kind: u32
size: vec3f, round: f32        // per-kind params (radius / half-axes / capsule b-offset / ...)
rot: vec4f                     // unit quaternion
color: u32 (rgba8), material: u32, group: u32, emission: f32
```

Max shapes: 2048 (v1 limit kept; exceeding throws). v1's 2D calls (`circle`, `capsule`, `box`) remain and map
to thin shapes on the floor at `y = 0`, so Dots and the v1 bench keep working.

## 4. Light transport

### 4.1 Pipeline
- All lighting in linear HDR, stored per tile in an `rgba16float` cache.
- A present pass applies exposure + filmic tone curve (ACES fit) + sRGB encode to the canvas every frame
  (cheap, full screen, deterministic).

### 4.2 Materials (table, ≤ 16 entries)
- Base color comes from the shape; the material adds `metallic`, `roughness`, `transmission density`
  (absorption per world unit), `emission scale`.
- Surface reflection: Cook–Torrance — GGX distribution, Smith height-correlated visibility, Schlick
  Fresnel — plus Lambert diffuse weighted by `(1 − F)(1 − metallic)`. Energy-conserving.
- **Jelly (transmission > 0)**: at the hit, the ray continues through the shape to the exit point;
  absorbed by Beer–Lambert `exp(−density · thickness · (1 − color))`; then continues straight on (no
  bending) to whatever is behind. Thickness is exact from the SDF.
- Emission: radiance = color × emission scale (blobs glow from within).

### 4.3 Lights
- **Sun**: directional, with angular radius (soft shadows). Shadow softness is an SDF cone estimate
  (approximation, listed in §4.5).
- **Player lights**: up to 8 spherical area lights (center, radius, color × intensity). Irradiance on a
  surface uses the closed-form sphere-light formula (exact for an unoccluded sphere) multiplied by the
  windowed inverse-square falloff `(1 − (d/R)⁴)²₊`, which gives each light a finite range `R`. Player
  lights cast no shadows in v2.
- **Haze glow**: a thin uniform haze; single scattering from each player light along the view ray uses the
  closed-form point-light in-scattering integral, inside the light's range. This is the physical origin of
  the halo around glowing things (no blur, no bloom pass).
- **Sky**: uniform cool ambient, scaled by SDF ambient occlusion (approximation, §4.5).

### 4.4 Ray marching
- Primary ray per pixel center. Sphere tracing with **step cap `D`**: each step advances
  `min(scene distance, D)`. Hit when distance < ε(t) (scales with distance), max steps fixed, max ray
  length fixed by the scene's bounds.
- Normals: analytic where exact (sphere, ellipsoid, plane), otherwise central differences of the same
  distance function.
- Sun shadow ray: same capped marching toward the sun.
- AO: fixed samples along the normal, all within distance `≤ D`.

### 4.5 Exact vs approximated (stated for honesty)
- Exact: geometry and normals, surface reflection model, jelly thickness and absorption, sphere-light
  irradiance (unoccluded), haze in-scattering from lights, tone mapping.
- Approximated: soft-shadow penumbra width (cone estimate), sky occlusion (AO), no multi-bounce light, no
  player-light shadows, no refraction bending.
- All of it is deterministic, so the exactness contract (§5) still holds.

## 5. Exactness in 3D: the step cap

Problem: sphere tracing's step depends on the nearest surface in the **whole** scene. A tile that ignores far
shapes would take different steps than the brute-force reference, so pixels would differ.

Rule: every march (primary, through-jelly, shadow, AO) steps by `min(d, D)` with the same constant `D` in
both modes. Every shape's distance function is ≥ the distance to its bounding sphere (true for exact SDFs; enforced for the
ellipsoid). A tile's shape list contains every shape whose bounds, grown by `D` (and by the AO reach), could come within reach of
any ray the tile casts. Any excluded shape therefore always has `d ≥ D`, so `min(d_all, D) = min(d_list, D)`
at every step: identical steps, identical pixels.

A shape's **screen reach** = screen rectangle (plus 2 px) covering the projection of:
1. its world bounds grown by `D` and `k/4` (if grouped) — catches primary and through-jelly rays (no
   bending keeps them inside the tile frustum) and AO;
2. those grown bounds swept along `−sunDir` down to the floor — catches every surface it can shadow;
3. if bounds reach behind the camera's near plane → the whole screen.

A light's **screen reach** = projection of its range sphere `R` (surfaces it lights and haze it scatters
into).

Tile lists hold shapes and lights whose reach overlaps the tile, in ascending index order (as in v1).

## 6. Incremental frames

As v1: a shape or light whose record changed marks tiles in its old and new reach dirty; camera, sun, sky,
material-table or group-table changes mark everything dirty. Clean tiles keep last frame's
HDR pixels. Exposure/tone curve run in the present pass, so changing exposure never dirties tiles.

Brute-force reference = same pipeline with every shape and light in every tile and every tile dirty.

## 7. API (TypeScript)

```ts
const k = await Kerf.create(device, { width, height });
k.camera.perspective({ eye, target, fovY }) | k.camera.ortho({ x, z, w, h });
k.sun.set({ dir, angularRadius, color, intensity }); k.sky.set({ color, intensity }); k.exposure = 1;
k.materials.set(id, { metallic, roughness, transmission, emission });
k.groups.set(id, { k });
const s = k.shapes;   // ShapeList (64-byte records), cleared per frame by the caller
s.sphere(pos, r, color, opts?); s.ellipsoid(pos, axes, rot, color, opts?); s.capsule(a, b, r, color, opts?);
s.roundbox(pos, half, round, rot, color, opts?); s.cylinder(pos, r, halfH, round, rot, color, opts?);
s.circle/capsule2d/box  // v1 2D calls → thin floor shapes
k.lights.sphere(pos, radius, color, intensity, range);
k.frame(); k.present(ctx); await k.readback(); // readback = HDR bytes for equivalence
```

`opts`: `{ material, group, emission }`.

## 8. Verification

- **Equivalence (byte-exact on the HDR cache)** fast vs brute, multi-frame, scenes:
  - lobby: 8 jelly blobs wandering, bumping/merging, each with a light; sun shadows across tiles.
  - grouped blobs merging and separating.
  - lights moving over a static scene (only light reach redrawn).
  - shapes partly behind the camera, at screen edges, crossing tile corners.
  - removal / count shrink, camera change, sun change.
  - v1 2D scene (ortho) — neon look preserved.
- **Material sanity (unit, GPU)**: energy conservation (white furnace: a white rough sphere under uniform
  sky never exceeds sky radiance); Fresnel → 1 at grazing; jelly thickness ↑ ⇒ transmitted light ↓.
- **Light sanity**: sphere-light irradiance matches the closed form at sampled distances; falls to 0 at range.
- **Mutation checks** (as v1): disabling old-reach dirty marking, dropping shadow sweep, or dropping `D`
  growth must each fail equivalence.
- **Bench**: lobby scene + v1 neon worst case, 1080p and 4K, p99 gate; plus the head-to-head harness
  re-run against PixiJS / Three.js for the neon scene.

## 9. Risks

- Ray marching with jelly transmission + 8 lights per pixel is far heavier than v1. Low-end 4K is the
  biggest risk; the bench gates further work and tuning targets only measured hotspots (`D`, tile size,
  max steps).
- Conservative reach (shadow sweeps, light ranges) can make tile lists long in busy scenes; measured, not
  guessed.
- Byte-exact equivalence depends on both modes running identical shader code on identical data (as v1);
  any compiler-dependent divergence is escalated, never tolerated.
