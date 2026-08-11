// Suite 2 — solo / offline play: the GameTok zero-tap launch, the setup screen
// for every player count and every lose-at target, the hand-over overlay's two
// buttons, rematch, and the turn clock.

const { World, playOut, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

function soloWorld(id, launch) {
  const w = new World();
  const c = w.add(id, "Alice", launch || { mode: "single", roomId: "standalone_a" });
  return { w, c };
}

async function bootSolo(id) {
  const { w, c } = soloWorld(id);
  c.start({ userId: id, userName: "Alice", roomId: "standalone_a", playerIds: [id] });
  await w.advance(1000);
  return { w, c };
}

/** Boot with no launch config at all (the plain setup screen) and press START. */
async function bootSetup(id, players, loseAt) {
  const w = new World();
  const c = w.add(id, "Alice", { mode: "single" });
  // No Usion.init callback fired: the game sits on its setup overlay, exactly
  // like the standalone/no-SDK preview.
  await w.advance(50);
  ok(c.el("setupOverlay").classList.contains("show"), "setup overlay should be up");
  c.doc.querySelectorAll("#countRow .count-btn").find(b => b.getAttribute("data-count") === String(players)).dispatch("click");
  c.doc.querySelectorAll("#loseRow .count-btn").find(b => b.getAttribute("data-lose") === String(loseAt)).dispatch("click");
  c.el("nameInput").value = "Alice";
  c.click("startBtn");
  await w.advance(500);
  return { w, c };
}

test("GameTok solo launch deals a zero-tap 4-player road-to-20 vs bots", async () => {
  const { w, c } = await bootSolo("solo1");
  const s = c.snap();
  eq(s.online, false, "a 'single' launch must not go online");
  eq(s.gameStarted, false);
  eq(s.numPlayers, 4);
  eq(s.loseAt, 20);
  eq(s.dealActive, true, "cards should already be dealt with no taps");
  eq(s.overlays, { setup: false, lobby: false, hand: false, winner: false }, "no overlay blocks the table");
  eq(s.counts.reduce((a, b) => a + b, 0) >= 13 * 4 - 12, true, "everyone was dealt in");
});

test("solo launch with a standalone_ room id still stays offline", async () => {
  const w = new World();
  const c = w.add("solo2", "Alice", { roomId: "standalone_xyz" });   // no mode field at all
  c.start({ userId: "solo2", userName: "Alice", roomId: "standalone_xyz", playerIds: ["solo2"] });
  await w.advance(1000);
  eq(c.snap().online, false, "a standalone_ room is not a real multiplayer room");
  eq(c.snap().dealActive, true);
});

test("solo match plays all the way to a winner with no dead end", async () => {
  const { w, c } = await bootSolo("solo3");
  const r = await playOut(w, { done: () => c.snap().overlays.winner, budget: 30 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  const s = c.snap();
  eq(s.dealActive, false, "the table stops when the match is over");
  eq(s.outs.filter(o => !o).length, 1, "exactly one survivor");
  ok(s.totals.filter(t => t >= s.loseAt).length >= 3, "the eliminated players all reached the target");
  eq(w.trace.filter(x => x.uiPlay !== "no-deal" && x.uiPlay !== "not-my-turn"), [], "the UI refused a legal move");
  eq(c.errors, []);
});

test("every player count × every lose-at target finishes cleanly", async () => {
  for (const players of [2, 3, 4]) {
    for (const loseAt of [20, 30, 40]) {
      const { w, c } = await bootSetup(`set-${players}-${loseAt}`, players, loseAt);
      const s0 = c.snap();
      eq(s0.numPlayers, players, `${players}p setup`);
      eq(s0.loseAt, loseAt, `lose at ${loseAt}`);
      eq(s0.dealActive, true, `${players}p/${loseAt} should deal`);
      eq(s0.counts.filter(n => n === 13).length, players, "13 cards each");
      const r = await playOut(w, { done: () => c.snap().overlays.winner, budget: 40 * 60 * 1000 });
      ok(r.ok, `${players}p / lose@${loseAt}: ` + r.reason + "\n" + (r.dump || ""));
      const s = c.snap();
      eq(s.outs.filter(o => !o).length, 1, `${players}p/${loseAt}: one survivor`);
      eq(c.errors, [], `${players}p/${loseAt} threw`);
    }
  }
});

test("30 solo matches back-to-back: no stall, no illegal state, no thrown error", async () => {
  for (let i = 0; i < 30; i++) {
    const { w, c } = await bootSolo("fuzz" + i);
    const r = await playOut(w, { done: () => c.snap().overlays.winner, budget: 30 * 60 * 1000 });
    ok(r.ok, "run " + i + ": " + r.reason + "\n" + (r.dump || ""));
    const s = c.snap();
    eq(s.outs.filter(o => !o).length, 1, "run " + i + ": one survivor");
    ok(s.totals.every(t => t >= 0), "run " + i + ": no negative score");
    eq(c.errors.map(String), [], "run " + i + " threw");
    const bad = w.trace.filter(x => x.uiPlay === "stuck-lead" || x.uiPlay === "play-disabled" || x.uiPlay === "cards-missing");
    eq(bad, [], "run " + i + ": UI refused a move it offered");
  }
});

test("hand-over overlay: the Next round button deals immediately", async () => {
  const { w, c } = await bootSolo("next1");
  const r = await playOut(w, { done: () => c.snap().overlays.hand || c.snap().overlays.winner, budget: 20 * 60 * 1000 });
  ok(r.ok, r.reason);
  if (c.snap().overlays.winner) return;              // first round already ended the match
  const epoch = c.snap().dealEpoch;
  const next = c.doc.querySelectorAll("#handActions .btn-next")[0];
  ok(next, "the offline results overlay offers a Next round button");
  next.dispatch("click");
  await w.advance(200);
  const s = c.snap();
  eq(s.overlays.hand, false, "the overlay closes");
  eq(s.dealActive, true, "the next round is live");
  ok(s.dealEpoch > epoch, "a new deal actually happened");
});

test("hand-over overlay: New game returns to the setup screen and can restart", async () => {
  const { w, c } = await bootSolo("quit1");
  const r = await playOut(w, { done: () => c.snap().overlays.hand || c.snap().overlays.winner, budget: 20 * 60 * 1000 });
  ok(r.ok, r.reason);
  if (c.snap().overlays.winner) return;
  const quit = c.doc.querySelectorAll("#handActions .btn-quit")[0];
  ok(quit, "the offline results overlay offers a New game button");
  quit.dispatch("click");
  await w.advance(3000);
  const s = c.snap();
  eq(s.dealActive, false, "the round is torn down");
  eq(s.overlays.setup, true, "we are back on the setup screen");
  // and nothing left running can deal into the setup screen
  await w.advance(120000);
  eq(c.snap().dealActive, false, "no stray timer re-deals behind the setup screen");
  c.click("startBtn");
  await w.advance(500);
  eq(c.snap().dealActive, true, "a fresh match starts from the setup screen");
});

test("offline rematch zeroes the match and deals again", async () => {
  const { w, c } = await bootSolo("re1");
  const r = await playOut(w, { done: () => c.snap().overlays.winner, budget: 30 * 60 * 1000 });
  ok(r.ok, r.reason);
  c.click("playAgainBtn");
  await w.advance(500);
  const s = c.snap();
  eq(s.overlays.winner, false, "the winner overlay closes");
  eq(s.totals, [0, 0, 0, 0], "scores reset");
  eq(s.outs, [false, false, false, false], "eliminations reset");
  eq(s.dealActive, true, "a new round is live");
  const r2 = await playOut(w, { done: () => c.snap().overlays.winner, budget: 30 * 60 * 1000 });
  ok(r2.ok, "second match: " + r2.reason + "\n" + (r2.dump || ""));
});

/**
 * Drive a solo game (trying a few RNG seeds) until the human is on turn in the
 * requested position — `lead` = nothing on the table, `follow` = something is.
 */
async function untilMyTurn(prefix, wantLead) {
  for (let seed = 0; seed < 12; seed++) {
    const { w, c } = await bootSolo(prefix + seed);
    for (let i = 0; i < 500; i++) {
      const s = c.snap();
      if (s.overlays.winner) break;
      if (s.dealActive && s.turn === s.mySeat) {
        if (wantLead === (s.tableLen === -1)) return { w, c, s };
        c.uiPlay();
      }
      await w.advance(300);
    }
  }
  throw new Error("could not reach the requested turn position");
}

test("offline turn clock: an idle human is auto-passed, the table never hangs", async () => {
  const { w, c, s } = await untilMyTurn("clockF", false);
  eq(s.lastAction[s.mySeat], undefined, "we have not acted this trick yet");
  await w.advance(95 * 1000);                        // TURN_SECONDS = 90
  const after = c.snap();
  ok(after.lastAction[s.mySeat] || !after.dealActive || after.overlays.hand || after.overlays.winner,
    "a timed-out human must be auto-passed, not left holding the table forever");
  // and the match still completes from there
  const r = await playOut(w, { done: () => c.snap().overlays.winner, budget: 30 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

test("offline: an idle human on lead is forced to play (a lead can never pass)", async () => {
  const { w, c, s } = await untilMyTurn("clockL", true);
  const held = s.counts[s.mySeat];
  await w.advance(95 * 1000);
  const s1 = c.snap();
  ok(s1.counts[s.mySeat] < held || s1.overlays.hand || s1.overlays.winner || !s1.dealActive,
    "a timed-out leader must be forced to play cards, not left stuck (a lead cannot pass)");
  const r = await playOut(w, { done: () => c.snap().overlays.winner, budget: 30 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

test("selecting more than five cards is refused", async () => {
  const { w, c } = await bootSolo("sel1");
  let guard = 0;
  while (!(c.snap().dealActive && c.snap().turn === c.snap().mySeat) && guard++ < 200) await w.advance(500);
  for (let i = 0; i < 7; i++) { const el = c.read("handEl.children[" + i + "]"); if (el) el.dispatch("click"); }
  eq(c.read("selected.size"), 5, "the hand caps a selection at five cards");
  eq(c.read('toastEl.textContent'), c.read('t("max5")'), "and says so");
});

test("dragging a hand card reorders it without changing selection", async () => {
  const { w, c } = await bootSolo("drag1");
  let guard = 0;
  while (!c.snap().dealActive && guard++ < 20) await w.advance(250);
  const before = c.read("(hands[mySeat] || []).map(cardKey)");
  c.run(`
    function fakeHandRects() {
      Array.from(handEl.children).forEach(function (el, i) {
        el.getBoundingClientRect = function () {
          return { left: i * 60, right: i * 60 + 52, top: 0, bottom: 74, width: 52, height: 74 };
        };
      });
    }
    selected.add(cardKey(hands[mySeat][1]));
    renderHand();
    fakeHandRects();
    var cards = Array.from(handEl.children);
    beginHandDrag({ button: 0, pointerId: 9, clientX: 86, clientY: 20 }, 1, cards[1]);
    updateHandDrag({ pointerId: 9, clientX: 1000, clientY: 22, preventDefault: function () {} });
    __dropHintShown = Array.from(handEl.children).some(function (el) {
      return el.classList.contains("drop-before") || el.classList.contains("drop-after");
    });
    finishHandDrag({ pointerId: 9, clientX: 1000, clientY: 22, preventDefault: function () {} });
    __dropHintCleared = !Array.from(handEl.children).some(function (el) {
      return el.classList.contains("drop-before") || el.classList.contains("drop-after");
    });
  `);
  const after = c.read("(hands[mySeat] || []).map(cardKey)");
  eq(c.read("__dropHintShown"), true, "a landing marker appears while dragging");
  eq(c.read("__dropHintCleared"), true, "the landing marker clears after drop");
  eq(after[after.length - 1], before[1], "the dragged card lands at the requested hand position");
  eq(c.read("Array.from(selected)"), [before[1]], "the same card remains selected after reorder");
});

test("cards can be selected off-turn, but only played on-turn; selected cards drag as a group", async () => {
  const { w, c } = await bootSolo("dragGroup1");
  let guard = 0;
  while (!c.snap().dealActive && guard++ < 20) await w.advance(250);
  c.run("turn = nextActiveAfter(mySeat); render();");
  const before = c.read("(hands[mySeat] || []).map(cardKey)");
  c.run(`
    function fakeHandRects2() {
      Array.from(handEl.children).forEach(function (el, i) {
        el.getBoundingClientRect = function () {
          return { left: i * 60, right: i * 60 + 52, top: 0, bottom: 74, width: 52, height: 74 };
        };
      });
    }
    handEl.children[0].dispatch("click");
    handEl.children[2].dispatch("click");
    __playDisabledOffTurn = playBtn.disabled;
    fakeHandRects2();
    var cards = Array.from(handEl.children);
    beginHandDrag({ button: 0, pointerId: 10, clientX: 26, clientY: 20 }, 0, cards[0]);
    updateHandDrag({ pointerId: 10, clientX: 1000, clientY: 22, preventDefault: function () {} });
    __groupDropHintShown = Array.from(handEl.children).some(function (el) {
      return el.classList.contains("drop-before") || el.classList.contains("drop-after");
    });
    finishHandDrag({ pointerId: 10, clientX: 1000, clientY: 22, preventDefault: function () {} });
  `);
  const after = c.read("(hands[mySeat] || []).map(cardKey)");
  eq(c.read("__playDisabledOffTurn"), true, "the Play button stays disabled while it is not your turn");
  eq(c.read("__groupDropHintShown"), true, "a landing marker appears for a selected group drag");
  eq(after.slice(-2), [before[0], before[2]], "dragging one selected card moves the selected group together");
  eq(c.read("Array.from(selected)"), [before[0], before[2]], "the selected cards remain selected after group reorder");
});

if (require.main === module) run("OFFLINE").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("OFFLINE") };
