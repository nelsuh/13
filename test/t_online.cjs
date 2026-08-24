// Suite 3 — the OPEN TABLE: a room is a persistent 4-seat game that deals on its
// own against bots, seats arrivals mid-match by displacing the lowest-scoring
// bot (score and cards included), and hands a departed seat back to a bot so the
// room keeps running. Plus full matches at 1–4 humans, round transitions,
// rematch, result reporting, names and quick chat. Every match is watched for
// desync and dead ends.

const { World, onlineWorld, startMatch, joinTable, botSeats, playOut, eventually, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const seated = (w) => w.drivers().filter(c => c.snap().gameStarted);
const finished = (w) => { const s = seated(w); return s.length > 0 && s.every(c => c.snap().overlays.winner); };

/** Play until one full round has been scored, so the seats hold real points. */
async function playARound(w, rounds = 2) {
  const r = await playOut(w, {
    done: () => w.clients[0].snap().dealEpoch >= rounds,
    budget: 30 * 60 * 1000, consistency: false,
  });
  ok(r.ok, "warm-up round: " + r.reason + "\n" + (r.dump || ""));
}

/**
 * Advance until `pred()` holds, keeping the LAST snapshot taken before it did.
 * Rounds keep scoring while we wait, so a seat's inherited total has to be
 * compared against what it was an instant before the change, not minutes before.
 */
async function watchUntil(w, c, pred, ms = 40000) {
  let prev = c.snap();
  const hit = await eventually(w, () => {
    const s = c.snap();
    if (pred(s)) return true;
    prev = s;
    return false;
  }, ms, 250);
  return { hit, prev, now: c.snap() };
}

test("an open table deals immediately against bots — no lobby, no Start press", async () => {
  const w = await onlineWorld(1);
  await startMatch(w);
  const s = w.clients[0].snap();
  eq(s.online, true);
  eq(s.gameStarted, true, "the lone player is already in a match");
  eq(s.numPlayers, 4, "an open table is always 4 seats wide");
  eq(s.mySeat, 0);
  eq(s.order, ["u1", null, null, null], "bots hold every empty seat");
  eq(s.counts, [13, 13, 13, 13], "13 cards each, bots included");
  eq(s.loseAt, 20, "open tables run the road to 20");
  eq(s.overlays.lobby, false, "the connect cover lifts as soon as cards land");
  eq(w.clients[0].el("readyBtn").style.display, "none", "there is no READY toggle");
  eq(w.clients[0].el("startGameBtn").style.display, "none", "and no Start button");
  eq(w.clients[0].el("lobbyLoseRow").querySelectorAll(".count-btn").every(b => b.disabled), true,
     "the match length is a read-only reminder");
});

test("the bots at an open table really play: the round advances with one human", async () => {
  const w = await onlineWorld(1);
  await startMatch(w);
  const before = w.clients[0].snap();
  const r = await playOut(w, { done: () => w.clients[0].snap().roundMoveNo >= 6, budget: 5 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  const after = w.clients[0].snap();
  ok(after.counts.filter((n, i) => i !== 0 && n < 13).length >= 1, "at least one bot has played cards");
  ok(after.roundMoveNo > before.roundMoveNo, "the move log grew");
  eq(w.clients[0].errors.map(String), [], "u1 threw");
});

for (const n of [1, 2, 3, 4]) {
  test(`${n} human(s) + bots: a full open-table match runs to the winner screen`, async () => {
    const w = await onlineWorld(n);
    await startMatch(w);
    for (let i = 0; i < n; i++) {
      const s = w.clients[i].snap();
      eq(s.mySeat, i, w.clients[i].id + " seat");
      eq(s.numPlayers, 4, "always four seats");
      eq(s.counts, [13, 13, 13, 13], "13 cards each");
      eq(s.order.slice(0, n), w.clients.map(c => c.id), "humans keep roster order");
      eq(s.order.slice(n), new Array(4 - n).fill(null), "the rest are bots");
      eq(s.names.slice(0, n), ["Alice", "Bob", "Chuck", "Dana"].slice(0, n), "real names, never 'Player N'");
      eq(s.overlays.lobby, false, "the Dealing… cover lifts once cards land");
    }
    eq(consistency(w), null, "clients agree right after the deal");
    const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
    ok(r.ok, r.reason + "\n" + (r.dump || ""));
    eq(consistency(w), null, "clients agree at the end");
    const s = w.clients[0].snap();
    eq(s.outs.filter(o => !o).length, 1, "one survivor");
    for (const c of w.clients) {
      eq(c.snap().winnerName !== "", true, "everyone sees a winner name");
      eq(c.errors.map(String), [], c.id + " threw");
    }
    eq(w.trace.filter(x => x.uiPlay === "stuck-lead" || x.uiPlay === "cards-missing"), [], "UI refused a move");
  });
}

// ── The headline behaviour ────────────────────────────────────────────────
test("a joining player takes over the LOWEST-SCORING bot and inherits its points", async () => {
  const w = await onlineWorld(1);
  await startMatch(w);
  await playARound(w);                      // give the bots real, different scores

  const before = w.clients[0].snap();
  const bots = botSeats(w.clients[0]);
  eq(bots.length, 3, "three bot seats before anyone joins");
  let want = bots[0];
  bots.forEach(s => { if (before.totals[s] < before.totals[want]) want = s; });

  const host = w.clients[0];
  const c = w.add("u2", "Bob", { mode: "multiplayer", roomId: w.roomId });
  c.start({ userId: "u2", userName: "Bob", roomId: w.roomId, playerIds: [] });
  const seen = await watchUntil(w, host, s => s.order.indexOf("u2") >= 0);
  ok(seen.hit, "the joiner should be seated:\n" + dump(w));

  const seat = seen.now.order.indexOf("u2");
  eq(seat, want, "Bob replaces the bot carrying the fewest penalty points");
  eq(seen.now.totals[seat], seen.prev.totals[seat], "and inherits that seat's score");
  eq(seen.now.totals, seen.prev.totals, "the swap resets nobody's score");
  eq(seen.now.counts[seat], seen.prev.counts[seat], "the seat keeps the cards the bot was holding");
  eq(seen.now.outs[seat], false);
  eq(seen.now.names[seat], "Bob", "and the seat now shows a human");

  await eventually(w, () => c.snap().gameStarted && c.snap().mySeat === seat, 20000, 250);
  const mine = c.snap();
  eq(mine.mySeat, seat, "Bob agrees which seat he took");
  eq(mine.totals, seen.now.totals, "Bob sees the same scoreboard");
  eq(mine.numPlayers, 4);
  eq(mine.overlays.lobby, false, "Bob is at the table, not on a waiting screen");

  // and the table keeps going with the mixed roster
  const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  eq(consistency(w), null);
});

test("B, then C, then D each drop into the running round and fill the table", async () => {
  const w = await onlineWorld(1);
  await startMatch(w);
  const host = w.clients[0];
  const seed = host.snap().curSeed;
  // Joining while every bot is still level: the tie-break is the lowest seat, so
  // they fill 1, 2, 3 in arrival order.
  for (const [id, name, expect] of [["u2", "Bob", 1], ["u3", "Chuck", 2], ["u4", "Dana", 3]]) {
    const before = host.snap();
    const c = w.add(id, name, { mode: "multiplayer", roomId: w.roomId });
    c.start({ userId: id, userName: name, roomId: w.roomId, playerIds: [] });
    const seen = await watchUntil(w, host, s => s.order.indexOf(id) >= 0);
    ok(seen.hit, id + " should be seated:\n" + dump(w));
    const seat = seen.now.order.indexOf(id);
    eq(seat, expect, name + " takes the lowest-scoring bot, ties broken by seat");
    eq(seen.now.totals[seat], seen.prev.totals[seat], name + " inherits that seat's score");
    eq(seen.now.counts[seat], seen.prev.counts[seat], name + " inherits that seat's cards");
    eq(seen.now.outs[seat], seen.prev.outs[seat], "and its standing");
    eq(seen.now.curSeed, before.curSeed, "the live round is not re-dealt for a newcomer");
    await eventually(w, () => c.snap().gameStarted && c.snap().mySeat === seat, 20000, 250);
    eq(c.snap().curSeed, before.curSeed, name + " joined the round already in progress");
  }
  const final = host.snap();
  eq(final.order, ["u1", "u2", "u3", "u4"], "the table is all human now");
  eq(final.curSeed, seed, "still the very same round the lone player started");
  eq(consistency(w), null);
  const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

test("a fifth arrival has no bot to displace and waits for a seat", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const late = w.add("u5", "Erdene", { mode: "multiplayer", roomId: w.roomId });
  late.start({ userId: "u5", userName: "Erdene", roomId: w.roomId, playerIds: [] });
  await w.advance(8000);
  const s = late.snap();
  eq(s.gameStarted, false, "no seat, so no match");
  eq(s.mySeat, -1);
  eq(s.overlays.lobby, true, "they sit on the waiting cover");
  eq(late.el("onlineStatus").textContent, late.read('t("openWaitSeat")'), "and are told a seat has to free up");
  eq(w.clients[0].snap().order, ["u1", "u2", "u3", "u4"], "the running table is untouched");
  eq(w.clients[0].snap().numPlayers, 4);
});

test("a player who leaves hands the seat AND its score back to a bot", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  await playARound(w);                       // let the seats accumulate real points
  const host = w.clients[0];
  // Whoever walks out has to still be IN the match — an eliminated seat has
  // nothing left for a bot to play. Prefer the one carrying the most points, so
  // the inherited score is worth asserting on.
  const state = host.snap();
  const seat = [1, 2, 3].filter(s => !state.outs[s])
                        .sort((a, b) => state.totals[b] - state.totals[a])[0];
  ok(seat !== undefined, "one of the guests is still alive:\n" + dump(w));
  const leaver = w.clients[seat];
  eq(state.order[seat], leaver.id);

  leaver.leaveRoom();
  const seen = await watchUntil(w, host, s => s.order[seat] === null);
  ok(seen.hit, "the empty seat should go back to a bot:\n" + dump(w));
  eq(seen.now.order[seat], null, "the seat is a bot again");
  eq(seen.now.totals[seat], seen.prev.totals[seat], "carrying the score the human left behind");
  eq(seen.now.totals, seen.prev.totals, "and disturbing nobody else's");
  eq(seen.now.outs[seat], false, "the seat is NOT folded out of the match");
  eq(seen.now.counts[seat], seen.prev.counts[seat], "and keeps the cards it was holding");

  // the room survives the walkout and finishes the match
  const rest = w.clients.filter(c => c !== leaver);
  const r = await playOut(w, {
    done: () => rest.every(c => c.snap().overlays.winner),
    budget: 60 * 60 * 1000, consistency: false, skip: [leaver.id],
  });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  for (const c of rest) eq(c.errors.map(String), [], c.id + " threw");
});

test("a seat freed by a walkout goes to the player who was waiting for one", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const host = w.clients[0];
  const late = w.add("u5", "Erdene", { mode: "multiplayer", roomId: w.roomId });
  late.start({ userId: "u5", userName: "Erdene", roomId: w.roomId, playerIds: [] });
  await w.advance(4000);
  eq(late.snap().mySeat, -1, "no seat while the table is full");

  w.clients[3].leaveRoom();                       // Dana walks out of seat 3
  const seen = await watchUntil(w, host, s => s.order.indexOf("u5") >= 0, 60000);
  ok(seen.hit, "the waiting player should inherit the freed seat:\n" + dump(w));
  eq(seen.now.order.indexOf("u5"), 3, "and it is the seat that opened up");
  await eventually(w, () => late.snap().gameStarted && late.snap().mySeat === 3, 20000, 250);
  eq(late.snap().mySeat, 3);
  eq(consistency(w), null);
});

// ── Security: the seat log is as forgeable-proof as the move log ──────────
test("an unseated spectator cannot inject moves or deals", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  w.room.started = true;
  const spectator = w.add("u5", "Erdene", { mode: "multiplayer", roomId: w.roomId });
  spectator.start({ userId: "u5", userName: "Erdene", roomId: w.roomId, playerIds: [] });
  await w.advance(3000);
  const before = w.clients[0].snap();
  spectator.run('Usion.game.action("deal", {seed: 42, order: ["u5","u1"], names: {}}).catch(function(){})');
  spectator.run('Usion.game.action("move", {kind: "pass", seat: 0, ti: 0}).catch(function(){})');
  await w.advance(1500);
  const after = w.clients[0].snap();
  eq(after.curSeed, before.curSeed, "a forged deal must not re-deal the table");
  eq(after.counts, before.counts, "a forged move must not touch the hands");
  eq(after.turn, before.turn, "a forged move must not steal the turn");
  eq(after.order, before.order, "and must not reseat anyone");
});

test("a seat claim for the wrong bot — or for somebody already seated — is rejected", async () => {
  const w = await onlineWorld(1);
  await startMatch(w);
  await playARound(w);
  const host = w.clients[0];
  const spectator = w.add("u2", "Bob", { mode: "multiplayer", roomId: w.roomId });
  spectator.start({ userId: "u2", userName: "Bob", roomId: w.roomId, playerIds: [] });
  await eventually(w, () => host.snap().order.indexOf("u2") >= 0, 20000, 250);
  const mine = host.snap().order.indexOf("u2");
  const bots = botSeats(host);
  ok(bots.length >= 1, "there are still bot seats left");

  // Bob is already seated, so a second claim anywhere must be refused…
  spectator.run(`Usion.game.action("move", {kind:"seat_take", seat:${bots[0]}, playerId:"u2"}).catch(function(){})`);
  // …and claiming a bot seat that is NOT the lowest-scoring one is refused too.
  const before = host.snap();
  let worst = bots[0];
  bots.forEach(s => { if (before.totals[s] > before.totals[worst]) worst = s; });
  const lowest = bots.reduce((a, s) => (before.totals[s] < before.totals[a] ? s : a), bots[0]);
  host.run(`Usion.game.action("move", {kind:"seat_take", seat:${worst}, playerId:"u9"}).catch(function(){})`);
  await w.advance(2000);
  const after = host.snap();
  eq(after.order[mine], "u2", "Bob still holds exactly one seat");
  eq(after.order.filter(id => id === "u2").length, 1, "and only one");
  if (worst !== lowest) eq(after.order[worst], null, "the wrong bot seat was not handed out");
  eq(after.order.indexOf("u9"), -1, "a phantom player was never seated");
});

test("a relayed bot move must be the engine's own choice, not the sender's", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  const host = w.clients[0];
  const bot = botSeats(host)[0];
  // Drive the table until it is genuinely the bot's turn, in small steps so we
  // get there before the elected relay's own 900 ms move goes out.
  const r = await playOut(w, {
    done: () => host.snap().dealActive && host.snap().turn === bot,
    budget: 5 * 60 * 1000, step: 50, consistency: false,
  });
  ok(r.ok, "the bot should get a turn: " + r.reason + "\n" + (r.dump || ""));
  // Offer the validator a bot move the engine would NOT have made. Evaluated
  // inside the client's realm so no virtual time passes and the turn cannot move
  // under us mid-test.
  const verdict = host.read(`(function () {
    var seat = ${bot};
    if (turn !== seat || !dealActive) return { skipped: true };
    var want = botDecision(seat);
    var wantKey = (want && want.kind === "play")
      ? want.combo.cards.map(cardWire).sort(function (a, b) { return a - b; }).join(",") : "";
    var junk = null;
    for (var i = 0; i < hands[seat].length; i++) {
      if (String(cardWire(hands[seat][i])) !== wantKey) { junk = [cardWire(hands[seat][i])]; break; }
    }
    var before = hands[seat].length, beforeTurn = turn, beforeMoves = roundMoveNo;
    var accepted = applyRemoteMove({ kind: "play", cards: junk, seat: seat, bot: true, ti: roundMoveNo }, "u2");
    // …and the move the engine really would make must still be accepted, so the
    // rule rejects forgeries rather than bot relaying as a whole.
    var honest = (want && want.kind === "play")
      ? { kind: "play", cards: want.combo.cards.map(cardWire), seat: seat, bot: true, ti: roundMoveNo }
      : { kind: "pass", seat: seat, bot: true, ti: roundMoveNo };
    var honestOk = applyRemoteMove(honest, "u2");
    return { accepted: accepted, honestOk: honestOk, before: before, after: hands[seat].length,
             beforeTurn: beforeTurn, beforeMoves: beforeMoves, moves: roundMoveNo };
  })()`);
  eq(verdict.skipped, undefined, "the bot really was on turn");
  eq(verdict.accepted, false, "a bot move the engine would not have made is rejected");
  eq(verdict.moves, verdict.beforeMoves + 1, "only the engine's own move was applied");
  ok(verdict.honestOk === true, "the engine's own choice is still accepted");
});

