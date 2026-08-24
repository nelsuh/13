// Suite 4 — the dead-end hunt. Locked phones, dropped sockets, players walking
// out, racing authorities, forged actions and three different server sync
// models. Every case ends with the same question: can the table still finish?
//
// Walkouts settle differently in the two modes, so both are covered: a CHAT
// INVITE match (onlineWorld) folds the departed seat out — the roster is the
// people who were invited — while an OPEN ROOM (openWorld) hands the seat back
// to a bot so the room keeps running.

const { onlineWorld, openWorld, startMatch, arrive, botSeats, playOut, driveUntil, rejoin, eventually, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const finished = (w) => w.drivers().every(c => c.snap().overlays.winner);
const BUDGET = 90 * 60 * 1000;

/** Run a match to its end and fail loudly with the table dump if it stalls. */
async function mustFinish(w, note, opts = {}) {
  const r = await playOut(w, Object.assign({ done: () => finished(w), budget: BUDGET }, opts));
  ok(r.ok, (note ? note + ": " : "") + r.reason + "\n" + (r.dump || ""));
  return r;
}

/** Set up an n-seat match and stop the moment it is `seat`'s turn to act. */
async function matchAtTurn(n, seat, opts = {}) {
  const w = await onlineWorld(n, opts);
  await startMatch(w);
  const id = w.clients[seat].id;
  const r = await driveUntil(w, () => {
    const s = w.clients[0].snap();
    return s.dealActive && s.turn === seat;
  }, { skip: [id] });
  ok(r.ok, "could not reach seat " + seat + "'s turn: " + r.reason);
  return w;
}

// ── locked phones (the classic freeze) ────────────────────────────────────

test("a guest locks their phone on their own turn — a peer covers and play goes on", async () => {
  const w = await matchAtTurn(3, 1);
  const victim = w.clients[1];
  const before = w.clients[0].snap();
  victim.freeze();
  await w.advance(140 * 1000);                 // 90s turn clock + 10s proxy grace
  const after = w.clients[0].snap();
  ok(after.turn !== 1 || after.roundMoveNo > before.roundMoveNo || !after.dealActive,
    "the frozen seat must be covered, not left holding the table\n" + dump(w));
  eq(consistency(w), null, "the awake clients still agree");
  victim.thaw();
  await w.advance(90 * 1000);
  eq(consistency(w), null, "the woken player catches up\n" + dump(w));
  await mustFinish(w, "after a guest freeze");
});

test("the HOST locks their phone on their own turn — the table does not freeze", async () => {
  const w = await matchAtTurn(3, 0);
  const host = w.clients[0];
  const before = w.clients[1].snap();
  host.freeze();
  await w.advance(140 * 1000);
  const after = w.clients[1].snap();
  ok(after.turn !== 0 || after.roundMoveNo > before.roundMoveNo || !after.dealActive,
    "a sleeping host must be covered by a peer\n" + dump(w));
  host.thaw();
  await w.advance(90 * 1000);
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a host freeze");
});

// NB: "the primary authority sleeps through a round boundary" is a real stall —
// see FINDING 1 in t_findings.cjs. The freeze cases below all keep the lowest
// present seat awake across the round change.

test("every seat locks its phone in rotation and the match still ends", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  // Somebody is asleep at every moment: sleep one seat for 45s, wake it, move on.
  for (let round = 0; round < 8 && !finished(w); round++) {
    const victim = w.clients[round % 4];
    victim.freeze();
    const r = await playOut(w, { done: () => finished(w), budget: 45 * 1000, stallMs: 4 * 60 * 1000, consistency: false });
    victim.thaw();
    if (r.ok) break;
    ok(!/DEAD END/.test(r.reason || ""), "rolling freezes: " + r.reason + "\n" + (r.dump || ""));
    // give the woken client a moment to resync before the next one goes dark
    await playOut(w, { done: () => finished(w), budget: 20 * 1000, consistency: false });
  }
  w.clients.forEach(c => c.thaw());
  await mustFinish(w, "rolling freezes", { consistency: false });
  await w.advance(60 * 1000);
  eq(consistency(w), null, dump(w));
});

