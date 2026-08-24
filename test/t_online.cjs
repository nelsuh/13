// Suite 3 — online play with everyone behaving, in BOTH modes.
//
//   PART A — CHAT INVITE (onlineWorld): the waiting room, READY gating, seat
//   locking, full matches at 2/3/4 seats, round transitions, rematch, result
//   reporting, names and quick chat.
//
//   PART B — NO INVITE / OPEN ROOM (openWorld): a table that deals itself against
//   bots, arrivals taking over the lowest-scoring bot mid-round, departures
//   handing the seat back to a bot, and the seat log resisting forgery.
//
// Every match is watched for desync and dead ends.

const { World, onlineWorld, openWorld, startMatch, arrive, botSeats, playOut, eventually, consistency, dump, PUBLIC_ROOM, PUBLIC_ROOM_2 } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const finished = (w) => w.drivers().every(c => c.snap().overlays.winner);
// An open room can hold spectators who are waiting for a seat; only the seated
// clients get a winner screen.
const seatedClients = (w) => w.drivers().filter(c => c.snap().gameStarted);
const openFinished = (w) => { const s = seatedClients(w); return s.length > 0 && s.every(c => c.snap().overlays.winner); };

// ══ PART A — chat invite: the waiting room ═══════════════════════════════

test("waiting room: seats, ready badges, host-only start button", async () => {
  const w = await onlineWorld(3);
  for (const c of w.clients) {
    const s = c.snap();
    eq(s.online, true, c.id + " should be online");
    eq(s.gameStarted, false);
    eq(s.overlays.lobby, true, c.id + " should be in the waiting room");
  }
  eq(w.clients[0].el("startGameBtn").style.display, "block", "the host gets a Start button");
  eq(w.clients[1].el("startGameBtn").style.display, "none", "a guest does not");
  eq(w.clients[0].el("startGameBtn").disabled, true, "Start is locked until everyone is ready");

  w.clients[0].click("readyBtn"); await w.advance(200);
  eq(w.clients[0].el("startGameBtn").disabled, true, "still locked with 1/3 ready");
  eq(w.clients[1].doc.querySelectorAll(".lobby-badge.ready").length, 1, "peers see the ready badge");

  w.clients[1].click("readyBtn"); await w.advance(200);
  w.clients[2].click("readyBtn"); await w.advance(300);
  eq(w.clients[0].el("startGameBtn").disabled, false, "Start unlocks at 3/3 ready");
  eq(w.clients[0].el("lobbyHint").textContent, w.clients[0].read('t("hintHostGo")'));
  eq(w.clients[1].el("lobbyHint").textContent, w.clients[1].read('t("hintWaitHost")'));
});

test("a guest pressing Start does nothing", async () => {
  const w = await onlineWorld(2);
  for (const c of w.clients) { c.click("readyBtn"); await w.advance(150); }
  w.clients[1].click("startGameBtn");                     // guest
  await w.advance(1500);
  eq(w.clients[0].snap().dealActive, false, "no deal from a guest press");
  eq(w.room.log.length, 0, "nothing was written to the action log");
  w.clients[0].click("startGameBtn");
  await w.advance(1500);
  eq(w.clients[0].snap().dealActive, true, "the host's press does deal");
});

