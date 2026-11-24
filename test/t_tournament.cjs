// Suite — the daily tournament (Menu → Тэмцээн):
//   register → tables drawn 10 min before (20:50 → 21:00) → stage 1 → break → final → champion.
// Everything runs through the real script.js: the bracket is derived on every
// client from the shared registration + result records, tables are private
// relay rooms, and the moves go through the real Play/Pass buttons.

const { World, playOut, eventually } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const NAMES = ["Alice", "Bob", "Chuck", "Dana", "Erdene", "Fiona", "Gan"];
const MIN = 60 * 1000;
const OPEN = 10 * MIN;   // registration closes / tables drawn this long before the start

function launch(w, id, name, startAt) {
  const c = w.add(id, name, { mode: "single", roomId: "standalone_" + id, pick: "none" });
  c.run("window.T13_TOUR_START_AT = " + startAt);
  if (w.server.opts.strictRooms) {
    // What the Usion host hands the game: its api base, service id and a live
    // token, so the game can create/join real rooms over REST.
    c.sandbox.Usion.config = { apiUrl: "https://api.test", serviceId: "svc13" };
    c.sandbox.Usion.user = { getToken: () => "tok-" + id };
    c.sandbox.fetch = w.server.restFetch(id);
  }
  c.start({ userId: id, userName: name, roomId: "standalone_" + id, playerIds: [id] });
  return c;
}
const shown = (c, id) => c.el(id).classList.contains("show");
const derived = c => c.read("tourDerive(tour.startsAt, tour.roster, tour.results, Date.now())");
const status = c => c.read("tourMyStatus(tourDerive(tour.startsAt, tour.roster, tour.results, Date.now()), myId)");

async function registered(n, lead = 15 * MIN) {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + lead;
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(launch(w, "p" + (i + 1), NAMES[i], startAt));
  await w.advance(500);
  cs.forEach(c => c.click("menuTourBtn"));
  await w.advance(500);
  cs.forEach(c => c.click("tourPrimary"));       // РЕГИСТЕР
  await eventually(w, () => cs.every(c => status(c) === "registered"), 30000);
  return { w, cs, startAt };
}
// Everyone still in sits down at their table, the stage plays out, and the
// people who finished go back to the tournament screen.
async function playStage(w, cs) {
  const live = cs.filter(c => ["waiting", "playing"].includes(status(c)));
  live.forEach(c => c.click("tourPrimary"));     // ШИРЭЭНДЭЭ ОРОХ
  const r = await playOut(w, { done: () => live.every(c => shown(c, "winnerOverlay")), consistency: false });
  ok(r.ok, "stage plays to the end: " + (r.reason || "") + (r.dump ? "\n" + r.dump : ""));
  await eventually(w, () => cs.every(c => live.every(x => {
    const d = derived(c); return d.stages.length > 0;
  })), 5000);
  live.forEach(c => c.click("playAgainBtn"));    // ТЭМЦЭЭН РҮҮ
  return live;
}

test("tables of 2–4, as even as possible", async () => {
  const w = new World({ strictRooms: true });
  const c = launch(w, "q1", "Alice", w.clock.now + MIN);
  const sizes = n => c.read("tourTableSizes(" + n + ")").join("+");
  eq(sizes(2), "2"); eq(sizes(4), "4"); eq(sizes(5), "3+2"); eq(sizes(7), "4+3");
  eq(sizes(9), "3+3+3"); eq(sizes(35), "4+4+4+4+4+4+4+4+3");
});

test("the bracket is the same on every client, seated from registrations alone", async () => {
  const { w, cs, startAt } = await registered(5);
  eq(derived(cs[0]).people.length, 5, "all five registrations landed (no write lost to a race)");
  await w.advance(startAt - OPEN - w.clock.now + 6000);   // past the draw
  const a = JSON.stringify(derived(cs[0]).stages);
  cs.forEach(c => eq(JSON.stringify(derived(c).stages), a, c.id + " sees the same draw"));
  eq(derived(cs[0]).stages[0].matches.map(m => m.playerIds.length).join("+"), "3+2");
  eq(derived(cs[0]).phase, "waiting", "drawn, not dealt before the start time");
});

test("register → stage 1 → final → one champion everybody agrees on", async () => {
  const { w, cs, startAt } = await registered(5);
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  // Sit down early: nothing is dealt before the start time.
  const firstLive = cs.filter(c => status(c) === "waiting");
  eq(firstLive.length, 5);
  firstLive.forEach(c => c.click("tourPrimary"));
  await w.advance(60000);
  ok(cs.every(c => !c.snap().dealActive), "no cards before 21:00");
  ok(cs.every(c => shown(c, "onlineOverlay")), "everyone waits at the table");
  await w.advance(startAt - w.clock.now + 4000);
  ok(cs.every(c => c.snap().dealActive), "dealt at the start time, every table full");
  ok(cs.every(c => c.read("turnSeconds()") === 60 && c.read("turnLeft") <= 60), "60 s a turn at a tournament table");
  const r = await playOut(w, { done: () => cs.every(c => shown(c, "winnerOverlay")), consistency: false });
  ok(r.ok, "stage 1 finishes: " + (r.reason || ""));
  cs.forEach(c => c.click("playAgainBtn"));
  await eventually(w, () => cs.every(c => derived(c).phase === "between"), 30000);
  const qualified = cs.filter(c => status(c) === "waiting");
  eq(qualified.length, 2, "two table winners go through");
  const out = cs.filter(c => status(c) === "eliminated");
  eq(out.length, 3, "three are out");
  const st = derived(cs[0]).stages;
  eq(st[1].startAt, Math.max(...st[0].matches.map(m => m.at)) + 20000, "the final starts 20 s after the last table");
  await w.advance(21000);                                    // the break
  eq(derived(cs[0]).phase, "playing", "the final is on");
  ok(derived(cs[0]).stages[1].isFinal, "one table left = the final");
  await playStage(w, cs);
  await eventually(w, () => cs.every(c => derived(c).phase === "complete"), 30000);
  const champ = derived(cs[0]).championId;
  ok(champ && qualified.some(c => c.id === champ), "the champion came through stage 1");
  cs.forEach(c => eq(derived(c).championId, champ, c.id + " agrees on the champion"));
  eq(status(cs.find(c => c.id === champ)), "champion");

  // The prize: the champion shares to their own News Feed (host-confirmed), and
  // everybody else sees them on the menu's "latest champion" strip.
  const winner = cs.find(c => c.id === champ);
  const posts = [];
  winner.sandbox.Usion.canShareToFeed = () => true;
  winner.sandbox.Usion.shareToFeed = (type, payload) => { posts.push({ type, payload }); return Promise.resolve({ success: true, postId: "p1" }); };
  await w.advance(6000);
  eq(winner.el("tourPrize").style.display, "block", "the champion sees their banner block");
  eq(winner.el("tourShareBtn").style.display, "block", "…with a share button when the host supports it");
  winner.click("tourShareBtn");
  await w.advance(2000);
  eq(posts.length, 1, "one feed post");
  eq(posts[0].type, "text");
  eq(posts[0].payload.path, "/tournament/" + startAt, "the post links back into the tournament");
  ok(/тэмцээнд түрүүллээ/.test(posts[0].payload.text), "caption");
  ok(posts[0].payload.card && posts[0].payload.card.title.indexOf(winner.name) === 0, "card names the champion");
  ok(winner.el("tourShareBtn").disabled, "shared once → button settles to shared");
  const loser = cs.find(c => c.id !== champ);
  eq(loser.el("tourPrize").style.display, "none", "nobody else gets the prize block");
  loser.click("tourBackBtn");
  await w.advance(3000);
  ok(!loser.el("menuChampStrip").hidden, "the menu shows the latest champion");
  ok(loser.el("menuChampStrip").textContent.indexOf(winner.name) >= 0, "…by name");
  const fame = loser.read("tourFame");
  eq(fame.list.length, 1, "one champion on the champions list");
  eq(fame.list[0].id, champ); eq(fame.list[0].w, 1, "with one win");
  eq(fame.events.length, 1, "the event is counted once, however many clients saw it finish");
  eq(w.errors().length, 0, "no script errors: " + w.errors().join("\n"));
});