test("a player frozen through an entire round rejoins the right round", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const victim = w.clients[2];
  victim.freeze();
  const r = await driveUntil(w, () => w.clients[0].snap().dealEpoch >= 3, { budget: 30 * 60 * 1000 });
  ok(r.ok, "the other two must be able to play rounds without seat 2: " + r.reason + "\n" + dump(w));
  victim.thaw();
  await w.advance(120 * 1000);
  eq(consistency(w), null, "a long sleeper must land on the CURRENT round\n" + dump(w));
  await mustFinish(w, "after a full-round sleep");
});

// ── dropped sockets ───────────────────────────────────────────────────────

test("a socket drop pauses that client's clock and never auto-passes them", async () => {
  const w = await matchAtTurn(3, 1);
  const victim = w.clients[1];
  victim.netDrop(false);                       // pure transport blip, no leave event
  await w.advance(200);
  eq(victim.snap().netPaused, true, "the dropped client pauses");
  const held = victim.snap().counts[1];
  await w.advance(200 * 1000);                 // far past their own 90s clock
  eq(victim.snap().counts[1], held, "a disconnected player must not auto-pass themselves");
  victim.netRestore(false);
  await w.advance(90 * 1000);
  eq(consistency(w), null, "the reconnected client resyncs\n" + dump(w));
  await mustFinish(w, "after a socket blip");
});

test("drop → reconnect mid-round converges with no duplicated move", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const victim = w.clients[2];
  victim.netDrop();
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 6, { budget: 10 * 60 * 1000 });
  const peerCounts = w.clients[0].snap().counts;
  victim.netRestore();
  await w.advance(90 * 1000);
  eq(victim.snap().counts, peerCounts, "the returning client rebuilds the exact board\n" + dump(w));
  eq(victim.snap().totals, w.clients[0].snap().totals);
  const total = victim.snap().counts.reduce((a, b) => a + b, 0);
  eq(total, w.clients[0].snap().counts.reduce((a, b) => a + b, 0), "no cards invented or lost");
  await mustFinish(w, "after a reconnect");
});

test("a drop that spans a round transition still lands on the current round", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const victim = w.clients[2];
  victim.netDrop();
  const r = await driveUntil(w, () => w.clients[0].snap().dealEpoch >= 3, { budget: 30 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + dump(w));
  victim.netRestore();
  await w.advance(120 * 1000);
  eq(victim.snap().curSeed, w.clients[0].snap().curSeed, "same round\n" + dump(w));
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a multi-round drop");
});

test("tapping Play while disconnected leaves no stuck 'Sending…' latch", async () => {
  const w = await matchAtTurn(3, 1);
  const victim = w.clients[1];
  victim.netDrop(false);
  await w.advance(200);
  for (let i = 0; i < 5; i++) { victim.uiPlay(); await w.advance(300); }
  eq(victim.snap().pendingAction, false, "a failed send must release the latch");
  victim.netRestore(false);
  ok(await eventually(w, () => !victim.snap().pendingAction, 120 * 1000),
    "the latch must not stick after reconnecting\n" + dump(w));
  await mustFinish(w, "after offline tapping");
});

// ── players walking out ───────────────────────────────────────────────────

test("invite 4p: a player leaves for good — 20s grace, then a fold, and three play on", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[3].leaveRoom();
  await w.advance(3000);
  eq(w.clients[0].snap().outs[3], false, "no fold during the grace window");
  ok(w.clients[0].snap().turnLine.length > 0, "the table shows the waiting-for-rejoin line");
  await w.advance(25 * 1000);
  eq(w.clients[0].snap().outs[3], true, "the departed seat folds once the window expires\n" + dump(w));
  eq(w.clients[1].snap().outs[3], true, "and every client agrees");
  await mustFinish(w, "after one of four left");
  eq(w.server.reports.length, 1, "still exactly one result card");
});

