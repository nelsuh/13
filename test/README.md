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
| `t_adversity.cjs` | 30 | locked phones (guest, host, rolling, whole-round), socket drops and reconnects, permanent walkouts at 2p/3p/4p, double walkouts, rejoin inside the grace window, full exit + rejoin, lost echoes, deal races, proxy races, seven kinds of forged action, forged and stale checkpoints, three server sync models, solo→room promotion, 500 ms latency |
| `t_findings.cjs` | 8 | **open bugs.** These assert the behaviour the game *should* have and fail today. |

## Open findings

See the comment blocks in `t_findings.cjs` for the reproduction and a suggested
fix for each.

1. **HIGH — a sleeping authority freezes the table at every round boundary.**
   `scheduleNextDeal()` lets every client deal, staggered by rank, so no single
   sleeping player can hold up the next round. `onDeal()` then rejects anything
   not sent by `proxyAuthorityId(-1)` — the lowest seat still in `presentIds` —
   and a locked phone never leaves `presentIds`. Every fallback deal is
   discarded and no round is ever dealt. Worse, those rejected deals stay in the
   stored log and replay skips the sender check, so the sleeper wakes into a
   round of its own while everyone else is still on the old results screen. The
   match never recovers, even after the phone is unlocked.
2. **MEDIUM — a peer can drive another player's seat.** `applyRemoteMove`
   accepts an `auto:true` move purely because the sender is the elected proxy
   authority, never checking that the target is actually stalled. Since every
   client holds every hand, it can also choose which cards the victim throws.
   The leave path already gets this right (it refuses to fold a player who is in
   `presentIds`).
3. **LOW — nothing recovers a message lost on a live socket.** Every resync
   trigger is an event (visibilitychange, the >3 s freeze watchdog, onReconnect).
   Lose your own move's echo while foregrounded with a healthy socket and the
   "Sending…" latch never clears — Play and Pass stay dead for the rest of the
   round. Backgrounding or a socket blip both recover.