test("closing the app mid-match: reopening it puts you straight back at your table", async () => {
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  await w.advance(startAt - w.clock.now + 4000);       // both auto-entered and were dealt in
  ok(cs.every(c => c.snap().dealActive), "the match is on");
  const r1 = await playOut(w, { done: () => cs[0].snap().roundMoveNo > 6, consistency: false, budget: 5 * MIN });
  ok(r1.ok, "a few moves in");
  cs[1].leaveRoom();                                  // Bob's app closes
  await w.advance(3000);
  const bob = launch(w, "p2", "Bob", startAt);        // …and he opens it again
  await eventually(w, () => bob.snap().gameStarted && bob.snap().mySeat >= 0, 15000);
  ok(bob.snap().gameStarted, "back in his seat without touching the menu");
  ok(!shown(bob, "menuOverlay") && !shown(bob, "tourOverlay"), "no menu, no tournament screen in the way");
  const r = await playOut(w, { done: () => [cs[0], bob].every(c => shown(c, "winnerOverlay")), consistency: false });
  ok(r.ok, "the match plays out with him in it: " + (r.reason || ""));
  await eventually(w, () => derived(cs[0]).phase === "complete", 20000);
  eq(w.errors().length, 0, "no script errors: " + w.errors().join("\n"));
});

test("leaving the table lobby on purpose is not undone by auto-entry", async () => {
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  await w.advance(startAt - OPEN - w.clock.now + 25000);   // drawn; both auto-enter the lobby
  ok(shown(cs[0], "onlineOverlay"), "Alice was taken to her table");
  cs[0].click("lobbyTourBtn");
  await w.advance(8000);
  ok(shown(cs[0], "tourOverlay") && !cs[0].read("tourCtx"), "she stays on the tournament screen");
  cs[0].click("tourPrimary");                             // until she taps in herself
  await w.advance(2000);
  ok(cs[0].read("tourCtx") !== null, "…then she is at the table");
});

test("watching other tables: anyone sees live scores on the bracket", async () => {
  const { w, cs, startAt } = await registered(4, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);          // not registered, just curious
  await w.advance(500);
  guest.click("menuTourBtn");
  await w.advance(startAt - w.clock.now + 4000);
  const r = await playOut(w, { done: () => guest.el("tourBody").textContent.indexOf("ШУУД") >= 0, consistency: false, budget: 20 * MIN });
  ok(r.ok, "the guest's bracket goes live: " + (r.reason || ""));
  const text = guest.el("tourBody").textContent;
  ok(/\d+\/20/.test(text), "with each player's points out of 20: " + text.slice(0, 200));
  let writes = 0;
  const gs = guest.sandbox.Usion.cloud.shared, set0 = gs.set;
  gs.set = (...a) => { writes++; return set0(...a); };
  await w.advance(30000);
  eq(writes, 0, "watching writes nothing");
});