test("open 4p: a player leaves for good — 20s grace, then a bot takes the seat", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[3].leaveRoom();
  await w.advance(3000);
  eq(w.clients[0].snap().order[3], "u4", "the seat is held during the grace window");
  await w.advance(25 * 1000);
  eq(w.clients[0].snap().order[3], null, "the departed seat goes to a bot once the window expires\n" + dump(w));
  eq(w.clients[1].snap().order[3], null, "and every client agrees");
  eq(w.clients[0].snap().outs[3], false, "an open room never folds a seat out of the match");
  await mustFinish(w, "after one of four left an open room");
});

test("a player who rejoins inside the grace window is NOT folded", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const victim = w.clients[2];
  const countsBefore = w.clients[0].snap().counts;
  victim.leaveRoom();
  await w.advance(8000);                        // well inside FORFEIT_GRACE_MS = 20s
  eq(w.clients[0].snap().outs[2], false, "not folded yet");
  await rejoin(w, victim);
  await w.advance(40 * 1000);                   // past what would have been the deadline
  eq(w.clients[0].snap().outs[2], false, "a quick rejoin must cancel the fold\n" + dump(w));
  eq(victim.snap().outs[2], false, "and the player is still in their own game");
  eq(victim.snap().counts.length, countsBefore.length);
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a rejoin inside the grace window");
});

test("invite 2p: the last opponent leaves — the match ends as a forfeit win, not a hang", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[1].leaveRoom();
  await w.advance(30 * 1000);
  const s = w.clients[0].snap();
  eq(s.overlays.winner, true, "the survivor gets the winner screen\n" + dump(w));
  eq(s.dealActive, false);
  eq(w.server.reports.length, 1, "the forfeit is reported");
  eq(w.server.reports[0].payload.winnerId, "u1", "the survivor wins");
  eq(w.server.reports[0].payload.scores, undefined, "a forfeit reports no misleading scoreline");
});

test("open 2p: the last human opponent leaves — a bot takes over and the table plays on", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[1].leaveRoom();
  await w.advance(30 * 1000);
  const s = w.clients[0].snap();
  eq(s.order[1], null, "the empty seat went back to a bot\n" + dump(w));
  eq(s.outs[1], false, "and stayed in the match");
  eq(s.overlays.winner, false, "an open room does not end just because a human walked out");
  eq(s.dealActive, true, "the round is still live");
  await mustFinish(w, "after the only human opponent left");
});

test("4p: two players vanish inside the same grace window", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[2].leaveRoom();
  await w.advance(4000);
  w.clients[3].leaveRoom();
  await w.advance(40 * 1000);
  const s = w.clients[0].snap();
  eq(s.outs[2], true, "the first leaver folded\n" + dump(w));
  eq(s.outs[3], true, "the second leaver folded too — not overwritten by the first");
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a double walkout");
});

test("open 4p: two players vanish inside the same grace window", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[2].leaveRoom();
  await w.advance(4000);
  w.clients[3].leaveRoom();
  await w.advance(60 * 1000);
  const s = w.clients[0].snap();
  eq(s.order[2], null, "the first leaver's seat went to a bot\n" + dump(w));
  eq(s.order[3], null, "and so did the second's — one release did not swallow the other");
  eq(s.outs.slice(2), [false, false], "neither seat was folded out of the match");
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a double walkout in an open room");
});

test("the HOST walks out mid-round and the remaining players finish the match", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[1].snap().roundMoveNo >= 2);
  w.clients[0].leaveRoom();
  await w.advance(30 * 1000);
  eq(w.clients[1].snap().outs[0], true, "the host's seat folds\n" + dump(w));
  await mustFinish(w, "after the host walked out");
  eq(w.server.reports.length, 1, "the surviving authority reports the result");
  ok(w.server.reports[0].by !== "u1", "and it is not the player who left");
});

test("an already-eliminated player leaving does not disturb the table", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const r = await driveUntil(w, () => w.clients[0].snap().outs.some(o => o), { budget: 30 * 60 * 1000 });
  ok(r.ok, "nobody was eliminated: " + r.reason);
  const outSeat = w.clients[0].snap().outs.findIndex(o => o);
  const before = w.clients[0].snap();
  w.clients[outSeat].leaveRoom();
  await w.advance(30 * 1000);
  const after = w.clients[0].snap();
  eq(after.outs, before.outs, "no extra fold is written for a seat that is already out");
  await mustFinish(w, "after an eliminated player left");
});

