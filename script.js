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
const BOT_NAMES = ["Та", "Бот Бат", "Бот Болд", "Бот Сүх"];
const HAND_OVER_SECONDS = 5;
const TURN_SECONDS = 90;   // each player gets 2:00 to act; on expiry they auto-pass (auto-lead if leading)

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
  if (n === 2) return allSame ? mk("pair", sorted, [cardStrength(top)], rankLabel(top.r) + " хос") : null;
  if (n === 3) return allSame ? mk("triple", sorted, [ranks[0]], rankLabel(ranks[0]) + " гурав") : null;
  if (n === 4) return allSame ? mk("four", sorted, [ranks[0]], rankLabel(ranks[0]) + " дөрөв") : null;
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
  if (isStraight && isFlush) return mk("sflush", runOrder, [4, ...straightKey], rankLabel(topS.r) + " дараалал флэш");
  if (sizes === "41") return mk("fourplus", sorted, [3, groups[0][1]], "дөрөв+1 (" + rankLabel(groups[0][1]) + ")");
  if (sizes === "32") return mk("fullhouse", sorted, [2, groups[0][1]], "фулл хаус (" + rankLabel(groups[0][1]) + ")");
  if (isFlush) return mk("flush", sorted, [1, ...sorted.map(cardStrength).sort((a, b) => b - a)], "флэш " + SUITS[sorted[0].s]);
  if (isStraight) return mk("straight", runOrder, [0, ...straightKey], rankLabel(topS.r) + " дараалал");
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
let passStreak = 0;         // consecutive passes since the last play (trick ends at active-1)
let lastAction = {};
let botTimer = null;
let turnTimer = null;       // ticks the active player's 2:00 turn clock
let turnLeft = TURN_SECONDS;
let netPaused = false;      // true while our connection is dropped — freezes the turn clock so a disconnect can't auto-pass us
let dealActive = false;
let lastWinner = -1;
let loseAt = 30;            // a player who reaches this many penalty points is eliminated
let firstDeal = true;       // first deal of the game: lowest card (3♦) leads; later deals: winner leads
let trickPlays = [];        // plays in the current trick: [{ seat, combo }] (for the table history)
let endTimer = null;        // brief pause after the winning play before the results overlay
let dealWaitTimer = null;   // non-host: keep asking for the host's deal until it lands
let mySeat = 0;
// Round-start snapshot for host checkpoints: scores/elimination + the starter
// context (firstDeal/lastWinner) as they were when THIS round was dealt, so a
// reconnecting client can rebuild the live round from the checkpoint alone
// (deal + replay this round's moves) instead of the full action log.
let roundStartTotals = [];
let roundStartOuts = [];
let roundFirstDeal = true;
let roundLastWinner = -1;

// ── DOM ──────────────────────────────────────────────────
const oppEl = document.getElementById("opponents");
const turnLine = document.getElementById("turnLine");
const tableComboEl = document.getElementById("tableCombo");
const tableLabelEl = document.getElementById("tableLabel");
const meNameEl = document.getElementById("meName");
const meScoreEl = document.getElementById("meScore");
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
function render() { renderOpponents(); renderTable(); renderHand(); renderControls(); updateTimers(); renderMyScore(); }
function renderMyScore() { if (meScoreEl && players[mySeat]) meScoreEl.textContent = players[mySeat].total; }

// ── Turn clock (per-player 2:00; auto-pass / auto-lead on expiry) ─────────
function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
// A circular countdown ring: the foreground arc depletes as the turn elapses,
// with the remaining time shown in the centre. pathLength=100 lets us drive the
// arc with a 0–100 dashoffset regardless of the circle's radius.
function ringSVG() {
  return '<svg viewBox="0 0 36 36">' +
    '<circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>' +
    '<circle class="ring-fg" cx="18" cy="18" r="7.75" pathLength="100"></circle>' +
    '</svg>';
}
function setTimerEl(el, live, secs) {
  if (!el) return;
  el.classList.toggle("live", live);
  el.classList.toggle("warn", live && secs <= 10);
  const frac = Math.max(0, Math.min(1, secs / TURN_SECONDS));
  const fg = el.querySelector(".ring-fg");
  if (fg) fg.style.strokeDashoffset = (100 * (1 - frac)).toFixed(2);
}
// Refresh just the clock rings (cheap; runs every second without a full render).
function updateTimers() {
  document.querySelectorAll(".opp").forEach(div => {
    const seat = +div.dataset.seat;
    const live = dealActive && turn === seat;
    setTimerEl(div.querySelector(".opp-timer"), live, live ? turnLeft : TURN_SECONDS);
  });
  const live = dealActive && turn === mySeat;
  setTimerEl(document.getElementById("meTimer"), live, live ? turnLeft : TURN_SECONDS);
}
function stopTurnTimer() { if (turnTimer) { clearInterval(turnTimer); turnTimer = null; } }
function startTurnTimer() {
  stopTurnTimer();
  turnLeft = TURN_SECONDS;
  // Frozen while disconnected: keep the clock displayed but don't tick (a dropped
  // player must not be auto-passed). The reconnect handler restarts it.
  if (!dealActive || netPaused) { updateTimers(); return; }
  updateTimers();
  turnTimer = setInterval(() => {
    turnLeft -= 1;
    updateTimers();
    if (turnLeft <= 0) { stopTurnTimer(); onTurnTimeout(); }
  }, 1000);
}
// Only the client that controls the active seat resolves the timeout, so the
// move is generated (and broadcast online) exactly once. Other clients just let
// their display sit at 0:00 until the move arrives and resets the clock.
function onTurnTimeout() {
  if (!dealActive || netPaused) return;   // never resolve a timeout while our link is down
  if (online) { if (turn !== mySeat) return; }       // remote seats resolve on their own client
  else if (players[turn].isBot) return;              // local bots act via botTimer, never time out
  autoMove(turn);
}
function autoMove(seat) {
  selected.clear();
  if (table) {                                       // following → forfeit the trick
    if (online) sendMove({ kind: "pass" });
    else doPass(seat);
  } else {                                            // leading → can't pass, so play a forced minimal lead
    const combo = botLead(hands[seat], firstPlay);
    if (!combo) return;
    if (online) sendMove({ kind: "play", cards: combo.cards.map(cardWire) });
    else doPlay(seat, combo);
  }
}