test("watching a table: «Ширээ үзэх» opens the real game table in spectator mode", async () => {
  const { w, cs, startAt } = await registered(4, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  guest.click("menuTourBtn");
  await w.advance(startAt - OPEN - w.clock.now + 6000);   // past the draw
  cs.forEach(c => c.click("tourPrimary"));                 // everyone sits down
  await w.advance(startAt - w.clock.now + 4000);
  const btn = () => guest.sandbox.document.querySelector(".tour-watch-btn");
  await eventually(w, () => !!btn(), 20000);
  guest.el("tourBody").dispatch("click", { target: btn() });
  const doc = guest.sandbox.document;
  ok(doc.body.classList.contains("spectating"), "the game table opens in spectator mode");
  ok(!shown(guest, "tourOverlay"), "the bracket steps aside");
  let sawPlay = false;
  const r = await playOut(w, { done: () => {
    if (guest.el("tableCombo").querySelectorAll(".card").length) sawPlay = true;
    return sawPlay && guest.el("opponents").querySelectorAll(".opp").length === 3;
  }, consistency: false, budget: 10 * MIN });
  ok(r.ok, "the watcher sees three opponents around the table and the cards being played: " + (r.reason || ""));
  ok(guest.el("hand").querySelectorAll(".card.spec-back").length > 0, "the bottom seat's hand is face down");
  eq(guest.el("hand").querySelectorAll(".card").length, guest.el("hand").querySelectorAll(".spec-back").length, "never a face");
  eq(guest.el("hand").querySelectorAll(".pip").length, 0, "no rank or suit drawn in the hand");
  ok(guest.el("meName").textContent.length > 0, "the bottom seat carries its player's name");
  await eventually(w, () => guest.el("specViewers").textContent === "1" && !guest.el("specViewersBox").hidden, 30000);
  ok(guest.el("specViewers").textContent === "1", "the watcher sees the eye badge count the viewers");
  await eventually(w, () => cs.every(c => !c.el("tableViewers").hidden && c.el("tableViewersN").textContent === "1"), 40000);
  ok(true, "every player at the table sees one viewer on the eye badge");
  eq(guest.read("players.length"), 0, "the watcher's own game state is untouched");
  const writes = [];
  const gs = guest.sandbox.Usion.cloud.shared, set0 = gs.set;
  gs.set = (...a) => { writes.push({ key: a[0], at: w.clock.now }); return set0(...a); };
  const t0 = w.clock.now;
  const r2 = await playOut(w, { done: () => /Ялагч/.test(guest.el("turnLine").textContent), consistency: false, budget: 30 * MIN });
  ok(r2.ok, "the watcher sees the table's winner: " + (r2.reason || "") + " / " + guest.el("turnLine").textContent);
  ok(writes.every(x => /\.v1\.1$/.test(x.key)), "a watcher writes only its viewer stamp: " + writes.map(x => x.key).join(","));
  const mins = Math.max(1, (w.clock.now - t0) / MIN);
  ok(writes.length / mins <= 4, "about one stamp every 20 s: " + writes.length + " in " + mins.toFixed(1) + " min");
  guest.click("specExit");
  ok(!doc.body.classList.contains("spectating") && shown(guest, "tourOverlay"), "Гарах returns to the bracket");
  await w.advance(3000);
  const rec = await guest.sandbox.Usion.cloud.shared.get(guest.read("tourViewKey(tour.startsAt, 1, 1)"));
  eq(guest.read("tourViewCount(" + JSON.stringify(rec) + ", Date.now())"), 0, "leaving takes the watcher off the count");
});

test("«Ширээ үзэх» on a table with no picture sends the watcher back with a word, not a spinner", async () => {
  // 2026-11-19: a table nobody sat at (or still waiting for its players) offered
  // «Ширээ үзэх», and the watcher sat on "waiting for this table" forever.
  const { w, cs, startAt } = await registered(6, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  guest.click("menuTourBtn");
  const ms = cs[0].read("tourDerive(tour.startsAt, tour.roster, {}, tour.startsAt)").stages[0].matches;
  eq(ms.length, 2, "two tables");
  const t1 = ms[0].playerIds;
  cs.filter(c => !t1.includes(c.id)).forEach(c => c.click("tourBackBtn"));   // table 2: registered, never came
  await w.advance(startAt - OPEN - w.clock.now + 6000);   // past the draw
  cs.filter(c => t1.includes(c.id)).forEach(c => { if (shown(c, "tourOverlay")) c.click("tourPrimary"); });   // table 1 sits down
  await w.advance(startAt - w.clock.now + 4000);
  const watchBtn = n => guest.sandbox.document.querySelector('.tour-watch-btn[data-watch-table="' + n + '"]');
  await eventually(w, () => !!watchBtn(ms[0].number), 30000);
  ok(!!watchBtn(ms[0].number), "the table being played offers «Ширээ үзэх»");
  // A table with no live scores may still be at play (its entry lost), so it
  // keeps the button — but with no picture the watcher goes back to the bracket
  // instead of waiting forever.
  ok(!!watchBtn(ms[1].number), "so does the table with no live scores");
  guest.el("tourBody").dispatch("click", { target: watchBtn(ms[1].number) });
  ok(guest.sandbox.document.body.classList.contains("spectating"), "spectating");
  await w.advance(16000);
  ok(!guest.sandbox.document.body.classList.contains("spectating"), "no picture in 15 s → out of spectator mode");
  ok(shown(guest, "tourOverlay"), "back on the bracket");
  ok(/явахгүй/.test(guest.el("toast").textContent), "and told why: " + guest.el("toast").textContent);
});

test("a table's live entry lost to another table's write is written again", async () => {
  const w = new World({ strictRooms: true });
  const c = launch(w, "lv1", "Alice", w.clock.now + 30 * MIN);
  await w.advance(500);
  // Two tables publish at once; the shared record ends up with only the other one.
  c.run(`tourCtx = { startsAt: 1, stage: 1, table: 2, roster: [myId] }; gameStarted = true; online = true;
         roomPlayerIds = [myId, "b"]; players = [{ total: 0 }, { total: 0 }]; isPrimaryAuthority = () => true;`);
  const shared = c.sandbox.Usion.cloud.shared, set0 = shared.set;
  let clobber = true;
  shared.set = (k, v) => set0(k, v).then(r => {
    if (clobber && /\.l1$/.test(k)) { clobber = false; return set0(k, { v: 1, t: { 1: { s: {}, o: [], r: 1, at: 5 } } }).then(() => r); }
    return r;
  });
  c.run("tourPublishLive()");
  await w.advance(4000);
  c.run("tourPublishLive()");
  await w.advance(4000);
  const rec = await shared.get(c.read("tourLiveKey(1, 1)"));
  ok(rec && rec.t && rec.t[2] && rec.t[1], "both tables are in the record again: " + JSON.stringify(rec));
  eq(rec.t[2].r, 1, "and the rewrite is not counted as a new round");
});

test("no bots at a tournament table, even when «Онлайн» falls back to its room", async () => {
  // 2026-11-17: «Бот …» seats at tournament tables. Players sit at their table
  // during the wait before 21:00; one walks away, and the reopened app is handed
  // that live room as its launch room. «Онлайн» (no world rooms here) fell back to
  // it as an OPEN table — which deals itself at once, bots in the empty seats.
  const { w, cs, startAt } = await registered(3, 15 * MIN);
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  cs.forEach(c => c.click("tourPrimary"));               // everyone waits at the table
  await w.advance(20000);
  const room = cs[0].read("tourCtx && tourCtx.roomId");
  ok(!!room, "the table has a platform room: " + room);
  cs[0].click("lobbyTourBtn");                           // walks away before the start…
  cs[0].click("tourBackBtn");                            // …to the menu
  cs[0].run("launchRoomId = " + JSON.stringify(room));   // the platform hands the live room back
  cs[0].click("menuOnlineBtn");                          // «Онлайн»
  await w.advance(30000);
  const bots = c => c.read("players.filter(p => p.isBot).map(p => p.name)");
  ok(!(cs[0].read("openTable") && cs[0].read("voiceRoomId") === room),
    "the walker's open table does not run inside the tournament room (bots: " + bots(cs[0]).join(",") + ")");
  cs[1].run("Usion.game.requestSync(0)");                // a phone coming back replays the room's log
  await w.advance(5000);
  cs.slice(1).forEach(c => {
    eq(bots(c).length, 0, c.id + " at the tournament table sees no bot: " + bots(c).join(","));
    eq(c.read("openTable"), false, c.id + " still runs the tournament rules");
  });
  // And the match that does start at 21:00 is the real one, bot-free.
  await w.advance(startAt - w.clock.now + 70000);
  await playOut(w, { done: () => false, consistency: false, budget: 2 * MIN, stallMs: 10 * MIN });
  cs.slice(1).forEach(c => eq(bots(c).length, 0, c.id + " still no bot after the start: " + bots(c).join(",")));
});

test("capacity: 200 registrations with photos fit the one record, 50 tables", async () => {
  const w = new World({ strictRooms: true });
  const c = launch(w, "q1", "Alice", w.clock.now + 30 * MIN);
  const avatar = "https://cdn.usions.com/avatars/" + "a".repeat(140) + ".jpg";   // a long real-world url
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: (i.toString(16).padStart(6, "0") + "a1b2c3d4e5f6a7b8c9").slice(0, 24), n: "Ганбаатар-Эрдэнэ" + i, a: avatar }));
  const bytes = Buffer.byteLength(JSON.stringify({ v: 1, list: rows }), "utf8");
  ok(bytes < 64 * 1024, "200 rows = " + bytes + " bytes (< 64 KB)");
  const d = c.read("tourDerive(" + (w.clock.now + 5 * MIN) + ", " + JSON.stringify(rows) + ", {}, " + (w.clock.now + 5 * MIN) + ")");
  eq(d.stages[0].matches.length, 50, "50 tables of four");
  eq(d.people.length, 200);
});