test("full exit and rejoin mid-round rebuilds the board from the checkpoint", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 4);
  const victim = w.clients[2];
  victim.leaveRoom();
  await w.advance(5000);
  await rejoin(w, victim);
  await w.advance(60 * 1000);
  eq(victim.snap().counts, w.clients[0].snap().counts, "the rejoiner's board matches\n" + dump(w));
  eq(victim.snap().turn, w.clients[0].snap().turn, "and so does the turn");
  eq(victim.snap().mySeat, 2, "the rejoiner keeps their seat");
  eq(consistency(w), null);
  await mustFinish(w, "after a full rejoin");
});

// ── lost messages ─────────────────────────────────────────────────────────

// NB: a message can only really go missing while the client is backgrounded or
// its socket is down — those are the two cases below. Losing a message with a
// live socket in the foreground has NO recovery trigger at all; that gap is
// reproduced separately in t_findings.cjs.

test("losing your own move echo while backgrounded does not strand you", async () => {
  const w = await matchAtTurn(3, 1);
  const victim = w.clients[1];
  w.server.dropNext.push({ to: "u2", type: "action" });   // eat u2's own echo
  victim.uiPlay();
  await w.advance(1000);
  eq(victim.snap().pendingAction, false, "the move went onto the board without waiting for the echo");
  victim.freeze(); await w.advance(5000); victim.thaw();  // the player backgrounds the app
  ok(await eventually(w, () => consistency(w) === null, 120 * 1000),
    "recovery must put the client back on the room's board\n" + dump(w));
  eq(victim.snap().counts, w.clients[0].snap().counts, "with the same hands\n" + dump(w));
  await mustFinish(w, "after a lost own-move echo");
});

test("losing your own move echo across a socket blip recovers too", async () => {
  const w = await matchAtTurn(3, 1);
  const victim = w.clients[1];
  w.server.dropNext.push({ to: "u2", type: "action" });
  victim.uiPlay();
  await w.advance(1000);
  victim.netDrop(false); await w.advance(1000); victim.netRestore(false);
  ok(await eventually(w, () => !victim.snap().pendingAction, 120 * 1000), dump(w));
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a lost echo + blip");
});

test("losing the dealer's own deal echo does not block the next round", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const r = await driveUntil(w, () => w.clients[0].snap().overlays.hand, { budget: 20 * 60 * 1000 });
  ok(r.ok, r.reason);
  const epoch = w.clients[0].snap().dealEpoch;
  w.server.dropNext.push({ to: "u1", type: "action" });   // the dealer never sees its own deal
  await w.advance(8000);
  w.clients[0].freeze(); await w.advance(5000); w.clients[0].thaw();
  ok(await eventually(w, () => w.clients[0].snap().dealEpoch > epoch, 120 * 1000),
    "the dealer must still end up in the new round\n" + dump(w));
  eq(w.clients[0].snap().pendingAction, false, "and must not be latched out of playing");
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a lost deal echo");
});

test("a burst of lost deliveries while backgrounded is repaired by resync", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const victim = w.clients[2];
  victim.freeze();                                        // backgrounded: everything is dropped
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 8, { budget: 20 * 60 * 1000 });
  victim.thaw();
  ok(await eventually(w, () => consistency(w) === null, 120 * 1000),
    "resync must repair a client that missed a dozen actions\n" + dump(w));
  await mustFinish(w, "after a burst of lost actions");
});

// ── races ─────────────────────────────────────────────────────────────────

test("two clients dealing the same round at once produce ONE round", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const r = await driveUntil(w, () => w.clients[0].snap().overlays.hand, { budget: 20 * 60 * 1000 });
  ok(r.ok, r.reason);
  const epoch = w.clients[0].snap().dealEpoch;
  w.clients[0].run("hostDeal()");
  w.clients[1].run("hostDeal()");               // same instant, before either echo lands
  await w.advance(60 * 1000);
  const s0 = w.clients[0].snap();
  eq(s0.dealEpoch, epoch + 1, "exactly one new round was applied\n" + dump(w));
  for (const c of w.clients) eq(c.snap().curSeed, s0.curSeed, c.id + " must be on the same deal");
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a deal race");
});