// opponents are seated around the table; each shows a fan of face-down cards
// (one per card held) plus their count, so you can read everyone's hand size.
const OPP_POSITIONS = { 2: ["top"], 3: ["left", "right"], 4: ["left", "top", "right"] };
function renderOpponents() {
  oppEl.innerHTML = "";
  const positions = OPP_POSITIONS[numPlayers] || ["top", "left", "right"];
  for (let i = 1; i < numPlayers; i++) {
    const seat = (mySeat + i) % numPlayers;
    const p = players[seat];
    const cnt = (hands[seat] || []).length;   // hands may be empty before the first deal
    const pos = positions[i - 1] || "top";
    const live = turn === seat && dealActive;
    const div = document.createElement("div");
    div.className = "opp opp--" + pos + (live ? " turn" : "") + (cnt === 0 ? " done" : "");
    div.dataset.seat = seat;
    div.innerHTML =
      '<div class="opp-name">' +
        '<span class="opp-timer seat-timer' + (live ? " live" : "") + '">' + ringSVG() + "</span>" +
        '<span class="opp-pname">' + escapeHtml(p.name) + "</span>" +
        '<span class="opp-score">' + p.total + "</span>" +
      "</div>" +
      '<div class="opp-fan">' + '<div class="mini-back"></div>'.repeat(cnt) + "</div>";
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
    tableLabelEl.textContent = "";
  }
  if (!dealActive) { turnLine.textContent = "—"; turnLine.className = "turn-line"; return; }
  if (turn === mySeat) { turnLine.textContent = "Таны ээлж"; turnLine.className = "turn-line mine"; }
  else { turnLine.textContent = players[turn].name + "-ийн ээлж…"; turnLine.className = "turn-line"; }
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
  meStatusEl.textContent = "";
  meStatusEl.className = "me-status";
  const myTurn = dealActive && turn === mySeat;
  if (pendingAction) {
    playBtn.disabled = true; passBtn.disabled = true;
    meStatusEl.textContent = "Илгээж байна…";
    meStatusEl.className = "me-status";
    return;
  }
  if (!myTurn) {
    playBtn.disabled = true; passBtn.disabled = true;
    return;
  }
  const combo = classify(selectedCards());
  const legal = isLegalPlay(combo);
  playBtn.disabled = !legal;
  passBtn.disabled = !table;
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
  else if (selected.size >= 5) { toast("Дээд тал нь 5 хөзөр"); return; }   // never select/raise more than 5
  else selected.add(i);
  renderHand(); renderControls();   // selection only — playing happens via the Play button
}
playBtn.addEventListener("click", humanPlay);
passBtn.addEventListener("click", () => { if (!passBtn.disabled) humanPass(); });

function humanPlay() {
  if (turn !== mySeat) return;
  const combo = classify(selectedCards());
  if (!isLegalPlay(combo)) { toast("Хүчингүй тавилт"); return; }
  selected.clear();
  if (online) sendMove({ kind: "play", cards: combo.cards.map(cardWire) });
  else doPlay(mySeat, combo);
}
function humanPass() {
  if (turn !== mySeat || !table) return;
  selected.clear();
  if (online) sendMove({ kind: "pass" });
  else doPass(mySeat);
}

// ── Engine ───────────────────────────────────────────────
function activeSeats() { return players.map((p, s) => s).filter(s => !players[s].out); }
function nextActiveAfter(seat) {
  for (let i = 1; i <= numPlayers; i++) { const s = (seat + i) % numPlayers; if (!players[s].out) return s; }
  return seat;
}
function startDeal(seed) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (dealWaitTimer) { clearInterval(dealWaitTimer); dealWaitTimer = null; }
  stopTurnTimer();
  // snapshot scores/elimination + starter context AT THE START of this round, so
  // a host checkpoint replays deterministically on reconnecting clients (replay
  // adds this round's deltas on top of these, avoiding double-counting).
  roundStartTotals = players.map(p => p.total);
  roundStartOuts = players.map(p => p.out);
  roundFirstDeal = firstDeal;
  roundLastWinner = lastWinner;
  // deal 13 only to players still in the game; eliminated seats sit out
  const active = activeSeats();
  const dealt = dealHands(seed, active.length);
  hands = players.map(() => []);
  active.forEach((s, i) => { hands[s] = dealt[i]; });
  table = null;
  passed = new Set();
  passStreak = 0;
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
  if (dragon !== undefined) { toast(players[dragon].name + " — ЛУУ! 🐉"); dealActive = false; endHand(dragon, true); return; }
  beginTurn();
}

function beginTurn() {
  render();
  maybeNotifyTurn();
  startTurnTimer();
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
  passStreak = 0;                       // a play resets the consecutive-pass count
  lastAction[seat] = { kind: "play", text: comboName(combo) };
  if (hand.length === 0) { lastAction[seat] = { kind: "win", text: "ДУУСГАВ! 🎉" }; dealActive = false; endHand(seat, false); return; }
  advanceTurn();
}
function doPass(seat) {
  passed.add(seat);
  passStreak += 1;
  lastAction[seat] = { kind: "pass", text: "Өнжих" };
  // No lock-out: a passer is NOT skipped on later turns. The trick ends only when
  // every OTHER active player has passed in a row since the last play.
  if (table && passStreak >= activeSeats().length - 1) { render(); clearTrick(table.seat); return; }
  advanceTurn();
}
// Hand the turn to the next active (non-eliminated) seat. Passers keep their seat
// in the rotation — they get asked again instead of being skipped for the trick.
function advanceTurn() {
  render();
  if (!dealActive) return;
  turn = nextActiveAfter(turn);
  beginTurn();
}
function clearTrick(winnerSeat) {
  table = null;
  passed = new Set();
  passStreak = 0;
  trickPlays = [];
  for (const k in lastAction) if (lastAction[k] && lastAction[k].kind !== "win") delete lastAction[k];
  turn = (players[winnerSeat] && players[winnerSeat].out) ? nextActiveAfter(winnerSeat) : winnerSeat;
  beginTurn();
}