test("polling stays well under Usion's 60 shared-storage ops a minute", async () => {
  const { w, cs, startAt } = await registered(4, 15 * MIN);
  const c = cs[0];
  let ops = 0;
  const shared = c.sandbox.Usion.cloud.shared;
  ["get", "set", "keys", "remove"].forEach(k => { const f = shared[k]; shared[k] = (...a) => { ops++; return f(...a); }; });
  c.click("lobbyTourBtn");                                  // (no-op unless at a table)
  ops = 0; await w.advance(MIN);
  ok(ops <= 30, "registration open, screen up: " + ops + " ops/min");
  await w.advance(startAt - w.clock.now + 4000);
  const r = await playOut(w, { done: () => w.clock.now > startAt + 3 * MIN, consistency: false, budget: 5 * MIN });
  ops = 0;
  await playOut(w, { done: () => false, consistency: false, budget: MIN, stallMs: 10 * MIN });
  ok(ops <= 30, "at the table mid-match: " + ops + " ops/min");
});

test("the bracket during play, dead-table checks included, stays under 30 ops a minute", async () => {
  const { w, cs, startAt } = await registered(6, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  guest.click("menuTourBtn");
  await w.advance(startAt - w.clock.now + 2 * MIN);
  let ops = 0;
  const shared = guest.sandbox.Usion.cloud.shared;
  ["get", "set", "keys", "remove"].forEach(k => { const f = shared[k]; shared[k] = (...a) => { ops++; return f(...a); }; });
  await playOut(w, { done: () => false, consistency: false, budget: MIN, stallMs: 10 * MIN });
  ok(shown(guest, "tourOverlay"), "on the bracket");
  ok(ops <= 30, "bracket, two tables at play: " + ops + " ops/min");
});

test("a no-show is cut after the 30 s grace; alone at the table = walkover", async () => {
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  cs[1].click("tourBackBtn");                   // Bob wanders off to the menu and never comes back
  await w.advance(startAt - w.clock.now + 2000);
  const [a] = cs;
  eq(status(a), "playing");
  a.click("tourPrimary");                       // only Alice turns up
  await w.advance(20000);
  ok(!a.snap().dealActive, "still waiting inside the 30 s grace");
  await w.advance(30000);
  await eventually(w, () => derived(a).phase === "complete", 20000);
  eq(derived(a).championId, "p1", "Alice goes through on a walkover (and it was the final)");
  cs[1].click("menuTourBtn");                   // Bob looks later
  await eventually(w, () => derived(cs[1]).championId === "p1", 20000);
  eq(derived(cs[1]).championId, "p1", "Bob's client agrees");
});

test("a table nobody came to closes after the 30 s grace — the next stage does not wait 50 minutes", async () => {
  // 2026-11-17: 13 of 26 tables had nobody; they closed only by the 50-minute
  // stall and the second stage started at 21:50.
  const { w, cs, startAt } = await registered(6, 15 * MIN);
  // The draw is fixed by the registrations: work it out before it happens.
  const st1 = cs[0].read("tourDerive(tour.startsAt, tour.roster, {}, tour.startsAt)").stages[0];
  eq(st1.matches.length, 2, "two tables of three");
  const byId = id => cs.find(c => c.id === id);
  const t1 = st1.matches[0].playerIds.map(byId), t2 = st1.matches[1].playerIds.map(byId);
  t2.forEach(c => c.click("tourBackBtn"));                // table 2: registered, then never came back
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  t1.forEach(c => { if (shown(c, "tourOverlay")) c.click("tourPrimary"); });   // table 1 sits down
  await w.advance(startAt - w.clock.now + 4000);
  ok(t1.every(c => c.snap().dealActive), "table 1 is dealt");
  const r = await playOut(w, { done: () => t1.every(c => shown(c, "winnerOverlay")), consistency: false, budget: 30 * MIN });
  ok(r.ok, "table 1 finishes: " + (r.reason || ""));
  t1.forEach(c => c.click("playAgainBtn"));               // back to the bracket
  await eventually(w, () => derived(t1[0]).stages[0].matches[1].done, 60000);
  ok(derived(t1[0]).stages[0].matches[1].done, "the empty table is closed");
  const m2 = derived(t1[0]).stages[0].matches[1];
  eq(m2.winnerId, null, "the empty table closed without a winner");
  eq(m2.at, startAt + 30000, "…at the moment the 30 s grace ended");
  const d = derived(t1[0]);
  ok(w.clock.now < startAt + 20 * MIN, "decided long before the 50-minute stall");
  ok(d.phase === "complete" || d.phase === "between" || d.phase === "playing", "the event moves on: " + d.phase);
  eq(d.championId, st1.matches[0].winnerId || derived(t1[0]).stages[0].matches[0].winnerId, "table 1's winner is the champion");
  t2[0].click("menuTourBtn");
  await eventually(w, () => derived(t2[0]).phase === "complete", 30000);
  eq(derived(t2[0]).championId, d.championId, "a client that was away agrees");
});

test("a table at play is never closed as empty, even if its room drops out of the record", async () => {
  const { w, cs, startAt } = await registered(2, 15 * MIN);
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  cs.forEach(c => c.click("tourPrimary"));
  await w.advance(startAt - w.clock.now + 4000);
  ok(cs.every(c => c.snap().dealActive), "dealt");
  // A crossed read-modify-write wipes the table's room from the record.
  const key = cs[0].read("tourRoomKey(tour.startsAt, 1)");
  await cs[0].sandbox.Usion.cloud.shared.set(key, { v: 1, t: {} });
  await playOut(w, { done: () => false, consistency: false, budget: 3 * MIN, stallMs: 10 * MIN });
  const rec = await cs[0].sandbox.Usion.cloud.shared.get(key);
  ok(rec && rec.t && typeof rec.t[1] === "string", "the table put its room back");
  const m = derived(cs[0]).stages[0].matches[0];
  ok(!m.done || m.winnerId !== null, "and was not closed as empty");
});

test("a live table whose room is missing when somebody else checks is not closed as empty", async () => {
  // 2026-11-23: table 6 (and stage-2 tables 1 and 4) were dealt and playing, but
  // their room had dropped out of the shared r<stage> record — a crossed
  // read-modify-write — at the moment another client ran the empty-table check.
  // Filed {w: null, at: start+30 s}; the players were thrown out mid-match.
  const { w, cs, startAt } = await registered(6, 15 * MIN);
  const st1 = cs[0].read("tourDerive(tour.startsAt, tour.roster, {}, tour.startsAt)").stages[0];
  eq(st1.matches.length, 2, "two tables of three");
  const byId = id => cs.find(c => c.id === id);
  const t1 = st1.matches[0].playerIds.map(byId);
  // Somebody looking at the bracket never sees table 1 in the room record.
  const guest = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  guest.click("menuTourBtn");
  const key = cs[0].read("tourRoomKey(tour.startsAt, 1)");
  [guest].forEach(c => {
    const shared = c.sandbox.Usion.cloud.shared, get = shared.get;
    shared.get = k => Promise.resolve(get(k)).then(rec => {
      if (k !== key || !rec || !rec.t) return rec;
      const t = Object.assign({}, rec.t); delete t[1];
      return Object.assign({}, rec, { t });
    });
  });
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  cs.forEach(c => { if (shown(c, "tourOverlay")) c.click("tourPrimary"); });   // everybody sits down
  await w.advance(startAt - w.clock.now + 4000);
  ok(cs.every(c => c.snap().dealActive), "both tables are dealt");
  await w.advance(3 * MIN);                                // nobody hurries: the tables are still at play at +60 s
  const m1 = derived(guest).stages[0].matches[0];
  ok(!m1.done || m1.winnerId !== null, "table 1 was not filed as a table nobody came to: " + JSON.stringify(m1));
  ok(t1.every(c => !shown(c, "tourOverlay")), "table 1's players are still at their table");
});

test("arriving late and alone is not a walkover: the table closes without a winner", async () => {
  // 2026-11-17: somebody sat down 18 minutes in, alone, and went through.
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  cs.forEach(c => c.click("tourBackBtn"));                // nobody is there at the start
  await w.advance(startAt - w.clock.now + 65000);        // the 30 s grace is over
  const a = cs[0];
  a.click("menuTourBtn");
  await w.advance(500);
  a.click("tourPrimary");                                  // Alice sits down, late
  await w.advance(30000);
  await eventually(w, () => derived(a).stages[0].matches[0].done, 30000);
  eq(derived(a).stages[0].matches[0].winnerId, null, "no winner");
  ok(/30 секундийн дотор ирээгүй/.test(a.el("onlineStatus").textContent), "and she is told why: " + a.el("onlineStatus").textContent);
  eq(status(a), "eliminated");
});

test("fewer than two registrations cancels the event", async () => {
  const { w, cs, startAt } = await registered(1, 11 * MIN);
  await w.advance(startAt - OPEN - w.clock.now + 2000);
  await w.advance(6000);
  eq(derived(cs[0]).phase, "cancelled");
  eq(derived(cs[0]).reason, "few");
});

test("withdrawing removes you; registration closes before the draw", async () => {
  const { w, cs, startAt } = await registered(3);
  cs[2].click("tourSecondary");                  // withdraw
  await eventually(w, () => status(cs[2]) === "guest", 10000);
  await w.advance(12000);                        // the others' next refresh
  eq(derived(cs[0]).people.length, 2, "the others see two");
  await w.advance(startAt - OPEN - w.clock.now - 5000);   // inside the guard window
  cs[2].el("tourPrimary").dataset.act = "register";
  cs[2].click("tourPrimary");
  await w.advance(8000);
  eq(status(cs[2]), "guest", "too late to register");
});

test("a forged opening deal (stranger, or seats off the list) is refused", async () => {
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  await w.advance(startAt - w.clock.now - 30000);
  cs.forEach(c => c.click("tourPrimary"));
  await w.advance(3000);
  const a = cs[0];
  eq(a.read('tourOpeningDealOk({order:["zz","p1"],open:false,loseAt:20}, "zz")'), false, "stranger");
  eq(a.read('tourOpeningDealOk({order:["p2","p1","zz"],open:false,loseAt:20}, "p2")'), false, "extra seat");
  eq(a.read('tourOpeningDealOk({order:["p2","p1"],open:false,loseAt:30}, "p2")'), false, "different target");
  eq(a.read('tourOpeningDealOk({order:["p2","p1"],open:false,loseAt:20}, "p2")'), true, "the real thing");
});

// A fake 13 reminder server (13/server, same origin) + permission prompt on one client.
function withReminder(c, opts = {}) {
  const calls = [], perms = [], muted = [];
  let state = { configured: opts.configured !== false, decided: false, enabled: false, events: [], lead_ms: 180000 };
  c.sandbox.Usion.config = { apiUrl: "https://api.test/", serviceId: "svc13", authToken: "tok-1" };
  c.sandbox.Usion.user = { getToken: () => "tok-live" };
  c.sandbox.Usion.permissions = {
    request: (list, o) => { perms.push({ list, o }); return Promise.resolve({ granted: opts.grant !== false }); },
    has: () => Promise.resolve(opts.revoked ? false : perms.length > 0 || !!opts.hasPermission),
  };
  c.sandbox.Usion.notify = { setMuted: v => { muted.push(v); return Promise.resolve(); }, isMuted: () => Promise.resolve(false) };
  c.sandbox.fetch = (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body });
    if (url === "/api/reminder" && init.method === "PUT") state = Object.assign({}, state, { decided: true, enabled: body.enabled });
    if (url === "/api/reminder/event" && init.method === "POST") state = Object.assign({}, state, { events: state.events.concat([body.startsAt]) });
    if (url === "/api/reminder/event" && init.method === "DELETE") state = Object.assign({}, state, { events: state.events.filter(x => x !== body.startsAt) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(Object.assign({}, state)) });
  };
  return { calls, perms, muted, state: () => state };
}
const remindText = c => c.el("tourRemind").style.display === "none" ? "" : c.el("tourRemind").textContent;
const remindBtn = (c, label) => {
  const find = el => { if (el.tagName === "BUTTON" && el.textContent === label) return el;
    for (const k of el.children || []) { const f = find(k); if (f) return f; } return null; };
  return find(c.el("tourRemind"));
};

