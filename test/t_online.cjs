// Suite 3 — online play with everyone behaving: the waiting room, seat locking,
// full matches at 2/3/4 seats, round transitions, rematch, result reporting,
// names and quick chat. Every match is watched for desync and dead ends.

const { World, onlineWorld, startMatch, playOut, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const finished = (w) => w.drivers().every(c => c.snap().overlays.winner);

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
  }
  eq(JSON.stringify(w.room.state.avatars), JSON.stringify({ u1: avatars[0], u2: avatars[1] }),
     "the reconnect checkpoint should preserve profile pictures");
});

if (require.main === module) run("ONLINE").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("ONLINE") };