function endHand(winnerSeat, dragon) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  stopTurnTimer();
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
  document.getElementById("handTitle").textContent = winnerSeat === mySeat ? "Та тойргийг хожлоо!" : players[winnerSeat].name + " тойргийг хожлоо!";
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
    const tag = p.out ? '<span class="rv-foul">ХОЖИГДСОН</span>' : (seat === winnerSeat ? "🏆 хожлоо" : hands[seat].length + " үлдсэн");
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
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);

  // Big ticking countdown to the next round (5 → 4 → 3 …), shown the same way
  // online and offline so everyone sees how long until the next deal.
  let left = HAND_OVER_SECONDS;
  const renderCd = (pop) => {
    cd.innerHTML =
      'Дараагийн тойрог <span class="cd-num' + (pop ? " pop" : "") + '">' + left + '</span> секундын дараа';
  };
  renderCd(false);
  handCdInterval = setInterval(() => {
    left--;
    if (left < 0) left = 0;
    renderCd(true);
    if (left <= 0) {
      clearInterval(handCdInterval); handCdInterval = null;
      if (!online) startNextLocal();
      else if (isHost) { handOverlay.classList.remove("show"); hostDeal(); }
    }
  }, 1000);

  if (!online) {
    const next = document.createElement("button");
    next.className = "btn-next"; next.textContent = "Дараагийн тойрог";
    next.addEventListener("click", startNextLocal);
    const quit = document.createElement("button");
    quit.className = "btn-quit"; quit.textContent = "Шинэ тоглоом";
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
  stopTurnTimer();
  handOverlay.classList.remove("show");
  dealActive = false;
  setupOverlay.classList.add("show");
}

// Game over: only one player has avoided the lose-at threshold — they win.
function showGameOver() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  stopTurnTimer();
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);
  handOverlay.classList.remove("show");
  dealActive = false;
  const survivors = activeSeats();
  const ranked = players.map((p, s) => s).sort((a, b) => players[a].total - players[b].total);
  const champ = survivors.length ? survivors[0] : ranked[0];
  recordOutcome(champ === mySeat);   // multiplayer-only, idempotent per match
  document.getElementById("winnerName").textContent = champ === mySeat ? "Та" : players[champ].name;
  const sb = document.getElementById("finalScoreboard");
  sb.innerHTML = "";
  ranked.forEach(seat => {
    const p = players[seat];
    const row = document.createElement("div");
    row.className = "sb-row" + (seat === champ ? " lead" : "");
    row.innerHTML =
      '<div class="sb-dot" style="background:' + p.color + '"></div>' +
      '<div class="sb-name">' + escapeHtml(p.name) + "</div>" +
      '<div class="sb-rank" style="width:auto;opacity:.7">' + (seat === champ ? "үлдсэн" : "хожигдсон") + "</div>" +
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
  const myName = (document.getElementById("nameInput").value || "Та").slice(0, 10);
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
let myId = null, myName = "Та", myAvatar = null;
let roomPlayerIds = [];
let connectedCount = 0;
let isHost = false;
let gameStarted = false;
let lastSeq = 0;
let curSeed = 0;
let moveLog = [];
let checkpointVersion = 0;
let replayingSync = false;
let appliedSequences = new Set();
let pendingAction = false;
const playerMeta = {};
// ── Lobby (waiting room): who's connected + their ready state, pre-game ──
const presentIds = new Set();   // player ids currently in the room (connected)
let lobbyReady = {};            // id → bool ready flag
let myReady = false;            // my own ready toggle

// ── Usion capabilities: cloud stats · leaderboard · notify · checkpoint ──
// All wrappers are defensive: missing modules / standalone preview must never
// throw (a thrown error in init blanks the game). They no-op gracefully.
let myStats = { wins: 0, losses: 0, games: 0 };
let statsRecordedThisGame = false;
let lastTurnNotified = false;
const STATS_KEY = "mp13:stats";

function isHostPlayer() {
  return online && Array.isArray(roomPlayerIds) && roomPlayerIds.length > 0 && roomPlayerIds[0] === myId;
}

// Cross-device stats: prefer Cloud KV, fall back to localStorage cache.
async function loadStats() {
  try {
    if (window.Usion && Usion.cloud) {
      const remote = await Usion.cloud.get(STATS_KEY);
      if (remote && typeof remote === "object") {
        myStats = Object.assign(myStats, remote);
        try { localStorage.setItem(STATS_KEY, JSON.stringify(myStats)); } catch (_) {}
        return;
      }
    }
  } catch (_) {}
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) myStats = Object.assign(myStats, JSON.parse(raw));
  } catch (_) {}
}

function persistStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(myStats)); } catch (_) {}
  try { if (window.Usion && Usion.cloud) Usion.cloud.set(STATS_KEY, myStats); } catch (_) {}
}

function submitLeaderboard() {
  try {
    if (window.Usion && Usion.leaderboard) {
      // Score = total cumulative wins; ranked highest-first. (Needs leaderboard.enabled on the service.)
      Usion.leaderboard.submit(myStats.wins, { games: myStats.games });
    }
  } catch (_) {}
}

function notifySelf(title, body) {
  // Only fires when the app is backgrounded (banner if online elsewhere, OS push if offline).
  try { if (window.Usion && Usion.notify && document.hidden) Usion.notify.send({ title, body }); } catch (_) {}
}

// Record MY outcome exactly once per multiplayer match (idempotent across paths).
function recordOutcome(iWon) {
  if (statsRecordedThisGame || !online) return;
  statsRecordedThisGame = true;
  myStats.games += 1;
  if (iWon) {
    myStats.wins += 1;
    notifySelf("Та хожлоо! 🎉", "Та Монгол Покерын тоглолтод хожлоо");
  } else {
    myStats.losses += 1;
    notifySelf("Тоглолт дууслаа", "Таны Монгол Покерын тоглолт дууслаа");
  }
  persistStats();
  submitLeaderboard();
  try { if (window.Usion && Usion.cloud && Usion.cloud.shared) Usion.cloud.shared.incr("games_total", 1); } catch (_) {}
}

function maybeNotifyTurn() {
  if (!online || !dealActive) { lastTurnNotified = false; return; }
  const myTurn = turn === mySeat;
  if (myTurn && document.hidden && !lastTurnNotified) {
    lastTurnNotified = true;
    notifySelf("Таны ээлж", "Монгол Покерт таны явах ээлж");
  }
  if (!myTurn) lastTurnNotified = false;
}

