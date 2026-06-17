// ── Mongolian Poker (Big-Two style) ──────────────────────
// 2-4 players, 13 cards each from a standard 52-card deck (2p uses 26 random
// cards, 3p uses 39 — each player still gets 13). Be the first to empty your
// hand to win the round; everyone else is docked points for the cards they're
// left holding.
//
// Single-card strength high→low: 2 A K Q J 10 9 8 7 6 5 4 3.
// Suit strength high→low: ♠ ♥ ♣ ♦ (tiebreak only).
// Combos: single, pair, triple, four, and 5-card hands — straight, flush,
// full house (3+2), four+1, straight flush. 5-card category order (low→high):
//   straight < flush < full house < four+1 < straight flush.
// Straights run 2-3-4-5-6 (lowest) up to 10-J-Q-K-A (highest); no wrap, the 2
// is the low end of a straight only. You must follow with a bigger combo of
// the SAME size, or pass.
//
// Auto-win: being dealt all 13 ranks (a 3→A straight plus a 2).
//
// Modes: local = you (seat 0) + bots; online = humans via a shared deal seed
// and a turn-log of moves (deterministic engine on every client).
// See memory: thirteen-game (this dir's history), ludo-powerups (turn-log).

// ── Card model ───────────────────────────────────────────
// rank: 3..15 where 11=J 12=Q 13=K 14=A 15=2 ; suit id: 0♠ 1♣ 2♦ 3♥
const SUITS = ["♠", "♣", "♦", "♥"];
const SUIT_RED = [false, false, true, true];
// Suit strength high→low: ♠ > ♥ > ♣ > ♦. Indexed by suit id.
const SUIT_RANK = [3, 1, 0, 2];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" };
const PLAYER_COLORS = ["#2ed573", "#ff4757", "#1e90ff", "#ffa502"];
const BOT_NAMES = ["You", "Bot Anh", "Bot Bat", "Bot Cag"];
const HAND_OVER_SECONDS = 8;

function rankLabel(r) { return RANK_LABEL[r] || String(r); }
function cardStrength(c) { return c.r * 4 + SUIT_RANK[c.s]; }            // 2 highest single
function cardWire(c) { return c.r * 4 + c.s; }
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
  if (n === 2) return allSame ? mk("pair", sorted, [cardStrength(top)], "pair of " + rankLabel(top.r) + "s") : null;
  if (n === 3) return allSame ? mk("triple", sorted, [ranks[0]], "triple " + rankLabel(ranks[0]) + "s") : null;
  if (n === 4) return allSame ? mk("four", sorted, [ranks[0]], "four " + rankLabel(ranks[0]) + "s") : null;
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
  if (isStraight && isFlush) return mk("sflush", runOrder, [4, ...straightKey], "straight flush to " + rankLabel(topS.r));
  if (sizes === "41") return mk("fourplus", sorted, [3, groups[0][1]], "four+1 (" + rankLabel(groups[0][1]) + "s)");
  if (sizes === "32") return mk("fullhouse", sorted, [2, groups[0][1]], "full house (" + rankLabel(groups[0][1]) + "s)");
  if (isFlush) return mk("flush", sorted, [1, ...sorted.map(cardStrength).sort((a, b) => b - a)], "5-flush " + SUITS[sorted[0].s]);
  if (isStraight) return mk("straight", runOrder, [0, ...straightKey], "straight to " + rankLabel(topS.r));
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
    if (g.length >= 2) out.push(classify(g.slice(-2)));
    if (g.length >= 3) out.push(classify(g.slice(-3)));
    if (g.length >= 4) out.push(classify(g.slice(0, 4)));
  });
  push5(out, hand, m, ranks);
  return out.filter(Boolean);
}
function push5(out, hand, m, ranks) {
  const bySuit = { 0: [], 1: [], 2: [], 3: [] };
  hand.forEach(c => bySuit[c.s].push(c));
  for (const s in bySuit) bySuit[s].sort((a, b) => cardStrength(a) - cardStrength(b));
  // straights & straight flushes (windows of 5 consecutive straight positions)
  for (let p = 0; p <= 8; p++) {
    const wr = [p, p + 1, p + 2, p + 3, p + 4].map(posToRank);
    if (!wr.every(r => m[r])) continue;
    const pick = wr.map((r, i) => i === 4 ? m[r][m[r].length - 1] : m[r][0]);  // top suit on high end
    out.push(classify(pick));
    for (const s of [0, 1, 2, 3]) {
      if (wr.every(r => m[r].some(c => c.s === s))) out.push(classify(wr.map(r => m[r].find(c => c.s === s))));
    }
  }
  // flushes (5 of a suit → highest 5)
  for (const s of [0, 1, 2, 3]) if (bySuit[s].length >= 5) out.push(classify(bySuit[s].slice(-5)));
  // full houses (triple + pair)
  ranks.forEach(tr => {
    if (m[tr].length < 3) return;
    ranks.forEach(pr => { if (pr !== tr && m[pr].length >= 2) out.push(classify(m[tr].slice(-3).concat(m[pr].slice(-2)))); });
  });
  // four + 1
  ranks.forEach(qr => {
    if (m[qr].length !== 4) return;
    const others = hand.filter(c => c.r !== qr).sort((a, b) => cardStrength(a) - cardStrength(b));
    if (others.length) out.push(classify(m[qr].concat(others[0])));
  });
}

