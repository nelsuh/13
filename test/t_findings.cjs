// Suite 5 — OPEN FINDINGS.
//
// Each test asserts the behaviour the game SHOULD have, and fails against the
// current script.js: that is the point. Everything in the other four suites
// passes today. When a fix lands, these turn green.

const { onlineWorld, startMatch, playOut, driveUntil, rejoin, eventually, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

async function matchAtTurn(n, seat) {
  const w = await onlineWorld(n);
  await startMatch(w);
  const r = await driveUntil(w, () => {
    const s = w.clients[0].snap();
    return s.dealActive && s.turn === seat;
  }, { skip: [w.clients[seat].id] });
  ok(r.ok, "could not reach seat " + seat + "'s turn: " + r.reason);
  return w;
}

/** Play until a round ends and the results overlay is up on a live client. */
async function atRoundBoundary(n) {
  const w = await onlineWorld(n);
  await startMatch(w);
  const r = await driveUntil(w, () => w.clients[1].snap().overlays.hand, { budget: 20 * 60 * 1000 });
  ok(r.ok, "no round ever ended: " + r.reason);
  return w;
}

// ── FINDING 1 — HIGH: a sleeping authority freezes the table at every round
// boundary, and then splits it in two.
//
// scheduleNextDeal() (script.js:998) deliberately lets EVERY client deal,
// staggered by rank, so a sleeping player can never hold up the next round.
// onDeal() (script.js:2463) then throws all of that away:
//
//     const expected = gameStarted ? proxyAuthorityId(-1) : roomPlayerIds[0];
//     if (fromId == null || fromId !== expected || …) return false;
//
// proxyAuthorityId(-1) is the lowest seat still in `presentIds`, and a locked
// phone never leaves presentIds (only onPlayerLeft removes you). So while the
// primary authority is merely asleep, every fallback deal is REJECTED by every
// client and no round is ever dealt.
//
// It gets worse on recovery: those rejected deals stay in the stored action
// log, and replay skips the sender check (`if (!replayingSync)`), so any client
// that resyncs later DOES apply them. The sleeper wakes into round 2 alone
// while the players who stayed awake are still stuck on round 1's results.
//
// Suggested fix — make onDeal's acceptance match scheduleNextDeal's election:
// between rounds, accept a deal from any seated player who is present, e.g.
//     const seatedAndPresent = roomPlayerIds.includes(fromId) && presentIds.has(fromId);
//     const expected = gameStarted ? null : roomPlayerIds[0];
//     if (gameStarted ? !seatedAndPresent : fromId !== expected) return false;
// The existing `if (dealActive) return false` already collapses a deal race to
// the first stored deal, so widening this cannot double-deal a round.

test("FINDING 1: a fallback client must be able to deal when the authority is asleep", async () => {
  const w = await atRoundBoundary(3);
  const epoch = w.clients[1].snap().dealEpoch;
  w.clients[0].freeze();                       // the lowest present seat locks their phone
  await w.advance(60 * 1000);                  // 5s countdown + rank×2.5s stagger, ×many
  const dealt = w.room.log.filter(a => a.action_type === "deal" && a.player_id !== "u1");
  ok(dealt.length > 0, "the fallback clients did send a deal — the election works");
  const s = w.clients[1].snap();
  ok(s.dealEpoch > epoch,
    "…but every client rejected it, so the table is stuck on the results screen forever\n" +
    "  deals in the log: " + w.room.log.filter(a => a.action_type === "deal").map(a => a.sequence + " from " + a.player_id).join(", ") + "\n" + dump(w));
});

test("FINDING 1b: the whole match must still finish when the authority sleeps through it", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[1].snap().roundMoveNo >= 3);
  w.clients[0].freeze();                       // never comes back
  const r = await playOut(w, { done: () => w.drivers().every(c => c.snap().overlays.winner), budget: 60 * 60 * 1000, consistency: false });
  ok(r.ok, "the match stalls at the first round boundary: " + r.reason + "\n" + (r.dump || ""));
});

test("FINDING 1c: the sleeper must not wake into a round of its own", async () => {
  const w = await atRoundBoundary(3);
  w.clients[0].freeze();
  await w.advance(60 * 1000);
  w.clients[0].thaw();                         // resync replays the rejected deals
  await w.advance(120 * 1000);
  eq(consistency(w), null,
    "the woken client applied a deal nobody else accepted — the table is split in two\n" + dump(w));
});

