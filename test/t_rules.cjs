// Suite 1 — the deterministic rules engine (no network, no DOM interaction).
// Everything here calls the real functions inside a loaded script.js realm.

const { Clock } = require("./lib/clock.cjs");
const { Server } = require("./lib/net.cjs");
const { Client } = require("./lib/client.cjs");
const { test, ok, eq, run } = require("./lib/tap.cjs");

const clock = new Clock();
const server = new Server(clock, {});
const c = new Client({ server, clock, id: "rules", name: "R", launch: { mode: "single" } });
// r: 3..15 (11=J 12=Q 13=K 14=A 15=2)   s: 0♠ 1♣ 2♦ 3♥
const S = { spade: 0, club: 1, diamond: 2, heart: 3 };
const ev = (expr) => c.read(expr);
const cards = (arr) => JSON.stringify(arr.map(([r, s]) => ({ r, s })));
const classify = (arr) => ev(`classify(${cards(arr)})`);
const beats = (a, b) => ev(`canBeat(classify(${cards(a)}), classify(${cards(b)}))`);

test("classify: singles, pairs, triples, fours", () => {
  eq(classify([[7, 0]]).type, "single");
  eq(classify([[7, 0], [7, 3]]).type, "pair");
  eq(classify([[7, 0], [7, 3], [7, 1]]).type, "triple");
  eq(classify([[7, 0], [7, 3], [7, 1], [7, 2]]).type, "four");
  eq(classify([[7, 0], [8, 3]]), null, "mismatched pair is not a combo");
  eq(classify([[7, 0], [7, 3], [8, 1]]), null, "2+1 is not a triple");
  eq(classify([]), null);
  eq(classify([[3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0]]), null, "6 cards is never a combo");
});

test("classify: the five 5-card categories", () => {
  eq(classify([[5, 0], [6, 1], [7, 2], [8, 3], [9, 0]]).type, "straight");
  eq(classify([[3, 0], [5, 0], [7, 0], [9, 0], [12, 0]]).type, "flush");
  eq(classify([[7, 0], [7, 1], [7, 2], [9, 0], [9, 1]]).type, "fullhouse");
  eq(classify([[7, 0], [7, 1], [7, 2], [7, 3], [9, 1]]).type, "fourplus");
  eq(classify([[5, 0], [6, 0], [7, 0], [8, 0], [9, 0]]).type, "sflush");
  eq(classify([[3, 0], [5, 1], [7, 2], [9, 3], [12, 0]]), null, "junk 5 cards is not a combo");
});

test("straights: 2 is the low end, A is the high end, no wrap", () => {
  ok(classify([[15, 0], [3, 1], [4, 2], [5, 3], [6, 0]]), "2-3-4-5-6 is the lowest straight");
  eq(classify([[15, 0], [3, 1], [4, 2], [5, 3], [6, 0]]).type, "straight");
  ok(classify([[10, 0], [11, 1], [12, 2], [13, 3], [14, 0]]), "10-J-Q-K-A is the highest straight");
  eq(classify([[14, 0], [15, 1], [3, 2], [4, 3], [5, 0]]), null, "A-2-3-4-5 does not wrap");
  eq(classify([[11, 0], [12, 1], [13, 2], [14, 3], [15, 0]]), null, "J-Q-K-A-2 does not wrap");
  // the 2 only ever sits at the bottom of a run
  ok(ev(`cmpArr(classify(${cards([[10, 0], [11, 1], [12, 2], [13, 3], [14, 0]])}).cmp, classify(${cards([[15, 0], [3, 1], [4, 2], [5, 3], [6, 0]])}).cmp) > 0`),
    "A-high straight beats the 2-low straight");
});

test("5-card category order: straight < flush < fullhouse < fourplus < sflush", () => {
  const straight = [[5, 0], [6, 1], [7, 2], [8, 3], [9, 0]];
  const flush = [[3, 2], [5, 2], [7, 2], [9, 2], [12, 2]];
  const full = [[4, 0], [4, 1], [4, 2], [5, 0], [5, 1]];
  const four1 = [[3, 0], [3, 1], [3, 2], [3, 3], [4, 0]];
  const sflush = [[5, 1], [6, 1], [7, 1], [8, 1], [9, 1]];
  ok(beats(flush, straight) && !beats(straight, flush), "flush > straight");
  ok(beats(full, flush) && !beats(flush, full), "full house > flush");
  ok(beats(four1, full) && !beats(full, four1), "four+1 > full house");
  ok(beats(sflush, four1) && !beats(four1, sflush), "straight flush > four+1");
  ok(beats(sflush, straight), "a weak straight flush still beats a strong straight");
});

