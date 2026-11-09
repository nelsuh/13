// AUDIT — a client that misses a seat change and recovers through a checkpoint.
// applyCheckpoint (gameStarted branch) adopts state.order into roomPlayerIds but
// never rebuilds players[s].isBot / name, and the trusted replay of the seat move
// is refused ("nobody sits twice" / "already a bot"), so the flags stay stale.

const { openWorld, startMatch, playOut, driveUntil, eventually, consistency, arrive, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

function seatInfo(c) {
  return c.read(`players.map(function (p, s) { return s + ":" + (roomPlayerIds[s] || "bot") + "/" + (p.isBot ? "isBot" : "human") + "/" + p.name; }).join("  ")`);
}

test("missed seat_release: the recovering client must treat the seat as a bot again", async () => {
  const w = await openWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const [a, b, c] = w.clients;
  b.freeze();                         // Bob's phone is locked…
  c.leaveRoom();                      // …while Chuck walks out for good
  await playOut(w, { done: () => a.snap().order[2] === null, budget: 5 * 60 * 1000, skip: ["u3"], consistency: false });
  ok(a.snap().order[2] === null, "Chuck's seat went back to a bot on Alice");
  await w.advance(10000);
  b.thaw();
  await w.advance(15000);
  console.log("    alice: " + seatInfo(a));
  console.log("    bob  : " + seatInfo(b));
  const bobBot = b.read("players[2].isBot");
  console.log("    seat log: " + JSON.stringify(w.room.log.filter(x => /seat/.test(x.action_data.kind || "")).map(x => x.sequence + ":" + x.player_id + ":" + x.action_data.kind + " s" + x.action_data.seat + " " + (x.action_data.playerId || ""))));
  console.log("    totals a=" + a.snap().totals + " b=" + b.snap().totals + "  consistency: " + (consistency(w) ? consistency(w).split(String.fromCharCode(10))[0] : "ok"));
  console.log("    bob present=" + b.snap().present + " heard u3=" + b.read("heardFrom.has('u3')") + " released=" + b.read("Array.from(releasedIds)"));
  // Now Alice leaves too: Bob is the only human, and must drive both bots.
  a.leaveRoom();
  const r = await playOut(w, { done: () => b.snap().overlays.winner, budget: 30 * 60 * 1000, skip: ["u1", "u3"], consistency: false });
  console.log("    bob alone: " + (r.ok ? "finished" : r.reason));
  ok(bobBot === true, "Bob still believes seat 2 is a human after recovering (order says bot)");
  ok(r.ok, "Bob's table stalls: " + r.reason + "\n" + (r.dump || ""));
});

test("missed seat_take: the recovering client must treat the seat as human again", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const [a, b] = w.clients;
  b.freeze();
  const c = arrive(w, "u3", "Chuck");
  await eventually(w, () => a.snap().order.indexOf("u3") >= 0 && c.snap().gameStarted, 30000, 250);
  await w.advance(5000);
  b.thaw();
  await w.advance(15000);
  console.log("    alice: " + seatInfo(a));
  console.log("    bob  : " + seatInfo(b));
  const seat = a.snap().order.indexOf("u3");
  ok(b.read(`players[${seat}].isBot`) === false, "Bob still believes Chuck's seat is a bot");
});

if (require.main === module) run("AUDIT stale isBot").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT stale isBot") };