test("FINDING 1d: the table must recover once the sleeper picks their phone back up", async () => {
  const w = await atRoundBoundary(3);
  w.clients[0].freeze();
  await w.advance(60 * 1000);
  w.clients[0].thaw();                         // the ordinary case: locked for a minute
  await w.advance(30 * 1000);
  const r = await playOut(w, { done: () => w.drivers().every(c => c.snap().overlays.winner), budget: 60 * 60 * 1000, consistency: false });
  ok(r.ok, "the match never recovers — the woken client is in a round of its own and the " +
    "others are still waiting on a deal that will never be accepted: " + r.reason + "\n" + (r.dump || ""));
});

// ── FINDING 2 — MEDIUM: a peer can drive another player's seat on demand.
//
// applyRemoteMove accepted a move flagged `auto:true` purely because the sender
// was the elected proxy authority for that seat, and never checked WHAT the
// cover played. Since every client holds every hand (shared deal seed), the
// sender could pick which cards came out of the victim's hand. Worse, the
// sender checks sit inside `if (!replayingSync)` — presence is not
// reconstructable — so a forged cover every live client rejected was still
// applied by anyone who resynced afterwards: a split table.
//
// Fixed by making a cover a FORCED move, validated from replayable state alone:
// a pass when following, the engine's own minimal lead when leading. Same
// verdict live and on replay.

test("FINDING 2: a peer must not be able to pick which cards another player throws", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const lead = w.clients[0].snap().turn;              // a lead cannot pass, so it must PLAY
  const attacker = w.clients[lead === 0 ? 1 : 0];
  const before = w.clients[0].snap();
  // the attacker picks a card of its own choosing out of the victim's hand,
  // instead of the forced minimal lead the engine would have produced
  const forged = attacker.read(
    `(function () {
       var hand = hands[${lead}];
       var forcedTop = botLead(hand, firstPlay).cards.map(cardWire).sort().join(",");
       for (var i = 0; i < hand.length; i++) {
         var one = [cardWire(hand[i])];
         if (one.sort().join(",") !== forcedTop) return one;
       }
       return null;
     })()`);
  ok(forged, "the victim has a card other than the forced lead");
  attacker.run(`Usion.game.action("move", {kind:"play", seat:${lead}, ti:${before.roundMoveNo}, auto:true, cards:${JSON.stringify(forged)}}).catch(function(){})`);
  await w.advance(3000);
  eq(w.clients[0].snap().counts[lead], before.counts[lead],
    "cards of someone else's choosing were played out of a live player's hand\n" + dump(w));
  eq(w.clients[0].snap().roundMoveNo, before.roundMoveNo, "and the forged cover was counted as real");
});

test("FINDING 2b: a rejected cover must stay rejected after a resync", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const lead = w.clients[0].snap().turn;
  const attacker = w.clients[lead === 0 ? 1 : 0];
  const before = w.clients[0].snap();
  const forged = attacker.read(
    `(function () {
       var hand = hands[${lead}];
       var forcedTop = botLead(hand, firstPlay).cards.map(cardWire).sort().join(",");
       for (var i = 0; i < hand.length; i++) {
         var one = [cardWire(hand[i])];
         if (one.sort().join(",") !== forcedTop) return one;
       }
       return null;
     })()`);
  attacker.run(`Usion.game.action("move", {kind:"play", seat:${lead}, ti:${before.roundMoveNo}, auto:true, cards:${JSON.stringify(forged)}}).catch(function(){})`);
  await w.advance(3000);
  // a client now rebuilds from the stored log, which still contains the forgery
  const observer = w.clients[3];
  observer.leaveRoom();
  await w.advance(2000);
  await rejoin(w, observer, 60 * 1000);
  eq(observer.snap().counts, w.clients[0].snap().counts,
    "the rejoining client replayed a forgery the live table had rejected\n" + dump(w));
  eq(consistency(w), null, dump(w));
});

// RESIDUAL, documented rather than fixed: a seated peer can still make another
// seat take the move the engine would have forced on it anyway (a pass while
// following). Closing that needs the platform to gate who may write an `auto`
// move — a client cannot prove how long another player has really had, because
// replay has no clock and any timing rule would be judged differently live and
// on replay, which is what produced the split table above. The damage is capped:
// the forged move is exactly the one a timed-out player would have made.
test("RESIDUAL (needs a platform-side gate): a forced pass can still be triggered early", async () => {
  const w = await matchAtTurn(4, 0);
  const before = w.clients[0].snap();
  ok(before.turnLeft > 30, "the victim still has most of their clock");
  w.clients[1].run('Usion.game.action("move", {kind:"pass", seat:0, ti:' + before.roundMoveNo + ', auto:true}).catch(function(){})');
  await w.advance(3000);
  const after = w.clients[0].snap();
  eq(after.roundMoveNo, before.roundMoveNo + 1, "documented: the forced pass is accepted");
  eq(consistency(w), null, "but every client agrees about it, so the table stays whole");
});

