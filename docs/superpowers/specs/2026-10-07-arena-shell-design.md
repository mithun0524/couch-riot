# Couch Riot Arena Shell — Design

Date: 2026-10-07
Status: draft, awaiting review
Parent spec: `2026-10-07-kerf-couch-riot-design.md` (§3). This document
supersedes parent §3 where they differ (noted inline).

## 1. Intent

The room, lobby, voting and phone controllers that every Couch Riot game
plugs into. One big screen (laptop → TV) hosts; up to 8 phones join by QR
and act as controllers.

What the Director said: run locally on home Wi-Fi first; players **vote**
on the next game; flow lobby → vote → play → results → vote.

Assumptions (accepted in review): v1 ships with a throwaway test game
(**Dots**) since Twin-stick is the next plan; host page is the single source
of truth.

Success:
- 3+ friends on the same Wi-Fi scan the QR and are in the lobby within 20 s.
- Thumb movement shows on the TV with no perceptible lag (target: < 50 ms
  phone→screen on LAN).
- Full loop lobby → vote → play → results → vote runs with no laptop
  interaction after the TV page is opened.

Out of scope: internet play/deploy (one command later), accounts,
persistence across TV refresh, spectators, tilt controls (need HTTPS),
audio.

## 2. Architecture

```
Phone page  ──WS──►  Room (Durable Object)  ──WS──►  Host page (TV)
                     membership + relay only          state machine, games, Kerf
```

- **Host page owns all game/session state**: lobby, ready flags, votes,
  scores, the running game. The Room never interprets game messages.
- **Room owns membership only**: slots 0–7, names, reconnect tokens, the
  60 s slot hold. It routes messages; it doesn't decide anything.
- Trade-off accepted: refreshing the TV page loses the session leaderboard
  (parent spec: "lives until tab closes").

### 2.1 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `server/worker.ts` | `POST /room` → new code; `GET /room/:code/ws` → Room | Room |
| `server/room.ts` | Durable Object: slots, tokens, names, hold, routing, junk drop | protocol |
| `shell/protocol.ts` | Encode/decode every message; shared by all sides | — |
| `shell/host/session.ts` | Pure state machine lobby/vote/play/results; no DOM | protocol, game contract |
| `shell/host/main.ts` + `host.html` | Wires session ↔ socket ↔ Kerf ↔ DOM screens | session, Kerf |
| `shell/phone/main.ts` + `play.html` | Join + screens + controller input | protocol |
| `shell/phone/stick.ts` | Floating thumbstick → (dir, mag) quantizer | — |
| `games/dots/` | Test game on the game contract | Kerf PrimList |

## 3. Room server

- **Room code**: 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I/O). Worker
  generates a code, asks the Room (`idFromName(code)`) to init; if a host is
  already attached it retries with a new code.
- **Host socket**: `GET /room/:code/ws?role=host`. One host per room. When
  the host socket closes, the Room sends `host-gone` to every phone, closes
  them, and forgets all state.
- **Phone socket**: `GET /room/:code/ws?role=phone&name=…[&token=…]`.
  - Valid token for a held slot → same slot, `back: true`.
  - Else first free slot; none free → reject with `room-full`.
  - No room / no host → reject with `no-room`.
  - Name: trimmed, 1–12 chars (longer is truncated); duplicate gets a
    suffix (`Sam`, `Sam 2`).
- **Slot hold**: phone socket closes → host gets `leave`; slot held 60 s
  (Durable Object alarm). Reconnect within 60 s with token → `join` with
  `back: true`. After 60 s → host gets `gone`, slot freed.
- **Routing**: phone binary frames → host, prefixed with the sender's slot
  byte. Phone JSON (`ready`, `vote`) → host with `slot` added. Host JSON
  with `to: <slot> | "all"` → those phones, `to` stripped.
- **Junk**: any frame that fails `protocol` decode is dropped, never
  forwarded.
- Membership is in memory only — nothing reads it after the room dies, so
  nothing is persisted.

## 4. Protocol (`shell/protocol.ts`)

### 4.1 Binary input (phone → host), sent only on change

One byte per event; a frame may carry several bytes.

- **Stick byte** (bit 7 = 0): bits 0–3 direction (0–15, 0 = right,
  counter-clockwise in 22.5° steps), bits 4–5 magnitude (0 = centered,
  1–3), bit 6 stick (0 = left, 1 = right).
- **Button byte** (bit 7 = 1): bits 0–5 button id, bit 6 = 1 down / 0 up.

Relayed to host as `[slot, byte, byte, …]`.

### 4.2 JSON messages

| Direction | Message |
|---|---|
| Room → phone | `{t:"welcome", slot, token, color}` · `{t:"host-gone"}` · `{t:"error", code:"room-full"\|"no-room"}` |
| Room → host | `{t:"join", slot, name, back}` · `{t:"leave", slot}` · `{t:"gone", slot}` |
| Phone → host | `{t:"ready", v:boolean}` · `{t:"vote", game:string}` |
| Host → phone | `{t:"screen", screen, data}` · `{t:"buzz", ms}` |

`screen` ∈ `lobby | vote | controller | results | wait`. `data` per screen:
- `lobby`: `{ready: boolean, players: {name, color, ready}[]}`
- `vote`: `{games: {id, name, again: boolean}[], endsAt: number, mine: string|null}`
- `controller`: `{layout: "twinstick"}`
- `results`: `{place, score}`
- `wait`: `{reason: "next-round"}`

Colors: fixed 8-color palette indexed by slot.

## 5. Session flow (`shell/host/session.ts`)