// Persist the authoritative round state so a reconnecting/returning client
// rebuilds from it instead of replaying the whole turn-log from zero.
//
// ⚠️ Written by WHOEVER JUST ACTED (the mover / the dealing host) — NOT only the
// room host. A host-only checkpoint goes STALE the moment the host backgrounds:
// while the host is away an opponent's move is never snapshotted (only the host
// used to write it), so on recovery everyone rebuilds from a checkpoint that's
// missing that move and it's silently lost (the move you see on the table
// reverts). The actor always holds current state (it just played), so its
// checkpoint is fresh regardless of who's backgrounded. Callers gate WHO writes.
// The full snapshot needed to rebuild the live round from scratch: deal seed,
// seating order, this round's moves so far, and the round-start scores/starter
// context (so replay re-derives the same lead and adds penalties on the correct
// baseline). Used both for the server checkpoint and for peer state-pushes.
function currentCheckpoint() {
  return {
    seed: curSeed, order: roomPlayerIds, moves: moveLog.slice(),
    totals: roundStartTotals, outs: roundStartOuts,
    firstDeal: roundFirstDeal, lastWinner: roundLastWinner,
    names: nameMap(),
    version: Date.now(),
    seq: lastSeq          // the action sequence this snapshot already includes
  };
}
function writeCheckpoint() {
  try {
    if (window.Usion && Usion.game && Usion.game.setState) {
      const checkpoint = Usion.game.setState(currentCheckpoint());
      if (checkpoint && checkpoint.catch) checkpoint.catch(() => {});
    }
  } catch (_) {}
}

// Peer recovery: when a player (re)joins, a present player PUSHES the current
// state to them over the room broadcast (realtime). A returning player's OWN
// sync round-trip can silently fail after a socket cycle (host recovers, but a
// non-host could sit on stale state forever) — but the room broadcast still
// reaches them once they've rejoined, so this is a reliable second path. Only
// the host pushes, to avoid a push storm in 3–4p; the host is the authority and
// is present whenever a non-host returns.
function broadcastStatePush() {
  if (!online || !dealActive || !isHostPlayer()) return;
  try {
    if (window.Usion && Usion.game && Usion.game.realtime) Usion.game.realtime("state_push", currentCheckpoint());
  } catch (_) {}
}
// Apply a pushed/synced snapshot if it's newer than what we already have.
function applyStateSnapshot(state) {
  if (!state || state.seed === undefined || !Array.isArray(state.order)) return;
  const incomingVersion = Number(state.version || 0);
  if (!dealActive || incomingVersion >= checkpointVersion) {
    applyCheckpoint(state);
  }
}

// Rebuild the current round from a host checkpoint (received as game_state on a
// reconnect/join). Restores round-start state, re-deals the same seed, then
// replays the round's moves so the board matches everyone else's. Returns true
// if a valid checkpoint was applied.
function applyCheckpoint(state) {
  if (!state || typeof state !== "object" || state.seed === undefined || !Array.isArray(state.order)) return false;
  applyNames(state.names);                              // host-supplied names before seating
  if (!gameStarted) startOnlineGame({ order: state.order });
  roomPlayerIds = state.order.slice();
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  // restore round-start scores/elimination (startOnlineGame zeroes them), then
  // replaying the moves re-applies this round's penalties exactly once.
  if (Array.isArray(state.totals)) state.totals.forEach((t, s) => { if (players[s]) players[s].total = t; });
  if (Array.isArray(state.outs)) state.outs.forEach((o, s) => { if (players[s]) players[s].out = o; });
  firstDeal = !!state.firstDeal;
  lastWinner = (typeof state.lastWinner === "number") ? state.lastWinner : -1;
  curSeed = state.seed;
  moveLog = [];
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  startDeal(state.seed);                                 // same seed → same hands & lead
  checkpointVersion = Number(state.version || checkpointVersion || 0);
  appliedSequences = new Set();
  replayingSync = true;
  (state.moves || []).forEach(mv => { moveLog.push(mv); applyRemoteMove(mv); });
  replayingSync = false;
  return true;
}

// Heuristic: did the platform open us in "play with bots"/solo mode? Such a
// launch should go straight to the offline vs-bots setup, NOT the online lobby.
// Checks the launch ref/path the host passes (config + getLaunchParams).
function isBotsLaunch(config) {
  try {
    let lp = {};
    if (window.Usion && typeof Usion.getLaunchParams === "function") lp = Usion.getLaunchParams() || {};
    const hint = [config && config.ref, config && config.launchPath, lp.ref, lp.path]
      .filter(Boolean).join(" ").toLowerCase();
    return /\b(bot|bots|solo|practice|single|ai|offline)\b/.test(hint);
  } catch (_) { return false; }
}

if (window.Usion && Usion.init) {
  try {
    Usion.init(async function (config) {
      myId = config.userId;
      if (config.userName) myName = config.userName;
      if (config.userAvatar) myAvatar = config.userAvatar;
      if (config.playerIds) roomPlayerIds = config.playerIds.slice();   // platform-provided roster (playerIds[0] = host)
      playerMeta[myId] = { name: myName, avatar: myAvatar };
      presentIds.add(myId);
      loadStats(); // fire-and-forget; never block init/render
      // "Play with bots" launches solo — skip the room/waiting-room entirely and
      // fall through to the offline setup (you vs bots). Only a real "play with
      // friends" room (roomId, not a bots/solo launch) goes online to the lobby.
      if (config.roomId && !isBotsLaunch(config)) {
        online = true;
        setupOverlay.classList.remove("show");
        onlineOverlay.classList.add("show");
        await setupMultiplayer(config.roomId);
      } else if (isBotsLaunch(config)) {
        startBotsGame();   // "play with bots" → straight into you + 3 bots
      }
    });
  } catch (e) { /* standalone preview */ }
}

// ── Foreground catch-up ──────────────────────────────────────────────────
// While the app/iframe is backgrounded the WebView is suspended: our turn clock
// freezes and any move the host relays in that window is dropped (postMessage to
// a frozen WebView). Nothing in the platform reliably tells us we missed it —
// so on return we'd sit on stale state (you see the opponent's old card; they
// see your turn) until a full exit+rejoin.
//
// Recovery rule: ask the server to replay everything AFTER OUR OWN last-applied
// sequence (lastSeq) — NOT from 0 (which would re-walk old rounds) and NOT from
// the host's checkpoint alone (it only holds the HOST's view; a non-host move
// made while the host was away isn't in it — the missing move lives in the
// action log). requestSync(lastSeq) returns the host checkpoint PLUS the action
// log past our point, so we replay exactly what we missed. Idempotent.
function foregroundResync() {
  if (!online || !gameStarted) return;
  netPaused = false;
  try {
    if (window.Usion && Usion.game) {
      if (Usion.game.requestSync) Usion.game.requestSync(lastSeq);
      if (Usion.game.realtime) Usion.game.realtime("request_state", {});
    }
  } catch (_) {}
  if (dealActive) { startTurnTimer(); render(); }
}