function isPrecious(c) {
  return (c.len === 1 && c.cards[0].r === 15) || c.type === "four" || c.type === "fourplus" || c.type === "sflush";
}
function botLead(hand, mustIncludeLow) {
  let pool = allCombos(hand);
  if (mustIncludeLow) {
    const lc = lowestCard(hand);
    pool = pool.filter(c => c.cards.some(x => sameCard(x, lc)));
    if (!pool.length) return classify([lowestCard(hand)]);
  }
  const cost = c => {
    const topR = Math.max(...c.cards.map(x => x.r));
    return (topR === 15 ? 40 : topR) + (isPrecious(c) ? 120 : 0);
  };
  pool.sort((a, b) => (b.len * 10 - cost(b)) - (a.len * 10 - cost(a)));
  return pool[0];
}
function botFollow(hand, tableCombo) {
  const beats = allCombos(hand).filter(c => canBeat(c, tableCombo)).sort((a, b) => cmpArr(a.cmp, b.cmp));
  if (!beats.length) return null;
  const minimal = beats[0];
  if (isPrecious(minimal) && hand.length - minimal.len > 3) {
    const alt = beats.find(c => !isPrecious(c));
    return alt || null;
  }
  return minimal;
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

// ── Game state ───────────────────────────────────────────
let players = [];
let numPlayers = 4;
let hands = [];
let table = null;           // { combo, seat } | null
let turn = 0;
let firstPlay = true;       // first lead of the deal must include the lowest card
let lowCard = null;         // the globally lowest dealt card
let passed = new Set();
let lastAction = {};
let botTimer = null;
let dealActive = false;
let lastWinner = -1;
let loseAt = 30;            // a player who reaches this many penalty points is eliminated
let firstDeal = true;       // first deal of the game: lowest card (3♦) leads; later deals: winner leads
let trickPlays = [];        // plays in the current trick: [{ seat, combo }] (for the table history)
let endTimer = null;        // brief pause after the winning play before the results overlay
let mySeat = 0;

// ── DOM ──────────────────────────────────────────────────
const oppEl = document.getElementById("opponents");
const turnLine = document.getElementById("turnLine");
const tableComboEl = document.getElementById("tableCombo");
const tableLabelEl = document.getElementById("tableLabel");
const meNameEl = document.getElementById("meName");
const meStatusEl = document.getElementById("meStatus");
const handEl = document.getElementById("hand");
const playBtn = document.getElementById("playBtn");
const passBtn = document.getElementById("passBtn");
const setupOverlay = document.getElementById("setupOverlay");
const onlineOverlay = document.getElementById("onlineOverlay");
const handOverlay = document.getElementById("handOverlay");
const toastEl = document.getElementById("toast");

let selected = new Set();
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1300);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function makeCardEl(c) {
  const el = document.createElement("div");
  el.className = "card" + (SUIT_RED[c.s] ? " red" : "");
  const r = rankLabel(c.r), s = SUITS[c.s];
  el.innerHTML =
    '<span class="corner tl"><b>' + r + '</b><i>' + s + '</i></span>' +
    '<span class="pip">' + s + "</span>" +
    '<span class="corner br"><b>' + r + '</b><i>' + s + "</i></span>";
  return el;
}

