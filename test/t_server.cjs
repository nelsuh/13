// Suite — the real script.js playing on the real 13 server.
//
// The page runs in the usual vm sandbox (lib/client.cjs), but `io` is the real
// socket.io client talking to server/sockets.mjs over a real websocket. So this
// covers the whole path a phone takes on 13.games.usions.com: menu → Онлайн →
// a server-dealt table → taps → the server's state drawn back on the page.
//
// The page's own timers run on the virtual clock; sockets run on real time, so
// waits pump both.

const { World } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");
const { io: ioClient } = require("socket.io-client");

let server = null;
// A fresh server per test: a player left over from the previous test would hold
// a seat (and the turn clock) at the next test's open table.
async function boot(timing) {
  await shutdown();
  const { createServer } = require("node:http");
  const { attachSockets } = await import("../server/sockets.mjs");
  const { createIdentity } = await import("../server/usion.mjs");
  const http = createServer((q, r) => { r.writeHead(404); r.end(); });
  const { io } = attachSockets(http, { identity: createIdentity({ devMode: true }), log: { error() {} }, timing });
  await new Promise(r => http.listen(0, "127.0.0.1", r));
  server = { url: "http://127.0.0.1:" + http.address().port, io, http, sockets: [] };
  return server;
}
async function shutdown() {
  if (!server) return;
  server.sockets.forEach(s => s.close());
  server.io.close();
  await new Promise(r => server.http.close(r));
  server = null;
}

function player(w, id, name) {
  const c = w.add(id, name, { mode: "single", roomId: "standalone_" + id, pick: "none" });
  c.sandbox.Usion.user = { getToken: () => "dev:" + id };
  c.sandbox.io = (opts) => {
    const s = ioClient(server.url, Object.assign({}, opts, { transports: ["websocket"], forceNew: true }));
    server.sockets.push(s);
    return s;
  };
  c.start({ userId: id, userName: name, roomId: "standalone_" + id, playerIds: [id] });
  return c;
}
const realTick = () => new Promise(r => setTimeout(r, 15));
async function waitFor(w, pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await realTick(); await w.advance(15); }
  return !!pred();
}

test("Онлайн on the 13 host sits you at a server table dealt 13 cards", async () => {
  await boot();
  const w = new World();
  const a = player(w, "s1", "Alice");
  await w.advance(300);
  a.click("menuOnlineBtn");
  ok(await waitFor(w, () => a.snap().gameStarted && a.snap().counts[a.snap().mySeat] === 13), "dealt:\n" + JSON.stringify(a.snap()));
  const s = a.snap();
  eq(a.read("srvMode"), true, "playing on the server, not the relay");
  eq(s.numPlayers, 4);
  eq(s.names[s.mySeat], "Alice");
  eq(s.order.filter(x => x === null).length, 3, "three bots");
  eq(a.el("onlineOverlay").classList.contains("show"), false, "the connect cover is gone");
  eq(a.errors.map(String), []);
});

test("two phones share one server table and play it through the buttons", async () => {
  await boot();
  const w = new World();
  const a = player(w, "t1", "Alice"), b = player(w, "t2", "Bob");
  await w.advance(300);
  a.click("menuOnlineBtn");
  ok(await waitFor(w, () => a.snap().gameStarted));
  b.click("menuOnlineBtn");
  ok(await waitFor(w, () => b.snap().gameStarted && a.snap().order.includes("t2")), "Bob joins Alice's table");
  eq(b.snap().order.join(), a.snap().order.join(), "same seating on both");
  const handsA = a.read("(hands[mySeat]||[]).map(cardWire).join()"), handsB = b.read("(hands[mySeat]||[]).map(cardWire).join()");
  ok(handsA !== handsB, "different hands");
  // Play several moves through the real Play/Pass buttons; bots move on the server.
  let moves = 0;
  for (let i = 0; i < 400 && moves < 6; i++) {
    for (const c of [a, b]) {
      const r = c.read("__uiPlay()");
      if (r === "play" || r === "pass") {
        moves++;
        ok(await waitFor(w, () => !c.snap().pendingAction), c.id + " move acked");
      }
    }
    await realTick(); await w.advance(50);
  }
  ok(moves >= 6, "the humans got to move: " + moves);
  ok(await waitFor(w, () => a.snap().tableSeat === b.snap().tableSeat && a.snap().turn === b.snap().turn), "both draw the same table");
  eq(a.errors.map(String), []); eq(b.errors.map(String), []);
});