// ── Match length, rematch, reporting, transitions ─────────────────────────
test("every client at an open table runs the same fixed target", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  for (const c of w.clients) eq(c.snap().loseAt, 20, c.id + " adopts the open-table target");
  eq(w.room.log[0].action_data.loseAt, 20, "and the deal carries it");
  for (const c of w.clients) {
    const btns = c.doc.querySelectorAll("#lobbyLoseRow .count-btn");
    eq(btns.every(b => b.disabled), true, c.id + ": nobody can change it mid-table");
  }
});

test("online rematch: the authority's reset deal restarts everyone", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason);
  ok(w.clients[0].snap().totals.some(t => t > 0), "the finished match has real scores");
  w.clients[0].click("playAgainBtn");
  await w.advance(2000);
  for (const c of w.clients) {
    const s = c.snap();
    eq(s.totals, [0, 0, 0, 0], c.id + ": scores reset");
    eq(s.outs, [false, false, false, false], c.id + ": eliminations reset");
    eq(s.overlays.winner, false, c.id + ": winner overlay cleared");
    eq(s.dealActive, true, c.id + ": a fresh round is live");
    eq(s.counts, [13, 13, 13, 13], c.id + ": fresh hands");
  }
  const r2 = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r2.ok, "rematch: " + r2.reason + "\n" + (r2.dump || ""));
});