// ── Rendering ────────────────────────────────────────────
function render() { renderOpponents(); renderTable(); renderHand(); renderControls(); }

// opponents are seated around the table; each shows a fan of face-down cards
// (one per card held) plus their count, so you can read everyone's hand size.
const OPP_POSITIONS = { 2: ["top"], 3: ["left", "right"], 4: ["left", "top", "right"] };
function renderOpponents() {
  oppEl.innerHTML = "";
  const positions = OPP_POSITIONS[numPlayers] || ["top", "left", "right"];
  for (let i = 1; i < numPlayers; i++) {
    const seat = (mySeat + i) % numPlayers;
    const p = players[seat];
    const act = lastAction[seat];
    const cnt = (hands[seat] || []).length;   // hands may be empty before the first deal
    const pos = positions[i - 1] || "top";
    const div = document.createElement("div");
    div.className = "opp opp--" + pos + (turn === seat && dealActive ? " turn" : "") + (cnt === 0 ? " done" : "");
    div.innerHTML =
      '<div class="opp-name">' +
        '<span class="opp-dot" style="background:' + p.color + '"></span>' +
        '<span class="opp-pname">' + escapeHtml(p.name) + "</span>" +
        '<span class="opp-score">' + p.total + "</span>" +
      "</div>" +
      '<div class="opp-fan">' + '<div class="mini-back"></div>'.repeat(cnt) + "</div>" +
      (act ? '<div class="opp-action ' + act.kind + '">' + act.text + "</div>" : "");
    oppEl.appendChild(div);
  }
}
function renderTable() {
  tableComboEl.innerHTML = "";
  if (trickPlays.length) {
    tableLabelEl.textContent = "";
    const shown = trickPlays.slice(-4);   // current trick's recent plays, oldest → newest
    shown.forEach((tp, idx) => {
      const latest = idx === shown.length - 1;
      const row = document.createElement("div");
      row.className = "tp-play" + (latest ? " latest" : "");
      const cards = document.createElement("div");
      cards.className = "tp-cards";
      tp.combo.cards.forEach(c => cards.appendChild(makeCardEl(c)));
      row.appendChild(cards);   // cards only — no name, no colour
      tableComboEl.appendChild(row);
    });
  } else {
    tableLabelEl.textContent = dealActive ? "Table is clear — lead any combo" : "";
  }
  if (!dealActive) { turnLine.textContent = "—"; turnLine.className = "turn-line"; return; }
  if (turn === mySeat) { turnLine.textContent = "Your turn"; turnLine.className = "turn-line mine"; }
  else { turnLine.textContent = players[turn].name + "'s turn…"; turnLine.className = "turn-line"; }
}
function renderHand() {
  handEl.innerHTML = "";
  const mine = hands[mySeat] || [];
  const myTurn = dealActive && turn === mySeat;
  mine.forEach((c, i) => {
    const el = makeCardEl(c);
    if (selected.has(i)) el.classList.add("sel");
    if (myTurn) el.addEventListener("click", () => toggleCard(i));
    handEl.appendChild(el);
  });
  layoutHand();
}

