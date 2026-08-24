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
| Which room | the **private** room the invite created (`config.roomId`) | a **shared public table** the game picks itself — see below |
| Getting started | a **waiting room**: everyone toggles READY, the host presses Start | none — the table **deals itself** a moment after you land |
| Seats | 2–4, exactly the people who were invited, **frozen at Start** | always **4**: humans first, bots in the rest |
| Somebody arrives | too late — they watch this match out | they **take over the bot with the fewest penalty points**, inheriting its score, its standing and the cards it is holding *right now*, mid-round |
| Somebody leaves | 20 s grace, then their seat **folds** out of the match | 20 s grace, then a **bot takes the seat and its score**, and play continues |
| Match length | the host picks 15 / 20 / 30 | fixed at 20 |
| When it ends | the winner screen, PLAY AGAIN | the table **restarts itself** a few seconds later |

Sharing mid-game *is* inviting, so a Share promotion (`onRoomAssigned`) moves an
open room over to the invite rules: the table is torn down and a waiting room
opens in the new room.

### Why the open room picks its own room id

The platform hands **every** no-invite launch its own private `standalone_` room.
Joining that is what an open table must *not* do: two people who both tap Play
would sit in two different rooms, each alone with three bots, and the open table
could never fill. So the game ignores that room and joins a shared one it names
itself — a short ladder of public tables:

```
public-13-1, public-13-2, … public-13-8      (OPEN_ROOM_PREFIX / OPEN_ROOM_SHARDS)
```

**Arriving is a search, not a join.** The point of a public table is that the
next person to tap Play finds the one you are already sitting at — and that does
not happen by itself. Tables spread over the ladder, people leave gaps in it, and
a client that only ever looked at table 1 would open a brand-new table right next
to somebody playing alone with bots two rungs along. Neither would ever know.

So we walk the ladder, spending at most `OPEN_PROBE_MS` on each rung, and the join
acknowledgement decides what happens:

| what the rung looks like | what we do |
|---|---|
| somebody here, a bot seat free | **stay** — this is the table we came for |
| somebody here, all four seats human | full, try the next rung |
| nobody here, never used at all | tables fill from the front, so nothing lies beyond this — the search is over |
| nobody here, but used before | remember it as somewhere to set up, and keep looking for actual people |

When the ladder holds nobody, we settle on the **lowest** empty rung we saw —
going back for it if we walked past — clear whatever is left in it and deal
against bots. Tables stay bunched at the front, so the next person's search is
short. The very first player probes exactly one rung and is dealt in immediately.

Two details that are easy to get wrong and were both bugs first: an
acknowledgement for a rung we are leaving must not be acted on (its roster and
checkpoint belong to a room we are walking out of), and neither must anything
still in flight from it (`joiningRoom` drops actions, syncs and realtime traffic
until the next room answers). Otherwise the search drags the previous table's
state along with it.

Once settled, a player still seatless after `OPEN_HOP_MS` **hops on** rather than
queuing behind strangers — but only when the table really is four humans. If a
bot is holding a seat they stay put, because one is about to come free.

If the host refuses a room id of our choosing, we fall back to the room it gave
us (a private table with bots — a game, just not a shared one); if the relay is
unreachable at all, we fall back to the same table played locally.

**A dead room is cleared, not resumed.** The relay keeps a table's action log and
checkpoint after everybody has left it, so tapping Play again would drop you back
into the leftovers of your own finished match — your old score, your old
elimination, and seats still held by people who are not there. Nothing in that
table will ever move, because the players it is waiting on are gone. So if we are
the only one connected and the roster names anybody else, the room is finished:
`openRoomIsAbandoned()` spots it and `reopenOpenTable()` deals a fresh match seated
on whoever is actually present. Two guards keep that off live tables — the
server's `connected_count` (not presence, which is built from the relay's frozen
roster and cannot tell a live opponent from a ghost), and a full forfeit-grace
window after anybody drops, because an *eliminated* seat gets no grace of its own
and a reconnecting peer must not have the room wiped out from under them.