test("an open table restarts itself after the winner screen — nobody has to press anything", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason);
  const epoch = w.clients[0].snap().dealEpoch;
  const back = await eventually(w, () => w.clients.every(c => {
    const s = c.snap();
    return s.dealActive && !s.overlays.winner && s.dealEpoch > epoch;
  }), 40000, 500);
  ok(back, "the table should deal a fresh match on its own:\n" + dump(w));
  for (const c of w.clients) {
    eq(c.snap().totals, [0, 0, 0, 0], c.id + ": the new table starts level");
    eq(c.snap().counts, [13, 13, 13, 13], c.id + ": fresh hands");
  }
});

test("a guest's rematch request is surfaced to the host", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason);
  w.clients[1].click("playAgainBtn");
  await w.advance(500);
  eq(w.clients[1].el("rematchStatus").textContent, w.clients[1].read('t("rematchWait")'), "the guest is told to wait");
  eq(w.clients[0].el("rematchStatus").textContent, w.clients[0].read('t("rematchWants", "Bob")'), "the host sees who asked");
  eq(w.clients[0].snap().totals.some(t => t > 0), true, "a request alone must not restart the match");
});

test("result reporting: at most one card per match, naming the real winner", async () => {
  for (const n of [2, 3, 4]) {
    const w = await onlineWorld(n);
    await startMatch(w);
    const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
    ok(r.ok, `${n}p: ` + r.reason);
    const s = w.clients[0].snap();
    const champSeat = s.outs.findIndex(o => !o);
    const champId = s.order[champSeat];
    if (champId == null) {
      // A bot took the table: there is no platform identity to file a card for.
      eq(w.server.reports.length, 0, `${n}p: a bot champion files no result card`);
      continue;
    }
    eq(w.server.reports.length, 1, `${n}p: exactly one result card per match`);
    const rep = w.server.reports[0];
    eq(rep.by, "u1", `${n}p: reported by the authority`);
    eq(rep.payload.winnerId, champId, `${n}p: the winner id matches the survivor`);
    if (n > 2) {
      ok(Array.isArray(rep.payload.standings), `${n}p: 3+ humans need standings`);
      eq(rep.payload.standings.length, n, `${n}p: one placement per human`);
      eq(rep.payload.standings[0], champId, "champion first");
      eq(new Set(rep.payload.standings).size, n, "no duplicate placements");
    }
    eq(rep.payload.metric, "penalty points", `${n}p: normal elimination reports penalties`);
    eq(Object.keys(rep.payload.scores).length, n, `${n}p: a score per human, bots excluded`);
  }
});