test("two peers covering the same stalled seat collapse into one move", async () => {
  const w = await matchAtTurn(4, 2);
  const victim = w.clients[2];
  victim.freeze();
  const before = w.clients[0].snap();
  // force BOTH remaining peers to cover seat 2 in the same instant
  w.clients[0].run("autoMove(2, true)");
  w.clients[1].run("autoMove(2, true)");
  w.clients[3].run("autoMove(2, true)");
  await w.advance(5000);
  const after = w.clients[0].snap();
  eq(after.roundMoveNo, before.roundMoveNo + 1, "only one cover move may land\n" + dump(w));
  eq(consistency(w), null, dump(w));
  victim.thaw();
  await w.advance(90 * 1000);
  await mustFinish(w, "after a proxy race");
});

// ── forgeries ─────────────────────────────────────────────────────────────

test("forged moves are rejected without desynchronising the table", async () => {
  const w = await matchAtTurn(4, 0);
  const before = w.clients[0].snap();
  const other = w.clients[1];                    // seat 1, NOT on turn
  const forge = (js) => other.run(`Usion.game.action("move", ${js}).catch(function(){})`);
  forge('{kind:"pass", seat:1, ti:' + before.roundMoveNo + '}');        // out of turn
  forge('{kind:"pass", seat:0, ti:' + before.roundMoveNo + '}');        // impersonating seat 0
  forge('{kind:"play", seat:1, ti:' + before.roundMoveNo + ', cards:[999]}');   // junk card
  forge('{kind:"play", seat:1, ti:' + before.roundMoveNo + ', cards:[60,60]}'); // duplicated card
  forge('{kind:"leave_fold", seat:0}');          // fold a player who is right here
  forge('{kind:"forfeit_win", seat:2}');         // end the match on a live player
  forge('{kind:"nonsense", seat:1}');
  forge('{kind:"pass", seat:2, ti:' + before.roundMoveNo + ', auto:true}');  // proxy for a seat we are not authority for
  forge('{kind:"pass", seat:1, ti:' + before.roundMoveNo + ', auto:true}');  // proxy for OURSELVES
  forge('{kind:"pass", seat:0, ti:' + (before.roundMoveNo + 7) + ', auto:true}'); // stale turn index
  await w.advance(5000);
  const after = w.clients[0].snap();
  eq(after.turn, before.turn, "the turn must not move\n" + dump(w));
  eq(after.counts, before.counts, "no cards may change hands");
  eq(after.outs, before.outs, "nobody may be folded");
  eq(after.roundMoveNo, before.roundMoveNo, "no forged move may be counted");
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a forgery attempt");
});

test("a forged state_push from a non-authority is ignored", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 4);
  const before = w.clients[0].snap();
  // seat 2 (not the authority) tries to roll the table back to the fresh deal
  w.clients[2].run('Usion.game.realtime("state_push", Object.assign(currentCheckpoint(), {moves: [], seq: lastSeq + 500}))');
  await w.advance(5000);
  const after = w.clients[0].snap();
  // The bots keep playing while we wait, so the table is allowed to move FORWARD —
  // what the forgery must never do is rewind it.
  eq(after.curSeed, before.curSeed, "a forged rollback must not re-deal the table\n" + dump(w));
  ok(after.roundMoveNo >= before.roundMoveNo, "the move log must not rewind\n" + dump(w));
  ok(after.counts.every((n, i) => n <= before.counts[i]), "no played card may come back into a hand");
  eq(consistency(w), null);
  await mustFinish(w, "after a forged state_push");
});

test("a stale checkpoint cannot roll a live round backwards", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const stale = JSON.parse(JSON.stringify(w.room.state));
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 6, { budget: 10 * 60 * 1000 });
  const before = w.clients[1].snap();
  w.clients[0].run("applyStateSnapshot(" + JSON.stringify(stale) + ")");
  await w.advance(2000);
  eq(w.clients[0].snap().roundMoveNo, before.roundMoveNo, "an older snapshot must be refused\n" + dump(w));
  eq(consistency(w), null);
});

