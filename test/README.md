# 13/ — Mongol Poker test harness

Headless scenario tests for `13/script.js`. No dependencies, no browser.

```bash
node 13/test/run_all.cjs          # everything
node 13/test/t_adversity.cjs      # one suite
```

## What it actually runs

Each simulated player is the **real `script.js`**, loaded into its own `vm`
realm on top of:

| piece | file | what it fakes |
|---|---|---|
| DOM | `lib/dom.cjs` | element tree, classes, `dataset`, selectors, events. Layout is zeroed; a **disabled button ignores clicks**, like a browser. |
| clock | `lib/clock.cjs` | virtual time. An owner marked `frozen` keeps accruing wall-clock time but runs **no javascript** — a locked phone. |
| relay | `lib/net.cjs` | `action` (sequenced + stored + broadcast), `realtime` (fire-and-forget), `setState` (CAS checkpoint), `requestSync` → `onSync`. Anything pushed at a frozen or disconnected client is **dropped**; recovery must come from a resync. |
| scenarios | `lib/world.cjs` | build a room in either mode — `onlineWorld()` for a chat invite, `openWorld()` for a no-invite open room — get a match under way (`startMatch` readies up and presses Start, or just waits for the open table to deal itself), drop extra players in and out with `arrive()`, drive every client's turn through the real Play/Pass buttons, and watch for stalls. |

Because the clock is virtual, a 90-second turn timeout or a 20-second grace
costs microseconds — a full 4-player match runs in about a second.

An open room always has four seats, so a world with fewer simulated clients is a
real table with bots in the rest: `openWorld(1)` is one human against three bots,
and `botSeats(client)` reports which seats a newcomer could take. `onlineWorld(n)`
is the other mode — n invited players, no bots, and a waiting room to get through
first.

`openWorld` hands every client its own private `standalone_` room, exactly as the
platform does; finding the shared public table (`PUBLIC_ROOM`) is the game's job,
and `client.sdk.room.id` is how a test checks which table somebody actually
ended up at.

### How a "dead end" is detected

`playOut()` ticks the table forward, making every live client take its turn
through the UI, and computes a signature of what every client believes
(`dealActive`, `turn`, hand sizes, totals, eliminations, overlays, move count).

* signature unchanged for **6 simulated minutes** → `DEAD END` + a dump of what
  each client thought was going on. Six minutes is comfortably longer than the
  worst legitimate gap (90 s turn clock + 90 s untrusted-proxy hold-back + 10 s
  grace).
* clients disagreeing for **30 simulated seconds** → `DESYNC`.
* the match not finishing inside the budget → reported separately from a stall.

`Math.random` is seeded per client, so every run is reproducible.

## Suites

| suite | tests | covers |
|---|---|---|
| `t_rules.cjs` | 16 | combination classification and ordering, complete alternate-combo generation, 2-low↔A-high straights with no wrap, suit order ♠>♥>♣>♦, wire encoding, the penalty ladder, seeded dealing, bot hand-planning/endgame choices, and fuzz proving every generated move is legal and held |
| `t_offline.cjs` | 14 | the no-room fallback (zero-tap, and a relay that cannot be reached), the setup screen at 2/3/4 players × lose-at 20/30/40, 30 back-to-back local matches, both hand-over buttons, rematch, the turn clock (auto-pass, and forced play when leading), the 5-card selection cap, hand drag-reorder |
| `t_online.cjs` | 43 | **both modes.** Chat invite: the waiting room, READY gating, seat locking, 2/3/4-player matches end to end, the host's lose-at pick, late joiners, spectator injection, rematch, result cards, round transitions, quick chat, avatars, plus proof that your own move lands on your board instantly at 500 ms latency without the echo being replayed. Open room: two "just play" launches finding the SAME shared public table, dealing against bots with no lobby, bots actually playing online, a joiner taking over the lowest-scoring bot with its score and cards, B→C→D filling the table mid-round, a fifth arrival hopping to the next public table, two friends being unable to lock the room by knocking the bots out, walking back into an abandoned room clearing it instead of resuming a table of ghosts (and a live table never cleared out from under it), the connect cover never becoming a lobby or a spinner — a stale shard claimed in seconds, and a guaranteed local game when no room will have us, a walkout handing seat + score back to a bot, a freed seat going to the next arrival, forged seat claims, forged bot moves, 1–4 humans end to end, the fixed target, self-restart |
| `t_adversity.cjs` | 45 | locked phones (guest, host, rolling, whole-round), socket drops and reconnects, permanent walkouts at 2p/3p/4p **in both modes** (folds vs bot takeovers), double walkouts, rejoin inside the grace window, full exit + rejoin, lost echoes, deal races, proxy races, seat-claim races, seating while the elected authority sleeps, joining between rounds, join/leave churn through a whole match, forged actions, forged and stale checkpoints, live-vs-replay agreement, catch-up traffic cost, three server sync models, Share promotion (open room → waiting room), 500 ms latency |
| `t_findings.cjs` | 10 | regression tests for the four bugs this harness found, plus one documented residual |