// Spread the fanned cards to fill the row so each exposes the largest possible
// tap target; gaps widen automatically as the hand shrinks, and a clear gap
// opens beside selected cards so multi-card picks are easy to read.
const CARD_W = 52, SEL_GAP = 8, MIN_EXPOSED = 16;
function layoutHand() {
  const cards = [...handEl.children];
  const n = cards.length;
  if (!n) return;
  const avail = (handEl.clientWidth || 440) - 12;
  const sel = cards.map(el => el.classList.contains("sel"));
  // reserve extra width for the gap on either side of each selected card
  let extra = 0;
  for (let i = 1; i < n; i++) if (sel[i] || sel[i - 1]) extra += SEL_GAP;
  let step = n > 1 ? (avail - CARD_W - extra) / (n - 1) : 0;
  step = Math.min(CARD_W + 6, Math.max(step, MIN_EXPOSED));   // cap gap; floor overlap
  cards.forEach((el, i) => {
    let ml = i === 0 ? 0 : step - CARD_W;
    if (i > 0 && (sel[i] || sel[i - 1])) ml += SEL_GAP;
    el.style.marginLeft = ml + "px";
  });
}
window.addEventListener("resize", layoutHand);
function renderControls() {
  const myTurn = dealActive && turn === mySeat;
  if (!myTurn) {
    playBtn.disabled = true; passBtn.disabled = true;
    meStatusEl.textContent = dealActive ? "Waiting…" : "";
    meStatusEl.className = "me-status";
    return;
  }
  const combo = classify(selectedCards());
  const legal = isLegalPlay(combo);
  playBtn.disabled = !legal;
  passBtn.disabled = !table;
  if (selected.size === 0) {
    if (!table) meStatusEl.textContent = firstPlay ? ("Lead — must include " + lowLabel()) : "Your lead";
    else meStatusEl.textContent = "Beat the " + comboName(table.combo) + ", or pass";
    meStatusEl.className = "me-status";
  } else if (!combo) {
    meStatusEl.textContent = selected.size > 5 ? "Max 5 cards per play" : selected.size + " cards — not a valid combo";
    meStatusEl.className = "me-status bad";
  } else if (!legal) {
    const why = firstPlay && !combo.cards.some(c => sameCard(c, lowCard)) ? "must include " + lowLabel()
      : table ? "doesn't beat the table" : "illegal";
    meStatusEl.textContent = comboName(combo) + " — " + why;
    meStatusEl.className = "me-status bad";
  } else {
    meStatusEl.textContent = comboName(combo) + " ✓";
    meStatusEl.className = "me-status good";
  }
}
function lowLabel() { return lowCard ? rankLabel(lowCard.r) + SUITS[lowCard.s] : "the lowest card"; }

function selectedCards() {
  const mine = hands[mySeat] || [];
  return [...selected].map(i => mine[i]).filter(Boolean);
}
function isLegalPlay(combo) {
  if (!combo) return false;
  if (firstPlay && !combo.cards.some(c => sameCard(c, lowCard))) return false;
  return canBeat(combo, table ? table.combo : null);
}

// ── Selection / human input ──────────────────────────────
function toggleCard(i) {
  if (selected.has(i)) selected.delete(i);
  else if (selected.size >= 5) { toast("Max 5 cards"); return; }   // never select/raise more than 5
  else selected.add(i);
  renderHand(); renderControls();   // selection only — playing happens via the Play button
}
playBtn.addEventListener("click", humanPlay);
passBtn.addEventListener("click", () => { if (!passBtn.disabled) humanPass(); });

function humanPlay() {
  if (turn !== mySeat) return;
  const combo = classify(selectedCards());
  if (!isLegalPlay(combo)) { toast("Not a legal play"); return; }
  selected.clear();
  doPlay(mySeat, combo);
  if (online) sendMove({ kind: "play", cards: combo.cards.map(cardWire) });
}
function humanPass() {
  if (turn !== mySeat || !table) return;
  selected.clear();
  doPass(mySeat);
  if (online) sendMove({ kind: "pass" });
}

// ── Engine ───────────────────────────────────────────────
function activeSeats() { return players.map((p, s) => s).filter(s => !players[s].out); }
function startDeal(seed) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  // deal 13 only to players still in the game; eliminated seats sit out
  const active = activeSeats();
  const dealt = dealHands(seed, active.length);
  hands = players.map(() => []);
  active.forEach((s, i) => { hands[s] = dealt[i]; });
  table = null;
  passed = new Set();
  trickPlays = [];
  lastAction = {};
  selected.clear();
  dealActive = true;
  // auto-win: an active hand with all 13 distinct ranks (3→A + 2)
  const dragon = active.find(s => new Set(hands[s].map(c => c.r)).size === 13);
  // first deal of the game → lowest-card (3♦) holder leads; later deals → the
  // previous round's winner leads. No mandatory 3♦-inclusion on the first move.
  let starter;
  if (firstDeal) {
    starter = active[0];
    active.forEach(s => { if (cardStrength(lowestCard(hands[s])) < cardStrength(lowestCard(hands[starter]))) starter = s; });
  } else {
    starter = (lastWinner >= 0 && !players[lastWinner].out) ? lastWinner : active[0];
  }
  lowCard = lowestCard(hands[starter]);
  turn = starter;
  firstPlay = false;
  firstDeal = false;
  handOverlay.classList.remove("show");
  onlineOverlay.classList.remove("show");   // cards are in — clear the "Dealing…" cover
  render();
  if (dragon !== undefined) { toast(players[dragon].name + " — DRAGON! 🐉"); dealActive = false; endHand(dragon, true); return; }
  beginTurn();
}