// ── live and replay must reach the same verdict ───────────────────────────
// The sender checks cannot run when moves come out of a checkpoint (those carry
// no sender id), but they MUST run when replaying the raw action log — the log
// keeps what the live table rejected. These guard both directions.

test("a real proxy cover survives a full rejoin", async () => {
  const w = await matchAtTurn(4, 2);
  const victim = w.clients[2];
  victim.freeze();                                    // the seat genuinely stalls
  await w.advance(140 * 1000);                        // 90s clock + 10s grace
  const covered = w.clients[0].snap();
  ok(covered.roundMoveNo > 0, "a cover move landed");
  const observer = w.clients[3];
  observer.leaveRoom();
  await w.advance(2000);
  await rejoin(w, observer, 60 * 1000);
  eq(observer.snap().counts, w.clients[0].snap().counts,
    "a rejoining client must keep the cover, not drop it as unverifiable\n" + dump(w));
  eq(observer.snap().turn, w.clients[0].snap().turn);
  victim.thaw();
  await w.advance(90 * 1000);
  await mustFinish(w, "cover + rejoin", { consistency: false });
});

test("a real fold survives a full rejoin", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[3].leaveRoom();
  await w.advance(30 * 1000);
  eq(w.clients[0].snap().outs[3], true, "seat 3 folded");
  const observer = w.clients[2];
  observer.leaveRoom();
  await w.advance(2000);
  await rejoin(w, observer, 60 * 1000);
  eq(observer.snap().outs, w.clients[0].snap().outs,
    "a rejoining client must keep a legitimate fold\n" + dump(w));
  await mustFinish(w, "fold + rejoin");
});

test("a real seat release survives a full rejoin", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[3].leaveRoom();
  await w.advance(30 * 1000);
  eq(w.clients[0].snap().order[3], null, "seat 3 is a bot now");
  const observer = w.clients[2];
  observer.leaveRoom();
  await w.advance(2000);
  await rejoin(w, observer, 60 * 1000);
  eq(observer.snap().order, w.clients[0].snap().order,
    "a rejoining client must rebuild the same roster\n" + dump(w));
  eq(observer.snap().outs, w.clients[0].snap().outs, "and the same standings");
  await mustFinish(w, "release + rejoin");
});

test("a forged fold cannot eliminate anyone, live or on replay", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[1].run('Usion.game.action("move", {kind:"leave_fold", seat:0}).catch(function(){})');
  w.clients[1].run('Usion.game.action("move", {kind:"forfeit_win", seat:2}).catch(function(){})');
  await w.advance(5000);
  eq(w.clients[0].snap().outs, [false, false, false, false], "nobody is folded live\n" + dump(w));
  const observer = w.clients[3];
  observer.leaveRoom();
  await w.advance(2000);
  await rejoin(w, observer, 60 * 1000);
  eq(observer.snap().outs, [false, false, false, false],
    "and the forgery must not take effect on a client that replays the log\n" + dump(w));
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "forged fold + rejoin");
});

test("the catch-up nets stay quiet in a healthy match", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const base = w.clients.map(c => c.sdk.calls.requestSync);
  await mustFinish(w, "healthy match");
  const minutes = Math.max(1, (w.clock.now - 0) / 60000);
  w.clients.forEach((c, i) => {
    const extra = c.sdk.calls.requestSync - base[i];
    const moves = w.room.log.length;
    ok(extra <= moves,
      `${c.id} asked for ${extra} syncs over ${moves} logged actions — the watchdog is firing in a healthy game`);
  });
});

// ── the server's sync model should not matter ─────────────────────────────