## The bugs this found (all fixed, `script.js?v=69`)

`t_findings.cjs` keeps a reproduction for each, so a regression turns it red
again. The reproductions and the reasoning live in the comment blocks there.

1. **HIGH — a sleeping authority froze the table at every round boundary.**
   `scheduleNextDeal()` lets every client deal, staggered by rank, so no single
   sleeping player can hold up the next round. `onDeal()` then rejected anything
   not sent by `proxyAuthorityId(-1)` — the lowest seat still in `presentIds` —
   and a locked phone never leaves `presentIds`. Every fallback deal was
   discarded and no round was ever dealt. Worse, those rejected deals stayed in
   the stored log and replay skipped the sender check, so the sleeper woke into a
   round of its own while everyone else was still on the old results screen; the
   match never recovered, even after the phone was unlocked.
   *Fixed:* between rounds any **seated** player may deal — the same election
   `scheduleNextDeal()` runs — judged identically live and on replay.
2. **MEDIUM — a peer could pick another player's cards.** `applyRemoteMove`
   accepted an `auto:true` move purely because the sender was the elected proxy
   authority, without checking *what* the cover played; every client holds every
   hand, so the sender could choose which cards left the victim's hand. And
   because the sender checks sat inside `if (!replayingSync)`, a forged cover the
   whole table rejected was still applied by anyone who resynced.
   *Fixed:* a cover must be exactly the move the engine would force (a pass while
   following, the minimal lead while leading) — derived from replayable state, so
   live and replay agree.
3. **LOW — nothing recovered a message lost on a live socket.** Every resync
   trigger was an event (visibilitychange, the >3 s freeze watchdog, onReconnect),
   so losing your own move's echo while foregrounded left the "Sending…" latch set
   for the rest of the round. `requestSync(lastSeq)` could not have healed it
   anyway: `lastSeq` advances on *receipt*, so a client that missed 8–19 and saw
   20 asked for "everything after 20".
   *Fixed:* `syncResumePoint()` resumes from the last hole-free sequence, only
   applied actions are recorded as applied, and a 1 s watchdog asks for a
   catch-up when the latch sticks or nothing arrives at all. Cost measured at
   ~0 extra requests in a healthy match.
4. **HIGH — an open table split in two when a released player came back.**
   A player whose socket dies long enough loses their seat to a bot. They never
   apply that release themselves — `applySeatMove` refuses to evict the seat you
   are sitting in, precisely so a stray action cannot throw out a player who is
   right there. So on the way back they still believed they held seat N while the
   room had given it away. Every bot move the room made for seat N was one they
   rejected (`players[seat].isBot` false in their copy), and every checkpoint that
   would have corrected them was one they skipped, because its roster did not name
   them: a client playing a private continuation of a round nobody else was in,
   with no path back.
   *Fixed:* a snapshot that is genuinely **ahead** of everything we have applied
   and does not seat us is the room telling us the seat is gone —
   `becomeUnseated()` drops to the waiting state and `reconcileOpenSeats` deals us
   back in, usually within a second.

Found while fixing the above: forged `leave_fold` / `forfeit_win` actions were
rejected live but applied by anyone replaying the raw action log. Checkpoint
replay (trusted — those moves were already validated and carry no sender id) now
uses `replayTrusted`, separate from action-log replay, which runs the full sender
checks.

### Residual, not fixable client-side

A seated peer can still make another seat take the move the engine would have
forced on it anyway — a pass while following. Closing it needs the platform to
gate who may write an `auto` move: a client cannot prove how long another player
has really had, and any timing rule would be judged differently live and on
replay, which is exactly what produced the split table in finding 1.

The same shape applies to `bot` moves on an open table: any seated client may
relay a bot seat's turn early. It can only ever be the move `botDecision(seat)`
would have produced anyway — every client recomputes it and rejects anything else
— so the cost is timing, not control. Gating it on presence instead was tried and
rejected for the reason above: presence cannot be reconstructed on replay, so a
presence rule splits the table exactly the way finding 1 did.