function beginTurn() {
  render();
  if (!dealActive || online) return;
  if (players[turn].isBot) botTimer = setTimeout(botAct, 750 + Math.floor(Math.random() * 500));
}
function botAct() {
  botTimer = null;
  if (!dealActive || online) return;
  const hand = hands[turn];
  if (!table) doPlay(turn, botLead(hand, firstPlay));
  else { const m = botFollow(hand, table.combo); if (m) doPlay(turn, m); else doPass(turn); }
}

function doPlay(seat, combo) {
  const hand = hands[seat];
  combo.cards.forEach(pc => { const idx = hand.findIndex(c => sameCard(c, pc)); if (idx >= 0) hand.splice(idx, 1); });
  table = { combo, seat };
  trickPlays.push({ seat, combo });
  firstPlay = false;
  lastAction[seat] = { kind: "play", text: comboName(combo) };
  if (hand.length === 0) { lastAction[seat] = { kind: "win", text: "OUT! 🎉" }; dealActive = false; endHand(seat, false); return; }
  advanceTurn();
}
function doPass(seat) {
  passed.add(seat);
  lastAction[seat] = { kind: "pass", text: "Pass" };
  advanceTurn();
}
function advanceTurn() {
  render();
  if (!table) { beginTurn(); return; }
  const owner = table.seat;
  for (let i = 1; i <= numPlayers; i++) {
    const s = (turn + i) % numPlayers;
    if (s === owner) { clearTrick(owner); return; }   // looped back to owner → trick won
    if (passed.has(s) || players[s].out) continue;    // skip passers and eliminated seats
    turn = s; beginTurn(); return;
  }
  clearTrick(owner);
}
function clearTrick(winnerSeat) {
  table = null;
  passed = new Set();
  trickPlays = [];
  for (const k in lastAction) if (lastAction[k] && lastAction[k].kind !== "win") delete lastAction[k];
  turn = winnerSeat;
  beginTurn();
}

function endHand(winnerSeat, dragon) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  lastWinner = winnerSeat;
  // losers ADD their leftover-card penalty toward the lose-at threshold
  const deltas = Array(numPlayers).fill(0);
  for (let s = 0; s < numPlayers; s++) {
    if (players[s].out || s === winnerSeat) continue;
    const n = hands[s].length;
    const ded = dragon ? 3 * n : deduction(n);
    deltas[s] = ded;
    players[s].total += ded;
  }
  // eliminate anyone who reached the threshold (the round winner added 0, stays safe)
  const newlyOut = [];
  for (let s = 0; s < numPlayers; s++) {
    if (!players[s].out && players[s].total >= loseAt) { players[s].out = true; newlyOut.push(s); }
  }
  render();   // show the winning play on the table first, so everyone sees the last trick
  if (endTimer) clearTimeout(endTimer);
  endTimer = setTimeout(function () {
    endTimer = null;
    if (activeSeats().length <= 1) showGameOver();
    else showHandOver(winnerSeat, deltas, newlyOut);
  }, 2400);
}