**And it is never just a spinner.** The connect cover exists for the fraction of
a second it takes to find a table — no READY, no host tag, no match-length picker,
because there is nothing there for the player to decide. Three things make sure it
stays that short: an empty rung holding only a stale log is claimed in about two
seconds; a table that owes us a seat is waited on rather than abandoned; and if
after `OPEN_STUCK_MS` nobody anywhere will seat us — a peer on an older build, a
wedged authority, a relay refusing our claims — we stop asking and take a table
over ourselves. Note that we stay **online** to do it: dropping to a local game
would make us invisible to the next person's search, which is the one thing
matchmaking must never do. Only an unreachable relay falls back that far.

**A table can never be locked, either.** Two friends on a road-to-20 table knock
the bots out after a few rounds, and an eliminated seat cannot be handed to
anybody: it holds no cards, so its new owner would sit there with nothing to play.
Rather than turn the newcomer away, the table deals a **fresh match**
(`openResetForWaiting()`, between rounds and rate-limited), putting every bot seat
back in play and the newcomer straight into one. The match that gets reset was
nearly over anyway; a room two people can close is worse.

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

### 3. Your own move does not wait for the relay

The deterministic log means a move is only real once the relay has sequenced it.
Applied literally that costs **a full round trip on every tap**: your card sits in
your hand, the Play button stays dead, and the turn does not move until the echo
comes back. Over a phone connection that is the whole feel of the game.

So a move you *own* — your own play or pass, and a bot seat you are the elected
relay for — is applied to your board the instant it is sent
(`applyOptimisticMove`). This is not a prediction: the move was built and
validated with the exact rules every other client will apply to it, and the same
engine produces the same result everywhere. The echo is then matched on
`(ti, cards)` and skipped — while still counting as applied, so the sequence
bookkeeping keeps no holes.

The safety rails around it:

- **Nothing is snapshotted early.** `writeCheckpoint()` and `broadcastStatePush()`
  both bail while a move is in flight, so no other client can be told to replay a
  move the relay may never have stored.
- **A send that fails marks us stale** and asks for a catch-up, because our board
  may now be a move ahead of the room's.
- **An echo that never arrives** (6 s) does the same, and a checkpoint at our own
  sequence is then accepted as the correction.

A cover for *another* human's stalled seat is deliberately excluded: that one
really is a guess about somebody else, so it waits for the relay.

### 4. Reconnect recovery: checkpoint + replay tail

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

### 5. Rematch and auto-restart (platform mode)

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

### 6a. The waiting room (chat invite)

While invited players trickle into `config.roomId`, the game shows who's present
with a ready toggle; the host locks the final seat order into the `deal` action so
every client (and every reconnect) derives identical seating. The lobby never
creates rooms or draws invite/share UI — the platform owns invites (host Share
button / `Usion.game.invite()`).

### 6b. The open room (no invite)

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

### 7. GameTok / Explore

A `'single'` launch (Explore or the GameTok feed) drops straight into a zero-tap
round vs 3 bots — no menu, per the GameTok contract. What changed is that it is
now an **open room on a shared public table**: the same three bots, except every
move is a stored action and anyone else who taps Play lands at the same table and
takes a bot's seat. With no room to join (self-hosted preview) or a relay it
cannot reach, it degrades to the identical table played locally rather than
stranding the player on a menu.

The same build registers all multiplayer handlers up front, so the Share button
can promote the room mid-session: `onRoomPromoted()` tears the open table down
and opens the invite waiting room in the new room.

### 8. Platform capabilities used

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

Launched without an invite, both tabs find the same public table: player 1 is
dealt in against 3 bots straight away, and player 2 takes over the lowest-scoring
bot mid-round. Launched from a chat invite, both tabs land in the waiting room and
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

132 headless scenario tests covering both modes, no dependencies and no browser:
every simulated player is the real `script.js` in its own `vm` realm on a virtual
clock. See [test/README.md](test/README.md).

## License

[MIT](LICENSE)
