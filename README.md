# 13 — Mongol Poker (Монгол Покер)

A 2–4 player Big-Two-style card game for the [Usion](https://usions.com) platform,
open-sourced as a **best-practice reference** for building multiplayer mini-apps
with the [Usion SDK](https://www.npmjs.com/package/@usions/sdk) (`window.Usion`).

Three files, no build step: [index.html](index.html) · [script.js](script.js) · [style.css](style.css).

> Товч монголоор: энэ бол Usion платформ дээрх «13» хөзрийн тоглоомын бүрэн эх
> код. Usion SDK-ийн multiplayer гэрээг (host-authoritative deal, deterministic
> turn-log, checkpoint reconnect, forfeit grace, solo→host promotion, i18n,
> permission-gated notifications) хэрхэн зөв хэрэгжүүлэхийг харуулах зорилготой
> нээлттэй жишээ.

## Game rules (short)

- 2–4 players, 13 cards each. First to empty their hand wins the round; the
  others gain penalty points for cards left (n ≤ 9 → n, 10–12 → 2n, 13 → 3n).
  Reach the lose-at threshold (20/30/40) and you're eliminated; last survivor wins.
- Single-card strength high→low: `2 A K Q J 10 9 8 7 6 5 4 3`; suits `♠ > ♥ > ♣ > ♦`.
- Combos: single, pair, triple, four, and 5-card hands
  (straight < flush < full house < four+1 < straight flush). Follow with a
  bigger combo of the SAME size, or pass. Being dealt all 13 ranks = instant win ("dragon").

## Why this is a reference implementation

### 1. Deterministic engine + turn log

Online play never ships card data around. The host broadcasts one stored
`deal` action carrying a **PRNG seed** (`mulberry32`) plus the seat order; every
client deals identical hands locally and applies the same **sequenced move log**
(`Usion.game.action("move", …)`). Any client can rebuild the entire round from
`(seed, moves)` — which is exactly what reconnect recovery does.

### 2. The multiplayer contract, implemented

| Contract requirement | Where |
|---|---|
| `connect()` → register handlers → `join(config.roomId)` | `setupMultiplayer()` / `registerNetHandlers()` |
| `playerIds[0]` is the host/authority | `isHostPlayer()`; only the host deals & stores leave outcomes |
| Handlers registered up front, even on a `'single'` launch | `Usion.game.onRoomAssigned` registered in `Usion.init` |
| Solo → host promotion (host Share button) | `onRoomPromoted()` — drops the bots round, opens the waiting room |
| Trust `mode`, never infer multiplayer from `roomId` | `launchedSolo()` (a solo launch may still get a `standalone_` room) |
| `action()` for turn-based moves, `realtime()` for ephemera | moves/deals vs `player_info`/`state_push` |
| Winner decided by authority, not self-reported | host stores `forfeit_win`/`leave_fold`; scores derive from the shared log |
| `onDisconnect` → real pause | `netPaused` freezes the turn clock so a dropped player can't be auto-passed |
| `onPlayerLeft` → forfeit, with grace | 20 s `startForfeitGrace()` — a quick rejoin resumes the hand untouched |

### 3. Reconnect recovery: checkpoint + replay tail

- Whoever **just acted** persists a checkpoint with `Usion.game.setState()`
  (`currentCheckpoint()`): seed, seat order, this round's moves, round-start
  totals, and the sequence it includes. Actor-written (not host-only) so the
  snapshot stays fresh even while the host is backgrounded.
- A (re)joining client gets the checkpoint as `game_state` (join ack / `onSync`)
  → `applyCheckpoint()` re-deals the same seed and replays the tail of actions
  **past the checkpoint's own sequence** (the server's action replay is
  inclusive — skipping `seq <= checkpoint.seq` avoids double-applied moves).
- Every applied action is deduped by `sequence` (`appliedSequences`), and moves
  are anchored to the **sender's seat**, so the turn pointer self-corrects
  instead of drifting after a missed packet.
- Foreground catch-up: RN WebViews fire no `visibilitychange`, so a 1 s
  wall-clock heartbeat detects the frozen-JS gap and pumps
  `requestSync(lastSeq)` until the sequence advances (`beginResync()`).
- As a second recovery path the host **pushes** the current checkpoint over the
  room broadcast when someone (re)joins (`broadcastStatePush`).

### 4. Rematch (platform mode)

Platform mode has **no server-side restart event** — `Usion.game.requestRematch()`
is a pure broadcast to the other players. So: a non-host's PLAY AGAIN sends the
request (peers see who asked via `onRematchRequest`); the **host's** PLAY AGAIN
broadcasts a normal stored `deal` action with `reset: true`, which every client
applies in `onDeal` by zeroing match state before dealing — deterministic and
replay-safe.

### 5. Waiting-room lobby (allowed, in-room only)

While invited players trickle into `config.roomId`, the game shows who's
present with a ready toggle; the host locks the final seat order into the
`deal` action so every client (and every reconnect) derives identical seating.
The lobby never creates rooms or draws invite/share UI — the platform owns
invites (host Share button / `Usion.game.invite()`).

### 6. Solo / GameTok

A `'single'` launch (Explore or the GameTok feed) drops straight into a
zero-tap round vs 3 bots — no menu, per the GameTok contract. The same build
still registers all multiplayer handlers so the host can promote it into a
live room mid-session.

### 7. Platform capabilities used

- `Usion.cloud` — cross-device win/loss stats (localStorage fallback), plus a
  shared `games_total` counter via atomic `shared.incr`.
- `Usion.leaderboard.submit` — cumulative wins.
- `Usion.permissions.request(['notifications'])` **once** at online match
  start, then `Usion.notify.send` for your-turn / match-end / opponent-left —
  only while the app is hidden.
- i18n: every UI string lives in the `STR` table (mn/en), chosen via
  `Usion.getLanguage()` (navigator fallback outside the host).

## Run it locally

```bash
npx @usions/devkit dev path/to/13     # or: usion dev .
# Player 1: http://localhost:4747/
# Player 2: http://localhost:4747/?player=2
```

The devkit fake host serves the game with real platform semantics (rooms,
sequenced actions, checkpoints) and a chaos panel — blip the connection and
watch the pause/resync, or drop a player and watch the 20 s forfeit grace.

Note: the platform injects `https://usions.com/usion-sdk.js`; the script tag in
`index.html` exists so the game also runs self-hosted/standalone.

## License

[MIT](LICENSE)
