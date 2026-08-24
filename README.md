# 13 — Mongol Poker (Монгол Покер)

A Big-Two-style card game for the [Usion](https://usions.com) platform,
open-sourced as a **best-practice reference** for building multiplayer mini-apps
with the [Usion SDK](https://www.npmjs.com/package/@usions/sdk) (`window.Usion`).

Three files, no build step: [index.html](index.html) · [script.js](script.js) · [style.css](style.css).

> Товч монголоор: энэ бол Usion платформ дээрх «13» хөзрийн тоглоомын бүрэн эх
> код. **Чатаас уригдаж** орвол хуучин ёсоороо хүлээх танхим — бүгд БЭЛЭН дараад
> хост эхлүүлнэ. **Урилгагүй** зүгээр тоглоход **нээлттэй ширээ**: 3 боттой шууд
> эхэлж, дараа нь ирсэн хүн бүр хамгийн бага оноотой ботын суудлыг (оноо, хөзрийн
> хамт) авч тоглоомын дундаас ордог; гарсан тоглогчийн суудлыг бот эргүүлж авдаг
> тул ширээ хэзээ ч зогсдоггүй.

## Two rooms, one game

How the game was **launched** decides how its room behaves. Both modes run the
same engine, the same relay and the same recovery machinery — they differ only in
who is allowed to sit down.

| | **Chat invite** (`mode: 'multiplayer'`) | **No invite — "just play"** (`mode: 'single'`) |
|---|---|---|
| Where from | a game invite in a chat | Explore, the GameTok feed, the Play button |
| Getting started | a **waiting room**: everyone toggles READY, the host presses Start | none — the table **deals itself** a moment after you land |
| Seats | 2–4, exactly the people who were invited, **frozen at Start** | always **4**: humans first, bots in the rest |
| Somebody arrives | too late — they watch this match out | they **take over the bot with the fewest penalty points**, inheriting its score, its standing and the cards it is holding *right now*, mid-round |
| Somebody leaves | 20 s grace, then their seat **folds** out of the match | 20 s grace, then a **bot takes the seat and its score**, and play continues |
| Match length | the host picks 15 / 20 / 30 | fixed at 20 |
| When it ends | the winner screen, PLAY AGAIN | the table **restarts itself** a few seconds later |

Sharing mid-game *is* inviting, so a Share promotion (`onRoomAssigned`) moves an
open room over to the invite rules: the table is torn down and a waiting room
opens in the new room.

## Game rules (short)

- 13 cards each. First to empty their hand wins the round; everyone else gains
  penalty points for the cards they are left holding (n ≤ 9 → n, 10–12 → 2n,
  13 → 3n). Reach the lose-at threshold and you're eliminated; last survivor wins.
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

In an open room the seat order carries `null` for every seat a bot holds, and
**seat changes are moves too** (`seat_take` / `seat_release`), so they live in the
same sequenced log as every card played. The roster is therefore replayable:
rebuilding `(seed, moves)` reconstructs not just the board but who was sitting
where, when. (A chat-invite match has no such actions — its roster is frozen at
Start, and `applySeatMove` refuses them outright.)

Which mode a room runs is **not** something a client decides for itself. It is
set by the launch, then carried on the `deal` action and every checkpoint
(`open: true|false`), so a client can never end up applying one mode's rules to
the other mode's table.

### 2. The multiplayer contract, implemented

| Contract requirement | Where |
|---|---|
| `connect()` → register handlers → `join(config.roomId)` | `setupMultiplayer()` / `registerNetHandlers()` |
| `playerIds[0]` is the host/authority | `isHostPlayer()` presses Start / opens the table at seat 0; every other authority job is rank-staggered |
| Handlers registered up front, even on a `'single'` launch | `Usion.game.onRoomAssigned` registered in `Usion.init` |
| Solo → host promotion (host Share button) | `onRoomPromoted()` — tears the open table down and opens the invite waiting room |
| Trust `mode`, never infer multiplayer from `roomId` | `launchedSolo()` (a solo launch may still get a `standalone_` room) |
| `action()` for turn-based moves, `realtime()` for ephemera | moves/deals/seat changes vs `player_info`/`state_push` |
| Winner decided by shared state, not self-reported | scores derive from the shared log; a bot champion files no result card |
| `onDisconnect` → real pause | `netPaused` freezes the turn clock so a dropped player can't be auto-passed |
| `onPlayerLeft` → settle the seat, with grace | 20 s `startForfeitGrace()` — a quick rejoin resumes the hand untouched; otherwise the seat folds (invite) or goes to a bot (open) |
| `onPlayerJoined` → seat the newcomer | open rooms only: `reconcileOpenSeats()` writes a `seat_take` for the lowest-scoring bot |

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

An **open room** also restarts on its own: `scheduleOpenRestart()` fires the same
reset deal `OPEN_RESTART_MS` after the champion screen (rank-staggered), so nobody
has to press anything for the room to keep going. PLAY AGAIN just brings it
forward. A chat-invite match does not — it ends when it ends.

### 5a. The waiting room (chat invite)

While invited players trickle into `config.roomId`, the game shows who's present
with a ready toggle; the host locks the final seat order into the `deal` action so
every client (and every reconnect) derives identical seating. The lobby never
creates rooms or draws invite/share UI — the platform owns invites (host Share
button / `Usion.game.invite()`).

### 5b. The open room (no invite)

There is no waiting room and nothing to press. `maybeStart()` schedules
`scheduleOpenStart()`, which deals a 4-seat round `OPEN_START_MS` after the room
settles — `null` in the order for every seat nobody is sitting in. A launch with
no room at all, or a room the relay cannot reach, falls back to the same table
played purely locally, so the zero-tap GameTok contract still holds.

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

### 6. GameTok / Explore

A `'single'` launch (Explore or the GameTok feed) drops straight into a zero-tap
round vs 3 bots — no menu, per the GameTok contract. What changed is that it is
now an **open room**: the same three bots, except every move is a stored action,
so anyone who wanders into that room can walk in and take a bot's seat. With no
room to join (self-hosted preview) or a relay it cannot reach, it degrades to the
identical table played locally rather than stranding the player on a menu.

The same build registers all multiplayer handlers up front, so the Share button
can promote the room mid-session: `onRoomPromoted()` tears the open table down
and opens the invite waiting room in the new room.

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

Launched without an invite, player 1 is dealt in against 3 bots straight away;
open the `?player=2` tab and watch them take over the lowest-scoring bot
mid-round. Launched from a chat invite, both tabs land in the waiting room and
wait for READY + Start.

The devkit fake host serves the game with real platform semantics (rooms,
sequenced actions, checkpoints) and a chaos panel — blip the connection and
watch the pause/resync, or drop a player and watch the 20 s grace expire into a
fold (invite) or a bot takeover (open room).

Note: the platform injects `https://usions.com/usion-sdk.js`; the script tag in
`index.html` exists so the game also runs self-hosted/standalone.

## Tests

```bash
node 13/test/run_all.cjs
```

120 headless scenario tests covering both modes, no dependencies and no browser:
every simulated player is the real `script.js` in its own `vm` realm on a virtual
clock. See [test/README.md](test/README.md).

## License

[MIT](LICENSE)