test("reminder: offered after registering, 3 min before the start, on only after the permission is granted", async () => {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + 30 * MIN;
  const c = launch(w, "r1", "Alice", startAt);
  const fake = withReminder(c);
  await w.advance(500);
  c.click("menuTourBtn");
  await w.advance(2000);
  eq(remindText(c), "", "nothing offered before registering");
  c.click("tourPrimary");                                    // register
  await eventually(w, () => remindText(c).indexOf("сануулга авах уу") >= 0, 15000);
  ok(remindText(c).indexOf("3 минутын өмнө") >= 0, "the offer says 3 minutes: " + remindText(c));
  const hm = c.read("tourFmtClock(" + (startAt - 3 * MIN) + ")");
  ok(remindText(c).indexOf(hm) >= 0, "and names the clock time " + hm + ": " + remindText(c));
  ok(fake.state().events.includes(startAt), "the server was told about the registration");
  remindBtn(c, "Асаах").dispatch("click");
  await w.advance(2000);
  eq(fake.perms.length, 1, "Usion's own permission prompt, on the tap");
  eq(fake.muted.join(), "false", "and the app unmuted");
  const put = fake.calls.find(x => x.method === "PUT");
  ok(put && put.body.enabled === true, "subscribed");
  eq(put.url, "/api/reminder", "on 13's own server");
  eq(put.auth, "Bearer tok-live", "with the live token, not the boot copy");
  ok(remindText(c).indexOf("асаалттай") >= 0, "the card turns into the on/off line: " + remindText(c));
  remindBtn(c, "Унтраах").dispatch("click");
  await w.advance(2000);
  ok(fake.calls.filter(x => x.method === "PUT").pop().body.enabled === false, "turned off");
  ok(remindText(c).indexOf("унтраалттай") >= 0, remindText(c));
});

test("reminder: withdrawing takes the event back from the server", async () => {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + 30 * MIN;
  const c = launch(w, "r5", "Erin", startAt);
  const fake = withReminder(c);
  await w.advance(500);
  c.click("menuTourBtn");
  await w.advance(1000);
  c.click("tourPrimary");
  await eventually(w, () => fake.state().events.includes(startAt), 15000);
  c.click("tourSecondary");                                  // withdraw
  await eventually(w, () => !fake.state().events.includes(startAt), 15000);
  ok(fake.calls.some(x => x.method === "DELETE" && x.url === "/api/reminder/event" && x.body.startsAt === startAt), "DELETE sent");
});

