// AUDIT — single elected writers (bot relay / proxy cover) that are asleep.

const { onlineWorld, openWorld, startMatch, playOut, driveUntil, eventually, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

test("open room: the bot relay locking their phone does not freeze the bots", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  const host = w.clients[0], peer = w.clients[1];
  const r = await playOut(w, {
    done: () => { const s = peer.snap(); return s.dealActive && s.order[s.turn] === null; },
    budget: 10 * 60 * 1000, step: 50, consistency: false,
  });
  ok(r.ok, "reach a bot turn");
  host.freeze();
  const before = peer.snap();
  const t0 = w.clock.now;
  const moved = await eventually(w, () => peer.snap().roundMoveNo !== before.roundMoveNo || !peer.snap().dealActive, 10 * 60 * 1000, 1000);
  console.log("    bot seat " + before.turn + " moved: " + moved + " after " + Math.round((w.clock.now - t0) / 1000) + "s");
  ok(moved, "the bot never moved while seat 0 slept\n" + dump(w));
});

test("invite 3p: two locked phones (the stalled seat AND its elected proxy) freeze the third player", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  // reach u2's turn
  const r = await driveUntil(w, () => { const s = w.clients[2].snap(); return s.dealActive && s.turn === 1; }, { skip: ["u2"] });
  ok(r.ok, "reach seat 1's turn: " + r.reason);
  w.clients[0].freeze();    // u1 = lowest present seat = the elected proxy for seat 1
  w.clients[1].freeze();    // u2 = the player on turn
  const before = w.clients[2].snap();
  const t0 = w.clock.now;
  const moved = await eventually(w, () => w.clients[2].snap().roundMoveNo !== before.roundMoveNo, 15 * 60 * 1000, 1000);
  console.log("    seat 1 covered: " + moved + " after " + Math.round((w.clock.now - t0) / 1000) + "s");
  ok(moved, "nobody ever covered seat 1 — u3 is stuck for as long as both phones stay locked\n" + dump(w));
});

if (require.main === module) run("AUDIT sleeping writer").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT sleeping writer") };
