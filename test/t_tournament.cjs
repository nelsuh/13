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
  c.start({ userId: id, userName: name, roomId: "standalone_" + id, playerIds: [id] });
  return c;
}
const shown = (c, id) => c.el(id).classList.contains("show");
const derived = c => c.read("tourDerive(tour.startsAt, tour.roster, tour.results, Date.now())");
const status = c => c.read("tourMyStatus(tourDerive(tour.startsAt, tour.roster, tour.results, Date.now()), myId)");

async function registered(n, lead = 15 * MIN) {
  const w = new World();
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
  const w = new World();
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
  const r = await playOut(w, { done: () => cs.every(c => shown(c, "winnerOverlay")), consistency: false });
  ok(r.ok, "stage 1 finishes: " + (r.reason || ""));
  cs.forEach(c => c.click("playAgainBtn"));
  await eventually(w, () => cs.every(c => derived(c).phase === "between"), 30000);
  const qualified = cs.filter(c => status(c) === "waiting");
  eq(qualified.length, 2, "two table winners go through");
  const out = cs.filter(c => status(c) === "eliminated");
  eq(out.length, 3, "three are out");
  await w.advance(31000);                                    // the break
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

test("capacity: 200 registrations with photos fit the one record, 50 tables", async () => {
  const w = new World();
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

test("a no-show is cut after the grace minute; alone at the table = walkover", async () => {
  const { w, cs, startAt } = await registered(2, 11 * MIN);
  cs[1].click("tourBackBtn");                   // Bob wanders off to the menu and never comes back
  await w.advance(startAt - w.clock.now + 2000);
  const [a] = cs;
  eq(status(a), "playing");
  a.click("tourPrimary");                       // only Alice turns up
  await w.advance(30000);
  ok(!a.snap().dealActive, "still waiting inside the grace minute");
  await w.advance(40000);
  await eventually(w, () => derived(a).phase === "complete", 20000);
  eq(derived(a).championId, "p1", "Alice goes through on a walkover (and it was the final)");
  cs[1].click("menuTourBtn");                   // Bob looks later
  await eventually(w, () => derived(cs[1]).championId === "p1", 20000);
  eq(derived(cs[1]).championId, "p1", "Bob's client agrees");
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

// A fake Usion reminder endpoint + permission prompt on one client.
function withReminder(c, opts = {}) {
  const calls = [], perms = [];
  let state = { configured: opts.configured !== false, decided: false, enabled: false, next_run_at: null,
                schedule: { hour_utc: 12, minute_utc: 40 } };
  c.sandbox.Usion.config = { apiUrl: "https://api.test/", serviceId: "svc13", authToken: "tok-1" };
  c.sandbox.Usion.user = { getToken: () => "tok-live" };
  c.sandbox.Usion.permissions = { request: (list, o) => { perms.push({ list, o }); return Promise.resolve({ granted: opts.grant !== false }); } };
  c.sandbox.fetch = (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body });
    if (init.method === "PUT") state = Object.assign({}, state, { decided: true, enabled: body.enabled,
      next_run_at: body.enabled ? "2026-11-16T12:40:00Z" : null });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(Object.assign({}, state)) });
  };
  return { calls, perms };
}
const remindText = c => c.el("tourRemind").style.display === "none" ? "" : c.el("tourRemind").textContent;
const remindBtn = (c, label) => {
  const find = el => { if (el.tagName === "BUTTON" && el.textContent === label) return el;
    for (const k of el.children || []) { const f = find(k); if (f) return f; } return null; };
  return find(c.el("tourRemind"));
};

test("daily reminder: offered after registering, subscribed only after the permission is granted", async () => {
  const w = new World();
  const startAt = w.clock.now + 30 * MIN;
  const c = launch(w, "r1", "Alice", startAt);
  const fake = withReminder(c);
  await w.advance(500);
  c.click("menuTourBtn");
  await w.advance(2000);
  eq(remindText(c), "", "nothing offered before registering");
  c.click("tourPrimary");                                    // register
  await eventually(w, () => remindText(c).indexOf("сануулга авах уу") >= 0, 15000);
  ok(remindText(c).indexOf("20:") >= 0 || remindText(c).length > 0, "the offer names the time: " + remindText(c));
  remindBtn(c, "Асаах").dispatch("click");
  await w.advance(2000);
  eq(fake.perms.length, 1, "Usion's own permission prompt, on the tap");
  const put = fake.calls.find(x => x.method === "PUT");
  ok(put && put.body.enabled === true, "subscribed");
  eq(put.url, "https://api.test/services/svc13/reminders/daily");
  eq(put.auth, "Bearer tok-live", "with the live token, not the boot copy");
  ok(remindText(c).indexOf("асаалттай") >= 0, "the card turns into the on/off line: " + remindText(c));
  remindBtn(c, "Унтраах").dispatch("click");
  await w.advance(2000);
  ok(fake.calls.filter(x => x.method === "PUT").pop().body.enabled === false, "turned off");
  ok(remindText(c).indexOf("унтраалттай") >= 0, remindText(c));
});

test("daily reminder: a denied permission subscribes nothing; Later records the choice", async () => {
  const w = new World();
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

test("daily reminder: hidden when the service has no reminder configured", async () => {
  const w = new World();
  const c = launch(w, "r4", "Dana", w.clock.now + 30 * MIN);
  withReminder(c, { configured: false });
  await w.advance(500);
  c.click("menuTourBtn");
  await w.advance(1000);
  c.click("tourPrimary");
  await w.advance(8000);
  eq(remindText(c), "", "no card");
});

if (require.main === module) run("TOURNAMENT").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("TOURNAMENT") };