for (const syncModel of ["full", "tail", "cpTailInclusive"]) {
  test(`sync model '${syncModel}': a sleeping authority never holds up the next round`, async () => {
    const w = await onlineWorld(3, { syncModel });
    await startMatch(w);
    const r = await driveUntil(w, () => w.clients[1].snap().overlays.hand, { budget: 20 * 60 * 1000 });
    ok(r.ok, r.reason);
    const epoch = w.clients[1].snap().dealEpoch;
    w.clients[0].freeze();
    await w.advance(60 * 1000);
    ok(w.clients[1].snap().dealEpoch > epoch, syncModel + ": the fallback deal must land\n" + dump(w));
    w.clients[0].thaw();
    await w.advance(120 * 1000);
    eq(consistency(w), null, syncModel + ": the sleeper must rejoin the same round\n" + dump(w));
    await mustFinish(w, syncModel + " fallback deal");
  });

  test(`sync model '${syncModel}': freeze + drop + rejoin all still converge`, async () => {
    const w = await onlineWorld(3, { syncModel });
    await startMatch(w);
    await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 3);
    w.clients[1].freeze();
    await w.advance(60 * 1000);
    w.clients[2].netDrop();
    await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 5, { budget: 15 * 60 * 1000 });
    w.clients[1].thaw();
    w.clients[2].netRestore();
    await w.advance(120 * 1000);
    eq(consistency(w), null, syncModel + ": clients failed to converge\n" + dump(w));
    const counts = w.clients[0].snap().counts;
    eq(counts.reduce((a, b) => a + b, 0) <= 39, true, "no phantom cards were replayed onto the board");
    await mustFinish(w, syncModel);
  });
}

// ── misc launch paths ─────────────────────────────────────────────────────

test("an open room promoted by Share becomes a chat-invite waiting room", async () => {
  const { World } = require("./lib/world.cjs");
  const w = new World();
  w.mode = "multiplayer";                       // the PROMOTED room is an invite room
  // Alice opened the game with no invite, so she is at an open table in her own
  // standalone room, playing three bots over the relay.
  const host = w.add("p1", "Alice", { mode: "single", roomId: "standalone_p" });
  host.start({ userId: "p1", userName: "Alice", roomId: "standalone_p", playerIds: ["p1"] });
  const solo = await eventually(w, () => host.snap().dealActive, 20000, 250);
  ok(solo, "the no-invite launch should open its own table\n" + dump(w));
  eq(host.snap().order, ["p1", null, null, null], "alone with three bots");

  // She hits Share, so the SDK moves her into a real invite room. Sharing IS
  // inviting, so the promoted room follows the chat-invite rules: a waiting room,
  // READY, and a roster frozen at Start.
  host.sdk.launch.roomId = w.roomId;
  host.sdk.launch.mode = "multiplayer";
  host.sdk.fire("roomAssigned", { roomId: w.roomId });
  host.run(`Usion.game.join(${JSON.stringify(w.roomId)}).catch(function () {})`);
  await w.advance(1500);
  const s = host.snap();
  eq(s.online, true, "we are in the new room");
  eq(s.dealActive, false, "the open table she was playing is torn down");
  eq(s.overlays.lobby, true, "and the waiting room is up");
  eq(host.el("readyBtn").style.display, "block", "with a READY toggle again");
  // no stray bot or restart timer may deal into the lobby
  await w.advance(120 * 1000);
  eq(host.snap().dealActive, false, "nothing re-deals behind the lobby\n" + dump(w));
  // and a real guest can now join and play
  const guest = w.add("p2", "Bob", { mode: "multiplayer", roomId: w.roomId });
  guest.start({ userId: "p2", userName: "Bob", roomId: w.roomId, playerIds: [] });
  await w.advance(1500);
  await startMatch(w);
  eq(host.snap().numPlayers, 2, "a promoted room deals a real 2-player match");
  eq(host.snap().order, ["p1", "p2"], "seated by the host's Start, not by bot takeover");
  await mustFinish(w, "promoted room");
});

test("high latency (500ms round trip) does not break a full match", async () => {
  const w = await onlineWorld(4, { latency: 500 });
  await startMatch(w);
  await mustFinish(w, "high latency");
  eq(consistency(w), null);
});

test("no client throws anywhere in an adversarial 4-player match", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[3].freeze();
  await w.advance(60 * 1000);
  w.clients[2].netDrop();
  await w.advance(30 * 1000);
  w.clients[3].thaw();
  w.clients[2].netRestore();
  await mustFinish(w, "mixed adversity");
  for (const c of w.clients) eq(c.errors.map(e => String(e && e.message || e)), [], c.id + " threw");
});