test("reminder: on, but the permission was revoked since → says so", async () => {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + 30 * MIN;
  const c = launch(w, "r6", "Fay", startAt);
  const fake = withReminder(c, { revoked: true });
  fake.state().decided = true;
  await w.advance(500);
  c.sandbox.fetch("/api/reminder", { method: "PUT", headers: {}, body: JSON.stringify({ enabled: true }) });
  c.click("menuTourBtn");
  await w.advance(1000);
  c.click("tourPrimary");
  await eventually(w, () => remindText(c).indexOf("Usion-д") >= 0, 15000);
});

test("reminder: a denied permission subscribes nothing; Later records the choice", async () => {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + 30 * MIN;
  const a = launch(w, "r2", "Bob", startAt), b = launch(w, "r3", "Chuck", startAt);
  const fa = withReminder(a, { grant: false }), fb = withReminder(b);
  await w.advance(500);
  [a, b].forEach(c => c.click("menuTourBtn"));
  await w.advance(1000);
  [a, b].forEach(c => c.click("tourPrimary"));
  await eventually(w, () => [a, b].every(c => remindText(c).indexOf("сануулга авах уу") >= 0), 15000);
  remindBtn(a, "Асаах").dispatch("click");
  remindBtn(b, "Дараа").dispatch("click");
  await w.advance(2000);
  eq(fa.calls.filter(x => x.method === "PUT").length, 0, "denied → no subscription");
  const pb = fb.calls.filter(x => x.method === "PUT");
  ok(pb.length === 1 && pb[0].body.enabled === false, "Later → saved as not now");
  eq(fb.perms.length, 0, "Later never prompts");
  ok(remindText(b).indexOf("унтраалттай") >= 0, "a one-line switch remains: " + remindText(b));
});

test("reminder: hidden when the service has no reminder configured", async () => {
  const w = new World({ strictRooms: true });
  const c = launch(w, "r4", "Dana", w.clock.now + 30 * MIN);
  withReminder(c, { configured: false });
  await w.advance(500);
  c.click("menuTourBtn");
  await w.advance(1000);
  c.click("tourPrimary");
  await w.advance(8000);
  eq(remindText(c), "", "no card");
});

test("the 1 s redraw leaves the screen alone: rules stay open, rows are not rebuilt", async () => {
  const { w, cs } = await registered(3);
  const c = cs[0];
  const rules = c.el("tourRules");
  rules.open = true;                                       // the player opened ДҮРЭМ
  const row = c.el("tourBody").children[1];                 // an entrant row
  row.__mark = 1;
  await w.advance(5000);                                    // five redraw ticks
  ok(c.el("tourRules") === rules && rules.open, "the rules are untouched");
  ok(c.el("tourBody").children[1] && c.el("tourBody").children[1].__mark === 1, "same row node: nothing rebuilt without a change");
  eq(c.el("tourRulesList").children.length, 7, "seven rules");
});

test("opening the app: «Оролцоё» on the invitation registers you", async () => {
  const w = new World({ strictRooms: true });
  const c = launch(w, "i1", "Alice", w.clock.now + 2 * 3600e3);
  await w.advance(2000);
  ok(shown(c, "tourInviteOverlay"), "the invitation is up");
  ok(/тэмцээнтэй/.test(c.el("tourInviteTitle").textContent), c.el("tourInviteTitle").textContent);
  c.click("tourInviteYes");
  await eventually(w, () => status(c) === "registered", 15000);
  eq(status(c), "registered", "registered");
  ok(shown(c, "tourOverlay") && !shown(c, "tourInviteOverlay"), "on the tournament screen");
});

test("opening the app: «Үгүй» leaves you on the home page, and it isn't asked again today", async () => {
  const w = new World({ strictRooms: true });
  const c = launch(w, "i2", "Bob", w.clock.now + 2 * 3600e3);
  await w.advance(2000);
  c.click("tourInviteNo");
  await w.advance(1000);
  ok(!shown(c, "tourInviteOverlay") && shown(c, "menuOverlay"), "home page");
  eq(status(c), "guest", "not registered");
  c.run("tourResumeOnLaunch(false)");                      // as if the app were opened again
  await w.advance(2000);
  ok(!shown(c, "tourInviteOverlay"), "not asked twice for the same event");
});

test("no invitation once registered, after registration closes, or for a chat invite", async () => {
  const { w, cs, startAt } = await registered(1, 3 * 3600e3);
  const again = launch(w, "p1", "Alice", startAt);         // already registered, opens the app again
  const late = launch(w, "i3", "Chuck", w.clock.now + 5 * MIN);   // past the 20:50 close
  const chat = w.add("i4", "Dana", { mode: "multiplayer", roomId: w.roomId });
  chat.run("window.T13_TOUR_START_AT = " + startAt);
  chat.start({ userId: "i4", userName: "Dana", roomId: w.roomId, playerIds: [] });
  await w.advance(3000);
  ok(!shown(again, "tourInviteOverlay"), "registered: no invitation");
  ok(!shown(late, "tourInviteOverlay"), "registration closed: no invitation");
  ok(!shown(chat, "tourInviteOverlay"), "chat invite: straight to the waiting room");
});

test("real rooms: one platform room per table, created over REST and joined by its players", async () => {
  const { w, cs, startAt } = await registered(5);
  await w.advance(startAt - w.clock.now + 6000);
  ok(cs.every(c => c.snap().dealActive), "both tables dealt (under the real relay's join rules)");
  const tables = new Map();
  cs.forEach(c => { const r = c.read("tourCtx && tourCtx.roomId"); tables.set(r, (tables.get(r) || 0) + 1); });
  eq([...tables.values()].sort().join("+"), "2+3", "players of each table share one room: " + JSON.stringify([...tables]));
  ok([...tables.keys()].every(id => /^room_\d+$/.test(id)), "rooms the server named, not made-up ids");
  ok(w.server.restLog.some(e => /\/games\/rooms$/.test(e.url) && e.status === 200), "rooms were created over REST");
  ok(w.server.restLog.some(e => /\/join$/.test(e.url) && e.status === 200), "…and joined over REST");
});

test("real rooms: everybody arriving in the same instant still ends up at one table", async () => {
  const { w, cs, startAt } = await registered(4, 16 * MIN);
  cs.forEach(c => c.click("tourBackBtn"));                   // all on the menu…
  await w.advance(startAt - w.clock.now - 20000);
  cs.forEach(c => c.click("menuTourBtn"));                  // …and all tap in together
  await w.advance(30000);
  const rooms = new Set(cs.map(c => c.read("tourCtx && tourCtx.roomId")));
  eq(rooms.size, 1, "one room for the table: " + [...rooms].join(", "));
  ok(cs.every(c => c.snap().dealActive), "dealt, all four seated");
  eq(cs[0].snap().numPlayers, 4);
});

test("real rooms: a failed join is said out loud, never a silent bounce", async () => {
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  cs.forEach(c => { c.sandbox.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }); });
  await w.advance(startAt - w.clock.now + 3000);
  const c = cs[0];
  ok(shown(c, "tourOverlay"), "back on the tournament screen");
  ok(/холбогдож чадсангүй/.test(c.el("toast").textContent), "with a message: " + c.el("toast").textContent);
  eq(c.el("tourPrimary").dataset.act, "enter", "and «Ширээндээ орох» to try again");
});