// On resume the host socket can take several seconds to reconnect + rejoin the
// room; a few fixed retries can ALL fire during that gap and get no response
// (observed: 5× requestSync, 0× sync back). So keep requesting until our own
// sequence actually advances (a response landed) or we hit a long timeout.
var _resyncBaseSeq = -1;
var _resyncDeadline = 0;
function beginResync(reason) {
  _resyncBaseSeq = lastSeq;
  // Keep trying for ~60s: with the host zombie-socket fix this resolves almost
  // immediately; WITHOUT it, a dead socket only self-heals via Socket.IO's own
  // ping-timeout (~45s), so we must outlast that to recover at all.
  _resyncDeadline = Date.now() + 60000;
  pumpResync();
}
function pumpResync() {
  if (!online || !gameStarted) return;
  if (lastSeq > _resyncBaseSeq) return;   // caught up
  if (Date.now() > _resyncDeadline) return;
  foregroundResync();
  setTimeout(pumpResync, 1200);
}

// Web fires visibilitychange on tab refocus — use it there.
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") beginResync("visible");
  });
}

// Mobile: React Native WebViews do NOT fire visibilitychange on app
// background/foreground, so the line above never runs in the Usion app. Detect
// the resume from the wall clock instead: a 1s heartbeat that sees a big jump
// means our JS was frozen (we were backgrounded). The host socket may still be
// reconnecting/rejoining the room on return, so retry the sync a few times over
// the next few seconds until our state catches up.
(function resumeWatchdog() {
  var lastBeat = Date.now();
  setInterval(function () {
    var now = Date.now();
    var gap = now - lastBeat;
    lastBeat = now;
    if (gap > 3000 && online && gameStarted) {
      beginResync("gap=" + Math.round(gap / 1000) + "s");
    }
  }, 1000);
})();

async function setupMultiplayer(roomId) {
  try {
    await Usion.game.connect();
    Usion.game.onJoined(onJoined);
    Usion.game.onPlayerJoined(onPlayerJoined);
    Usion.game.onPlayerLeft(onPlayerLeft);
    Usion.game.onAction(onNetAction);
    Usion.game.onRealtime(onNetRealtime);
    Usion.game.onSync(onNetSync);
    // Real pause on a dropped link: freeze the turn clock (so we can't be
    // auto-passed while offline) and tell the player. onTurnTimeout/startTurnTimer
    // both honor netPaused, so the clock sits frozen until we're back.
    if (Usion.game.onDisconnect) Usion.game.onDisconnect(() => {
      netPaused = true;
      stopTurnTimer();
      if (dealActive) toast("Холболт тасарлаа — түр зогссон…");
    });
    if (Usion.game.onReconnect) Usion.game.onReconnect(() => {
      netPaused = false;
      beginResync("reconnect");   // persistent retry — the round-trip can be flaky right after reconnect
      if (dealActive) startTurnTimer();   // resume the active seat's clock from full
    });
    await Usion.game.join(roomId);
  } catch (err) {
    console.error("Multiplayer failed:", err);
    online = false; onlineOverlay.classList.remove("show"); setupOverlay.classList.add("show");
  }
}
function sendPlayerInfo() { Usion.game.realtime("player_info", { name: myName, avatar: myAvatar || null, ready: myReady }); }
// number of seats this online match has, from the authorized roster (2–4)
function targetSeats() { return Math.max(2, Math.min(4, roomPlayerIds.length || 2)); }

function onJoined(data) {
  roomPlayerIds = data.player_ids || [];
  connectedCount = Number(data.connected_count || 0);
  if (data.sequence !== undefined) lastSeq = data.sequence;
  isHost = roomPlayerIds[0] === myId;
  sendPlayerInfo(); updateOnlineStatus();
  // The join ack may carry the host's checkpoint as game_state — rebuild the
  // live round straight away so a rejoin resumes instead of stalling on
  // "Dealing…". Guarded by !dealActive (don't disturb an in-progress round);
  // applying it marks the game started so maybeStart won't re-deal.
  if (!dealActive && data.game_state && data.game_state.seed !== undefined) applyCheckpoint(data.game_state);
  Usion.game.requestSync(0);   // SDK replays the stored deal + moves via onSync
  maybeStart();
}
function onPlayerJoined(data) {
  if (data.player_ids) roomPlayerIds = data.player_ids;
  else if (data.player && data.player.id && !roomPlayerIds.includes(data.player.id)) roomPlayerIds.push(data.player.id);
  if (data.player && data.player.id) presentIds.add(data.player.id);
  if (typeof data.connected_count === "number") connectedCount = data.connected_count;
  else if (data.player && data.player.is_connected) connectedCount = Math.min(roomPlayerIds.length, connectedCount + 1);
  isHost = roomPlayerIds[0] === myId;
  if (connectedCount > 1 && forfeitTimer) { clearForfeitGrace(); render(); } // a player returned → cancel pending forfeit
  sendPlayerInfo(); updateOnlineStatus(); maybeStart();
  // Someone (re)joined — push them the current state so they catch up even if
  // their own sync is failing. Slight delay so they've finished rejoining the
  // room (and registered their realtime handlers) before the broadcast lands.
  if (gameStarted && dealActive) setTimeout(broadcastStatePush, 600);
}
// ── Forfeit grace period ──────────────────────────────────
// When a leave WOULD end the match (one active seat left), defer the forfeit
// for a grace window so a quick rejoin resumes the hand untouched. Non-decisive
// leaves (3–4p with others still in) fold the leaver and play continues as before.
let forfeitTimer = null;
let pendingLeaveSeat = -1;
const FORFEIT_GRACE_MS = 20000;

function clearForfeitGrace() {
  if (forfeitTimer) { clearInterval(forfeitTimer); forfeitTimer = null; }
  pendingLeaveSeat = -1;
}

function applyLeaveFold(seat) {
  if (seat < 0 || !players[seat] || players[seat].out) return;
  players[seat].out = true;
  lastAction[seat] = { kind: "pass", text: "Гарсан" };
  if (dealActive && turn === seat) {
    if (table) doPass(seat);                              // was following → pass & advance
    else { turn = nextActiveAfter(seat); beginTurn(); }   // was leading → hand the lead to the next active seat
  }
}

