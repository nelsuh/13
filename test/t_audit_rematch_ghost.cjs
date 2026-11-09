// AUDIT — chat-invite rematch after somebody walked out of the match.
// hostDeal(true) reuses the frozen roster and onDeal's reset un-eliminates every
// seat, so the departed player is dealt back in with nobody to play for them.

const { onlineWorld, startMatch, playOut, eventually, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

test("invite 3p: PLAY AGAIN after a walkout does not deal the departed seat back in", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await playOut(w, { done: () => w.clients[0].snap().roundMoveNo >= 2, budget: 5 * 60 * 1000, consistency: false });
  w.clients[2].leaveRoom();                       // Chuck closes the app for good
  const r = await playOut(w, { done: () => [0, 1].every(i => w.clients[i].snap().overlays.winner), budget: 90 * 60 * 1000, skip: ["u3"], consistency: false });
  ok(r.ok, "the 2 remaining players should finish: " + r.reason + "\n" + (r.dump || ""));
  const host = w.clients[0];
  ok(host.read("isPrimaryAuthority()"), "host is primary");
  host.click("playAgainBtn");
  await eventually(w, () => host.snap().dealActive, 10000, 250);
  const s = host.snap();
  console.log("    rematch order=" + s.order + " outs=" + s.outs + " counts=" + s.counts);
  // Measure how slow the rematch is: every turn of the ghost seat waits for a proxy cover.
  const t0 = w.clock.now;
  const done = await playOut(w, { done: () => [0, 1].every(i => w.clients[i].snap().overlays.winner || w.clients[i].snap().overlays.hand), budget: 60 * 60 * 1000, skip: ["u3"], consistency: false });
  console.log("    first rematch round took " + Math.round((w.clock.now - t0) / 1000) + "s of virtual time (ok=" + done.ok + ")");
  eq(s.outs[2] === true || s.counts[2] === 0, true, "the departed seat was dealt 13 cards and un-eliminated for the rematch");
});

if (require.main === module) run("AUDIT rematch ghost").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT rematch ghost") };