// ── Hand-over overlay ────────────────────────────────────
let handCdInterval = null, handCdTimeout = null;
function showHandOver(winnerSeat, deltas, newlyOut) {
  newlyOut = newlyOut || [];
  document.getElementById("handTitle").textContent = winnerSeat === mySeat ? "You win the round!" : players[winnerSeat].name + " wins the round!";
  const sb = document.getElementById("handScoreboard");
  sb.innerHTML = "";
  // lower total is safer → list best (lowest) first
  const order = players.map((p, s) => s).sort((a, b) => players[a].total - players[b].total);
  const best = Math.min(...players.filter(p => !p.out).map(p => p.total));
  order.forEach(seat => {
    const p = players[seat];
    const justOut = newlyOut.includes(seat);
    const row = document.createElement("div");
    row.className = "sb-row" + (!p.out && p.total === best ? " lead" : "");
    const tag = p.out ? '<span class="rv-foul">OUT</span>' : (seat === winnerSeat ? "🏆 won" : hands[seat].length + " left");
    row.innerHTML =
      '<div class="sb-dot" style="background:' + p.color + (p.out ? ";opacity:.4" : "") + '"></div>' +
      '<div class="sb-name"' + (p.out ? ' style="opacity:.55"' : "") + '>' + escapeHtml(p.name) + "</div>" +
      '<div class="sb-rank" style="width:auto;opacity:.7">' + tag + "</div>" +
      '<div class="sb-delta" style="color:' + (deltas[seat] ? "#ff9aa2" : "#7be8a8") + '">' + (deltas[seat] ? "+" + deltas[seat] : "—") + "</div>" +
      '<div class="sb-score">' + p.total + '<small> / ' + loseAt + "</small></div>";
    sb.appendChild(row);
  });
  const cd = document.getElementById("handCountdown");
  const actions = document.getElementById("handActions");
  actions.innerHTML = "";
  if (online) {
    cd.textContent = isHost ? "Dealing next round…" : "Waiting for next deal…";
    if (handCdTimeout) clearTimeout(handCdTimeout);
    if (isHost) handCdTimeout = setTimeout(() => { handOverlay.classList.remove("show"); hostDeal(); }, HAND_OVER_SECONDS * 1000);
  } else {
    let left = HAND_OVER_SECONDS;
    cd.textContent = "Next round in " + left + "s";
    if (handCdInterval) clearInterval(handCdInterval);
    handCdInterval = setInterval(() => { left--; cd.textContent = "Next round in " + left + "s"; if (left <= 0) startNextLocal(); }, 1000);
    const next = document.createElement("button");
    next.className = "btn-next"; next.textContent = "Next Round";
    next.addEventListener("click", startNextLocal);
    const quit = document.createElement("button");
    quit.className = "btn-quit"; quit.textContent = "New Game";
    quit.addEventListener("click", backToSetup);
    actions.appendChild(next); actions.appendChild(quit);
  }
  handOverlay.classList.add("show");
}
function startNextLocal() {
  if (handCdInterval) clearInterval(handCdInterval);
  handOverlay.classList.remove("show");
  startDeal(randomSeed());
}
function backToSetup() {
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  handOverlay.classList.remove("show");
  dealActive = false;
  setupOverlay.classList.add("show");
}

// Game over: only one player has avoided the lose-at threshold — they win.
function showGameOver() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);
  handOverlay.classList.remove("show");
  dealActive = false;
  const survivors = activeSeats();
  const ranked = players.map((p, s) => s).sort((a, b) => players[a].total - players[b].total);
  const champ = survivors.length ? survivors[0] : ranked[0];
  document.getElementById("winnerName").textContent = champ === mySeat ? "You" : players[champ].name;
  const sb = document.getElementById("finalScoreboard");
  sb.innerHTML = "";
  ranked.forEach(seat => {
    const p = players[seat];
    const row = document.createElement("div");
    row.className = "sb-row" + (seat === champ ? " lead" : "");
    row.innerHTML =
      '<div class="sb-dot" style="background:' + p.color + '"></div>' +
      '<div class="sb-name">' + escapeHtml(p.name) + "</div>" +
      '<div class="sb-rank" style="width:auto;opacity:.7">' + (seat === champ ? "survivor" : "out") + "</div>" +
      '<div class="sb-score">' + p.total + "</div>";
    sb.appendChild(row);
  });
  document.getElementById("winnerOverlay").classList.add("show");
}
document.getElementById("playAgainBtn").addEventListener("click", () => {
  document.getElementById("winnerOverlay").classList.remove("show");
  if (online) { location.reload(); return; }   // fresh room/seed online
  players.forEach(p => { p.total = 0; p.out = false; });
  firstDeal = true; lastWinner = -1;
  startDeal(randomSeed());
});