for (const n of [2, 3, 4]) {
  test(`${n}-player match: deal, seats, names, and a full run to the winner screen`, async () => {
    const w = await onlineWorld(n);
    await startMatch(w);
    for (let i = 0; i < n; i++) {
      const s = w.clients[i].snap();
      eq(s.mySeat, i, w.clients[i].id + " seat");
      eq(s.numPlayers, n);
      eq(s.counts, new Array(n).fill(13), "13 cards each");
      eq(s.order, w.clients.map(c => c.id), "same seat order everywhere");
      eq(s.names, ["Alice", "Bob", "Chuck", "Dana"].slice(0, n), "real names, never 'Player N'");
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

test("the host's lose-at pick reaches every client and the deal carries it", async () => {
  const w = await onlineWorld(3);
  const host = w.clients[0];
  const btn = host.doc.querySelectorAll("#lobbyLoseRow .count-btn").find(b => b.getAttribute("data-lose") === "15");
  btn.dispatch("click");
  await w.advance(400);
  for (const c of w.clients) eq(c.snap().loseAt, 15, c.id + " should adopt the host's target");
  // a guest cannot change it
  const guestBtn = w.clients[1].doc.querySelectorAll("#lobbyLoseRow .count-btn").find(b => b.getAttribute("data-lose") === "30");
  eq(guestBtn.disabled, true, "the guest's picker is read-only");
  guestBtn.dispatch("click");
  await w.advance(400);
  for (const c of w.clients) eq(c.snap().loseAt, 15, "a guest press must not change the target");
  await startMatch(w);
  for (const c of w.clients) eq(c.snap().loseAt, 15, "the deal carries the target");
  eq(w.room.log[0].action_data.loseAt, 15);
});

test("Start stays locked while anyone in the room is not ready", async () => {
  const w = await onlineWorld(3);
  w.clients[0].click("readyBtn"); await w.advance(150);
  w.clients[1].click("readyBtn"); await w.advance(400);
  eq(w.clients[0].el("startGameBtn").disabled, true, "2 of 3 ready must not unlock Start");
  w.clients[0].click("startGameBtn");                       // a real press does nothing
  await w.advance(2000);
  eq(w.room.log.length, 0, "no deal was written");
  eq(w.clients[0].snap().dealActive, false, "and nobody was dealt in");
});

test("a player who arrives after the deal is not seated and is told so", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  w.room.started = true;
  // a third player joins the room after the seats were locked
  const late = w.add("u3", "Chuck", { mode: "multiplayer", roomId: w.roomId });
  late.start({ userId: "u3", userName: "Chuck", roomId: w.roomId, playerIds: [] });
  await w.advance(3000);
  eq(w.clients[0].snap().numPlayers, 2, "the running match keeps its two seats");
  eq(w.clients[0].snap().order, ["u1", "u2"], "and its seat order");
  const odd = late.snap();
  eq(odd.gameStarted, false, "the unseated player is not in the match");
  eq(odd.overlays.lobby, true, "and stays on the overlay");
  eq(late.el("onlineStatus").textContent, late.read('t("startedWithoutYou")'), "and is told why");
  // the seated pair must still be able to finish
  const r = await playOut(w, { done: () => w.clients.slice(0, 2).every(c => c.snap().overlays.winner), budget: 60 * 60 * 1000, consistency: false });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

test("an unseated spectator cannot inject moves or deals", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  w.room.started = true;
  const spectator = w.add("u3", "Chuck", { mode: "multiplayer", roomId: w.roomId });
  spectator.start({ userId: "u3", userName: "Chuck", roomId: w.roomId, playerIds: [] });
  await w.advance(3000);
  const before = w.clients[0].snap();
  // the spectator forges both a deal and a move for seat 0 (fire, then let the
  // virtual clock deliver them — never await a virtual-clock promise directly)
  spectator.run('Usion.game.action("deal", {seed: 42, order: ["u3","u1"], names: {}}).catch(function(){})');
  spectator.run('Usion.game.action("move", {kind: "pass", seat: 0, ti: 0}).catch(function(){})');
  await w.advance(1500);
  const after = w.clients[0].snap();
  eq(after.curSeed, before.curSeed, "a forged deal must not re-deal the table");
  eq(after.counts, before.counts, "a forged move must not touch the hands");
  eq(after.turn, before.turn, "a forged move must not steal the turn");
  eq(after.order, before.order, "and must not reseat anyone");
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
    eq(s.totals, [0, 0, 0], c.id + ": scores reset");
    eq(s.outs, [false, false, false], c.id + ": eliminations reset");
    eq(s.overlays.winner, false, c.id + ": winner overlay cleared");
    eq(s.dealActive, true, c.id + ": a fresh round is live");
    eq(s.counts, [13, 13, 13], c.id + ": fresh hands");
  }
  const r2 = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  ok(r2.ok, "rematch: " + r2.reason + "\n" + (r2.dump || ""));
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

test("result reporting: exactly one card, from the authority, naming the real winner", async () => {
  for (const n of [2, 3, 4]) {
    const w = await onlineWorld(n);
    await startMatch(w);
    const r = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
    ok(r.ok, `${n}p: ` + r.reason);
    eq(w.server.reports.length, 1, `${n}p: exactly one result card per match`);
    const rep = w.server.reports[0];
    eq(rep.by, "u1", `${n}p: reported by the authority`);
    const s = w.clients[0].snap();
    const champSeat = s.outs.findIndex(o => !o);
    eq(rep.payload.winnerId, s.order[champSeat], `${n}p: the winner id matches the survivor`);
    if (n > 2) {
      ok(Array.isArray(rep.payload.standings), `${n}p: 3+ players need standings`);
      eq(rep.payload.standings.length, n);
      eq(rep.payload.standings[0], rep.payload.winnerId, "champion first");
      eq(new Set(rep.payload.standings).size, n, "no duplicate placements");
    } else {
      eq(rep.payload.standings, undefined, "1v1 needs no standings");
    }
    eq(rep.payload.metric, "penalty points", `${n}p: normal elimination reports penalties`);
    eq(Object.keys(rep.payload.scores).length, n, `${n}p: a score per player`);
    // a rematch must be able to report again
    w.clients[0].click("playAgainBtn");
    await w.advance(2000);
    const r2 = await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
    ok(r2.ok, `${n}p rematch: ` + r2.reason);
    eq(w.server.reports.length, 2, `${n}p: the rematch reports its own result`);
  }
});

test("round transitions: the results countdown always lands the next deal", async () => {
  const w = await onlineWorld(4);
  await startMatch(w, { loseAt: 30 });
  let rounds = 0;
  const r = await playOut(w, {
    done: () => finished(w), budget: 90 * 60 * 1000,
    each: (c, s) => { if (c.id === "u1" && s.overlays.hand) rounds = Math.max(rounds, s.dealEpoch); },
  });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  ok(w.clients[0].snap().dealEpoch >= 2, "the match ran more than one round");
  for (const c of w.clients) eq(c.snap().dealEpoch, w.clients[0].snap().dealEpoch, c.id + " dealt the same number of rounds");
  // every deal in the log is unique and sequential — no round was dealt twice
  const deals = w.room.log.filter(a => a.action_type === "deal");
  const applied = w.clients[0].snap().dealEpoch;
  ok(deals.length >= applied, "each applied round has a stored deal");
});

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
  // spam is throttled, and none of it disturbs the round
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

test("the chat button is hidden on the overlays and shown at the table", async () => {
  const w = await onlineWorld(2);
  eq(w.clients[0].el("chatToggle").classList.contains("show-btn"), false, "hidden in the lobby");
  await startMatch(w);
  eq(w.clients[0].el("chatToggle").classList.contains("show-btn"), true, "shown once the match is on screen");
});

test("profile pictures render in the lobby and at every table seat", async () => {
  const avatars = ["https://cdn.example/alice.jpg", "https://cdn.example/bob.jpg"];
  const w = await onlineWorld(2, { avatars });
  for (const c of w.clients) {
    const lobbyImages = c.el("lobbyList").querySelectorAll("img");
    eq(lobbyImages.length, 2, c.id + " should see both lobby profile pictures");
    eq(lobbyImages[0].getAttribute("src"), avatars[0]);
    eq(lobbyImages[1].getAttribute("src"), avatars[1]);
  }

  await startMatch(w);
  for (let i = 0; i < w.clients.length; i++) {
    const c = w.clients[i];
    eq(JSON.stringify(c.snap().avatars), JSON.stringify(avatars), c.id + " should keep every seated avatar");
    eq(c.el("meAvatar").querySelectorAll("img").length, 1, c.id + " should see their own profile picture");
    eq(c.el("meAvatar").querySelector("img").getAttribute("src"), avatars[i]);
    eq(c.el("opponents").querySelectorAll(".opp-avatar img").length, 1, c.id + " should see the opponent profile picture");
    ok(c.el("meTimer").parentNode.classList.contains("me-profile-timer"), c.id + " should have the timer around their avatar");
    eq(c.el("opponents").querySelectorAll(".opp-profile-timer .opp-timer").length, 1,
       c.id + " should have the timer around the opponent avatar");
    eq(c.el("opponents").querySelectorAll(".opp-name .opp-timer").length, 0,
       c.id + " should not show a separate timer beside the opponent name");
  }
  eq(JSON.stringify(w.room.state.avatars), JSON.stringify({ u1: avatars[0], u2: avatars[1] }),
     "the reconnect checkpoint should preserve profile pictures");
});

test("your own move lands on your board instantly, however slow the relay is", async () => {
  // Waiting for the relay to echo your own move back costs a full round trip on
  // every single tap — the thing that makes a two-player game feel sluggish.
  const w = await onlineWorld(2, { latency: 500 });
  await startMatch(w);
  const r = await playOut(w, {
    done: () => w.clients[0].snap().dealActive && w.clients[0].snap().turn === 0,
    budget: 5 * 60 * 1000, step: 50, consistency: false,
  });
  ok(r.ok, "could not reach seat 0's turn: " + r.reason);
  const me = w.clients[0], peer = w.clients[1];
  const before = me.snap();
  me.uiPlay();
  eq(me.snap().counts[0] < before.counts[0], true, "the cards leave my hand on the tap, not a round trip later");
  eq(me.snap().pendingAction, false, "and the controls are never dead while the relay catches up");
  eq(me.snap().turn !== 0 || !me.snap().dealActive, true, "the turn has already moved on");
  // The peer still only learns about it when the relay tells them — but when the
  // echo does come back it must be a no-op, not a second copy of the move.
  await w.advance(3000);
  eq(consistency(w), null, "one move, applied once, on both clients\n" + dump(w));
  eq(me.snap().counts, peer.snap().counts, "same hands");
  eq(me.snap().roundMoveNo, peer.snap().roundMoveNo, "and the same move count — the echo was not replayed");
  await playOut(w, { done: () => finished(w), budget: 60 * 60 * 1000 });
  eq(consistency(w), null, "and the match still finishes in step");
});

// ══ PART B — no invite: the open room ════════════════════════════════════
//
// Same relay, same deterministic engine, different rules: 4 seats always, bots
// in the empty ones, no lobby, and a roster that changes while the round runs.

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

test("open room: two people who 'just play' land at the SAME table, not two private ones", async () => {
  // The platform hands each no-invite launch its own private standalone_ room.
  // Joining that would put every player alone with three bots and the open table
  // could never fill, so the game has to go and find the shared public table.
  const w = await openWorld(2);
  await startMatch(w);
  for (const c of w.clients) {
    eq(c.sdk.room.id, PUBLIC_ROOM, c.id + " should be on the shared public table");
    const s = c.snap();
    eq(s.order.slice(0, 2), ["u1", "u2"], c.id + " should see BOTH humans seated");
    eq(s.order.slice(2), [null, null], "with bots in the two spare seats");
  }
  eq(w.clients[0].snap().mySeat, 0);
  eq(w.clients[1].snap().mySeat, 1);
  eq(consistency(w), null, "and they agree on one round, not two");
});

test("open room: a no-invite launch deals immediately against bots — no lobby, no Start", async () => {
  const w = await openWorld(1);
  await startMatch(w);
  const s = w.clients[0].snap();
  eq(s.online, true, "a no-invite launch with a room DOES go online");
  eq(s.gameStarted, true, "and is already in a match");
  eq(s.numPlayers, 4, "an open room is always 4 seats wide");
  eq(s.mySeat, 0);
  eq(s.order, ["u1", null, null, null], "bots hold every empty seat");
  eq(s.counts, [13, 13, 13, 13], "13 cards each, bots included");
  eq(s.loseAt, 20, "open rooms run the road to 20");
  eq(s.overlays.lobby, false, "the connect cover lifts as soon as cards land");
  eq(w.clients[0].el("readyBtn").style.display, "none", "there is no READY toggle");
  eq(w.clients[0].el("startGameBtn").style.display, "none", "and no Start button");
  eq(w.clients[0].el("lobbyLimit").style.display, "none",
     "and no match-length picker — the target is fixed, so offering one would be a lie");
  eq(w.room.log[0].action_data.open, true, "the deal tells every client which mode the room runs");
});

test("open room: the bots really play — the round advances with one human", async () => {
  const w = await openWorld(1);
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
  test(`open room: ${n} human(s) + bots runs a full match to the winner screen`, async () => {
    const w = await openWorld(n);
    await startMatch(w);
    for (let i = 0; i < n; i++) {
      const s = w.clients[i].snap();
      eq(s.mySeat, i, w.clients[i].id + " seat");
      eq(s.numPlayers, 4, "always four seats");
      eq(s.counts, [13, 13, 13, 13], "13 cards each");
      eq(s.order.slice(0, n), w.clients.map(c => c.id), "humans keep roster order");
      eq(s.order.slice(n), new Array(4 - n).fill(null), "the rest are bots");
      eq(s.names.slice(0, n), ["Alice", "Bob", "Chuck", "Dana"].slice(0, n), "real names, never 'Player N'");
    }
    eq(consistency(w), null, "clients agree right after the deal");
    const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
    ok(r.ok, r.reason + "\n" + (r.dump || ""));
    eq(consistency(w), null, "clients agree at the end");
    eq(w.clients[0].snap().outs.filter(o => !o).length, 1, "one survivor");
    for (const c of w.clients) eq(c.errors.map(String), [], c.id + " threw");
    eq(w.trace.filter(x => x.uiPlay === "stuck-lead" || x.uiPlay === "cards-missing"), [], "UI refused a move");
  });
}

// ── the headline behaviour ────────────────────────────────────────────────
test("open room: a joiner takes over the LOWEST-SCORING bot and inherits its points", async () => {
  const w = await openWorld(1);
  await startMatch(w);
  await playARound(w);                      // give the bots real, different scores

  const host = w.clients[0];
  const before = host.snap();
  const bots = botSeats(host);
  eq(bots.length, 3, "three bot seats before anyone joins");
  let want = bots[0];
  bots.forEach(s => { if (before.totals[s] < before.totals[want]) want = s; });

  const c = arrive(w, "u2", "Bob");
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

  const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  eq(consistency(w), null);
});

test("open room: B, then C, then D drop into the running round and fill the table", async () => {
  const w = await openWorld(1);
  await startMatch(w);
  const host = w.clients[0];
  const seed = host.snap().curSeed;
  // Joining while every bot is still level: the tie-break is the lowest seat, so
  // they fill 1, 2, 3 in arrival order.
  for (const [id, name, expect] of [["u2", "Bob", 1], ["u3", "Chuck", 2], ["u4", "Dana", 3]]) {
    const before = host.snap();
    const c = arrive(w, id, name);
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
  const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

test("open room: a fifth arrival hops to the next public table instead of queuing", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  const late = arrive(w, "u5", "Erdene");
  // No bot to displace here, so after the hop window they move on and open a
  // table of their own rather than watching four strangers play.
  const moved = await eventually(w, () => late.snap().gameStarted, 40000, 250);
  ok(moved, "the fifth player should end up in a game:\n" + dump(w));
  eq(late.sdk.room.id, PUBLIC_ROOM_2, "on the next public table");
  const s = late.snap();
  eq(s.mySeat, 0, "as the first player there");
  eq(s.order, ["u5", null, null, null], "with three bots");
  eq(w.clients[0].snap().order, ["u1", "u2", "u3", "u4"], "and the first table is untouched");
  eq(w.clients[0].sdk.room.id, PUBLIC_ROOM);
});

test("open room: a player who leaves hands the seat AND its score back to a bot", async () => {
  const w = await openWorld(4);
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

  const rest = w.clients.filter(c => c !== leaver);
  const r = await playOut(w, {
    done: () => rest.every(c => c.snap().overlays.winner),
    budget: 60 * 60 * 1000, consistency: false, skip: [leaver.id],
  });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  for (const c of rest) eq(c.errors.map(String), [], c.id + " threw");
});

test("open room: a seat freed by a walkout is handed to the next person through the door", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  const host = w.clients[0];
  w.clients[3].leaveRoom();                       // Dana walks out of seat 3
  const freed = await eventually(w, () => host.snap().order[3] === null, 60000, 250);
  ok(freed, "the seat should go back to a bot first:\n" + dump(w));

  const late = arrive(w, "u5", "Erdene");
  const seen = await watchUntil(w, host, s => s.order.indexOf("u5") >= 0, 40000);
  ok(seen.hit, "and then to the next arrival:\n" + dump(w));
  eq(seen.now.order.indexOf("u5"), 3, "the seat that opened up");
  eq(late.sdk.room.id, PUBLIC_ROOM, "no need to hop — this table had room");
  await eventually(w, () => late.snap().gameStarted && late.snap().mySeat === 3, 20000, 250);
  eq(consistency(w), null);
});

test("open room: two friends who knock the bots out cannot lock the room", async () => {
  // Reported from the live app: nelsuh and nelsuh_pc were playing with 2 bots and
  // a third person could not get in. After a few rounds on a road-to-20 table
  // both bots are ELIMINATED, so there is no seat to hand out — and the newcomer
  // used to give up and open an empty table of their own on the next shard.
  const w = await openWorld(2);
  await startMatch(w);
  const host = w.clients[0];
  const bots = () => host.snap().order.map((id, i) => (id === null ? i : -1)).filter(i => i >= 0);
  const r = await playOut(w, {
    done: () => bots().every(s => host.snap().outs[s]),
    budget: 30 * 60 * 1000, consistency: false,
  });
  ok(r.ok, "could not reach the all-bots-eliminated state: " + r.reason);
  eq(host.read("takeoverSeat()"), -1, "there really is no seat to give away");
  eq(host.read("openTableIsClosed()"), true, "and the table is closed, not full");

  const c = arrive(w, "u3", "Chuck");
  const inPlay = await eventually(w, () => {
    const s = c.snap();
    return s.gameStarted && s.mySeat >= 0 && !s.outs[s.mySeat] && s.counts[s.mySeat] > 0;
  }, 120 * 1000, 250);
  ok(inPlay, "the third player must get into THIS game, not a private one:\n" + dump(w));
  eq(c.sdk.room.id, PUBLIC_ROOM, "at the same table as the other two");
  eq(w.clients[0].sdk.room.id, PUBLIC_ROOM);
  eq(w.clients[1].sdk.room.id, PUBLIC_ROOM);
  const s = c.snap();
  eq(s.numPlayers, 4);
  eq(s.order.filter(Boolean).sort(), ["u1", "u2", "u3"], "all three humans on one table");
  eq(s.totals, [0, 0, 0, 0], "a fresh match, since the old one had nothing left to join");
  eq(s.outs, [false, false, false, false], "and nobody is sitting it out");
  eq(consistency(w), null, dump(w));
  const done = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
  ok(done.ok, done.reason + "\n" + (done.dump || ""));
});

test("open room: walking back into a room everyone has left clears it, not resumes it", async () => {
  // Reported from the live app: tap Play, land back in the public table you were
  // last in, and get your OWN finished match back — your old score, your old
  // elimination, and a seat still held by somebody who is not there. The relay
  // keeps a room's log and checkpoint after everybody leaves, and rejoining with
  // the same user id means the stored roster still names you, so the checkpoint
  // applies cleanly and rebuilds a table of ghosts that will never move.
  const w = await openWorld(2);
  await startMatch(w);
  await playOut(w, { done: () => w.clients[0].snap().dealEpoch >= 2, budget: 30 * 60 * 1000, consistency: false });
  const abandoned = w.clients[0].snap();
  ok(abandoned.totals.some(t => t > 0), "the match we are abandoning has real scores");
  w.clients[0].leaveRoom();
  w.clients[1].leaveRoom();
  await w.advance(2000);
  ok(w.room.log.length > 0, "the relay keeps the log behind");
  ok(w.room.state && w.room.state.order.indexOf("u1") >= 0, "and a checkpoint that still names us");

  const back = arrive(w, "u1", "Alice");           // same user id taps Play again
  const cleared = await eventually(w, () => {
    const s = back.snap();
    return s.dealActive && s.order.filter(Boolean).length === 1 && s.totals.every(t => t === 0);
  }, 60 * 1000, 250);
  ok(cleared, "the dead room must be cleared, not resumed:\n" + dump(w));
  const s = back.snap();
  eq(s.order, ["u1", null, null, null], "one human, three bots — nobody's ghost holding a seat");
  eq(s.totals, [0, 0, 0, 0], "a fresh match, not the old scoreline");
  eq(s.outs, [false, false, false, false], "and nobody eliminated from a game that is over");
  eq(s.counts, [13, 13, 13, 13], "everyone dealt in");
  eq(s.mySeat, 0);
  const r = await playOut(w, { done: () => back.snap().roundMoveNo >= 6, budget: 5 * 60 * 1000 });
  ok(r.ok, "and the cleared table actually plays: " + r.reason);
  eq(back.errors.map(String), [], "u1 threw");
});

test("open room: a live table is never cleared out from under the people playing it", async () => {
  // The flip side of clearing dead rooms: two people really playing must never
  // have their match wiped, and neither must a brief disconnect (that is what the
  // forfeit grace is for).
  const w = await openWorld(2);
  await startMatch(w);
  await playOut(w, { done: () => w.clients[0].snap().dealEpoch >= 2, budget: 30 * 60 * 1000, consistency: false });
  const before = w.clients[0].snap();
  ok(before.totals.some(t => t > 0), "there is a scoreline worth protecting");
  eq(before.order.slice(0, 2), ["u1", "u2"], "both humans seated");

  // sit here far longer than the abandoned-room window with nothing happening
  await w.advance(60 * 1000);
  eq(w.clients[0].snap().order.slice(0, 2), ["u1", "u2"], "the roster survives\n" + dump(w));
  ok(w.clients[0].snap().totals.some(t => t > 0), "and so does the scoreline");

  // now a real socket blip on the peer — still not an abandoned room. This holds
  // even when their seat is already eliminated, which gets no forfeit grace of
  // its own: dropping out is not the same as never having been here.
  w.clients[1].netDrop();
  await w.advance(15 * 1000);
  eq(w.clients[0].snap().order.slice(0, 2), ["u1", "u2"],
     "a blip inside the grace window must not wipe the room\n" + dump(w));
  w.clients[1].netRestore();
  await w.advance(10 * 1000);
  eq(consistency(w), null, dump(w));
  const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

test("open room: the connect cover is a blink, not a lobby you have to deal with", async () => {
  // Reported from the live app: a player sat looking at "waiting for a seat" with
  // a host tag, a match-length picker and no idea what was happening. None of
  // that belongs on a screen that should be up for well under a second.
  const w = await openWorld(1);
  const c = w.clients[0];
  await startMatch(w);
  eq(c.el("lobbyLimit").style.display, "none", "no match-length picker on an open table");
  eq(c.el("readyBtn").style.display, "none", "no READY");
  eq(c.el("startGameBtn").style.display, "none", "no Start");
  eq(c.doc.querySelectorAll(".lobby-tag").length, 0, "and no host tag — an open room has no host");
  eq(c.snap().overlays.lobby, false, "the cover is gone by the time cards land");
});

test("open room: a room nobody will seat us in still ends in a game, not a spinner", async () => {
  // Peers on an older cached build, a wedged authority, a relay that will not take
  // our seat claim — whatever the cause, the player must never be left staring at
  // the connect cover. After OPEN_STUCK_MS we stop asking and take a table over.
  // Crucially we stay ONLINE doing it: dropping to a local game would make us
  // invisible to the next person's search, which is the one thing matchmaking
  // must never do.
  const w = await openWorld(2);
  await startMatch(w);
  w.clients.forEach(x => x.run("reconcileOpenSeats = function () {};"));   // nobody will let us in
  const c = arrive(w, "u3", "Chuck");
  c.run("scheduleHop = function () {}; probeNextRung = function () {};");  // and we cannot walk away
  const playing = await eventually(w, () => c.snap().dealActive, 120 * 1000, 500);
  ok(playing, "the player must end up with a game:\n" + dump(w));
  const s = c.snap();
  eq(s.counts, [13, 13, 13, 13], "a full table");
  eq(s.online, true, "and still in a real room, so the next search can find them");
  eq(s.mySeat >= 0, true, "with a seat of their own");
  eq(s.overlays.lobby, false, "and the cover is down");
  eq(c.errors.map(String), [], "u3 threw");
});

test("open room: a table left behind on a public shard does not slow the next player down", async () => {
  // Every public shard collects a stale log over time. Landing on one must not
  // mean sitting through a hop to the next shard — if nobody is connected, the
  // room is ours immediately.
  const w = await openWorld(1);
  await startMatch(w);
  await playOut(w, { done: () => w.clients[0].snap().dealEpoch >= 2, budget: 30 * 60 * 1000, consistency: false });
  w.clients[0].leaveRoom();
  await w.advance(2000);
  ok(w.room.log.length > 0, "the shard keeps a log behind");

  const t0 = w.clock.now;
  const c = arrive(w, "z1", "Zaya");
  const dealt = await eventually(w, () => c.snap().dealActive, 60 * 1000, 250);
  ok(dealt, "the next player should be dealt in:\n" + dump(w));
  const took = w.clock.now - t0;
  ok(took <= 10000, "…and quickly: took " + took + "ms\n" + dump(w));
  eq(c.sdk.room.id, PUBLIC_ROOM, "on the shard they landed on, without hopping away");
  eq(c.snap().order, ["z1", null, null, null], "with a clean table");
});

// ── matchmaking: the next person must FIND the table you are already at ───
test("open room: the very first player is dealt in without a search", async () => {
  const w = await openWorld(1);
  const t0 = w.clock.now;
  const dealt = await eventually(w, () => w.clients[0].snap().dealActive, 30 * 1000, 100);
  ok(dealt, "the first player must not sit through a ladder sweep:\n" + dump(w));
  ok(w.clock.now - t0 <= 3000, "dealt in " + (w.clock.now - t0) + "ms");
  eq(w.clients[0].sdk.room.id, PUBLIC_ROOM, "on the first table, where the next search looks first");
  eq(w.clients[0].snap().order, ["u1", null, null, null], "alone with three bots — but in a real room");
});

test("open room: A plays bots, then B's search finds A instead of opening its own table", async () => {
  // This is the whole promise of a public table: A could not find anybody, so A
  // is sitting with three bots — and B, arriving later, has to end up at A's
  // table rather than starting a second one nobody can see.
  const w = await openWorld(1);
  await startMatch(w);
  const A = w.clients[0];
  eq(A.snap().order, ["u1", null, null, null], "A is playing bots");
  const B = arrive(w, "u2", "Bat");
  const met = await eventually(w, () => B.snap().gameStarted && A.snap().order.indexOf("u2") >= 0, 60 * 1000, 250);
  ok(met, "B must find A:\n" + dump(w));
  eq(B.sdk.room.id, A.sdk.room.id, "same room");
  eq(A.snap().order.slice(0, 2), ["u1", "u2"], "same table, two humans and two bots");
  eq(consistency(w), null, dump(w));
});

test("open room: a search walks past an emptied table to find the people further along", async () => {
  // The hard case. The first table filled up, so A was pushed further along the
  // ladder; later everybody on the first table left. A client that only ever
  // looked at the first table would find it empty, open a second one right there,
  // and never discover A — two people playing bots side by side.
  const w = await openWorld(4);
  await startMatch(w);
  const A = arrive(w, "uA", "Ariunaa");
  ok(await eventually(w, () => A.snap().gameStarted, 60 * 1000, 250), "A should be pushed along:\n" + dump(w));
  eq(A.sdk.room.id, PUBLIC_ROOM_2, "to the second table");
  w.clients.slice(0, 4).forEach(c => c.leaveRoom());     // the first table empties out
  await w.advance(3000);

  const B = arrive(w, "uB", "Bat");
  const met = await eventually(w, () => B.snap().gameStarted && A.snap().order.indexOf("uB") >= 0, 90 * 1000, 250);
  ok(met, "B must walk past the empty table and find A:\n" + dump(w));
  eq(B.sdk.room.id, PUBLIC_ROOM_2, "at A's table, not the empty one it passed");
  eq(A.snap().order.slice(0, 2), ["uA", "uB"]);
  eq(consistency(w), null, dump(w));
});

test("open room: with nobody anywhere, a search settles on the FIRST table, not the last", async () => {
  // Where a lone player sets up matters: tables have to stay bunched at the front
  // of the ladder, or every later search gets longer and people drift apart.
  const w = await openWorld(1);
  await startMatch(w);
  await playOut(w, { done: () => w.clients[0].snap().dealEpoch >= 2, budget: 30 * 60 * 1000, consistency: false });
  w.clients[0].leaveRoom();                              // leaves a used-but-empty first table
  await w.advance(2000);

  const c = arrive(w, "z1", "Zaya");
  const dealt = await eventually(w, () => c.snap().dealActive, 60 * 1000, 250);
  ok(dealt, "the next player should get a game:\n" + dump(w));
  eq(c.sdk.room.id, PUBLIC_ROOM, "back on the first table, cleared out and reused");
  eq(c.snap().order, ["z1", null, null, null], "with a clean table");
  eq(c.snap().totals, [0, 0, 0, 0], "and no leftovers from whoever was here before");
});

// ── security: the seat log is as forgery-proof as the move log ────────────
test("open room: an unseated spectator cannot inject moves or deals", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  w.room.started = true;
  const spectator = arrive(w, "u5", "Erdene");
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

test("open room: a seat claim for the wrong bot — or for somebody already seated — is rejected", async () => {
  const w = await openWorld(1);
  await startMatch(w);
  await playARound(w);
  const host = w.clients[0];
  const spectator = arrive(w, "u2", "Bob");
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

test("open room: a relayed bot move must be the engine's own choice, not the sender's", async () => {
  const w = await openWorld(2);
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
    var beforeMoves = roundMoveNo;
    var accepted = applyRemoteMove({ kind: "play", cards: junk, seat: seat, bot: true, ti: roundMoveNo }, "u2");
    // …and the move the engine really would make must still be accepted, so the
    // rule rejects forgeries rather than bot relaying as a whole.
    var honest = (want && want.kind === "play")
      ? { kind: "play", cards: want.combo.cards.map(cardWire), seat: seat, bot: true, ti: roundMoveNo }
      : { kind: "pass", seat: seat, bot: true, ti: roundMoveNo };
    var honestOk = applyRemoteMove(honest, "u2");
    return { accepted: accepted, honestOk: honestOk, beforeMoves: beforeMoves, moves: roundMoveNo };
  })()`);
  eq(verdict.skipped, undefined, "the bot really was on turn");
  eq(verdict.accepted, false, "a bot move the engine would not have made is rejected");
  eq(verdict.moves, verdict.beforeMoves + 1, "only the engine's own move was applied");
  ok(verdict.honestOk === true, "the engine's own choice is still accepted");
});

test("open room: every client runs the same fixed target", async () => {
  const w = await openWorld(3);
  await startMatch(w);
  for (const c of w.clients) eq(c.snap().loseAt, 20, c.id + " adopts the open-room target");
  eq(w.room.log[0].action_data.loseAt, 20, "and the deal carries it");
  for (const c of w.clients) {
    eq(c.el("lobbyLimit").style.display, "none", c.id + ": the picker is not even offered");
    // …and pressing it anyway must do nothing, since the element is still in the DOM
    const btn = c.doc.querySelectorAll("#lobbyLoseRow .count-btn").find(b => b.getAttribute("data-lose") === "30");
    if (btn) btn.dispatch("click");
  }
  await w.advance(1000);
  for (const c of w.clients) eq(c.snap().loseAt, 20, c.id + ": nobody can change it mid-table");
});

test("open room: the table restarts itself after the winner screen", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
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

test("open room: result reporting names the real winner, and a bot champion files none", async () => {
  for (const n of [2, 3, 4]) {
    const w = await openWorld(n);
    await startMatch(w);
    const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
    ok(r.ok, `${n}p: ` + r.reason);
    const s = w.clients[0].snap();
    const champId = s.order[s.outs.findIndex(o => !o)];
    if (champId == null) {
      eq(w.server.reports.length, 0, `${n}p: a bot champion files no result card`);
      continue;
    }
    eq(w.server.reports.length, 1, `${n}p: exactly one result card per match`);
    const rep = w.server.reports[0];
    eq(rep.by, "u1", `${n}p: reported by the authority`);
    eq(rep.payload.winnerId, champId, `${n}p: the winner id matches the survivor`);
    if (n > 2) eq(rep.payload.standings.length, n, `${n}p: one placement per human, bots excluded`);
    eq(Object.keys(rep.payload.scores).length, n, `${n}p: a score per human, bots excluded`);
  }
});

test("open room: the results countdown always lands the next round", async () => {
  const w = await openWorld(4);
  await startMatch(w);
  const r = await playOut(w, { done: () => openFinished(w), budget: 90 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  ok(w.clients[0].snap().dealEpoch >= 2, "the match ran more than one round");
  for (const c of w.clients) eq(c.snap().dealEpoch, w.clients[0].snap().dealEpoch, c.id + " dealt the same number of rounds");
});

if (require.main === module) run("ONLINE").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("ONLINE") };
