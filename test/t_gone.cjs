// Suite — a player whose socket drops and never comes back.
//
// Reported from the live app (online + tournament): somebody closes the app or
// opens another game, their avatar stays at the table, and every round the turn
// sits on them for the whole clock as if they might still play.
//
// The relay never sends game:player_left for a dropped socket. It sends
// game:player_connection "reconnecting" at once and "gone" 15 s later (backend
// realtime/server.py _game_disconnect_grace). The game listened to player_left
// only, so a drop never started the forfeit grace and the seat was never
// settled. test/lib/net.cjs now models the real relay; these pin the outcome.

const { World, onlineWorld, openWorld, startMatch, botSeats, playOut, driveUntil, eventually, consistency, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const SEC = 1000, MIN = 60 * SEC;
// The whole wait is the relay's 15 s: "gone" has already waited it, so the game
// settles the seat on its next tick (≤ 1 s) plus delivery latency.
const SETTLE = 18 * SEC;

test("chat invite: a player who drops for good is folded, and play goes on without them", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  const gone = w.clients[2];
  gone.netDrop();                                  // app swiped away, never reopened
  await w.advance(13 * SEC);
  eq(w.clients[0].snap().outs[2], false, "still seated while the relay says only 'reconnecting'");
  const folded = await eventually(w, () => w.clients[0].snap().outs[2] === true &&
    w.clients[1].snap().outs[2] === true, SETTLE - 13 * SEC, 250);
  ok(folded, "the departed seat must fold on every live client\n" + dump(w));
  const r = await playOut(w, { done: () => w.clients.slice(0, 2).every(c => c.snap().overlays.winner), budget: 60 * MIN, consistency: false });
  ok(r.ok, "the two who stayed finish the match: " + (r.reason || "") + (r.dump ? "\n" + r.dump : ""));
  w.clients.slice(0, 2).forEach(c => eq(c.errors.map(String), [], c.id + " threw"));
});

test("chat invite: a drop shorter than the relay's grace changes nothing", async () => {
  const w = await onlineWorld(3);
  await startMatch(w);
  await driveUntil(w, () => w.clients[0].snap().roundMoveNo >= 2);
  w.clients[2].netDrop();
  await w.advance(10 * SEC);                       // "reconnecting" only, never "gone"
  w.clients[2].netRestore();
  await w.advance(40 * SEC);
  eq(w.clients[0].snap().outs[2], false, "a blip is not a departure\n" + dump(w));
  eq(consistency(w), null, dump(w));
});

test("open room: a dropped player's seat goes back to a bot", async () => {
  const w = await openWorld(2);
  await startMatch(w);
  const seat = w.clients[0].snap().order.indexOf("u2");
  ok(seat >= 0, "u2 is seated");
  w.clients[1].netDrop();
  const freed = await eventually(w, () => botSeats(w.clients[0]).includes(seat), SETTLE, 500);
  ok(freed, "u2's seat must be handed to a bot, not left holding their avatar\n" + dump(w));
  eq(w.clients[0].snap().order.indexOf("u2"), -1, "u2 is no longer at the table");
});

test("tournament: a player who closes the app mid-match is folded and the table finishes", async () => {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + 11 * MIN;
  const cs = ["Alice", "Bob", "Chuck"].map((name, i) => {
    const id = "p" + (i + 1);
    const c = w.add(id, name, { mode: "single", roomId: "standalone_" + id, pick: "none" });
    c.run("window.T13_TOUR_START_AT = " + startAt);
    c.sandbox.Usion.config = { apiUrl: "https://api.test", serviceId: "svc13" };
    c.sandbox.Usion.user = { getToken: () => "tok-" + id };
    c.sandbox.fetch = w.server.restFetch(id);
    c.start({ userId: id, userName: name, roomId: "standalone_" + id, playerIds: [id] });
    return c;
  });
  await w.advance(500);
  cs.forEach(c => c.click("menuTourBtn")); await w.advance(500);
  cs.forEach(c => c.click("tourPrimary"));
  await w.advance(startAt - w.clock.now + 4000);
  ok(cs.every(c => c.snap().dealActive), "the three are dealt in\n" + dump(w));
  await playOut(w, { done: () => cs[0].snap().roundMoveNo > 4, consistency: false, budget: 5 * MIN });
  const bob = cs[1], seat = bob.snap().mySeat;
  bob.netDrop();
  const folded = await eventually(w, () => cs[0].snap().outs[seat] === true, SETTLE, 500);
  ok(folded, "Bob's seat must fold instead of holding the table every turn\n" + dump(w));
  const stay = [cs[0], cs[2]];
  const r = await playOut(w, { done: () => stay.every(c => c.el("winnerOverlay").classList.contains("show")), consistency: false, budget: 60 * MIN });
  ok(r.ok, "the table finishes without him: " + (r.reason || ""));
});

if (require.main === module) run("GONE").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("GONE") };