// ── Table skin (green ↔ red velvet) — a per-client cosmetic, persisted ──
let skin = "green";
try { skin = localStorage.getItem("mp_skin") || "green"; } catch (e) {}
function applySkin(s) {
  skin = (s === "red") ? "red" : "green";
  document.body.classList.toggle("skin-red", skin === "red");
  try { localStorage.setItem("mp_skin", skin); } catch (e) {}
}
applySkin(skin);
document.getElementById("skinToggle").addEventListener("click", () => applySkin(skin === "green" ? "red" : "green"));

// ── Setup (local) ────────────────────────────────────────
document.querySelectorAll("#countRow .count-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#countRow .count-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    numPlayers = +btn.dataset.count;
  });
});
document.querySelectorAll("#loseRow .count-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#loseRow .count-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    loseAt = +btn.dataset.lose;
  });
});
document.getElementById("startBtn").addEventListener("click", () => {
  const myName = (document.getElementById("nameInput").value || "You").slice(0, 10);
  players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ name: i === 0 ? myName : BOT_NAMES[i], color: PLAYER_COLORS[i], isBot: i !== 0, total: 0, out: false });
  }
  online = false;
  mySeat = 0;
  firstDeal = true; lastWinner = -1;
  setupOverlay.classList.remove("show");
  meNameEl.textContent = myName;
  startDeal(randomSeed());
});

// ── Online (Usion) ───────────────────────────────────────
let online = false;
let myId = null, myName = "You", myAvatar = null;
let roomPlayerIds = [];
let connectedCount = 0;
let isHost = false;
let gameStarted = false;
let lastSeq = 0;
let curSeed = 0;
let moveLog = [];
const playerMeta = {};

if (window.Usion && Usion.init) {
  try {
    Usion.init(async function (config) {
      myId = config.userId;
      if (config.userName) myName = config.userName;
      if (config.userAvatar) myAvatar = config.userAvatar;
      playerMeta[myId] = { name: myName, avatar: myAvatar };
      if (config.roomId) {
        online = true;
        setupOverlay.classList.remove("show");
        onlineOverlay.classList.add("show");
        await setupMultiplayer(config.roomId);
      }
    });
  } catch (e) { /* standalone preview */ }
}
async function setupMultiplayer(roomId) {
  try {
    await Usion.game.connect();
    Usion.game.onJoined(onJoined);
    Usion.game.onPlayerJoined(onPlayerJoined);
    Usion.game.onPlayerLeft(onPlayerLeft);
    Usion.game.onAction(onNetAction);
    Usion.game.onRealtime(onNetRealtime);
    Usion.game.onSync(onNetSync);
    if (Usion.game.onReconnect) Usion.game.onReconnect(() => { Usion.game.requestSync(0); Usion.game.realtime("request_state", {}); });
    await Usion.game.join(roomId);
  } catch (err) {
    console.error("Multiplayer failed:", err);
    online = false; onlineOverlay.classList.remove("show"); setupOverlay.classList.add("show");
  }
}
function sendPlayerInfo() { Usion.game.realtime("player_info", { name: myName, avatar: myAvatar || null }); }
// number of seats this online match has, from the authorized roster (2–4)
function targetSeats() { return Math.max(2, Math.min(4, roomPlayerIds.length || 2)); }