// ── open table: dropping in and out under adversity ───────────────────────

test("open room: a newcomer is still seated when the elected authority is asleep", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  // Seat 0 writes seat claims. A locked phone runs no javascript but never
  // leaves presentIds, so without a staggered fallback it would lock the room.
  w.clients[0].freeze();
  await w.advance(2000);
  const late = arrive(w, "u3", "Chuck");
  const got = await eventually(w, () => w.clients[1].snap().order.indexOf("u3") >= 0, 60 * 1000, 250);
  ok(got, "seat 1 must cover the claim seat 0 owes\n" + dump(w));
  await eventually(w, () => late.snap().gameStarted, 30 * 1000, 250);
  eq(late.snap().mySeat, w.clients[1].snap().order.indexOf("u3"), "and the newcomer agrees which seat");
  w.clients[0].thaw();
  await w.advance(60 * 1000);
  eq(consistency(w), null, "the sleeper catches up to the new roster\n" + dump(w));
  await mustFinish(w, "seated while the authority slept");
});

test("open room: two clients claiming the same seat at once produce ONE seating", async () => {
  const w = await openWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const bot = w.clients[0].snap().order.indexOf(null);
  ok(bot >= 0, "there is a bot seat to claim");
  arrive(w, "u4", "Dana");
  await w.advance(300);
  // every seated client fires the same claim in the same tick
  for (const c of [w.clients[0], w.clients[1], w.clients[2]]) {
    c.run(`Usion.game.action("move", {kind:"seat_take", seat:${bot}, playerId:"u4"}).catch(function(){})`);
  }
  await w.advance(5000);
  const s = w.clients[0].snap();
  eq(s.order.filter(id => id === "u4").length, 1, "Dana holds exactly one seat\n" + dump(w));
  eq(new Set(s.order.filter(Boolean)).size, s.order.filter(Boolean).length, "no id appears twice");
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "after a seat-claim race");
});

test("open room: a player who joins between rounds is dealt into the very next hand", async () => {
  const w = await openWorld(1);
  await startMatch(w);
  // stop on the results overlay, i.e. between two rounds
  const r = await driveUntil(w, () => w.clients[0].snap().overlays.hand, { budget: 30 * 60 * 1000 });
  ok(r.ok, "the table should reach a results screen: " + r.reason + "\n" + (r.dump || ""));
  const late = arrive(w, "u2", "Bob");
  const got = await eventually(w, () => w.clients[0].snap().order.indexOf("u2") >= 0, 60 * 1000, 250);
  ok(got, "a between-rounds joiner still gets a seat\n" + dump(w));
  const seat = w.clients[0].snap().order.indexOf("u2");
  const dealt = await eventually(w, () => late.snap().dealActive && late.snap().counts[seat] === 13, 60 * 1000, 250);
  ok(dealt, "and is dealt a full hand in the next round\n" + dump(w));
  eq(consistency(w), null, dump(w));
  await mustFinish(w, "joined between rounds");
});

test("open room: churn — joining and leaving all match long never splits the table", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const c = arrive(w, "u3", "Chuck");
  await eventually(w, () => c.snap().gameStarted, 40 * 1000, 250);
  w.clients[1].leaveRoom();                       // Bob walks out while Chuck settles in
  await w.advance(30 * 1000);
  const d = arrive(w, "u4", "Dana");
  await eventually(w, () => d.snap().gameStarted, 40 * 1000, 250);
  eq(consistency(w), null, "the table agrees through the churn\n" + dump(w));
  const live = [w.clients[0], c, d];
  const r = await playOut(w, {
    done: () => live.every(x => x.snap().overlays.winner),
    budget: BUDGET, skip: ["u2"],
  });
  ok(r.ok, "churn: " + r.reason + "\n" + (r.dump || ""));
  for (const x of live) eq(x.errors.map(e => String(e && e.message || e)), [], x.id + " threw");
});

if (require.main === module) run("ADVERSITY").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("ADVERSITY") };