// The table that held up every evening: its players sat down early (auto-entry
// after the 20:50 draw), so it has a room, and then they were gone by the start —
// app closed, phone locked. Nobody at the table runs any javascript, so nobody
// files anything, and the empty-table close skips it because it has a room. The
// whole event waited for the 50-minute stall.
async function stageWithDeadTable() {
  const { w, cs, startAt } = await registered(6, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);          // somebody watching the bracket
  await w.advance(500);
  guest.click("menuTourBtn");
  const st1 = cs[0].read("tourDerive(tour.startsAt, tour.roster, {}, tour.startsAt)").stages[0];
  eq(st1.matches.length, 2, "two tables of three");
  const byId = id => cs.find(c => c.id === id);
  const t1 = st1.matches[0].playerIds.map(byId), t2 = st1.matches[1].playerIds.map(byId);
  await w.advance(startAt - OPEN - w.clock.now + 30000);  // drawn: everybody is auto-entered
  ok(t2.every(c => c.read("tourCtx") !== null), "table 2 sat down early");
  const rooms = await cs[0].sandbox.Usion.cloud.shared.get(cs[0].read("tourRoomKey(tour.startsAt, 1)"));
  ok(rooms && rooms.t && typeof rooms.t[2] === "string", "so table 2 has a room");
  t2.forEach(c => { c.netDrop(); c.freeze(); });          // …then both phones go dark
  return { w, cs, startAt, guest, t1, t2 };
}

test("a table whose players sat down early and then went dark closes in minutes, not 50", async () => {
  const { w, startAt, guest, t1 } = await stageWithDeadTable();
  await w.advance(startAt - w.clock.now + 4000);
  ok(t1.every(c => c.snap().dealActive), "table 1 is dealt");
  const r = await playOut(w, { done: () => derived(guest).stages[0].matches[1].done, consistency: false,
                               budget: 10 * MIN, stallMs: 20 * MIN });
  ok(r.ok, "the dead table is closed: " + (r.reason || ""));
  const m2 = derived(guest).stages[0].matches[1];
  eq(m2.winnerId, null, "without a winner");
  ok(m2.at < startAt + 8 * MIN, "within minutes of the start: +" + ((m2.at - startAt) / 1000) + " s");
  const m1 = derived(guest).stages[0].matches[0];
  ok(!m1.done || m1.winnerId !== null, "the table at play is left alone");
});

test("players who wake up at a table that was closed under them are told and sent back", async () => {
  const { w, startAt, guest, t2 } = await stageWithDeadTable();
  await w.advance(startAt - w.clock.now + 4000);
  await playOut(w, { done: () => derived(guest).stages[0].matches[1].done, consistency: false, budget: 10 * MIN, stallMs: 20 * MIN });
  ok(derived(guest).stages[0].matches[1].done, "closed");
  const a = t2[0];
  a.thaw(); a.netRestore();
  await eventually(w, () => shown(a, "tourOverlay"), 60000);
  ok(shown(a, "tourOverlay") && !a.read("tourCtx"), "back on the bracket");
  ok(/хаагдсан/.test(a.el("toast").textContent), "told the table was closed: " + a.el("toast").textContent);
});