function onJoined(data) {
  roomPlayerIds = data.player_ids || [];
  connectedCount = Number(data.connected_count || 0);
  if (data.sequence !== undefined) lastSeq = data.sequence;
  isHost = roomPlayerIds[0] === myId;
  sendPlayerInfo(); updateOnlineStatus();
  Usion.game.requestSync(0);   // SDK replays the stored deal + moves via onSync
  maybeStart();
}
function onPlayerJoined(data) {
  if (data.player_ids) roomPlayerIds = data.player_ids;
  else if (data.player && data.player.id && !roomPlayerIds.includes(data.player.id)) roomPlayerIds.push(data.player.id);
  if (typeof data.connected_count === "number") connectedCount = data.connected_count;
  else if (data.player && data.player.is_connected) connectedCount = Math.min(roomPlayerIds.length, connectedCount + 1);
  isHost = roomPlayerIds[0] === myId;
  sendPlayerInfo(); updateOnlineStatus(); maybeStart();
}
function onPlayerLeft(data) {
  if (data && data.player_ids) roomPlayerIds = data.player_ids;
  connectedCount = Math.max(0, connectedCount - 1);
  isHost = roomPlayerIds[0] === myId;
  if (!gameStarted) updateOnlineStatus();
}
function updateOnlineStatus() {
  const s = document.getElementById("onlineStatus");
  if (!s) return;
  const n = targetSeats();
  s.textContent = connectedCount < n
    ? ("Waiting for players… (" + Math.min(connectedCount, n) + "/" + n + ")")
    : (n + " players ready — starting…");
}
// Every client starts independently once the roster is fully connected (same
// model as Ludo). 13 also needs a shared deal, so the host (seat 0) then
// broadcasts the seed; the others deal identically on receiving it.
function maybeStart() {
  if (gameStarted) return;
  if (roomPlayerIds.length >= 2 && connectedCount >= targetSeats()) {
    startOnlineGame({ order: roomPlayerIds.slice() });
    if (isHost) hostDeal();
  }
}
function startOnlineGame(data) {
  if (gameStarted) return;
  gameStarted = true; online = true;
  roomPlayerIds = data.order;
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  isHost = roomPlayerIds[0] === myId;
  firstDeal = true; lastWinner = -1;
  players = roomPlayerIds.map((id, i) => ({
    name: (playerMeta[id] && playerMeta[id].name) || (id === myId ? myName : "Player " + (i + 1)),
    color: PLAYER_COLORS[i], isBot: false, total: 0, out: false
  }));
  meNameEl.textContent = players[mySeat].name;
  setupOverlay.classList.remove("show");
  const os = document.getElementById("onlineStatus");
  if (os) os.textContent = "Dealing…";
  onlineOverlay.classList.add("show");   // keep covering the table until the first deal lands
  render();
  Usion.game.requestSync(0);   // catch any actions (e.g. the deal) we missed
}
function hostDeal() {
  if (!isHost) return;
  curSeed = randomSeed();
  Usion.game.action("deal", { seed: curSeed, order: roomPlayerIds }).catch(() => {});
}
function sendMove(move) { moveLog.push(move); Usion.game.action("move", move).catch(() => {}); }
function applyRemoteMove(move) {
  if (!dealActive) return;
  const seat = turn;
  if (move.kind === "pass") doPass(seat);
  else { const combo = classify(move.cards.map(wireCard)); if (combo) doPlay(seat, combo); }
}
function onNetAction(data) {
  if (data.sequence !== undefined) lastSeq = Math.max(lastSeq, data.sequence);
  const d = data.action_data || {};
  if (data.action_type === "deal") onDeal(d);
  else if (data.action_type === "move") { if (data.player_id === myId) return; moveLog.push(d); applyRemoteMove(d); }
}
function onNetRealtime(data) {
  if (data.player_id === myId) return;
  const d = data.action_data || {};
  if (data.action_type === "player_info") {
    playerMeta[data.player_id] = { name: d.name, avatar: d.avatar };
    if (gameStarted) { refreshNames(); render(); } else updateOnlineStatus();
  }
}
// Catch-up replay (from requestSync). Each "deal" resets state, so replaying
// the whole log from sequence 0 deterministically rebuilds the current round.
function onNetSync(data) {
  if (data.sequence !== undefined) lastSeq = Math.max(lastSeq, data.sequence);
  if (!data.actions) return;
  data.actions.forEach(a => {
    const d = a.action_data || {};
    if (a.action_type === "deal") onDeal(d);
    else if (a.action_type === "move") { moveLog.push(d); applyRemoteMove(d); }
  });
}
function onDeal(d) {
  if (!gameStarted) startOnlineGame({ order: d.order });
  curSeed = d.seed; moveLog = [];
  handOverlay.classList.remove("show");
  numPlayers = d.order.length;
  startDeal(d.seed);
}
function refreshNames() {
  roomPlayerIds.forEach((id, i) => { if (players[i] && playerMeta[id] && playerMeta[id].name) players[i].name = playerMeta[id].name; });
  if (players[mySeat]) meNameEl.textContent = players[mySeat].name;
}
