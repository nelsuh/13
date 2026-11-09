// AUDIT — the same race as t_audit_seat_race, but with nothing injected: a real
// newcomer walks in while the takeover bot is "thinking", at varying moments.
// Counts how many arrivals leave the table split for more than 5 s.

const { openWorld, startMatch, playOut, consistency, arrive, dump } = require("./lib/world.cjs");
const { test, ok, run } = require("./lib/tap.cjs");

test("a newcomer arriving during the takeover bot's think time never splits the table", async () => {
  let split = 0, trials = 0;
  const notes = [];
  for (let k = 0; k < 9; k++) {
    const w = await openWorld(2, { latency: 150 });
    await startMatch(w);
    const host = w.clients[0];
    const r = await playOut(w, {
      done: () => { const s = host.snap(); return s.dealActive && host.read("takeoverSeat()") === s.turn && host.read("botTimer !== null"); },
      budget: 20 * 60 * 1000, step: 20, consistency: false,
    });
    if (!r.ok) continue;
    await w.advance(k * 90);                 // arrive at a different point of the 900 ms think
    trials++;
    arrive(w, "u3", "Chuck");
    let worst = 0, since = 0;
    for (let i = 0; i < 300; i++) {
      await w.advance(100);
      const d = consistency(w);
      if (d) { if (!since) since = w.clock.now; worst = Math.max(worst, w.clock.now - since); } else since = 0;
    }
    if (worst > 5000) { split++; notes.push("offset " + (k * 90) + "ms: split " + Math.round(worst / 1000) + "s"); }
  }
  console.log("    " + split + "/" + trials + " arrivals split the table for >5s  " + notes.join("; "));
  ok(split === 0, split + "/" + trials + " natural arrivals split the table");
});

if (require.main === module) run("AUDIT seat race natural").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT seat race natural") };