function applyLeaveOutcome(seat, endMatch) {
  applyLeaveFold(seat);
  if (endMatch || activeSeats().length <= 1) {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    dealActive = false;
    showGameOver();
  } else {
    render();
  }
}

function sendHostLeaveOutcome(seat, endMatch) {
  if (!isHostPlayer() || seat < 0) return;
  Usion.game.action("move", { kind: endMatch ? "forfeit_win" : "leave_fold", seat })
    .catch(() => {
      toast("Гаралтын төлөв илгээж чадсангүй");
      Usion.game.requestSync(0);
    });
}

function startForfeitGrace() {
  if (forfeitTimer) clearInterval(forfeitTimer);
  let secs = Math.ceil(FORFEIT_GRACE_MS / 1000);
  if (turnLine) { turnLine.textContent = "Тоглогч гарлаа — дахин нэгдэхийг хүлээж байна… (" + secs + "с)"; turnLine.className = "turn-line"; }
  forfeitTimer = setInterval(() => {
    if (!gameStarted || connectedCount > 1) {   // someone returned → resume
      clearForfeitGrace();
      render();
      return;
    }
    secs -= 1;
    if (secs > 0) { if (turnLine) turnLine.textContent = "Тоглогч гарлаа — дахин нэгдэхийг хүлээж байна… (" + secs + "с)"; return; }
    const seat = pendingLeaveSeat;
    clearForfeitGrace();
    sendHostLeaveOutcome(seat, true);             // grace expired → host stores the forfeit result
  }, 1000);
}