test("single-card strength: 2 is highest, suits break ties ♠>♥>♣>♦", () => {
  ok(beats([[15, 2]], [[14, 0]]), "the lowest 2 beats the highest A");
  ok(beats([[9, 0]], [[9, 3]]), "9♠ beats 9♥");
  ok(beats([[9, 3]], [[9, 1]]), "9♥ beats 9♣");
  ok(beats([[9, 1]], [[9, 2]]), "9♣ beats 9♦");
  ok(!beats([[9, 2]], [[9, 0]]), "9♦ does not beat 9♠");
  ok(!beats([[9, 0]], [[9, 0]]), "a combo never beats itself");
});

test("combos must match in size, and anything can lead an empty table", () => {
  ok(!beats([[9, 0], [9, 1]], [[8, 0]]), "a pair cannot answer a single");
  ok(!beats([[8, 0]], [[9, 0], [9, 1]]), "a single cannot answer a pair");
  ok(ev(`canBeat(classify(${cards([[3, 2]])}), null)`), "any combo leads an empty table");
  ok(!ev("canBeat(null, null)"), "an invalid selection is never playable");
});

test("card wire encoding round-trips and rejects junk", () => {
  for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) {
    eq(ev(`wireCard(cardWire({r:${r},s:${s}}))`), { r, s });
  }
  eq(ev("decodeMoveCards([])"), null, "empty play rejected");
  eq(ev("decodeMoveCards([1,2,3,4,5,6])"), null, "6 cards rejected");
  eq(ev("decodeMoveCards([0])"), null, "rank 0 rejected");
  eq(ev("decodeMoveCards([999])"), null, "rank 249 rejected");
  eq(ev("decodeMoveCards(['x'])"), null, "non-numeric rejected");
  eq(ev("decodeMoveCards([1.5])"), null, "fractional rejected");
  ok(ev("decodeMoveCards([cardWire({r:7,s:0})]) !== null"), "a real card decodes");
});

test("penalty deduction ladder (n≤9 → n, 10-12 → 2n, 13 → 3n)", () => {
  for (let n = 0; n <= 9; n++) eq(ev(`deduction(${n})`), n);
  eq(ev("deduction(10)"), 20); eq(ev("deduction(11)"), 22); eq(ev("deduction(12)"), 24);
  eq(ev("deduction(13)"), 39);
});

test("dealHands is seed-deterministic, 13 cards each, no duplicates", () => {
  for (const n of [2, 3, 4]) {
    for (const seed of [1, 2, 12345, 999999]) {
      const a = ev(`dealHands(${seed}, ${n})`);
      const b = ev(`dealHands(${seed}, ${n})`);
      eq(a, b, "same seed → same deal");
      eq(a.length, n);
      const seen = new Set();
      a.forEach(h => {
        eq(h.length, 13, "every player gets 13");
        h.forEach(card => {
          const k = card.r + ":" + card.s;
          ok(!seen.has(k), "card " + k + " dealt twice");
          seen.add(k);
          ok(card.r >= 3 && card.r <= 15 && card.s >= 0 && card.s <= 3, "card in range");
        });
      });
    }
  }
  const x = ev("dealHands(1, 4)"), y = ev("dealHands(2, 4)");
  ok(JSON.stringify(x) !== JSON.stringify(y), "different seeds → different deals");
});

test("fuzz: every generated combo is legal and made only of held cards", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const hand = ev(`dealHands(${seed}, 4)`)[seed % 4];
    const combos = ev(`allCombos(${JSON.stringify(hand)})`);
    ok(combos.length > 0, "a 13-card hand always has plays");
    for (const combo of combos) {
      const re = ev(`classify(${JSON.stringify(combo.cards)})`);
      ok(re && re.type === combo.type, "combo re-classifies to itself: " + combo.type);
      const pool = hand.slice();
      for (const card of combo.cards) {
        const i = pool.findIndex(p => p.r === card.r && p.s === card.s);
        ok(i >= 0, "combo uses a card the player does not hold");
        pool.splice(i, 1);
      }
    }
  }
});

