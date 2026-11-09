// AUDIT — a seat_take sequenced just before an in-flight bot move.
// The relay applied its bot move optimistically; everyone else rejects it
// because the seat is human by the time it lands. Does the table split?

const { openWorld, startMatch, playOut, eventually, consistency, dump, arrive } = require("./lib/world.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

async function toTakeoverBotTurn(w, host) {
  const r = await playOut(w, {
    done: () => {
      const s = host.snap();
      return s.dealActive && host.read("takeoverSeat()") === s.turn && host.read("botTimer !== null");
    },
    budget: 20 * 60 * 1000, step: 50, consistency: false,
  });
  ok(r.ok, "never reached a bot turn on the takeover seat: " + r.reason);
}

test("seat_take sequenced just before the relay's own bot move does not split the table", async () => {
  const w = await openWorld(2, { latency: 200 });
  await startMatch(w);
  const host = w.clients[0], peer = w.clients[1];
  await toTakeoverBotTurn(w, host);
  const seat = host.snap().turn;
  // A newcomer arrives; peer (seat 1, a legitimate covering writer) claims the
  // bot seat that is on turn. 5 ms later the host's bot timer fires.
  const late = arrive(w, "u3", "Chuck");
  peer.run(`Usion.game.action("move", {kind:"seat_take", seat:${seat}, playerId:"u3", name:"Chuck"}).catch(function(){})`);
  await w.advance(5);
  host.run(`(function(){ clearTimeout(botTimer); botTimer = null;
    var d = botDecision(turn);
    var mv = d.kind === "pass" ? {kind:"pass"} : {kind:"play", cards: d.combo.cards.map(cardWire)};
    mv.bot = true; sendMove(mv, turn, true); })()`);
  await w.advance(3000);
  const a = host.snap(), b = peer.snap();
  console.log("    host: turn=" + a.turn + " moves=" + a.roundMoveNo + " counts=" + a.counts + " order=" + a.order);
  console.log("    peer: turn=" + b.turn + " moves=" + b.roundMoveNo + " counts=" + b.counts + " order=" + b.order);
  // give every recovery net a fair chance (catch-up debounce 5s, idle 20s, optimistic 6s)
  let splitFor = 0;
  for (let i = 0; i < 60; i++) { await w.advance(1000); if (consistency(w)) splitFor = i + 4;
    if (i % 5 === 0) { const x = host.snap(), y = peer.snap(), z = late.snap(); console.log("    t+" + (i+4) + " host m=" + x.roundMoveNo + " c=" + x.counts + " | peer m=" + y.roundMoveNo + " c=" + y.counts + " | u3 m=" + z.roundMoveNo + " c=" + z.counts + " seat=" + z.mySeat); } }
  console.log("    host log: " + JSON.stringify(w.room.log.slice(-12).map(a => a.sequence + ":" + a.player_id + ":" + (a.action_data.kind||a.action_type) + (a.action_data.bot?"(bot s"+a.action_data.seat+")":"") + " ti=" + a.action_data.ti)));
  console.log("    split persisted until ~" + splitFor + "s after the race");
  eq(consistency(w), null, "table split after the seat_take / bot move race\n" + dump(w));
  const r = await playOut(w, { done: () => w.drivers().every(c => c.snap().overlays.winner), budget: 60 * 60 * 1000 });
  ok(r.ok, r.reason + "\n" + (r.dump || ""));
});

if (require.main === module) run("AUDIT seat race").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT seat race") };
