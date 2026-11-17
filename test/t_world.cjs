// Suite — Онлайн (the open table) under the REAL relay's room rules.
//
// The relay admits only rooms that exist and their players (backend
// realtime/game_handlers.py → handle_game_join). The open table used to join
// made-up rooms (public-13-1 … 8): in production every one of those joins failed
// and each player fell back to a private table with three bots — strangers never
// met. The shared tables are now Usion WORLD rooms: Usion.game.joinWorld() places
// a player in the world they are in, else a world with a free seat (max 4), else
// a fresh one; a seat frees when its player leaves.
//
// Every world here runs with { strictRooms: true, worlds: true }: rooms exist
// only if the server made them, standalone rooms are the platform's, and worlds
// follow _join_world's placement and prune-on-leave rules.

const { openWorld, startMatch, arrive, botSeats, playOut, eventually, consistency, dump, WORLD_ROOM, WORLD_ROOM_2 } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const REAL = { strictRooms: true, worlds: true };
const seated = w => w.drivers().filter(c => c.snap().gameStarted);
const openFinished = w => { const s = seated(w); return s.length > 0 && s.every(c => c.snap().overlays.winner); };
async function watchUntil(w, c, pred, ms = 40000) {
  let prev = c.snap();
  const hit = await eventually(w, () => { const s = c.snap(); if (pred(s)) return true; prev = s; return false; }, ms, 250);
  return { hit, prev, now: c.snap() };
}
const worldPlayers = (w, id) => (w.server.rooms.get(id) || {}).players || [];

test("without the world tag (today's production): each player falls back to a private table", async () => {
  // Documents the failure this suite exists for: the service lacks the `world`
  // tag, joinWorld answers NOT_WORLD_SERVICE, the made-up public rooms do not
  // exist, and the game falls back to the platform's own room — still a game,
  // just never a shared one.
  const w = await openWorld(2, { strictRooms: true, worlds: false });
  await startMatch(w);
  eq(w.clients[0].sdk.room.id, "standalone_u1");
  eq(w.clients[1].sdk.room.id, "standalone_u2", "two people, two tables");
  ok(w.clients.every(c => c.snap().order.filter(Boolean).length === 1), "each alone with three bots");
});

test("world rooms: two people who tap Онлайн land at the SAME table", async () => {
  const w = await openWorld(2, REAL);
  await startMatch(w);
  for (const c of w.clients) {
    eq(c.sdk.room.id, WORLD_ROOM, c.id + " is on the shared world table");
    eq(c.snap().order.slice(0, 2), ["u1", "u2"], c.id + " sees both humans seated");
    eq(c.snap().order.slice(2), [null, null], "bots in the spare seats");
  }
  eq(worldPlayers(w, WORLD_ROOM).sort(), ["u1", "u2"], "the server counts both in that world");
  eq(consistency(w), null, "one round, not two");
});

test("world rooms: a lone player is dealt in at once against three bots", async () => {
  const w = await openWorld(1, REAL);
  await startMatch(w);
  const s = w.clients[0].snap();
  eq(s.order, ["u1", null, null, null]);
  eq(s.counts, [13, 13, 13, 13]);
  eq(s.loseAt, 20);
  eq(s.overlays.lobby, false, "no lobby, no Start");
});

test("world rooms: a joiner takes over the lowest-scoring bot mid-round", async () => {
  const w = await openWorld(1, REAL);
  await startMatch(w);
  const warm = await playOut(w, { done: () => w.clients[0].snap().dealEpoch >= 2, budget: 30 * 60 * 1000, consistency: false });
  ok(warm.ok, "warm-up: " + warm.reason);
  const host = w.clients[0];
  const before = host.snap();
  let want = botSeats(host)[0];
  botSeats(host).forEach(s => { if (before.totals[s] < before.totals[want]) want = s; });
  const c = arrive(w, "u2", "Bob");
  const seen = await watchUntil(w, host, s => s.order.indexOf("u2") >= 0);
  ok(seen.hit, "Bob is seated:\n" + dump(w));
  eq(seen.now.order.indexOf("u2"), want, "on the bot with the fewest points");
  eq(seen.now.totals, seen.prev.totals, "inheriting its score, resetting nobody's");
  await eventually(w, () => c.snap().gameStarted && c.snap().mySeat === want, 20000, 250);
  eq(c.sdk.room.id, WORLD_ROOM, "in the same world");
  const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  eq(consistency(w), null);
});

