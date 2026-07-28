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
// applyRemoteMove accepts a move flagged `auto:true` purely because the sender
// is the elected proxy authority for that seat (script.js:2336-2340). It never
// checks that the target is actually stalled. The proxy TIMERS are well guarded
// (90s clock + 10s grace + epoch/ti checks) but nothing on the RECEIVING side
// enforces them, so a modified client can act for another seat whenever it
// likes — and since every client holds every hand (shared deal seed), it can
// choose which cards the victim throws away.
//
// The equivalent leave path already gets this right: applyRemoteMove refuses a
// leave_fold for a player who is in presentIds (script.js:2313).
//
// Suggested fix — the same idea for auto moves: refuse a cover for a seat we can
// see is present and whose clock we watched start and has not run out, e.g.
//     if (turnTrusted && presentIds.has(roomPlayerIds[seat]) && Date.now() < turnDeadline) return false;

test("FINDING 2: a peer must not be able to force a present, awake player to pass", async () => {
  const w = await matchAtTurn(4, 0);
  const before = w.clients[0].snap();
  eq(before.turn, 0, "seat 0 is on turn");
  ok(before.present.includes("u1"), "and everyone can see they are present");
  ok(before.turnLeft > 30, "with most of their turn clock left");
  // seat 1 is proxyAuthorityId(0); it fires a cover move with no timer involved
  w.clients[1].run('Usion.game.action("move", {kind:"pass", seat:0, ti:' + before.roundMoveNo + ', auto:true}).catch(function(){})');
  await w.advance(3000);
  const after = w.clients[0].snap();
  eq(after.turn, before.turn, "the victim's turn was taken from them\n" + dump(w));
  eq(after.roundMoveNo, before.roundMoveNo, "a forged cover move was counted as a real one");
});

test("FINDING 2b: …nor pick which cards that player throws away", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  // at the start of a round the leader must PLAY (a lead cannot pass), so a
  // forged cover dumps real cards out of the victim's hand
  const lead = w.clients[0].snap().turn;
  const attacker = w.clients[lead === 0 ? 1 : 0];
  const before = w.clients[0].snap();
  attacker.run(`autoMove(${lead}, true)`);
  await w.advance(3000);
  eq(w.clients[0].snap().counts[lead], before.counts[lead],
    "cards were played out of a live player's hand by someone else\n" + dump(w));
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

if (require.main === module) run("FINDINGS").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("FINDINGS") };