test("round transitions: the results countdown always lands the next deal", async () => {
  const w = await onlineWorld(4);
  await startMatch(w);
  const r = await playOut(w, { done: () => finished(w), budget: 90 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  ok(w.clients[0].snap().dealEpoch >= 2, "the match ran more than one round");
  for (const c of w.clients) eq(c.snap().dealEpoch, w.clients[0].snap().dealEpoch, c.id + " dealt the same number of rounds");
  const deals = w.room.log.filter(a => a.action_type === "deal");
  const applied = w.clients[0].snap().dealEpoch;
  ok(deals.length >= applied, "each applied round has a stored deal");
});

// ── Chat and identity ─────────────────────────────────────────────────────
test("quick chat pops on the sender's seat and reaches the peers", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const sender = w.clients[1];
  sender.click("chatToggle");
  const emoji = sender.doc.querySelectorAll(".chat-emoji")[2];
  ok(emoji, "the picker is built");
  emoji.dispatch("click");
  await w.advance(300);
  eq(sender.doc.querySelectorAll(".reaction-bubble").length, 1, "the sender sees their own bubble");
  for (const peer of [w.clients[0], w.clients[2]]) {
    eq(peer.doc.querySelectorAll(".reaction-bubble").length, 1, peer.id + " should see the reaction");
  }
  const before = w.clients[0].snap();
  for (let i = 0; i < 5; i++) { emoji.dispatch("click"); }
  await w.advance(300);
  const after = w.clients[0].snap();
  eq(after.turn, before.turn, "chat never touches the turn");
  eq(after.counts, before.counts, "chat never touches the hands");
  eq(consistency(w), null);
});

test("custom quick chat synchronizes typed text without changing the round", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  const sender = w.clients[1];
  const before = sender.snap();
  sender.click("chatToggle");
  sender.doc.querySelectorAll(".chat-custom-toggle")[0].dispatch("click");
  eq(sender.el("customChatForm").hidden, false, "the custom composer opens");
  sender.el("customChatInput").value = "  Сайн   тоглолт!  ";
  sender.el("customChatForm").dispatch("submit");
  await w.advance(300);

  eq(sender.doc.querySelectorAll(".reaction-bubble")[0].textContent, "Сайн тоглолт!", "the sender sees normalized text");
  for (const peer of [w.clients[0], w.clients[2]]) {
    eq(peer.doc.querySelectorAll(".reaction-bubble")[0].textContent, "Сайн тоглолт!", peer.id + " should receive custom text");
  }
  eq(sender.snap().turn, before.turn, "custom chat does not touch the turn");
  eq(sender.snap().counts, before.counts, "custom chat does not touch the hands");
});

