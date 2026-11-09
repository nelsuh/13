// AUDIT — what a seated peer can put in a between-rounds `deal`.
// onDeal (gameStarted branch) only checks that the sender is seated and the
// order matches; seed / lastWinner / firstDeal / loseAt / reset are adopted as-is.

const { onlineWorld, openWorld, startMatch, driveUntil, playOut, eventually, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

async function atRoundBoundary(w) {
  await startMatch(w);
  const r = await driveUntil(w, () => w.clients.every(c => !c.snap().dealActive && c.snap().roundMoveNo > 0),
    { budget: 20 * 60 * 1000, step: 50 });
  ok(r.ok, "no round ever ended: " + r.reason);
}

function forgeDeal(c, extra) {
  c.run(`Usion.game.action("deal", Object.assign({ seed: 12345, order: roomPlayerIds.slice(), names: nameMap(),
    avatars: avatarMap(), firstDeal: false, lastWinner: lastWinner, loseAt: loseAt, open: openTable }, ${JSON.stringify(extra)})).catch(function(){})`);
}

test("a guest's deal with an out-of-range lastWinner must not brick every client", async () => {
  const w = await onlineWorld(3);
  // A browser logs a throwing event handler and carries on; do the same.
  w.clients.forEach(c => { const f = c.sdk.fire.bind(c.sdk); c.sdk.fire = (t, p) => { try { f(t, p); } catch (e) { c.errors.push(e); } }; });
  await atRoundBoundary(w);
  forgeDeal(w.clients[1], { lastWinner: 7 });
  await w.advance(500);
  const errs = w.errors();
  console.log("    errors: " + errs.length + (errs[0] ? "  first: " + errs[0].split("\n")[0] : ""));
  w.clients.forEach(c => { const s = c.snap(); console.log("    " + c.id + " deal=" + s.dealActive + " turn=" + s.turn + " counts=" + s.counts + " pending=" + s.pendingAction); });
  const r = await playOut(w, { done: () => w.drivers().every(c => c.snap().overlays.winner), budget: 30 * 60 * 1000 });
  ok(r.ok, "after the forged deal: " + r.reason + "\n" + (r.dump || ""));
});

test("a guest must not be able to wipe the match scores with reset:true between rounds", async () => {
  const w = await onlineWorld(3);
  await atRoundBoundary(w);
  const before = w.clients[0].snap().totals;
  forgeDeal(w.clients[2], { reset: true, seed: 999 });
  await w.advance(1000);
  const after = w.clients[0].snap().totals;
  console.log("    totals before=" + before + " after=" + after);
  eq(after, before, "scores were wiped by a non-host guest's reset deal");
});

test("a guest must not be able to change the lose-at threshold mid-match", async () => {
  const w = await onlineWorld(3);
  await atRoundBoundary(w);
  forgeDeal(w.clients[2], { loseAt: 100000 });
  await w.advance(1000);
  const s = w.clients[0].snap();
  console.log("    loseAt now " + s.loseAt + " on host");
  eq(s.loseAt, 30, "lose-at was changed by a guest's deal");
});

test("the dealer must not be able to pick a seed that hands itself a dragon (instant match win)", async () => {
  const w = await onlineWorld(3);
  await atRoundBoundary(w);
  const cheat = w.clients[2];
  const seed = cheat.read(`(function () {
    var active = activeSeats(); var idx = active.indexOf(mySeat);
    for (var s = 1; s < 5000000; s++) {
      var h = dealHands(s, active.length)[idx];
      if (new Set(h.map(function (c) { return c.r; })).size === 13) return s;
    }
    return -1; })()`);
  console.log("    found dragon seed " + seed);
  ok(seed > 0, "seed search");
  const before = w.clients[0].snap();
  // Fire before the honest countdown deal (countdown is 2.4 s + 5 s).
  forgeDeal(cheat, { seed: seed });
  await w.advance(4000);
  const s = w.clients[0].snap();
  console.log("    totals " + before.totals + " -> " + s.totals + "  outs=" + s.outs);
  await w.advance(4000);
  console.log("    winner overlay on host: " + w.clients[0].snap().overlays.winner + " winnerName=" + w.clients[0].snap().winnerName);
  ok(!w.clients[0].snap().overlays.winner, "one forged seed ended the whole match in the cheater's favour");
});

if (require.main === module) run("AUDIT forged deal").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT forged deal") };
