// AUDIT — quick-chat flood. The 700 ms throttle lives only in sendReaction();
// onNetRealtime shows every incoming "reaction" without any rate limit.

const { onlineWorld, startMatch } = require("./lib/world.cjs");
const { test, ok, run } = require("./lib/tap.cjs");

test("a modified client cannot flood its seat with chat bubbles", async () => {
  const w = await onlineWorld(2);
  await startMatch(w);
  w.clients[1].run(`for (var i = 0; i < 200; i++) Usion.game.realtime("reaction", { kind: "text", value: "spam " + i });`);
  await w.advance(100);
  const n = w.clients[0].doc.getElementById("reactionLayer").children.length;
  console.log("    bubbles on the victim's screen: " + n);
  ok(n <= 3, n + " bubbles stacked on the victim's screen in 100 ms");
});

if (require.main === module) run("AUDIT chat spam").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("AUDIT chat spam") };