test("the chat button is hidden on the connect cover and shown at the table", async () => {
  const w = new World();
  const c = w.add("u1", "Alice", { mode: "multiplayer", roomId: w.roomId });
  c.start({ userId: "u1", userName: "Alice", roomId: w.roomId, playerIds: [] });
  await w.advance(100);
  eq(c.el("chatToggle").classList.contains("show-btn"), false, "hidden while connecting");
  await startMatch(w);
  eq(c.el("chatToggle").classList.contains("show-btn"), true, "shown once the match is on screen");
});

test("profile pictures render on the connect cover and at every human seat", async () => {
  const avatars = ["https://cdn.example/alice.jpg", "https://cdn.example/bob.jpg"];
  const w = await onlineWorld(2, { avatars });
  for (const c of w.clients) {
    const lobbyImages = c.el("lobbyList").querySelectorAll("img");
    eq(lobbyImages.length, 2, c.id + " should see both profile pictures while connecting");
    eq(lobbyImages[0].getAttribute("src"), avatars[0]);
    eq(lobbyImages[1].getAttribute("src"), avatars[1]);
  }

  await startMatch(w);
  for (let i = 0; i < w.clients.length; i++) {
    const c = w.clients[i];
    eq(JSON.stringify(c.snap().avatars), JSON.stringify([avatars[0], avatars[1], null, null]),
       c.id + " should keep every seated avatar and leave bots blank");
    eq(c.el("meAvatar").querySelectorAll("img").length, 1, c.id + " should see their own profile picture");
    eq(c.el("meAvatar").querySelector("img").getAttribute("src"), avatars[i]);
    eq(c.el("opponents").querySelectorAll(".opp-avatar img").length, 1, c.id + " should see the human opponent's picture");
    ok(c.el("meTimer").parentNode.classList.contains("me-profile-timer"), c.id + " should have the timer around their avatar");
    eq(c.el("opponents").querySelectorAll(".opp-profile-timer .opp-timer").length, 3,
       c.id + " should have a timer around all three opponent avatars");
    eq(c.el("opponents").querySelectorAll(".opp-name .opp-timer").length, 0,
       c.id + " should not show a separate timer beside the opponent name");
  }
  eq(JSON.stringify(w.room.state.avatars), JSON.stringify({ u1: avatars[0], u2: avatars[1] }),
     "the reconnect checkpoint should preserve profile pictures, bots aside");
});

if (require.main === module) run("ONLINE").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("ONLINE") };
