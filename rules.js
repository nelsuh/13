// 13 — the rules, shared by the browser (window.T13Rules) and the server
// (require("./rules.js")). Pure: no DOM, no game state, no timers.
//
// Cards are { r, s }: rank 3..15 (11=J 12=Q 13=K 14=A 15=2), suit 0♠ 1♣ 2♦ 3♥.
// On the wire a card is r*4+s (cardWire / wireCard).
//
// Combo labels are display text, so they come from a labeller the page sets
// (T13Rules.setLabeler(t)); the server never needs them.
(function (root) {
"use strict";
const SUITS = ["♠", "♣", "♦", "♥"];
// Suit strength high→low: ♠ > ♥ > ♣ > ♦. Indexed by suit id.
const SUIT_RANK = [3, 1, 0, 2];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" };
let labeler = null;
function label(key) {
  const args = Array.prototype.slice.call(arguments, 1);
  return labeler ? labeler.apply(null, [key].concat(args)) : key + (args.length ? " " + args.join(" ") : "");
}
function setLabeler(fn) { labeler = typeof fn === "function" ? fn : null; }

function rankLabel(r) { return RANK_LABEL[r] || String(r); }
function cardStrength(c) { return c.r * 4 + SUIT_RANK[c.s]; }            // 2 highest single
function cardWire(c) { return c.r * 4 + c.s; }
function cardKey(c) { return String(cardWire(c)); }
function wireCard(v) { return { r: Math.floor(v / 4), s: v % 4 }; }
function sortCards(cards) { return cards.slice().sort((a, b) => a.r - b.r || SUIT_RANK[a.s] - SUIT_RANK[b.s]); }
function sameCard(a, b) { return a.r === b.r && a.s === b.s; }

// Straight ordering: 2 is the low end, A is the high end. position 0..12.
function straightPos(r) { return r === 15 ? 0 : r - 2; }   // 2→0, 3→1, … A(14)→12
function posToRank(p) { return p === 0 ? 15 : p + 2; }     // inverse

// ── Combination classification ───────────────────────────
// Returns { type, len, cmp[], cards(sorted), label } or null. `cmp` is a
// comparable array; for equal-length combos, higher cmp (lexicographic) wins.
function mk(type, sorted, cmp, label) {
  return { type, len: sorted.length, cmp, cards: sorted, label };
}
function classify(cards) {
  const n = cards.length;
  if (!n) return null;
  const sorted = sortCards(cards);
  const ranks = sorted.map(c => c.r);
  const top = sorted[n - 1];
  const allSame = ranks.every(r => r === ranks[0]);
  if (n === 1) return mk("single", sorted, [cardStrength(top)], rankLabel(top.r));
  if (n === 2) return allSame ? mk("pair", sorted, [cardStrength(top)], label("pair", rankLabel(top.r))) : null;
  if (n === 3) return allSame ? mk("triple", sorted, [ranks[0]], label("triple", rankLabel(ranks[0]))) : null;
  if (n === 4) return allSame ? mk("four", sorted, [ranks[0]], label("four", rankLabel(ranks[0]))) : null;
  if (n === 5) return classify5(sorted);
  return null;
}
function classify5(sorted) {
  const isFlush = sorted.every(c => c.s === sorted[0].s);
  const positions = sorted.map(c => straightPos(c.r)).sort((a, b) => a - b);
  let isStraight = new Set(positions).size === 5;
  if (isStraight) for (let i = 1; i < 5; i++) if (positions[i] !== positions[i - 1] + 1) { isStraight = false; break; }
  // top card of a straight = highest straightPos
  let topS = sorted[0];
  sorted.forEach(c => { if (straightPos(c.r) > straightPos(topS.r)) topS = c; });
  const straightKey = [straightPos(topS.r), SUIT_RANK[topS.s]];
  const counts = {};
  sorted.forEach(c => counts[c.r] = (counts[c.r] || 0) + 1);
  const groups = Object.keys(counts).map(r => [counts[r], +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const sizes = groups.map(g => g[0]).join("");
  // straights / straight flushes display in run order
  const runOrder = sorted.slice().sort((a, b) => straightPos(a.r) - straightPos(b.r));
  if (isStraight && isFlush) return mk("sflush", runOrder, [4, ...straightKey], label("sflush", rankLabel(topS.r)));
  if (sizes === "41") return mk("fourplus", sorted, [3, groups[0][1]], label("fourplus", rankLabel(groups[0][1])));
  if (sizes === "32") return mk("fullhouse", sorted, [2, groups[0][1]], label("fullhouse", rankLabel(groups[0][1])));
  if (isFlush) return mk("flush", sorted, [1, ...sorted.map(cardStrength).sort((a, b) => b - a)], label("flush", SUITS[sorted[0].s]));
  if (isStraight) return mk("straight", runOrder, [0, ...straightKey], label("straight", rankLabel(topS.r)));
  return null;
}
function comboName(c) { return c ? c.label : ""; }

function cmpArr(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
// Can `cand` be played on `tableCombo`? Same size required; higher cmp wins.
function canBeat(cand, tableCombo) {
  if (!cand) return false;
  if (!tableCombo) return true;
  if (cand.len !== tableCombo.len) return false;
  return cmpArr(cand.cmp, tableCombo.cmp) > 0;
}

// ── Move generation (bots) ───────────────────────────────
function byRank(hand) {
  const m = {};
  hand.forEach(c => { (m[c.r] = m[c.r] || []).push(c); });
  for (const k in m) m[k].sort((a, b) => SUIT_RANK[a.s] - SUIT_RANK[b.s]);
  return m;
}
function lowestCard(hand) { return hand.reduce((lo, c) => cardStrength(c) < cardStrength(lo) ? c : lo, hand[0]); }

function allCombos(hand) {
  const m = byRank(hand);
  const ranks = Object.keys(m).map(Number);
  const out = [];
  hand.forEach(c => out.push(classify([c])));
  ranks.forEach(r => {
    const g = m[r];
    chooseCards(g, 2, cards => out.push(classify(cards)));
    chooseCards(g, 3, cards => out.push(classify(cards)));
    if (g.length >= 4) out.push(classify(g.slice(0, 4)));
  });
  pushAll5(out, hand, m, ranks);
  return out.filter(Boolean);
}

// Generate every legal five-card subset by category instead of classifying all
// 1,287 possible subsets. This remains complete while keeping bot turns quick.
function pushAll5(out, hand, m, ranks) {
  const seen = new Set();
  function add(cards) {
    const key = cards.map(cardWire).sort((a, b) => a - b).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    const combo = classify(cards);
    if (combo) out.push(combo);
  }

  // Every suit choice for every straight window (including straight flushes).
  for (let p = 0; p <= 8; p++) {
    const wr = [p, p + 1, p + 2, p + 3, p + 4].map(posToRank);
    if (!wr.every(r => m[r])) continue;
    chooseAcross(wr.map(r => m[r]), 0, [], add);
  }

  // Every five-card flush, not merely the highest five.
  const bySuit = { 0: [], 1: [], 2: [], 3: [] };
  hand.forEach(c => bySuit[c.s].push(c));
  for (const s of [0, 1, 2, 3]) chooseCards(bySuit[s], 5, add);

  // Every triple/pair allocation for a full house.
  ranks.forEach(tr => {
    if (m[tr].length < 3) return;
    ranks.forEach(pr => {
      if (pr === tr || m[pr].length < 2) return;
      chooseCards(m[tr], 3, triple => {
        chooseCards(m[pr], 2, pair => add(triple.concat(pair)));
      });
    });
  });

  // Every kicker for four-of-a-kind plus one.
  ranks.forEach(qr => {
    if (m[qr].length !== 4) return;
    hand.forEach(card => { if (card.r !== qr) add(m[qr].concat(card)); });
  });
}

function chooseAcross(groups, index, picked, visit) {
  if (index === groups.length) { visit(picked.slice()); return; }
  groups[index].forEach(card => {
    picked.push(card);
    chooseAcross(groups, index + 1, picked, visit);
    picked.pop();
  });
}

function chooseCards(cards, count, visit, start, picked) {
  start = start || 0;
  picked = picked || [];
  if (picked.length === count) { visit(picked.slice()); return; }
  for (let i = start; i <= cards.length - (count - picked.length); i++) {
    picked.push(cards[i]);
    chooseCards(cards, count, visit, i + 1, picked);
    picked.pop();
  }
}

function isPrecious(c) {
  return (c.len === 1 && c.cards[0].r === 15) || c.type === "four" || c.type === "fourplus" || c.type === "sflush";
}

// Build a tiny exact-cover planner for this hand. `turns(mask)` is the fewest
// legal plays needed to shed the cards in mask, ignoring what opponents may put
// on the table. There are at most 2^13 states, and forcing every partition to
// cover its first remaining card avoids exploring the same plays in every order.
function buildHandPlanner(hand) {
  const combos = allCombos(hand).map(combo => {
    let mask = 0;
    combo.cards.forEach(card => {
      const i = hand.findIndex(c => sameCard(c, card));
      if (i >= 0) mask |= (1 << i);
    });
    return { combo, mask };
  });
  const byBit = hand.map(() => []);
  combos.forEach(entry => {
    for (let i = 0; i < hand.length; i++) if (entry.mask & (1 << i)) byBit[i].push(entry);
  });
  const memo = new Map([[0, 0]]);
  function turns(mask) {
    if (memo.has(mask)) return memo.get(mask);
    let bit = 0;
    while (!(mask & (1 << bit))) bit++;
    let best = hand.length;
    byBit[bit].forEach(entry => {
      if ((entry.mask & mask) !== entry.mask) return;
      best = Math.min(best, 1 + turns(mask ^ entry.mask));
    });
    memo.set(mask, best);
    return best;
  }
  return { combos, turns, fullMask: (1 << hand.length) - 1 };
}

function comparePlannedMoves(a, b, context) {
  if (a.futureTurns !== b.futureTurns) return a.futureTurns - b.futureTurns;
  const threat = context && context.opponentMin <= 2;
  if (threat) {
    const aBlocks = a.combo.len > context.opponentMin;
    const bBlocks = b.combo.len > context.opponentMin;
    if (aBlocks !== bBlocks) return aBlocks ? -1 : 1;
  }
  const ap = isPrecious(a.combo), bp = isPrecious(b.combo);
  if (ap !== bp) return ap ? 1 : -1;
  if (a.combo.len !== b.combo.len) return b.combo.len - a.combo.len;
  return cmpArr(a.combo.cmp, b.combo.cmp);
}

function plannedMoves(hand, predicate, context) {
  const planner = buildHandPlanner(hand);
  const moves = planner.combos.filter(entry => !predicate || predicate(entry.combo)).map(entry => ({
    combo: entry.combo,
    mask: entry.mask,
    futureTurns: planner.turns(planner.fullMask ^ entry.mask),
  }));
  moves.sort((a, b) => comparePlannedMoves(a, b, context));
  return { planner, moves };
}

function botLead(hand, mustIncludeLow, context) {
  let required = null;
  if (mustIncludeLow) {
    required = lowestCard(hand);
  }
  const result = plannedMoves(hand, c => !required || c.cards.some(x => sameCard(x, required)), context);
  return result.moves.length ? result.moves[0].combo : classify([required || lowestCard(hand)]);
}
function botFollow(hand, tableCombo, context) {
  context = context || {};
  const result = plannedMoves(hand, c => canBeat(c, tableCombo), context);
  if (!result.moves.length) return null;
  const best = result.moves[0];
  if (best.futureTurns === 0) return best.combo;

  // Passing can be stronger than smashing a carefully planned pair/straight
  // merely to win one weak trick. Play freely when the beat belongs to an
  // optimal hand partition; otherwise preserve the hand unless somebody is
  // close enough to going out that they must be stopped.
  const currentTurns = result.planner.turns(result.planner.fullMask);
  const urgent = context.urgent === true || Number(context.opponentMin) <= 1;
  if (!urgent && best.futureTurns >= currentTurns) return null;
  return best.combo;
}

// ── Deck / dealing ───────────────────────────────────────
function buildDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 3; r <= 15; r++) d.push({ r, s });
  return d;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function dealHands(seed, n) {
  const deck = buildDeck();
  const rng = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  const hands = [];
  for (let p = 0; p < n; p++) hands.push(sortCards(deck.slice(p * 13, p * 13 + 13)));
  return hands;
}
function randomSeed() { return Math.floor(Math.random() * 0x7fffffff); }

// remaining-card deduction: n≤9 → n, 10-12 → 2n, 13 → 3n
function deduction(n) { return n <= 9 ? n : n <= 12 ? 2 * n : 3 * n; }

const api = { SUITS, SUIT_RANK, RANK_LABEL, setLabeler, rankLabel, cardStrength, cardWire, cardKey, wireCard, sortCards, sameCard, straightPos, posToRank, mk, classify, classify5, comboName, cmpArr, canBeat, byRank, lowestCard, allCombos, pushAll5, chooseAcross, chooseCards, isPrecious, buildHandPlanner, comparePlannedMoves, plannedMoves, botLead, botFollow, buildDeck, mulberry32, dealHands, randomSeed, deduction };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.T13Rules = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