function onPlayerLeft(data) {
  connectedCount = Math.max(0, connectedCount - 1);
  if (!gameStarted) {
    if (data && data.player_ids) roomPlayerIds = data.player_ids;   // roster only changes pre-game; seats are fixed once started
    if (data && data.player_id != null) { presentIds.delete(data.player_id); delete lobbyReady[data.player_id]; }
    isHost = roomPlayerIds[0] === myId;
    renderLobby();
    return;
  }
  // mid-game: the player who left forfeits (their seat stays fixed)
  const seat = (data && data.player_id != null) ? roomPlayerIds.indexOf(data.player_id) : -1;
  if (seat < 0 || !players[seat] || players[seat].out) { render(); return; }
  if (!isHostPlayer()) {
    notifySelf("Өрсөлдөгч гарлаа", "Таны Монгол Покерын тоглолтоос тоглогч гарлаа");
    Usion.game.requestSync(0);
    render();
    return;
  }

  // Decisive case (would leave ≤1 active) → grace window before ending; don't
  // mutate yet, so a rejoin resumes the hand exactly where it was.
  const activeAfter = activeSeats().filter(s => s !== seat).length;
  if (activeAfter <= 1) {
    notifySelf("Өрсөлдөгч гарлаа", "Таны Монгол Покерын тоглолтоос тоглогч гарлаа");
    pendingLeaveSeat = seat;
    startForfeitGrace();
    return;
  }

  // Non-decisive: fold the leaver and continue with the remaining players.
  notifySelf("Өрсөлдөгч гарлаа", "Таны Монгол Покерын тоглолтоос тоглогч гарлаа");
  sendHostLeaveOutcome(seat, false);
}
function updateOnlineStatus() {
  const s = document.getElementById("onlineStatus");
  if (!s) return;
  const n = targetSeats();
  s.textContent = connectedCount < n
    ? ("Тоглогчдыг хүлээж байна… (" + Math.min(connectedCount, n) + "/" + n + ")")
    : (n + " тоглогч бэлэн — эхэлж байна…");
}
// Players gather in a waiting room, each toggles READY, and the host starts the
// match once everyone present is ready (2–4 seats). The host's "deal" action
// carries the final seat order, so every client begins with the same players.
function maybeStart() {
  if (gameStarted || dealActive) return;
  enterLobby();
}
function enterLobby() {
  if (gameStarted || dealActive) return;
  presentIds.add(myId);
  lobbyReady[myId] = myReady;
  onlineOverlay.classList.add("show");
  renderLobby();
}
// present players in roster order (then any extras), so seats are stable for all
function lobbyOrder() {
  const ids = roomPlayerIds.filter(id => presentIds.has(id));
  presentIds.forEach(id => { if (!ids.includes(id)) ids.push(id); });
  return ids;
}
function renderLobby() {
  const list = document.getElementById("lobbyList");
  if (!list || gameStarted || dealActive) return;
  const ids = lobbyOrder();
  const hostId = roomPlayerIds[0];
  const spinner = document.getElementById("lobbySpinner");
  if (spinner) spinner.style.display = ids.length ? "none" : "block";
  list.innerHTML = "";
  ids.forEach((id, i) => {
    const nm = (playerMeta[id] && playerMeta[id].name) || (id === myId ? myName : "Тоглогч " + (i + 1));
    const ready = !!lobbyReady[id];
    const row = document.createElement("div");
    row.className = "lobby-row" + (id === myId ? " me" : "");
    row.innerHTML =
      '<span class="lobby-seat">' + (i + 1) + "</span>" +
      '<span class="lobby-name">' + escapeHtml(nm) + (id === hostId ? ' <span class="lobby-tag">ХОСТ</span>' : "") + "</span>" +
      '<span class="lobby-badge ' + (ready ? "ready" : "wait") + '">' + (ready ? "БЭЛЭН" : "БЭЛЭН БИШ") + "</span>";
    list.appendChild(row);
  });
  const present = ids.length;
  const readyCount = ids.filter(id => lobbyReady[id]).length;
  const allReady = present >= 2 && readyCount === present;
  const statusEl = document.getElementById("onlineStatus");
  if (statusEl) statusEl.textContent = present < 2 ? "Тоглогчид нэгдэхийг хүлээж байна…" : (readyCount + "/" + present + " бэлэн");
  const readyBtn = document.getElementById("readyBtn");
  if (readyBtn) {
    readyBtn.style.display = "block";
    readyBtn.textContent = myReady ? "✓ БЭЛЭН" : "БЭЛЭН";
    readyBtn.classList.toggle("btn-ready-on", myReady);
  }
  const startBtn = document.getElementById("startGameBtn");
  if (startBtn) {
    startBtn.style.display = isHost ? "block" : "none";
    startBtn.disabled = !allReady || pendingAction;
  }
  const hint = document.getElementById("lobbyHint");
  if (hint) {
    hint.textContent = isHost
      ? (allReady ? "Бүгд бэлэн — Эхлүүлэх дар!" : "Бүх тоглогч бэлэн болмогц Эхлүүлэх нээгдэнэ.")
      : (myReady ? "Хост эхлүүлэхийг хүлээж байна…" : "Бэлэн болсон бол БЭЛЭН гэж дар.");
  }
}
// Host only: lock the seats to the present + ready players and deal.
function hostStartGame() {
  if (gameStarted || !isHost) return;
  const order = lobbyOrder().filter(id => lobbyReady[id]);
  if (order.length < 2) return;
  roomPlayerIds = order;
  numPlayers = order.length;
  isHost = roomPlayerIds[0] === myId;
  if (!isHost) return;
  firstDeal = true; lastWinner = -1;   // fresh match → lowest-card holder leads
  hostDeal();   // broadcasts the deal (with this order) → every client begins
}
// Start a solo offline game vs 3 bots (you + Bot Anh/Bat/Cag = 4 seats).
function startBotsGame() {
  online = false; gameStarted = false; dealActive = false;
  myReady = false; presentIds.clear(); lobbyReady = {};
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  setupOverlay.classList.remove("show");
  const nm = (myName || "Та").slice(0, 10);
  numPlayers = 4;                       // "play with bots" is always you + 3 bots
  players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ name: i === 0 ? nm : BOT_NAMES[i], color: PLAYER_COLORS[i], isBot: i !== 0, total: 0, out: false });
  }
  mySeat = 0;
  firstDeal = true; lastWinner = -1;
  meNameEl.textContent = nm;
  startDeal(randomSeed());
}
// Bail out of the online room and play solo vs 3 bots — no ready needed.
function leaveForBots() {
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  startBotsGame();
}
(function wireLobby() {
  const readyBtn = document.getElementById("readyBtn");
  const startBtn = document.getElementById("startGameBtn");
  const botsBtn = document.getElementById("lobbyBotsBtn");
  if (readyBtn) readyBtn.addEventListener("click", () => {
    myReady = !myReady;
    lobbyReady[myId] = myReady;
    if (online && window.Usion && Usion.game) sendPlayerInfo();
    renderLobby();
  });
  if (startBtn) startBtn.addEventListener("click", hostStartGame);
  if (botsBtn) botsBtn.addEventListener("click", leaveForBots);
})();
function startOnlineGame(data) {
  if (gameStarted) return;
  clearForfeitGrace();
  gameStarted = true; online = true;
  statsRecordedThisGame = false;   // new match → allow recording its outcome once
  lastTurnNotified = false;
  roomPlayerIds = data.order;
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  isHost = roomPlayerIds[0] === myId;
  firstDeal = true; lastWinner = -1;
  players = roomPlayerIds.map((id, i) => ({
    name: (playerMeta[id] && playerMeta[id].name) || (id === myId ? myName : "Тоглогч " + (i + 1)),
    color: PLAYER_COLORS[i], isBot: false, total: 0, out: false
  }));
  meNameEl.textContent = players[mySeat].name;
  setupOverlay.classList.remove("show");
  const os = document.getElementById("onlineStatus");
  if (os) os.textContent = "Хөзөр тарааж байна…";
  onlineOverlay.classList.add("show");   // keep covering the table until the first deal lands
  render();
  Usion.game.requestSync(0);   // catch any actions (e.g. the deal) we missed
  // non-host safety net: if the host's deal never reaches us, keep asking
  if (!isHost) {
    if (dealWaitTimer) clearInterval(dealWaitTimer);
    dealWaitTimer = setInterval(function () {
      if (dealActive) { clearInterval(dealWaitTimer); dealWaitTimer = null; return; }
      Usion.game.requestSync(0);
    }, 2000);
  }
}
// names the host knows for the current roster — carried in stored deal/checkpoint
// so every client (and reconnects) gets real names, not "Player N", even if they
// missed the ephemeral player_info broadcast.
function nameMap() {
  const m = {};
  roomPlayerIds.forEach(id => { const nm = playerMeta[id] && playerMeta[id].name; if (nm) m[id] = nm; });
  return m;
}
function applyNames(map) {
  if (!map) return;
  for (const id in map) playerMeta[id] = Object.assign(playerMeta[id] || {}, { name: map[id] });
}
function hostDeal() {
  if (!isHost || pendingAction) return;
  curSeed = randomSeed();
  // carry the starter context so every client picks the SAME leader: firstDeal →
  // lowest-card holder leads; otherwise the previous round's winner leads. Without
  // this, a client with stale firstDeal/lastWinner computes a different starter.
  const d = { seed: curSeed, order: roomPlayerIds, names: nameMap(), firstDeal: firstDeal, lastWinner: lastWinner };
  pendingAction = true;
  renderLobby();
  Usion.game.action("deal", d)
    .then(res => {
      if (res && res.success === false) {
        pendingAction = false;
        toast("Тараалт илгээж чадсангүй");
        renderLobby();
      }
    })
    .catch(() => {
      pendingAction = false;
      toast("Тараалт илгээж чадсангүй");
      renderLobby();
    });
}
function sendMove(move) {
  if (pendingAction) return;
  pendingAction = true;
  renderControls();
  Usion.game.action("move", move)
    .then(res => {
      if (res && res.success === false) {
        pendingAction = false;
        toast("Нүүдэл илгээж чадсангүй");
        render();
      }
    })
    .catch(() => {
      pendingAction = false;
      toast("Нүүдэл илгээж чадсангүй");
      render();
    });
}
// Apply a move from `fromId` (the actual sender). Anchoring to the sender's seat
// — not the local `turn` — makes the turn pointer self-correcting: if a client
// ever missed/duplicated/reordered a move, it snaps back instead of drifting and
// deadlocking the whole table.
function applyRemoteMove(move, fromId) {
  if (!dealActive) return;
  if (move.kind === "leave_fold" || move.kind === "forfeit_win") {
    applyLeaveOutcome(Number(move.seat), move.kind === "forfeit_win");
    if (!replayingSync && fromId === myId) writeCheckpoint();   // the sender (host) persists the outcome
    return;
  }
  let seat = (fromId != null) ? roomPlayerIds.indexOf(fromId) : -1;
  if (seat < 0) seat = turn;                 // no sender info (e.g. checkpoint replay) → in-order
  if (seat !== turn) turn = seat;            // snap to the real actor before applying
  if (move.kind === "pass") doPass(seat);
  else { const combo = classify(move.cards.map(wireCard)); if (combo) doPlay(seat, combo); }
  // The ACTOR (the player who just moved) persists the fresh state — not the
  // host — so a move made while the host is backgrounded is never lost.
  if (!replayingSync && fromId === myId) writeCheckpoint();
}
function onNetAction(data) {
  if (data.sequence !== undefined) lastSeq = Math.max(lastSeq, data.sequence);
  // Clear our "sending…" state the moment we SEE our own action echoed — BEFORE
  // the dedup return. If a resync already applied this seq, the echo is a dup and
  // we'd skip out below; without clearing here first, pendingAction sticks true
  // forever and we can never move again ("Sending…" with the Play button dead).
  if (data.player_id === myId) pendingAction = false;
  if (data.sequence !== undefined) {
    if (appliedSequences.has(data.sequence)) { renderControls(); return; }
    appliedSequences.add(data.sequence);
  }
  const d = data.action_data || {};
  if (data.action_type === "deal") onDeal(d);
  else if (data.action_type === "move") { moveLog.push(d); applyRemoteMove(d, data.player_id); }
}
function onNetRealtime(data) {
  if (data.player_id === myId) return;
  const d = data.action_data || {};
  if (data.action_type === "player_info") {
    playerMeta[data.player_id] = { name: d.name, avatar: d.avatar };
    presentIds.add(data.player_id);
    if (typeof d.ready === "boolean") lobbyReady[data.player_id] = d.ready;
    if (gameStarted) { refreshNames(); render(); } else renderLobby();
  } else if (data.action_type === "state_push") {
    // The host pushed authoritative state to us (we just rejoined). Apply it —
    // this is the reliable recovery path when our own sync round-trip is dead.
    applyStateSnapshot(d);
  }
}
// Catch-up replay (from requestSync). Each "deal" resets state, so replaying
// the whole log from sequence 0 deterministically rebuilds the current round.
function onNetSync(data) {
  const syncTop = data.sequence !== undefined ? data.sequence : 0;
  // Already current? Don't rebuild. The resync watchdog fires requestSync a few
  // times and several replies can land after we've already caught up — each
  // re-applies the checkpoint (re-deal + replay), which wipes the live UI mid-
  // hand (your card selection, "your turn" state). If the server has nothing
  // past what we've applied, treat it as a no-op.
  if (syncTop <= lastSeq) return;
  if (data.sequence !== undefined) lastSeq = Math.max(lastSeq, data.sequence);
  const actions = data.actions || [];

  // Checkpoint path: once the host has setState()'d, the SDK compacts the log —
  // sync carries game_state + only the tail of actions (the original "deal" is
  // gone). Rebuild from the checkpoint, then replay anything newer than it.
  // Apply newer/equal checkpoints even mid-hand: reconnect sync may compact the
  // stored log into game_state + tail actions, and stale local state must be rebuilt.
  const checkpoint = data.game_state;
  const incomingVersion = checkpoint && Number(checkpoint.version || 0);
  if (checkpoint && checkpoint.seed !== undefined && (!dealActive || incomingVersion >= checkpointVersion) && applyCheckpoint(checkpoint)) {
    // The checkpoint already includes every action up to checkpoint.seq. The
    // server's get_game_actions(last_sequence) is INCLUSIVE, so the tail re-sends
    // the checkpoint's own last move(s) — applying those again double-pushes the
    // play onto the trick (duplicate cards on the table). Skip anything the
    // checkpoint already baked in.
    const cpSeq = Number(checkpoint.seq || 0);
    replayingSync = true;
    try {
      actions.forEach(a => {
        if (a.sequence !== undefined && a.sequence <= cpSeq) return;   // already in the checkpoint
        if (a.sequence !== undefined) {
          if (appliedSequences.has(a.sequence)) return;
          appliedSequences.add(a.sequence);
        }
        const d = a.action_data || {};
        if (a.action_type === "deal") {
          if (d.seed !== curSeed) onDeal(d);   // a round newer than the checkpoint
        } else if (a.action_type === "move") {
          moveLog.push(d); applyRemoteMove(d, a.player_id);   // SDK sends tail actions after game_state
        }
      });
    } finally {
      replayingSync = false;
    }
    return;
  }
  // No checkpoint: deterministic full replay from sequence 0.
  replayingSync = true;
  try {
    actions.forEach(a => {
      if (a.sequence !== undefined) {
        if (appliedSequences.has(a.sequence)) return;
        appliedSequences.add(a.sequence);
      }
      const d = a.action_data || {};
      if (a.action_type === "deal") onDeal(d);
      else if (a.action_type === "move") { moveLog.push(d); applyRemoteMove(d, a.player_id); }
    });
  } finally {
    replayingSync = false;
  }
}
function onDeal(d) {
  // Not seated in this match (e.g. wasn't ready when the host started) → stay in
  // the room instead of crashing on a -1 seat.
  if (!gameStarted && Array.isArray(d.order) && d.order.indexOf(myId) < 0) {
    onlineOverlay.classList.add("show");
    const s = document.getElementById("onlineStatus");
    if (s) s.textContent = "Хост таныг оруулалгүй эхлүүллээ.";
    return;
  }
  applyNames(d.names);                 // adopt host-supplied names before seating
  if (!gameStarted) startOnlineGame({ order: d.order });
  else refreshNames();                 // later rounds: update any "Player N" already shown
  // authoritative starter context from the host → identical leader on every client
  if (typeof d.firstDeal === "boolean") firstDeal = d.firstDeal;
  if (typeof d.lastWinner === "number") lastWinner = d.lastWinner;
  curSeed = d.seed; moveLog = [];
  handOverlay.classList.remove("show");
  numPlayers = d.order.length;
  startDeal(d.seed);
  if (!replayingSync && isHostPlayer()) writeCheckpoint();   // only the host deals → host snapshots the fresh deal
}
function refreshNames() {
  roomPlayerIds.forEach((id, i) => { if (players[i] && playerMeta[id] && playerMeta[id].name) players[i].name = playerMeta[id].name; });
  if (players[mySeat]) meNameEl.textContent = players[mySeat].name;
}