Pure state machine: `(state, event, now) → (state, outbound messages)`.
No timers inside — the host calls `tick(now)`; this keeps it unit-testable.

1. **lobby**: players toggle READY.
   - ≥ 2 players and all ready → **vote**.
   - ≥ 2 players and more than half ready → 15 s countdown shown on TV;
     at 0 → **vote**. Countdown cancels if the ratio drops.
2. **vote** (10 s): each player picks one game; re-tapping changes the
   vote. Ends at 10 s or when every connected player has voted.
   - Most votes wins. Tie → TV shows a 3 s wheel spin, winner chosen
     uniformly among the tied games.
   - No votes at all → random game.
   - Last played game is flagged `again` ("Run it back").
3. **play**: phones get `controller`; game runs until `isOver()`.
4. **results** (8 s): round ranking on TV, placement points added to the
   session leaderboard (1st 3, 2nd 2, 3rd 1). Then → **vote**.

- Joins mid-vote: can vote. Joins mid-play: phone shows `wait` until the
  next vote.
- `leave` mid-play: player's pad goes neutral (stands still); `back`
  restores it.
- Fewer than 2 players connected during vote/results → back to **lobby**.
  During play the round finishes.

## 6. Game contract

Supersedes parent §3 `onInput` contract: games poll pad state each tick
instead of receiving events (simpler, no event ordering bugs).

```ts
interface Pad { left: { dir: number; mag: number }; right: { dir: number; mag: number }; buttons: number }

interface GameModule {
  meta: { id: string; name: string; minPlayers: number };
  controls: 'twinstick';
  create(players: { slot: number; color: number }[]): GameInstance;
}

interface GameInstance {
  tick(pads: ReadonlyArray<Pad | undefined>): void; // fixed 60 Hz, index = slot
  draw(prims: PrimList): void;                      // Kerf shapes, world 1600×900
  isOver(): boolean;
  result(): { slot: number; score: number }[];      // any order; host ranks
}
```

Host runs a fixed 60 Hz tick with a requestAnimationFrame accumulator, then
draws once per frame through one Kerf `Renderer`.

### 6.1 Dots (test game)

- Each player is a glowing circle in their color; left stick moves it,
  right stick shows a small aim pointer.
- 30 s round. Score = distance travelled (world units). Silly on purpose —
  it proves input, ticking, drawing and results.

## 7. Screens

**TV (HTML overlay on the Kerf canvas):**
- lobby: big room code, QR to the phone URL, player tiles (name, color,
  ready), countdown when running.
- vote: game tiles with live vote counts and timer bar; tie wheel.
- play: Kerf canvas only.
- results: round ranking + session leaderboard.

**Phone (plain HTML/CSS, portrait, no framework):**
- join: code prefilled from QR, name field, JOIN.
- lobby: full-width READY toggle in player color.
- vote: tappable game tiles, countdown bar, own pick highlighted.
- controller `twinstick`: screen split left/right; each half spawns a
  floating stick where the thumb lands; landscape recommended.
- results: place + score. wait: "Next round soon".
- Errors: room full / no room / host left — each a full-screen message with
  a "scan again" hint.
- Best-effort on LAN HTTP: fullscreen (Android), `navigator.vibrate` for
  `buzz` (Android only). Screen wake lock needs HTTPS → only after deploy.
  Correction to earlier chat: vibration does not need HTTPS; tilt does.

## 8. Local dev on Wi-Fi

- `npm run dev` starts Vite (`host: true`) and `wrangler dev --ip 0.0.0.0`
  together.
- Vite injects the laptop's LAN IPv4 at dev time so the QR points to
  `http://<lan-ip>:5173/play.html?c=CODE`; phone opens WS to
  `ws://<lan-ip>:8787`.
- If the laptop has no LAN address, the TV shows the URL with `localhost`
  and a warning that phones can't reach it.

## 9. Testing

- **protocol**: round-trip every JSON message; stick byte for all 16 dirs ×
  4 mags × 2 sticks; button byte for ids 0–63 down/up; junk bytes rejected.
- **room** (Cloudflare Workers test pool): host attach; join assigns slots;
  9th phone `room-full`; unknown code `no-room`; duplicate names suffixed;
  reconnect with token within 60 s keeps slot (`back: true`); after alarm
  slot freed + `gone`; host close → phones get `host-gone`; junk dropped.
- **session** (node unit): all-ready → vote; majority → 15 s countdown and
  cancel; vote resolves majority; tie picks among tied only; no votes →
  any game; mid-play join → `wait`; drop below 2 → lobby; points 3/2/1.
- **stick quantizer**: angle/distance → dir/mag edges (dead zone, 16
  sectors).
- **end-to-end** (Playwright): TV + 3 phone pages → join, ready, vote,
  move left stick on phone 1, assert phone 1's dot moved on TV (via a test
  hook exposing dot positions), round ends → results shown.

## 10. Stack & layout additions

- `wrangler`, `@cloudflare/vitest-pool-workers` (Room tests), `qrcode`
  (QR rendering — encoding is not worth hand-rolling).
- ```
  server/   worker.ts, room.ts, wrangler.toml
  shell/    protocol.ts, host/, phone/
  games/dots/
  ```

## 11. Risks

- Some home routers block device-to-device traffic (AP/client isolation) →
  phones can't reach the laptop. Mitigation: TV shows the URL; fallback is
  deploying (one command).
- Phone browsers throttle background tabs; a locked phone drops its socket —
  covered by the 60 s hold.
- iOS Safari: no vibration, no fullscreen for pages — controller still
  works.
