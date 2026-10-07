# Couch Riot + Kerf Engine — Design (v1)

Date: 2026-10-07
Status: draft, awaiting review

## 1. Intent

A browser party-game arena. One big screen (laptop/TV) runs the games; every
player joins on their phone by room code/QR and uses it as a controller
(Jackbox-style). Mad, chaotic, unrealistic games. No AI features.

Success for v1:
- Friends in one room join from phones in < 20 s and play a full Twin-stick
  match on the big screen.
- Locked 60 fps at native resolution (1080p and 4K) on the reference low-end
  machine (§6) with the worst-case scene.
- Optimized frame output is pixel-identical to the brute-force reference
  renderer (§6).

Out of v1: games 2–10 (each gets its own spec), accounts, persistence,
matchmaking with strangers, spectators, audio beyond basic SFX.

## 2. Scope of v1

1. **Kerf** — custom WebGPU engine (§4).
2. **Arena shell** — room server, host page, phone controller (§3).
3. **Twin-stick Arena** — first game, built on Kerf (§5).

Game roadmap (one at a time, each its own spec): Floor is Lava, Zombie Last
Stand, Kaiju Rampage, Hungry Hole, Meteor Dodge Dinos, Bee Swarm War,
Asteroid Dogfight, Death Kart, Shopping Cart Downhill.

## 3. Arena shell

```
Phone (/play/CODE) ──WS──► Room (Durable Object, relay only) ──WS──► Host (/)
   ◄──────────────── per-player HUD/haptics events ─────────────────────┘
```

- **Room server**: Cloudflare Worker + one Durable Object per room. Holds
  membership only (in memory, no DB — nothing reads history). Relays
  messages; zero game logic. 4-letter room code, max 8 players.
- **Host page**: creates room, shows code + QR, lobby (names, colors),
  game picker, round scoreboard, session leaderboard (lives until tab
  closes), game mount point.
- **Controller page**: name entry, assigned color, renders the control
  layout the active game requests (`twinstick` | `stick+buttons` | `tilt`),
  shows own HUD (health, ammo), vibrates on events (Vibration API).
- **Reconnect**: player keeps slot by token in sessionStorage for 60 s.
  Host disconnect → phones show "waiting for host".
- **Wire protocol** (binary):
  - Stick: 1 byte = 4-bit direction (16 dirs) + 2-bit magnitude (4 levels)
    + 2 spare bits. Sent only on change.
  - Buttons: 1-byte event (id + down/up). Sent on change.
  - Host → phone: small HUD/haptic events only. World state never leaves
    the host.
- **Game module contract**:
  `{ meta, controls, init(world, players), onInput(id, input), tick(), isOver(), result() }`
  Each game lazy-loads from its own folder.

## 4. Kerf engine

### 4.1 Representation — everything is an analytic shape
- Scene = signed-distance primitives (sphere, capsule, rounded box,
  cylinder, plane) combined with union / smooth-union / subtraction.
- Consequences used by the games:
  - Exact soft shadows, glow and AO from closed-form/analytic SDF evaluation
    — no shadow maps, no blur-based bloom.
  - Resolution-independent edges; no AA pass.
  - Destruction = CSG subtraction (kaiju, hole, lava).
- Art style follows: chunky, rounded, primitive-built. Neon (orthographic
  top-down) or 3D (fixed angled camera) chosen per game.

### 4.2 Incremental frame — build-system for pixels
- Screen split into tiles (size tuned by bench, start 16×16).
- Each tile keeps a dependency list: primitives whose surface, shadow or
  glow *influence bound* overlaps the tile.
- Per frame: a GPU pass marks tiles dirty whose dependency set or any
  dependency's state changed; only dirty tiles are shaded; clean tiles keep
  last frame's pixels.
- Static geometry lighting computed once into a tile cache; invalidated only
  by destruction or static change.
- Dynamic–dynamic interactions (shadow of one moving object on another) are
  computed exactly per frame, limited to tiles where both influences overlap.
- Invariant: output == full recompute. Enforced by reference test (§6).

### 4.3 GPU-resident world
- World state (transforms, bullets, particles, crowds) lives in WebGPU
  storage buffers; simulation runs in compute shaders.
- CPU→GPU per frame: input deltas only. GPU→CPU: a small event buffer
  (deaths, hits, round end) read asynchronously.

### 4.4 Determinism
- Fixed 60 Hz sim tick, decoupled from render.
- Fixed-point integer math in simulation → identical results for identical
  inputs; required for reference comparison and replays in bench.

### 4.5 Platform
- WebGPU only (Chrome/Edge desktop & ChromeOS). Unsupported browser →
  clear message. No WebGL fallback (would be a second engine).

## 5. Twin-stick Arena (game 1)

- Look: neon, orthographic top-down.
- Players: 2–8. Controls: `twinstick` — left stick moves, right stick
  aims and auto-fires while held.
- Mode: free-for-all, 3-minute round. +1 per kill, −1 per self-hazard death.
  Respawn after 2 s at the spawn point farthest from enemies, 1.5 s
  spawn shield.
- Health: 3 hits. Phone vibrates on hit; HUD shows health.
- Arena: single map, walls built from rounded boxes, a few cover blocks.
- Pickups (one spawns every 10 s, max 2 on map, 8 s duration):
  - **Chicken cannon** — slow, big, bouncing projectiles.
  - **Boomerang laser** — beam that returns, hits twice.
  - **Shotgun spray** — 5-way spread.
- Round end: scoreboard on host, winner's color floods the arena.

## 6. Verification

- **Reference renderer**: brute-force path — every pixel evaluates every
  primitive every frame, no tiles, no caching. Same shaders otherwise.
- **Equivalence test**: scripted deterministic input replay; capture N
  frames from both paths; byte-for-byte compare. Runs on every change.
- **Bench mode**: worst-case scripted scene (8 players, max projectiles,
  max particles, all pickups) at 1080p and 4K; records frame-time
  p50/p99. Pass = p99 ≤ 16.6 ms.
- **Reference machine**: Intel UHD 620-class iGPU, Chrome with 4× CPU
  throttle. Real hardware preferred; throttled dev machine is the CI proxy.
- **Shell tests**: room join/leave/reconnect, protocol encode/decode
  round-trip.

## 7. Stack & layout

- Vite + TypeScript (frontend), WGSL shaders, Cloudflare Worker + Durable
  Objects (`wrangler`). No runtime framework, no Three.js.
- One repo:
  ```
  engine/      Kerf (shapes, tiles, sim kernels, reference path)
  shell/       host + controller pages, protocol
  server/      Worker + Room Durable Object
  games/twinstick/
  bench/       scenes, equivalence + frame-time harness
  ```

## 8. Risks

- Kerf is unproven; bench is the gate. If tile-incremental shading can't
  hold budget on the reference machine, revisit §4.2 before game work.
- Influence bounds for soft shadows/glow must be conservative or the
  equivalence test fails — expected to be the hardest correctness area.
- Fixed-point sim in WGSL needs care (no i64 in WGSL; use 32-bit 16.16).
- WebGPU only excludes pre-~2017 hardware and some browsers.