test("move generation keeps every strategically distinct pair, triple, straight, and flush", () => {
  const four = [[7, 0], [7, 1], [7, 2], [7, 3]];
  eq(ev(`allCombos(${cards(four)}).filter(c => c.type === "pair").length`), 6, "four suits contain six distinct pairs");
  eq(ev(`allCombos(${cards(four)}).filter(c => c.type === "triple").length`), 4, "four suits contain four distinct triples");

  const sixSpades = [[3, 0], [5, 0], [7, 0], [9, 0], [11, 0], [13, 0]];
  eq(ev(`allCombos(${cards(sixSpades)}).filter(c => c.type === "flush").length`), 6, "six suited cards contain all six five-card flushes");

  const twoSuitRun = [[3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0], [6, 1], [7, 0], [7, 1]];
  eq(ev(`allCombos(${cards(twoSuitRun)}).filter(c => c.type === "straight" || c.type === "sflush").length`), 32,
    "two suit choices at each rank produce all 2^5 straights");
});

test("bot lead uses the move that leaves the shortest legal hand plan", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const hand = ev(`dealHands(${seed}, 4)[${seed % 4}]`);
    const result = ev(`(function () {
      var hand = ${JSON.stringify(hand)};
      var planner = buildHandPlanner(hand);
      var lead = botLead(hand, false);
      var chosen = planner.combos.find(function (entry) {
        return entry.combo.cards.map(cardWire).sort().join(",") === lead.cards.map(cardWire).sort().join(",");
      });
      var best = Math.min.apply(null, planner.combos.map(function (entry) {
        return planner.turns(planner.fullMask ^ entry.mask);
      }));
      return { chosen: planner.turns(planner.fullMask ^ chosen.mask), best: best };
    })()`);
    eq(result.chosen, result.best, "seed " + seed + ": lead should preserve an optimal partition");
  }
});

test("bot preserves a planned pair, but breaks it to stop an endgame threat", () => {
  const hand = [[7, 0], [7, 3], [8, 1], [8, 2]];
  const table = [[6, 0]];
  eq(ev(`botFollow(${cards(hand)}, classify(${cards(table)}))`), null,
    "a routine follow should not split a pair and leave the same number of future plays");
  const urgent = ev(`botFollow(${cards(hand)}, classify(${cards(table)}), { urgent: true, opponentMin: 1 })`);
  ok(urgent && ev(`canBeat(classify(${JSON.stringify(urgent.cards)}), classify(${cards(table)}))`),
    "the bot must make that beat when an opponent is about to go out");
});

test("fuzz: a forced lead always contains the mandatory lowest card", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const hand = ev(`dealHands(${seed}, 4)`)[0];
    const combo = ev(`botLead(${JSON.stringify(hand)}, true)`);
    ok(combo, "botLead must always produce a lead");
    const low = ev(`lowestCard(${JSON.stringify(hand)})`);
    ok(combo.cards.some(x => x.r === low.r && x.s === low.s), "seed " + seed + ": forced lead omits the low card");
  }
});

test("fuzz: botFollow either beats the table or passes, never plays junk", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const hands = ev(`dealHands(${seed}, 4)`);
    const lead = ev(`botLead(${JSON.stringify(hands[0])}, false)`);
    for (let p = 1; p < 4; p++) {
      const follow = ev(`botFollow(${JSON.stringify(hands[p])}, classify(${JSON.stringify(lead.cards)}))`);
      if (!follow) continue;
      ok(ev(`canBeat(classify(${JSON.stringify(follow.cards)}), classify(${JSON.stringify(lead.cards)}))`),
        "seed " + seed + " p" + p + ": botFollow returned a play that does not beat the table");
    }
  }
});

test("dragon: a hand holding all 13 ranks exists and is detectable", () => {
  // 3..15 is exactly 13 ranks; the engine's test is `new Set(ranks).size === 13`
  const dragon = [];
  for (let r = 3; r <= 15; r++) dragon.push({ r, s: r % 4 });
  eq(ev(`new Set(${JSON.stringify(dragon)}.map(c => c.r)).size`), 13);
  const normal = ev("dealHands(7, 4)")[0];
  ok(ev(`new Set(${JSON.stringify(normal)}.map(c => c.r)).size`) < 13, "an ordinary hand is not a dragon");
});

if (require.main === module) run("RULES").then(r => process.exit(r.fails.length ? 1 : 0));
module.exports = { run: () => run("RULES") };