test("world rooms: B, C and D drop in and fill the table; a fifth gets a table of their own", async () => {
  const w = await openWorld(1, REAL);
  await startMatch(w);
  const host = w.clients[0];
  for (const [id, name, seat] of [["u2", "Bob", 1], ["u3", "Chuck", 2], ["u4", "Dana", 3]]) {
    const c = arrive(w, id, name);
    const seen = await watchUntil(w, host, s => s.order.indexOf(id) >= 0);
    ok(seen.hit, id + " seated:\n" + dump(w));
    eq(seen.now.order.indexOf(id), seat);
    await eventually(w, () => c.snap().gameStarted, 20000, 250);
  }
  eq(host.snap().order, ["u1", "u2", "u3", "u4"], "all four human");
  eq(worldPlayers(w, WORLD_ROOM).length, 4, "the world is full");
  const late = arrive(w, "u5", "Erdene");
  ok(await eventually(w, () => late.snap().gameStarted, 40000, 250), "the fifth plays:\n" + dump(w));
  eq(late.sdk.room.id, WORLD_ROOM_2, "in a fresh world, not queued behind four");
  eq(late.snap().order, ["u5", null, null, null]);
  eq(host.snap().order, ["u1", "u2", "u3", "u4"], "the first table is untouched");
});

test("world rooms: a walkout hands the seat back to a bot, and the next arrival gets it", async () => {
  const w = await openWorld(4, REAL);
  await startMatch(w);
  const host = w.clients[0];
  w.clients[3].leaveRoom();
  ok(await eventually(w, () => host.snap().order[3] === null, 60000, 250), "seat back to a bot:\n" + dump(w));
  ok(!worldPlayers(w, WORLD_ROOM).includes("u4"), "and freed in the server's world for backfill");
  const late = arrive(w, "u5", "Erdene");
  const seen = await watchUntil(w, host, s => s.order.indexOf("u5") >= 0, 40000);
  ok(seen.hit, "the next arrival takes it:\n" + dump(w));
  eq(seen.now.order.indexOf("u5"), 3);
  eq(late.sdk.room.id, WORLD_ROOM, "placed into the world with the free seat");
  await eventually(w, () => late.snap().gameStarted && late.snap().mySeat === 3, 20000, 250);
  eq(consistency(w), null);
});

test("world rooms: walking back into a world everyone left clears it, not resumes it", async () => {
  const w = await openWorld(2, REAL);
  await startMatch(w);
  await playOut(w, { done: () => w.clients[0].snap().dealEpoch >= 2, budget: 30 * 60 * 1000, consistency: false });
  w.clients[0].leaveRoom(); w.clients[1].leaveRoom();
  await w.advance(2000);
  eq(worldPlayers(w, WORLD_ROOM).length, 0, "empty world, log and checkpoint left behind");
  const back = arrive(w, "u1", "Alice");
  const cleared = await eventually(w, () => {
    const s = back.snap();
    return s.dealActive && s.order.filter(Boolean).length === 1 && s.totals.every(t => t === 0);
  }, 60 * 1000, 250);
  ok(cleared, "a fresh table, not the old one:\n" + dump(w));
  eq(back.sdk.room.id, WORLD_ROOM, "backfilled into the empty world");
});

test("world rooms: a full match to the winner screen, then the table restarts itself", async () => {
  const w = await openWorld(2, REAL);
  await startMatch(w);
  const r = await playOut(w, { done: () => openFinished(w), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
  const restarted = await eventually(w, () => w.clients.every(c => c.snap().dealActive && !c.snap().overlays.winner), 60000, 250);
  ok(restarted, "the next match deals itself:\n" + dump(w));
  eq(consistency(w), null);
  for (const c of w.clients) eq(c.errors.map(String), [], c.id + " threw");
});

if (require.main === module) run("WORLD").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("WORLD") };
