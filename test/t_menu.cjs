// Suite — the start menu a no-invite launch lands on:
//   Онлайн        → the shared public-table ladder (fills 4 | 4 | 4 …)
//   Боттой тоглох → a private local table, you + 3 bots, no relay
//   Найзаа урих   → the host's friend picker, then the waiting hall
// A chat invite (mode 'multiplayer') skips the menu entirely.

const { World, openWorld, arrive, startMatch, eventually, dump } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

function launchSolo(w, id, name, extra) {
  const c = w.add(id, name, Object.assign({ mode: "single", roomId: "standalone_" + id, pick: "none" }, extra || {}));
  c.start({ userId: id, userName: name, roomId: "standalone_" + id, playerIds: [id] });
  return c;
}
const shown = (c, id) => c.el(id).classList.contains("show");

test("a no-invite launch stops on the menu: nothing dealt, nothing joined", async () => {
  const w = new World();
  const c = launchSolo(w, "m1", "Alice");
  await w.advance(3000);
  ok(shown(c, "menuOverlay"), "the menu is up");
  eq(c.snap().online, false, "not online until Online is tapped");
  eq(c.snap().dealActive, false, "no cards behind the menu");
  eq(c.sdk.room, null, "no room joined yet");
  ok(!shown(c, "onlineOverlay") && !shown(c, "setupOverlay"), "no other overlay on top");
});

test("first paint, before Usion.init: the menu — not the rules card, not the hall", async () => {
  const w = new World();
  const c = w.add("m0", "Alice", { mode: "single", roomId: "standalone_m0", pick: "none" });
  ok(shown(c, "menuOverlay"), "menu up from the very first frame");
  ok(!shown(c, "setupOverlay"), "no rules/setup card flash");
  ok(!shown(c, "onlineOverlay"), "no waiting-hall flash");
});

test("first paint of a chat invite: the waiting hall, never the menu", async () => {
  const w = new World();
  const c = w.add("m00", "Alice", { mode: "multiplayer", roomId: w.roomId });
  ok(!shown(c, "menuOverlay"), "no menu flash for an invite");
  ok(!shown(c, "setupOverlay"), "no rules/setup card flash");
  ok(shown(c, "onlineOverlay"), "hall cover from the very first frame");
});

test("a chat invite skips the menu and goes straight to the waiting hall", async () => {
  const w = new World();
  const c = w.add("m2", "Alice", { mode: "multiplayer", roomId: w.roomId });
  c.start({ userId: "m2", userName: "Alice", roomId: w.roomId, playerIds: [] });
  await w.advance(1500);
  ok(!shown(c, "menuOverlay"), "no menu for an invite");
  ok(shown(c, "onlineOverlay"), "waiting hall is up");
  eq(c.sdk.room && c.sdk.room.id, w.roomId, "in the invite room");
});

test("Play vs bots: a private local table, you + 3 bots, no room joined", async () => {
  const w = new World();
  const c = launchSolo(w, "m3", "Alice");
  await w.advance(500);
  c.click("menuBotsBtn");
  await w.advance(1500);
  const s = c.snap();
  ok(!shown(c, "menuOverlay"), "menu closed");
  eq(s.online, false, "private — never online");
  eq(s.numPlayers, 4);
  eq(s.dealActive, true, "dealt straight away");
  eq(c.sdk.room, null, "no relay room at all, so nobody can drop in");
});

test("Online: lands on the shared public table and deals", async () => {
  const w = new World();
  const c = launchSolo(w, "m4", "Alice");
  await w.advance(500);
  c.click("menuOnlineBtn");
  const dealt = await eventually(w, () => c.snap().dealActive, 20000, 250);
  ok(dealt, "the open table dealt\n" + dump(w));
  eq(c.sdk.room.id, "public-13-1", "on the first public table");
  eq(c.snap().online, true);
});

test("Online: 12 arrivals fill the public tables 4 | 4 | 4", async () => {
  const w = await openWorld(1);
  await eventually(w, () => w.clients[0].snap().gameStarted, 20000, 250);
  for (let i = 2; i <= 12; i++) {
    const c = arrive(w, "u" + i, "P" + i);
    const seated = await eventually(w, () => c.snap().mySeat >= 0 && c.snap().gameStarted, 60000, 250);
    ok(seated, "arrival " + i + " got a seat\n" + dump(w));
  }
  await w.advance(2000);
  const tally = {};
  w.clients.forEach(x => { const r = x.sdk.room.id; tally[r] = (tally[r] || 0) + 1; });
  eq(tally, { "public-13-1": 4, "public-13-2": 4, "public-13-3": 4 }, "tables fill in order, four each");
  eq(w.errors(), [], "no client threw");
});

test("Invite a friend: picker → waiting hall in the new room, then a real match", async () => {
  const w = new World();
  w.mode = "multiplayer";
  const host = launchSolo(w, "m5", "Alice", { inviteRoom: w.roomId });
  await w.advance(500);
  host.click("menuInviteBtn");
  await w.advance(1500);
  eq(host.sdk.calls.invite, 1, "the host's picker was opened");
  ok(!shown(host, "menuOverlay"), "menu closed");
  ok(shown(host, "onlineOverlay"), "waiting hall is up");
  eq(host.el("readyBtn").style.display, "block", "with READY");
  eq(host.snap().dealActive, false, "no bots dealt behind the hall");
  // the friend taps the invite card
  const guest = w.add("m6", "Bob", { mode: "multiplayer", roomId: w.roomId });
  guest.start({ userId: "m6", userName: "Bob", roomId: w.roomId, playerIds: [] });
  await w.advance(1500);
  await startMatch(w);
  eq(host.snap().order, ["m5", "m6"], "the two of them, no bots");
});

test("Invite a friend: closing the picker leaves you on the menu", async () => {
  const w = new World();
  const c = launchSolo(w, "m7", "Alice", { inviteCancel: true });
  await w.advance(500);
  c.click("menuInviteBtn");
  await w.advance(1500);
  ok(shown(c, "menuOverlay"), "still on the menu");
  eq(c.el("menuInviteBtn").disabled, false, "and the button works again");
  eq(c.snap().online, false);
  c.click("menuBotsBtn");
  await w.advance(1000);
  eq(c.snap().dealActive, true, "can still pick another option");
});

if (require.main === module) run("MENU").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("MENU") };