test("an illegal tap is refused by the server and the hand is untouched", async () => {
  await boot();
  const w = new World();
  const a = player(w, "x1", "Alice");
  await w.advance(300);
  a.click("menuOnlineBtn");
  ok(await waitFor(w, () => a.snap().gameStarted));
  // Two cards of different rank are never a legal play, whoever's turn it is
  // (the deal may well put the 3♣ — and so the first turn — in our hand).
  ok(await waitFor(w, () => a.snap().dealActive, 8000));
  const before = a.snap().counts[a.snap().mySeat];
  const bad = a.read("(function(){const h=hands[mySeat];const b=h.find(c=>c.r!==h[0].r);return [cardWire(h[0]),cardWire(b)];})()");
  const r = await new Promise(res => a.read("srv").timeout(3000).emit("move", { kind: "play", cards: bad, moveNo: a.read("srvView.game.moveNo") }, (e, x) => res(x)));
  ok(r && r.error, "refused: " + JSON.stringify(r));
  await waitFor(w, () => false, 300);
  eq(a.snap().counts[a.snap().mySeat], before);
});

test("no server reachable → Онлайн falls back to the relay", async () => {
  const w = new World();
  const c = w.add("f1", "Alice", { mode: "single", roomId: "standalone_f1", pick: "none" });
  c.sandbox.Usion.user = { getToken: () => "dev:f1" };
  c.sandbox.io = (opts) => ioClient("http://127.0.0.1:1", Object.assign({}, opts, { transports: ["websocket"], forceNew: true, reconnection: false }));
  c.start({ userId: "f1", userName: "Alice", roomId: "standalone_f1", playerIds: ["f1"] });
  await w.advance(300);
  c.click("menuOnlineBtn");
  ok(await waitFor(w, () => c.read("srvFailed") === true, 8000), "gave up on the server");
  eq(c.read("srvMode"), false);
  eq(c.snap().online, true, "and went online over the relay instead");
});

test("a whole match: results between hands, the champion screen, then the table deals again", async () => {
  await boot({ BOT_MS: 5, HAND_PAUSE_MS: 2600, OPEN_RESTART_MS: 2600 });
  const w = new World();
  const a = player(w, "m1", "Alice");
  await w.advance(300);
  a.click("menuOnlineBtn");
  ok(await waitFor(w, () => a.snap().gameStarted));
  let sawHand = false, sawWinner = false;
  const end = Date.now() + 60000;
  while (Date.now() < end && !sawWinner) {
    a.read("__uiPlay()");
    if (a.el("handOverlay").classList.contains("show")) sawHand = true;
    if (a.el("winnerOverlay").classList.contains("show")) sawWinner = true;
    await realTick(); await w.advance(200);
  }
  ok(sawHand, "the results screen came up between hands");
  ok(sawWinner, "the champion screen came up");
  const champ = a.read("document.getElementById('winnerName').textContent");
  ok(champ.length > 0, "with a name: " + champ);
  ok(await waitFor(w, () => !a.el("winnerOverlay").classList.contains("show") && a.snap().dealActive, 8000), "and the table dealt a new match by itself");
  eq(a.snap().totals.every(t => t === 0), true, "scores back to zero");
  eq(a.errors.map(String), []);
});

if (require.main === module) run("SERVER").then(async r => { await shutdown(); process.exit(r.fails.length ? 1 : 0); });
module.exports = { run: async () => { const r = await run("SERVER"); await shutdown(); return r; } };