// ── FINDING 3 — LOW: nothing recovers a message lost on a live socket.
//
// Every resync trigger is an event: visibilitychange, the >3s wall-clock gap
// watchdog, or onReconnect (script.js:1675-1737). A message lost while the
// socket stays up and the app stays in the foreground therefore has no recovery
// path at all. For the actor's own echo the effect is permanent: the "Sending…"
// latch (pendingAction) never clears, Play and Pass stay dead for the rest of
// the round, and both hostDeal() and sendMove() bail while it is set.
//
// A TCP relay makes this unlikely, and backgrounding or a socket blip both
// recover (see t_adversity.cjs) — but the latch has no timeout of its own.
//
// Suggested fix: when pendingAction has been set for more than a few seconds,
// call Usion.game.requestSync(lastSeq).

test("FINDING 3: a lost own-move echo must not lock the player out for the round", async () => {
  const w = await matchAtTurn(3, 1);
  const victim = w.clients[1];
  w.server.dropNext.push({ to: "u2", type: "action" });   // eat only u2's own echo
  victim.uiPlay();
  await w.advance(2000);
  eq(victim.snap().pendingAction, true, "the latch is set while the echo is in flight");
  await w.advance(180 * 1000);                            // three full turn clocks
  eq(victim.snap().pendingAction, false,
    "the 'Sending…' latch never cleared — Play and Pass stay dead\n" + dump(w));
  eq(victim.snap().counts, w.clients[0].snap().counts, "and the board stayed a move behind");
});

test("FINDING 3b: a foreground client that missed actions must self-heal", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  for (let i = 0; i < 12; i++) w.server.dropNext.push({ to: "u3", type: "action" });
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 8, { budget: 20 * 60 * 1000 });
  ok(await eventually(w, () => consistency(w) === null, 180 * 1000),
    "a foreground client that missed a dozen actions never resyncs\n" + dump(w));
});

// ── FINDING 4 — HIGH: an open table split in two when a released player came
// back. Found while building the open table itself.
//
// A player whose socket dies for long enough loses their seat to a bot (that is
// the whole point of an open table: the room must not stall on someone who is
// gone). They do NOT apply that release themselves — applySeatMove refuses to
// release the seat you are sitting in, precisely so a stray action cannot evict a
// present player. So on the way back they still believe they hold seat N while
// the room has given it to a bot.
//
// Every bot move the room then makes for seat N is one they reject
// (`players[seat].isBot` is false in their copy), and every checkpoint that would
// have corrected them is one they skip, because the roster in it does not name
// them. The result is a client sitting in a private continuation of a round
// nobody else is playing — a split table that never heals, which is exactly the
// failure mode this harness exists to catch.
//
// Fixed: a snapshot that is genuinely AHEAD of everything we have applied and
// does not seat us is the room telling us our seat is gone. becomeUnseated()
// drops back to the waiting state, and the table's own reconcileOpenSeats deals
// us in again — usually within a second, on whichever bot seat is now weakest.

test("FINDING 4: a player released while offline must rejoin the room's round, not their own", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 3);
  const victim = w.clients[2];
  victim.netDrop();
  // Stay away well past the 20 s forfeit grace, so the seat is genuinely released.
  await driveUntil(w, () => w.clients[0].snap().order[2] === null, { budget: 10 * 60 * 1000 });
  eq(w.clients[0].snap().order[2], null, "the table gave the seat to a bot\n" + dump(w));
  victim.netRestore();
  // Converging takes two steps: the room deals us back in (a seat_take action),
  // and then our copy of the round catches up. Wait for both.
  ok(await eventually(w, () => {
    const v = victim.snap(), h = w.clients[0].snap();
    return v.gameStarted && v.mySeat >= 0 && consistency(w) === null &&
           JSON.stringify(v.order) === JSON.stringify(h.order);
  }, 180 * 1000), "the returning player must converge on the room's round\n" + dump(w));
  const s = victim.snap();
  const host = w.clients[0].snap();
  eq(s.curSeed, host.curSeed, "same round as everyone else");
  eq(s.order, host.order, "same roster");
  eq(s.counts, host.counts, "same board");
  ok(s.mySeat >= 0 && s.order[s.mySeat] === victim.id, "and a seat of their own again\n" + dump(w));
});

if (require.main === module) run("FINDINGS").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("FINDINGS") };
