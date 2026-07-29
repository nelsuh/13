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
| scenarios | `lib/world.cjs` | build a table, run the lobby, drive every client's turn through the real Play/Pass buttons, and watch for stalls. |

Because the clock is virtual, a 90-second turn timeout or a 20-second forfeit
grace costs microseconds — a full 4-player match runs in about a second.

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
| `t_rules.cjs` | 13 | combination classification, straight/flush/full-house/four+1/straight-flush ordering, 2-low↔A-high straights with no wrap, suit order ♠>♥>♣>♦, wire encoding, the penalty ladder, seeded dealing, and fuzz over 300 deals proving every generated combo is legal and only uses held cards |
| `t_offline.cjs` | 11 | the GameTok zero-tap launch, the setup screen at 2/3/4 players × lose-at 20/30/40, 30 back-to-back solo matches, both hand-over buttons, rematch, the turn clock (auto-pass, and forced play when leading), the 5-card selection cap |
| `t_online.cjs` | 15 | waiting room and ready gating, seat locking, 2/3/4-player matches end to end, the host's lose-at pick, late joiners, spectator injection, rematch (host and guest), result-card payloads, round transitions, quick chat |
| `t_adversity.cjs` | 37 | locked phones (guest, host, rolling, whole-round), socket drops and reconnects, permanent walkouts at 2p/3p/4p, double walkouts, rejoin inside the grace window, full exit + rejoin, lost echoes, deal races, proxy races, forged actions, forged and stale checkpoints, live-vs-replay agreement, catch-up traffic cost, three server sync models, solo→room promotion, 500 ms latency |
| `t_findings.cjs` | 9 | regression tests for the three bugs this harness found, plus one documented residual |

## The bugs this found (all fixed, `script.js?v=52`)

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