test("the table's lead locks the phone: scores and the picture keep coming, and the table is not closed", async () => {
  const { w, cs, startAt } = await registered(3, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  guest.click("menuTourBtn");
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  cs.forEach(c => { if (shown(c, "tourOverlay")) c.click("tourPrimary"); });
  await w.advance(startAt - w.clock.now + 4000);
  ok(cs.every(c => c.snap().dealActive), "dealt");
  const lead = cs.find(c => c.read("isPrimaryAuthority()"));
  ok(!!lead, "one client is the lead");
  lead.freeze();                                            // locked: still in the room, runs nothing
  const shared = guest.sandbox.Usion.cloud.shared;
  const wkey = guest.read("tourWatchKey(tour.startsAt, 1, 1)"), lkey = guest.read("tourLiveKey(tour.startsAt, 1)");
  await w.advance(5000);
  const w0 = await shared.get(wkey);
  const l0 = await shared.get(lkey);
  await playOut(w, { done: () => false, consistency: false, budget: 6 * MIN, stallMs: 20 * MIN });
  const w1 = await shared.get(wkey);
  ok(w1 && (!w0 || w1.at !== w0.at), "the picture is still being posted");
  ok(!derived(guest).stages[0].matches[0].done, "6 minutes in, the table is still open (not closed as dead)");
  // Every turn of the sleeping lead takes its full clock, so a round is slow:
  // the bracket must still show the scores move when it ends.
  const liveSig = () => guest.read("JSON.stringify(((tour.live[1] || {})[1] || {}).s || null)");
  const s0 = liveSig();
  const r = await playOut(w, { done: () => liveSig() !== s0 || derived(guest).stages[0].matches[0].done,
                               consistency: false, budget: 40 * MIN, stallMs: 20 * MIN });
  ok(r.ok && liveSig() !== s0, "the bracket's scores move with the lead asleep: " + s0 + " → " + liveSig() + " " + (r.reason || ""));
  const m = derived(guest).stages[0].matches[0];
  ok(!m.done || m.winnerId !== null, "and the table is never closed as dead");
});

test("watching a table still gathering shows who is there, not an endless 'waiting'", async () => {
  const { w, cs, startAt } = await registered(4, 15 * MIN);
  const guest = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  guest.click("menuTourBtn");
  const st1 = cs[0].read("tourDerive(tour.startsAt, tour.roster, {}, tour.startsAt)").stages[0];
  const t1 = st1.matches[0].playerIds.map(id => cs.find(c => c.id === id));
  cs.filter(c => !t1.includes(c)).forEach(c => c.click("tourBackBtn"));   // table 2 never comes
  await w.advance(startAt - OPEN - w.clock.now + 30000);    // drawn: table 1 is auto-entered
  ok(t1[0].read("tourCtx") !== null, "at the table");
  t1[0].click("lobbyTourBtn");                              // table 1: one of the four walks out
  await w.advance(startAt - w.clock.now + 5000);            // started, still inside the 30 s grace
  const btn = () => guest.sandbox.document.querySelector('.tour-watch-btn[data-watch-table="1"]');
  await eventually(w, () => !!btn(), 10000);
  guest.el("tourBody").dispatch("click", { target: btn() });
  await w.advance(4000);
  ok(guest.sandbox.document.body.classList.contains("spectating"), "spectating");
  ok(/3\/4/.test(guest.el("turnLine").textContent), "the watcher sees 3 of 4 at the table: " + guest.el("turnLine").textContent);
});

// ── Phone clocks set by hand (c.skew) ──
// The tests above read Date.now() through the page; a skewed phone's own idea of
// the bracket has to be read on its corrected clock.
const derivedT = c => c.read("tourDerive(tour.startsAt, tour.roster, tour.results, tourNow())");
const regList = async (c) => {
  const rec = await c.sandbox.Usion.cloud.shared.get(c.read("tourRegKey(tour.startsAt)"));
  return (rec && rec.list || []).map(p => p.id);
};

test("a phone whose clock is behind cannot register after the draw and split the bracket", async () => {
  const { w, cs, startAt } = await registered(4, 15 * MIN);
  const late = launch(w, "p5", "Erdene", startAt);
  late.skew = -3 * MIN;                                   // set by hand, three minutes slow
  await w.advance(startAt - OPEN - w.clock.now + 30000);  // the others froze the roster at the draw
  late.click("menuTourBtn");
  await w.advance(1000);
  eq(late.read("clockSync.synced"), true, "the phone read the server clock");
  ok(Math.abs(late.read("clockSync.offset") - 3 * MIN) < 1000, "…and knows it is three minutes slow: " + late.read("clockSync.offset"));
  late.el("tourPrimary").dataset.act = "register";        // its own clock still says 20:47:30
  late.click("tourPrimary");
  await w.advance(8000);
  ok(!(await regList(late)).includes("p5"), "registration was refused: closed on the server's clock");
  const fresh = launch(w, "g1", "Gan", startAt);          // somebody opening the bracket now
  await w.advance(500);
  fresh.click("menuTourBtn");
  await eventually(w, () => derivedT(fresh).stages.length > 0, 20000);
  eq(JSON.stringify(derivedT(fresh).stages), JSON.stringify(derivedT(cs[0]).stages), "one bracket for early and late readers alike");
});

test("a registration stamped after the draw counts for nobody", async () => {
  const { w, cs, startAt } = await registered(4, 15 * MIN);
  await w.advance(startAt - OPEN - w.clock.now + 30000);
  // A write that got in anyway (raced the close, or an older build), stamped late.
  const key = cs[0].read("tourRegKey(tour.startsAt)");
  const rec = await cs[0].sandbox.Usion.cloud.shared.get(key);
  rec.list.push({ id: "p9", n: "Late", a: null, t: startAt - OPEN + 20000 });
  await cs[0].sandbox.Usion.cloud.shared.set(key, rec);
  const fresh = launch(w, "g1", "Gan", startAt);
  await w.advance(500);
  fresh.click("menuTourBtn");
  await eventually(w, () => derivedT(fresh).stages.length > 0, 20000);
  eq(derivedT(fresh).people.length, 4, "the late row is not in the draw");
  eq(JSON.stringify(derivedT(fresh).stages), JSON.stringify(derivedT(cs[0]).stages), "same bracket as the phones that froze the list");
});

test("a phone whose clock is ahead neither deals nor calls a walkover before the start", async () => {
  const w = new World({ strictRooms: true });
  const startAt = w.clock.now + 11 * MIN;
  const a = launch(w, "p1", "Alice", startAt);
  a.skew = 2 * MIN;                                       // two minutes fast
  const b = launch(w, "p2", "Bob", startAt);
  await w.advance(500);
  [a, b].forEach(c => c.click("menuTourBtn"));
  await w.advance(500);
  [a, b].forEach(c => c.click("tourPrimary"));
  await eventually(w, () => derivedT(a).people.length === 2 && derivedT(b).people.length === 2, 30000);
  b.click("tourBackBtn");                                 // Bob comes at the start, by the real clock
  await w.advance(startAt - OPEN - w.clock.now + 6000);
  if (!a.read("tourCtx")) a.click("tourPrimary");
  await w.advance(startAt - w.clock.now - 60000);         // real 20:59 — Alice's phone says 21:01
  ok(a.read("tourCtx") && !a.read("tourCtx.walkover"), "no walkover: the grace has not even begun");
  ok(!a.snap().dealActive, "nothing dealt before the start");
  eq(derivedT(a).stages[0].matches[0].done, false, "the table is open");
  b.click("menuTourBtn");
  await w.advance(70000);                                 // real 21:00:10, inside the grace
  if (!b.read("tourCtx")) { b.click("tourPrimary"); }
  await eventually(w, () => a.snap().dealActive && b.snap().dealActive, 30000);
  ok(a.snap().dealActive && b.snap().dealActive, "both are dealt in");
});

// ── The schedule: 21:00 UB through 2026-11-23, 19:00 UB from 2026-11-24 ──
test("the event moves to 19:00 from 2026-11-24, and players are told before and on the day", async () => {
  const w = new World();
  const at = iso => Date.parse(iso);
  // No ?tourStart override: the real schedule.
  const c = w.add("s1", "Alice", { mode: "single", roomId: "standalone_s1", pick: "none" });
  c.start({ userId: "s1", userName: "Alice", roomId: "standalone_s1", playerIds: ["s1"] });
  await w.advance(500);
  const start = iso => c.read("tourCurrentStart(" + at(iso) + ")");
  eq(start("2026-11-23T05:00:00Z"), at("2026-11-23T13:00:00Z"), "tonight: 21:00 UB");
  eq(start("2026-11-23T18:00:00Z"), at("2026-11-23T13:00:00Z"), "…still tonight's while it may be running");
  eq(start("2026-11-23T20:00:00Z"), at("2026-11-24T11:00:00Z"), "after it: tomorrow 19:00 UB");
  eq(start("2026-11-24T05:00:00Z"), at("2026-11-24T11:00:00Z"), "2026-11-24: 19:00 UB");
  eq(start("2026-11-25T12:00:00Z"), at("2026-11-25T11:00:00Z"), "and every day after");
  eq(start("2026-11-20T05:00:00Z"), at("2026-11-20T13:00:00Z"), "past events keep their keys (21:00)");

  const hm = ms => c.read("tourFmtClock(" + ms + ")");
  const noticeAt = iso => { c.skew = at(iso) - w.clock.now; c.run("tour.startsAt = 0; showMenu()"); return c.el("menuTourNotice"); };
  let n = noticeAt("2026-11-23T05:00:00Z");
  ok(!n.hidden, "today, the menu says the time is moving");
  ok(n.textContent.includes(hm(at("2026-11-24T11:00:00Z"))) && /Маргаашаас/.test(n.textContent), "…to tomorrow, at the new time: " + n.textContent);
  n = noticeAt("2026-11-24T05:00:00Z");
  ok(!n.hidden && n.textContent.includes(hm(at("2026-11-23T13:00:00Z"))), "on the day: the new time, and what it was: " + n.textContent);
  n = noticeAt("2026-11-26T05:00:00Z");
  ok(n.hidden, "after that, no notice");

  c.skew = at("2026-11-23T05:00:00Z") - w.clock.now;
  c.run("tour.startsAt = 0");
  c.click("menuTourBtn");
  await w.advance(1500);
  const tn = c.el("tourNotice");
  ok(!tn.hidden && /Маргаашаас/.test(tn.textContent), "the tournament screen says it too: " + tn.textContent);
  ok(c.el("tourWhen").textContent.includes(hm(at("2026-11-23T13:00:00Z"))), "while tonight's event is still at 21:00");
  ok(c.el("tourRulesList").children[0].textContent.includes(hm(at("2026-11-23T13:00:00Z"))), "the rules name tonight's time");
});

if (require.main === module) run("TOURNAMENT").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("TOURNAMENT") };
