# 13 — Mongol Poker (Монгол Покер)

A 4-seat Big-Two-style **open table** for the [Usion](https://usions.com) platform,
open-sourced as a **best-practice reference** for building multiplayer mini-apps
with the [Usion SDK](https://www.npmjs.com/package/@usions/sdk) (`window.Usion`).

Three files, no build step: [index.html](index.html) · [script.js](script.js) · [style.css](style.css).

> Товч монголоор: энэ бол Usion платформ дээрх «13» хөзрийн тоглоомын бүрэн эх
> код. Өрөө нь **нээлттэй ширээ**: эхний тоглогч 3 боттой шууд эхэлж, дараа нь
> ирсэн хүн бүр хамгийн бага оноотой ботын суудлыг (оноо, хөзрийн хамт) авч
> тоглоомын дундаас ордог; гарсан тоглогчийн суудлыг бот эргүүлж авдаг тул ширээ
> хэзээ ч зогсдоггүй.

## The open table, in one paragraph

A room is a **persistent 4-seat game**, not a match you gather people for. Player
A opens it and is dealt in immediately against 3 bots — no lobby, no READY, no
Start button. When B arrives they **displace the bot carrying the fewest penalty
points** and inherit that seat outright: its score, its standing, and the cards it
is holding *right now*, mid-round. C and D drop in the same way. A player who
leaves hands their seat — score included — back to a bot after a 20 s grace, so
the table never stalls and the room outlives everyone in it. When somebody wins,
the table restarts itself a few seconds later.

## Game rules (short)

- 4 seats, 13 cards each, humans first and bots filling the rest. First to empty
  their hand wins the round; everyone else gains penalty points for the cards
  they are left holding (n ≤ 9 → n, 10–12 → 2n, 13 → 3n). Reach the lose-at
  threshold (20 on an open table) and you're eliminated; last survivor wins.
- Single-card strength high→low: `2 A K Q J 10 9 8 7 6 5 4 3`; suits `♠ > ♥ > ♣ > ♦`.
- Combos: single, pair, triple, four, and 5-card hands
  (straight < flush < full house < four+1 < straight flush). Follow with a
  bigger combo of the SAME size, or pass. Being dealt all 13 ranks = instant win ("dragon").

## Why this is a reference implementation

### 1. Deterministic engine + turn log

Online play never ships card data around. One stored
`deal` action carries a **PRNG seed** (`mulberry32`) plus the seat order; every
client deals identical hands locally and applies the same **sequenced move log**
(`Usion.game.action("move", …)`). Any client can rebuild the entire round from
`(seed, moves)` — which is exactly what reconnect recovery does, and exactly what
lets a newcomer take over a bot's half-played hand the instant they walk in.

The seat order carries `null` for every seat a bot holds, and **seat changes are
moves too** (`seat_take` / `seat_release`), so they live in the same sequenced log
as every card played. The roster is therefore replayable: rebuilding `(seed,
moves)` reconstructs not just the board but who was sitting where, when.

### 2. The multiplayer contract, implemented

| Contract requirement | Where |
|---|---|
| `connect()` → register handlers → `join(config.roomId)` | `setupMultiplayer()` / `registerNetHandlers()` |
| `playerIds[0]` is the host/authority | `isHostPlayer()` opens the table at seat 0; every other authority job is rank-staggered |
| Handlers registered up front, even on a `'single'` launch | `Usion.game.onRoomAssigned` registered in `Usion.init` |
| Solo → host promotion (host Share button) | `onRoomPromoted()` — drops the offline round and opens a live open table |
| Trust `mode`, never infer multiplayer from `roomId` | `launchedSolo()` (a solo launch may still get a `standalone_` room) |
| `action()` for turn-based moves, `realtime()` for ephemera | moves/deals/seat changes vs `player_info`/`state_push` |
| Winner decided by shared state, not self-reported | scores derive from the shared log; a bot champion files no result card |
| `onDisconnect` → real pause | `netPaused` freezes the turn clock so a dropped player can't be auto-passed |
| `onPlayerLeft` → seat released, with grace | 20 s `startForfeitGrace()` — a quick rejoin resumes the hand untouched; otherwise a bot takes the seat |
| `onPlayerJoined` → seat the newcomer | `reconcileOpenSeats()` writes a `seat_take` for the lowest-scoring bot |

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

### 4. Rematch and auto-restart (platform mode)

Platform mode has **no server-side restart event** — `Usion.game.requestRematch()`
is a pure broadcast to the other players. So: a non-host's PLAY AGAIN sends the
request (peers see who asked via `onRematchRequest`); the **host's** PLAY AGAIN
broadcasts a normal stored `deal` action with `reset: true`, which every client
applies in `onDeal` by zeroing match state before dealing — deterministic and
replay-safe.

An open table also restarts **on its own**: `scheduleOpenRestart()` fires the same
reset deal `OPEN_RESTART_MS` after the champion screen (rank-staggered), so nobody
has to press anything for the room to keep going. PLAY AGAIN just brings it
forward.

### 5. The open table

There is no waiting room and nothing to press. `maybeStart()` schedules
`scheduleOpenStart()`, which deals a 4-seat round `OPEN_START_MS` after the room
settles — `null` in the order for every seat nobody is sitting in.

**Bots play online.** A bot seat is driven by `botDecision(seat)`, a pure function
of replayable state (that seat's hand, the table, `firstPlay`). The lowest-seated
human present broadcasts it as an ordinary stored move tagged `bot: true`, and
every client **recomputes the same decision and rejects anything that differs** —
so relaying a bot can never smuggle in a chosen discard. This is the proxy-cover
rule from finding 2, widened from "a forced minimal move" to "the engine's full
choice".

**Joining** (`reconcileOpenSeats` → `seat_take`): the target is
`takeoverSeat()` — the non-eliminated bot seat with the **lowest total**, lowest
seat index breaking a tie. Every client recomputes that target when the action
lands, so a claim naming any other seat is rejected identically everywhere. The
seat's `total`, `out` and `hands[seat]` are left completely untouched; only who
controls it changes.

**Leaving** (`sendSeatRelease` → `seat_release`): after the 20 s grace, the seat
goes back to a bot with its score intact. Nothing writes `leave_fold` /
`forfeit_win` any more — an open table never folds a seat out of the match — though
`applyRemoteMove` still accepts and validates both so an older client's log
replays.

**Coming back to a seat that is gone.** A released player never applies their own
release (`applySeatMove` refuses to evict the seat you are sitting in), so on
return they still believe they hold it. If the room's state is genuinely *ahead*
of everything they have applied and does not name them, `becomeUnseated()` drops
them back to the waiting state and `reconcileOpenSeats` deals them in again. See
finding 4 in [test/README.md](test/README.md) — arguing with the room here is a
split table that never heals.

**No single point of failure.** Seat claims are rank-staggered exactly like
`scheduleNextDeal`: the lowest present seat writes first, every other seated
client covers `SEAT_STAGGER_MS` later. A locked phone never leaves `presentIds`,
so a single elected writer asleep would otherwise lock newcomers out of the room
forever — the same trap as finding 1.

The game never creates rooms or draws invite/share UI — the platform owns invites
(host Share button / `Usion.game.invite()`).

### 6. Solo / GameTok

A `'single'` launch (Explore or the GameTok feed) drops straight into a
zero-tap **offline** round vs 3 bots — no menu, no network, per the GameTok
contract. The same build still registers all multiplayer handlers, so the Share
button can promote it mid-session: `onRoomPromoted()` tears the offline round
down and the room reopens as a live open table — the same three bots, except now
every move is a stored action anyone can walk in and take over.

### 7. Platform capabilities used

- `Usion.cloud` — cross-device win/loss stats (localStorage fallback), plus a
  shared `games_total` counter via atomic `shared.incr`.
- `Usion.leaderboard.submit` — cumulative wins.
- i18n: every UI string lives in the `STR` table (mn/en), chosen via
  `Usion.getLanguage()` (navigator fallback outside the host).

## Run it locally

```bash
npx @usions/devkit dev path/to/13     # or: usion dev .
# Player 1: http://localhost:4747/
# Player 2: http://localhost:4747/?player=2
```

Player 1 is dealt in against 3 bots straight away; open the `?player=2` tab and
watch them take over the lowest-scoring bot mid-round.

The devkit fake host serves the game with real platform semantics (rooms,
sequenced actions, checkpoints) and a chaos panel — blip the connection and
watch the pause/resync, or drop a player and watch the 20 s grace expire into a
bot takeover.

Note: the platform injects `https://usions.com/usion-sdk.js`; the script tag in
`index.html` exists so the game also runs self-hosted/standalone.

## Tests

```bash
node 13/test/run_all.cjs
```

105 headless scenario tests, no dependencies and no browser: every simulated
player is the real `script.js` in its own `vm` realm on a virtual clock. See
[test/README.md](test/README.md).

## License

[MIT](LICENSE)
