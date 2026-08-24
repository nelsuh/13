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
// and a turn-log of moves (deterministic engine on every client). A solo launch
// can be promoted into a live room mid-session (Usion.game.onRoomAssigned).
// UI is bilingual (mn/en) via the STR table + Usion.getLanguage().

// ── Card model ───────────────────────────────────────────
// rank: 3..15 where 11=J 12=Q 13=K 14=A 15=2 ; suit id: 0♠ 1♣ 2♦ 3♥
const SUITS = ["♠", "♣", "♦", "♥"];
const SUIT_RED = [false, false, true, true];
// Suit strength high→low: ♠ > ♥ > ♣ > ♦. Indexed by suit id.
const SUIT_RANK = [3, 1, 0, 2];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" };
const PLAYER_COLORS = ["#2ed573", "#ff4757", "#1e90ff", "#ffa502"];
const HAND_OVER_SECONDS = 5;
const TURN_SECONDS = 90;   // each player gets 2:00 to act; on expiry they auto-pass (auto-lead if leading)

// ── Open table ───────────────────────────────────────────
// An online room is an OPEN SERVER: it always seats 4, humans first and bots
// filling whatever is left, and it never waits in a lobby. The first player in
// deals immediately against 3 bots; everyone who arrives afterwards drops
// straight into the round by taking over a bot seat — inheriting that seat's
// accumulated penalty points. A player who leaves hands their seat (and score)
// back to a bot, so the table stays full and the room keeps running.
const OPEN_SEATS = 4;           // an open table is always 4 seats wide
const OPEN_START_MS = 600;      // let presence settle before the first deal
const BOT_MOVE_MS = 900;        // how long an online bot "thinks" before its move goes out
const OPEN_RESTART_MS = 8000;   // the champion screen auto-restarts an open table
const OPEN_LOSE_AT = 20;        // open tables run the 4-player road to 20 points
const SEAT_RETRY_MS = 3000;     // don't re-send a seat claim faster than this
const SEAT_STAGGER_MS = 2500;   // per authority rank, so a sleeping seat 0 can't lock newcomers out
const OPEN_REVIVE_MS = 20000;   // a room that owes us a seat and has gone silent is dead — reopen it

// ── i18n ─────────────────────────────────────────────────
// Mongolian is the default; every other host language falls back to English.
// The language comes from the platform (Usion.getLanguage(), i.e. the user's
// app-wide setting) — never hardcode UI strings to one locale.
const STR = {
  mn: {
    you: "Та",
    botNames: ["Та", "Бот Бат", "Бот Болд", "Бот Сүх"],
    pair: r => r + " хос",
    triple: r => r + " гурав",
    four: r => r + " дөрөв",
    sflush: r => r + " дараалал флэш",
    fourplus: r => "дөрөв+1 (" + r + ")",
    fullhouse: r => "фулл хаус (" + r + ")",
    flush: s => "флэш " + s,
    straight: r => r + " дараалал",
    max5: "Дээд тал нь 5 хөзөр",
    invalidPlay: "Хүчингүй тавилт",
    sending: "Илгээж байна…",
    yourTurn: "Таны ээлж",
    turnOf: n => n + "-ийн ээлж…",
    pass: "Өнжих",
    play: "Тавих",
    finished: "ДУУСГАВ! 🎉",
    leftGame: "Гарсан",
    dragon: n => n + " — ЛУУ! 🐉",
    youWonRound: "Та тойргийг хожлоо!",
    wonRound: n => n + " тойргийг хожлоо!",
    eliminatedTag: "ХОЖИГДСОН",
    wonTag: "🏆 хожлоо",
    cardsLeft: n => n + " үлдсэн",
    nextRoundIn: num => "Дараагийн тойрог " + num + " секундын дараа",
    nextRound: "Дараагийн тойрог",
    newGame: "Шинэ тоглоом",
    winnerLabel: "ЯЛАГЧ",
    survived: "үлдсэн",
    lostTag: "хожигдсон",
    playAgain: "ДАХИН ТОГЛОХ",
    lobbyTitle: "Нээлттэй ширээ",
    connecting: "Холбогдож байна…",
    hostTag: "ХОСТ",
    playerN: i => "Тоглогч " + i,
    openBotNames: ["Бот Бат", "Бот Болд", "Бот Сүх", "Бот Дорж"],
    openWaitSeat: "Суудал чөлөөлөгдөхийг хүлээж байна…",
    openJoining: "Ширээнд орж байна…",
    openTableTag: "НЭЭЛТТЭЙ ШИРЭЭ",
    openStatus: "Нээлттэй ширээ — хэн ч дундаас нь нэгдэж болно",
    openJoined: n => n + " ширээнд оролоо",
    openLeftBot: n => n + " гарлаа — бот суудлыг нь авлаа",
    openRestarting: "Шинэ ширээ бэлдэж байна…",
    botTag: "БОТ",
    dealing: "Хөзөр тарааж байна…",
    startGame: "ТОГЛООМ ЭХЛҮҮЛЭХ",
    playBots: "БОТТОЙ ТОГЛОХ",
    disconnectedPaused: "Холболт тасарлаа — түр зогссон…",
    dealFail: "Тараалт илгээж чадсангүй",
    moveFail: "Нүүдэл илгээж чадсангүй",
    leaveFail: "Гаралтын төлөв илгээж чадсангүй",
    leftGrace: s => "Тоглогч гарлаа — дахин нэгдэхийг хүлээж байна… (" + s + "с)",
    rematchWait: "Хост дахин тоглолт эхлүүлэхийг хүлээж байна…",
    rematchWants: n => n + " дахин тоглохыг хүсэж байна",
    title: "МОНГОЛ ПОКЕР",
    docTitle: "Монгол Покер",
    setupSub: "2–4 тоглогч, тус бүр 13 хөзөр — хөзрөө хамгийн түрүүнд дуусга. Ганц, хос, гурав, дөрөв, эсвэл 5 хөзрийн хослол (дараалал, флэш, фулл хаус, дөрөв+1, дараалал флэш) тавь. Ширээн дээрхийг ижил тооны илүү том хослолоор дар, эсвэл Өнжих. ♠>♥>♣>♦.",
    playersLabel: "ТОГЛОГЧ",
    loseLabel: "ХОЖИГДОХ ОНОО",
    nameLabel: "ТАНЫ НЭР",
    setupFoot: "Офлайн та ботуудтай. Онлайн бол нээлттэй ширээ — хүн ирэхэд ботын суудлыг авна.",
    skinToggle: "Ширээний өнгө солих",
    chatAria: "Түргэн харилцах",
    customChat: "Өөрийн мессеж",
    customChatPlaceholder: "Мессеж бичих…",
    backToQuickChat: "Түргэн чат руу буцах",
    send: "Илгээх",
    qcHurry: "Хурдлаач",
    qcBad: "Муу юм бэ",
    qcGotit: "Чи болчихжээ",
    qcNice: "Юм авцаан",
    qcWow: "Аймар аймар",
  },
  en: {
    you: "You",
    botNames: ["You", "Bot Bat", "Bot Bold", "Bot Sukh"],
    pair: r => r + " pair",
    triple: r => r + " triple",
    four: r => r + " four",
    sflush: r => r + "-high straight flush",
    fourplus: r => "four+1 (" + r + ")",
    fullhouse: r => "full house (" + r + ")",
    flush: s => "flush " + s,
    straight: r => r + "-high straight",
    max5: "Max 5 cards",
    invalidPlay: "Invalid play",
    sending: "Sending…",
    yourTurn: "Your turn",
    turnOf: n => n + "'s turn…",
    pass: "Pass",
    play: "Play",
    finished: "FINISHED! 🎉",
    leftGame: "Left",
    dragon: n => n + " — DRAGON! 🐉",
    youWonRound: "You won the round!",
    wonRound: n => n + " won the round!",
    eliminatedTag: "ELIMINATED",
    wonTag: "🏆 won",
    cardsLeft: n => n + " left",
    nextRoundIn: num => "Next round in " + num + " seconds",
    nextRound: "Next round",
    newGame: "New game",
    winnerLabel: "WINNER",
    survived: "survived",
    lostTag: "eliminated",
    playAgain: "PLAY AGAIN",
    lobbyTitle: "Open table",
    connecting: "Connecting…",
    hostTag: "HOST",
    playerN: i => "Player " + i,
    openBotNames: ["Bot Bat", "Bot Bold", "Bot Sukh", "Bot Dorj"],
    openWaitSeat: "Waiting for a seat to open…",
    openJoining: "Taking a seat…",
    openTableTag: "OPEN TABLE",
    openStatus: "Open table — anyone can drop in",
    openJoined: n => n + " joined the table",
    openLeftBot: n => n + " left — a bot took the seat",
    openRestarting: "Starting a fresh table…",
    botTag: "BOT",
    dealing: "Dealing…",
    startGame: "START GAME",
    playBots: "PLAY VS BOTS",
    disconnectedPaused: "Connection lost — paused…",
    dealFail: "Couldn't send the deal",
    moveFail: "Couldn't send the move",
    leaveFail: "Couldn't send the leave outcome",
    leftGrace: s => "A player left — waiting for them to rejoin… (" + s + "s)",
    rematchWait: "Waiting for the host to start a rematch…",
    rematchWants: n => n + " wants a rematch",
    title: "MONGOL POKER",
    docTitle: "Mongol Poker",
    setupSub: "2–4 players, 13 cards each — be the first to empty your hand. Play a single, pair, triple, four, or a 5-card hand (straight, flush, full house, four+1, straight flush). Beat the table with a bigger combo of the same size, or Pass. ♠>♥>♣>♦.",
    playersLabel: "PLAYERS",
    loseLabel: "LOSE AT",
    nameLabel: "YOUR NAME",
    setupFoot: "Offline you play bots. Online it is an open table — arrivals take over a bot's seat.",
    skinToggle: "Change table colour",
    chatAria: "Quick chat",
    customChat: "Custom message",
    customChatPlaceholder: "Type a message…",
    backToQuickChat: "Back to quick chat",
    send: "Send",
    qcHurry: "Hurry up!",
    qcBad: "So bad!",
    qcGotit: "You got it!",
    qcNice: "Nice one!",
    qcWow: "Wow wow!",
  },
};
let LANG = "mn";
function t(key) {
  let v = STR[LANG] ? STR[LANG][key] : undefined;
  if (v === undefined) v = STR.mn[key];
  if (typeof v === "function") return v.apply(null, Array.prototype.slice.call(arguments, 1));
  return v !== undefined ? v : key;
}
function detectLang() {
  // This game ships Mongolian, so it always opens in Mongolian regardless of the
  // platform/browser language. The English (STR.en) table stays only as an
  // internal fallback for any key missing from STR.mn.
  return "mn";
}

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
  if (n === 2) return allSame ? mk("pair", sorted, [cardStrength(top)], t("pair", rankLabel(top.r))) : null;
  if (n === 3) return allSame ? mk("triple", sorted, [ranks[0]], t("triple", rankLabel(ranks[0]))) : null;
  if (n === 4) return allSame ? mk("four", sorted, [ranks[0]], t("four", rankLabel(ranks[0]))) : null;
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
  if (isStraight && isFlush) return mk("sflush", runOrder, [4, ...straightKey], t("sflush", rankLabel(topS.r)));
  if (sizes === "41") return mk("fourplus", sorted, [3, groups[0][1]], t("fourplus", rankLabel(groups[0][1])));
  if (sizes === "32") return mk("fullhouse", sorted, [2, groups[0][1]], t("fullhouse", rankLabel(groups[0][1])));
  if (isFlush) return mk("flush", sorted, [1, ...sorted.map(cardStrength).sort((a, b) => b - a)], t("flush", SUITS[sorted[0].s]));
  if (isStraight) return mk("straight", runOrder, [0, ...straightKey], t("straight", rankLabel(topS.r)));
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
let turnDeadline = 0;       // wall-clock ms when the active seat's clock expires (survives a background freeze)
let pausedAt = 0;           // wall-clock ms when netPaused began, so the deadline can be pushed back on resume
let proxyTimer = null;      // fallback: act FOR a frozen/away player once their clock has long expired
// Did we WATCH this turn begin on a live move? A client that rebuilt the round
// from a checkpoint, or that was disconnected through it, restarts the clock from
// full and therefore has no idea how long the active player has really had — it
// must not be the one to auto-pass them. Peers that stayed live still can.
let turnTrusted = false;
let netPaused = false;      // true while our connection is dropped — freezes the turn clock so a disconnect can't auto-pass us
let dealActive = false;
let lastWinner = -1;
let loseAt = 30;            // a player who reaches this many penalty points is eliminated
let firstDeal = true;       // first deal of the game: lowest card (3♦) leads; later deals: winner leads
let trickPlays = [];        // plays in the current trick: [{ seat, combo }] (for the table history)
let endTimer = null;        // brief pause after the winning play before the results overlay
let dealWaitTimer = null;   // non-host: keep asking for the host's deal until it lands
let dealTimer = null;       // staggered fallback: deal the next round if the higher-ranked client didn't
// Declared up here (not next to showHandOver) because startDeal clears them and
// `let` would leave them in the temporal dead zone if a deal ever landed first.
let handCdInterval = null, handCdTimeout = null;
let dealEpoch = 0;          // bumped on every applied deal — lets a scheduled fallback detect "already dealt"
let awaitingDeal = false;   // the results countdown finished and the next round hasn't landed yet
let roundMoveNo = 0;        // moves applied in THIS round; carried on the wire as `ti` for duplicate/proxy dedup
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
const meAvatarEl = document.getElementById("meAvatar");
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
// Apply the chosen language to the static DOM (overlays, buttons, <html lang>).
// Runs once at load (navigator fallback) and again in Usion.init once the
// platform's language setting arrives.
function applyLang(lang) {
  LANG = lang === "en" ? "en" : "mn";
  document.documentElement.lang = LANG;
  document.title = t("docTitle");
  const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  set("setupTitle", "title"); set("setupSub", "setupSub");
  set("playersLabel", "playersLabel"); set("loseLabel", "loseLabel"); set("nameLabelText", "nameLabel");
  set("startBtn", "startGame"); set("setupFoot", "setupFoot");
  set("lobbyTitle", "lobbyTitle"); set("startGameBtn", "startGame"); set("lobbyBotsBtn", "playBots");
  set("lobbyLoseLabel", "loseLabel");
  set("winnerLabel", "winnerLabel"); set("playAgainBtn", "playAgain");
  set("passBtn", "pass"); set("playBtn", "play");
  const skinBtn = document.getElementById("skinToggle");
  if (skinBtn) skinBtn.setAttribute("aria-label", t("skinToggle"));
  const chatBtn = document.getElementById("chatToggle");
  if (chatBtn) chatBtn.setAttribute("aria-label", t("chatAria"));
  const customInput = document.getElementById("customChatInput");
  const customBack = document.getElementById("customChatBack");
  const customSend = document.getElementById("customChatSend");
  if (customInput) customInput.placeholder = t("customChatPlaceholder");
  if (customBack) customBack.setAttribute("aria-label", t("backToQuickChat"));
  if (customSend) customSend.textContent = t("send");
  buildChatPicker();
  // Swap the default placeholder name only if the user hasn't typed their own.
  const nameInput = document.getElementById("nameInput");
  if (nameInput && (!nameInput.value || nameInput.value === STR.mn.you || nameInput.value === STR.en.you)) nameInput.value = t("you");
  if (meNameEl && (meNameEl.textContent === STR.mn.you || meNameEl.textContent === STR.en.you)) meNameEl.textContent = t("you");
}
const MAX_CHAT_LENGTH = 80;
let customChatOpen = false;
applyLang(detectLang());

function makeCardEl(c) {
  const el = document.createElement("div");
  el.className = "card" + (SUIT_RED[c.s] ? " red" : "");
  el.dataset.cardKey = cardKey(c);
  const r = rankLabel(c.r), s = SUITS[c.s];
  el.innerHTML =
    '<span class="corner tl"><b>' + r + '</b><i>' + s + '</i></span>' +
    '<span class="pip">' + s + "</span>" +
    '<span class="corner br"><b>' + r + '</b><i>' + s + "</i></span>";
  return el;
}

// ── Rendering ────────────────────────────────────────────
function normalizeAvatar(value) {
  if (typeof value !== "string") return null;
  const src = value.trim();
  return src && src.length <= 2048 ? src : null;
}
function avatarInitial(name, isBot) {
  if (isBot) return "♣";
  const chars = Array.from(String(name || "").trim());
  return chars.length ? chars[0].toUpperCase() : "?";
}
function paintAvatar(el, name, avatar, isBot) {
  if (!el) return;
  const src = normalizeAvatar(avatar);
  el.textContent = avatarInitial(name, isBot);
  el.classList.toggle("bot-avatar", !!isBot);
  el.setAttribute("aria-label", String(name || t("you")));
  if (!src) return;
  const img = document.createElement("img");
  img.setAttribute("src", src);
  img.setAttribute("alt", "");
  img.setAttribute("draggable", "false");
  img.addEventListener("error", () => img.remove());
  el.appendChild(img);
}
function makeAvatarEl(name, avatar, className, isBot) {
  const el = document.createElement("span");
  el.className = "player-avatar" + (className ? " " + className : "");
  paintAvatar(el, name, avatar, isBot);
  return el;
}
function renderMyPlayer() {
  const p = players[mySeat];
  if (!p) return;
  meNameEl.textContent = p.name;
  paintAvatar(meAvatarEl, p.name, p.avatar, p.isBot);
}
function render() {
  // Unseated (waiting for a seat at a full open table): there is no hand, no
  // opponents and no seat of our own to draw — only the chat button's state.
  if (mySeat < 0 || !players[mySeat]) { updateChatButton(); return; }
  renderMyPlayer(); renderOpponents(); renderTable(); renderHand(); renderControls(); updateTimers(); renderMyScore(); updateChatButton();
}
function renderMyScore() { if (meScoreEl && players[mySeat]) meScoreEl.textContent = players[mySeat].total; }

// ── Turn clock (per-player 2:00; auto-pass / auto-lead on expiry) ─────────
function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
// A circular countdown ring around the profile photo. pathLength=100 lets us
// drive the arc with a 0–100 dashoffset regardless of its rendered size.
function ringSVG() {
  return '<svg viewBox="0 0 36 36">' +
    '<circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>' +
    '<circle class="ring-fg" cx="18" cy="18" r="15.5" pathLength="100"></circle>' +
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
function stopTurnTimer() {
  if (turnTimer) { clearInterval(turnTimer); turnTimer = null; }
  if (proxyTimer) { clearTimeout(proxyTimer); proxyTimer = null; }
}
// The clock is driven by a wall-clock DEADLINE, not by counting ticks. A
// backgrounded WebView stops firing intervals entirely, so a tick-counting clock
// silently gains however long the app was away — a player could dodge their turn
// forever by toggling out and back. With a deadline, time passes whether we're
// running or not, and a resume just re-attaches the interval (resumeTurnTimer).
function startTurnTimer() {
  turnDeadline = Date.now() + TURN_SECONDS * 1000;
  resumeTurnTimer();
}
function resumeTurnTimer() {
  stopTurnTimer();
  if (!turnDeadline) turnDeadline = Date.now() + TURN_SECONDS * 1000;
  turnLeft = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  // Frozen while disconnected: keep the clock displayed but don't tick (a dropped
  // player must not be auto-passed). The reconnect handler restarts it.
  if (!dealActive || netPaused) { updateTimers(); return; }
  updateTimers();
  const tick = () => {
    turnLeft = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
    updateTimers();
    if (turnLeft <= 0) { stopTurnTimer(); onTurnTimeout(); }
  };
  turnTimer = setInterval(tick, 1000);
  if (turnLeft <= 0) tick();   // deadline already blew past while we were away
}
// The active seat's own client resolves the timeout first — that keeps the normal
// case exactly as before. But a locked phone runs NO javascript, so if we stopped
// there a suspended player would hang the whole table forever (their auto-pass can
// only ever come from the one client that is asleep). After a further grace window
// the elected lowest-ranked live client will act FOR them.
const PROXY_GRACE_MS = 10000;
function onTurnTimeout() {
  if (!dealActive || netPaused) return;   // never resolve a timeout while our link is down
  if (!online) {
    if (players[turn].isBot) return;      // local bots act via botTimer, never time out
    autoMove(turn);
    return;
  }
  if (turn === mySeat) { autoMove(mySeat); return; }
  if (players[turn] && players[turn].isBot) { scheduleBotMove(turn); return; }   // a bot never times out
  scheduleProxyMove(turn);
}
// Fallback rank among the clients that could cover `seat` (everyone seated and
// still in the room except the stalled player), lowest seat first.
function proxyRank(seat) {
  const ids = roomPlayerIds.filter((id, s) => s !== seat && presentIds.has(id));
  return ids.indexOf(myId);
}
function scheduleProxyMove(seat) {
  if (proxyTimer) { clearTimeout(proxyTimer); proxyTimer = null; }
  const rank = proxyRank(seat);
  // A single deterministic authority covers the stalled seat. Letting every peer
  // send a staggered `auto:true` move makes another player's seat forgeable.
  if (rank !== 0) return;                            // not elected / not in the room → not our job
  // If we didn't watch this turn start our clock is meaningless, so we hang back a
  // whole extra turn and let the clients that DID see it go first. We still act
  // eventually: if every client rebuilt during this turn, somebody has to, or the
  // table is frozen again — which is the exact failure we're removing.
  const extra = turnTrusted ? 0 : TURN_SECONDS * 1000;
  const epoch = dealEpoch, moveNo = roundMoveNo;
  proxyTimer = setTimeout(() => {
    proxyTimer = null;
    // Stand down if anything moved on: the player woke up and acted, the round
    // rolled over, or we lost our link.
    if (!online || !dealActive || netPaused) return;
    if (epoch !== dealEpoch || moveNo !== roundMoveNo || turn !== seat) return;
    autoMove(seat, true);
  }, extra + PROXY_GRACE_MS);
}
// `proxy` = we are acting on behalf of a seat that isn't ours. Every client holds
// every hand (same seed → same deal), so the forced move is identical whoever
// generates it; `seat` on the wire tells receivers who it belongs to and `ti`
// ties it to the exact turn state it was generated for.
function autoMove(seat, proxy) {
  if (!proxy) selected.clear();
  if (table) {                                       // following → forfeit the trick
    if (online) sendMove({ kind: "pass" }, seat, proxy);
    else doPass(seat);
  } else {                                            // leading → can't pass, so play a forced minimal lead
    const combo = botLead(hands[seat], firstPlay);
    if (!combo) return;
    if (online) sendMove({ kind: "play", cards: combo.cards.map(cardWire) }, seat, proxy);
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
    const profileTimer = document.createElement("span");
    profileTimer.className = "profile-timer opp-profile-timer";
    profileTimer.appendChild(makeAvatarEl(p.name, p.avatar, "opp-avatar", p.isBot));
    const timer = document.createElement("span");
    timer.className = "opp-timer seat-timer" + (live ? " live" : "");
    timer.innerHTML = ringSVG();
    profileTimer.appendChild(timer);
    div.appendChild(profileTimer);
    const nameRow = document.createElement("div");
    nameRow.className = "opp-name";
    nameRow.innerHTML =
        '<span class="opp-pname">' + escapeHtml(p.name) + "</span>" +
        '<span class="opp-score">' + p.total + "</span>";
    div.appendChild(nameRow);
    const fan = document.createElement("div");
    fan.className = "opp-fan";
    fan.innerHTML = '<div class="mini-back"></div>'.repeat(cnt);
    div.appendChild(fan);
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
      const p = players[tp.seat] || { name: "?", avatar: null, isBot: false };
      const row = document.createElement("div");
      row.className = "tp-play" + (latest ? " latest" : "");
      row.dataset.seat = tp.seat;
      const owner = document.createElement("div");
      owner.className = "tp-owner";
      owner.title = p.name;
      owner.appendChild(makeAvatarEl(p.name, p.avatar, "tp-avatar", p.isBot));
      const cards = document.createElement("div");
      cards.className = "tp-cards";
      tp.combo.cards.forEach(c => cards.appendChild(makeCardEl(c)));
      cards.appendChild(owner);
      row.appendChild(cards);   // cards only — no name, no colour
      tableComboEl.appendChild(row);
    });
  } else {
    tableLabelEl.textContent = "";
  }
  if (!dealActive) { turnLine.textContent = "—"; turnLine.className = "turn-line"; return; }
  if (turn === mySeat) { turnLine.textContent = t("yourTurn"); turnLine.className = "turn-line mine"; }
  else { turnLine.textContent = t("turnOf", players[turn].name); turnLine.className = "turn-line"; }
}
function renderHand() {
  clearHandDropIndicator();
  handEl.innerHTML = "";
  const mine = hands[mySeat] || [];
  mine.forEach((c, i) => {
    const el = makeCardEl(c);
    if (selected.has(cardKey(c))) el.classList.add("sel");
    if (dealActive) el.addEventListener("pointerdown", (e) => beginHandDrag(e, i, el));
    el.addEventListener("click", () => {
      if (consumeSuppressedCardClick()) return;
      if (dealActive) toggleCard(c);
    });
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
window.addEventListener("resize", () => {
  if (customChatOpen) updateChatKeyboardInset();
  else layoutHand();
});
function renderControls() {
  meStatusEl.textContent = "";
  meStatusEl.className = "me-status";
  const myTurn = dealActive && turn === mySeat;
  if (pendingAction) {
    playBtn.disabled = true; passBtn.disabled = true;
    meStatusEl.textContent = t("sending");
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
  return mine.filter(c => selected.has(cardKey(c)));
}
function isLegalPlay(combo) {
  if (!combo) return false;
  if (firstPlay && !combo.cards.some(c => sameCard(c, lowCard))) return false;
  return canBeat(combo, table ? table.combo : null);
}

// ── Selection / human input ──────────────────────────────
function toggleCard(card) {
  const key = cardKey(card);
  if (selected.has(key)) selected.delete(key);
  else if (selected.size >= 5) { toast(t("max5")); return; }   // never select/raise more than 5
  else selected.add(key);
  renderHand(); renderControls();   // selection only — playing happens via the Play button
}
const HAND_DRAG_THRESHOLD = 8;
let handDrag = null;
let suppressCardClick = false;

function consumeSuppressedCardClick() {
  if (!suppressCardClick) return false;
  suppressCardClick = false;
  return true;
}

function suppressNextCardClick() {
  suppressCardClick = true;
  setTimeout(() => { suppressCardClick = false; }, 0);
}

function beginHandDrag(e, index, el) {
  if (!dealActive || pendingAction) return;
  if (e.button != null && e.button !== 0) return;
  const key = el.dataset.cardKey;
  const mine = hands[mySeat] || [];
  const keys = selected.has(key) ? mine.map(cardKey).filter(k => selected.has(k)) : [key];
  handDrag = {
    pointerId: e.pointerId,
    key,
    keys,
    fromIndex: index,
    el,
    startX: e.clientX || 0,
    startY: e.clientY || 0,
    dragging: false,
    dropIndex: -1,
  };
  if (el.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId);
}

function updateHandDrag(e) {
  if (!handDrag || (handDrag.pointerId != null && e.pointerId !== handDrag.pointerId)) return;
  const x = e.clientX || 0, y = e.clientY || 0;
  const dx = x - handDrag.startX, dy = y - handDrag.startY;
  if (!handDrag.dragging) {
    if (Math.hypot(dx, dy) < HAND_DRAG_THRESHOLD) return;
    handDrag.dragging = true;
    handEl.classList.add("reordering");
    setHandDraggingCards(handDrag.keys, true);
    suppressNextCardClick();
  }
  handDrag.dropIndex = handDropIndex(handDrag.keys, x);
  updateHandDropIndicator(handDrag.keys, handDrag.dropIndex);
  moveHandDraggingCards(handDrag.keys, dx, dy);
  if (e.preventDefault) e.preventDefault();
}

function finishHandDrag(e) {
  if (!handDrag || (handDrag.pointerId != null && e.pointerId !== handDrag.pointerId)) return;
  const drag = handDrag;
  const wasDragging = drag.dragging;
  handDrag = null;
  handEl.classList.remove("reordering");
  clearHandDropIndicator();
  setHandDraggingCards(drag.keys, false);
  if (drag.el.releasePointerCapture && drag.pointerId != null) {
    try { drag.el.releasePointerCapture(drag.pointerId); } catch (_) {}
  }
  if (!wasDragging) return;
  suppressNextCardClick();
  reorderHandTo(drag.keys, drag.dropIndex >= 0 ? drag.dropIndex : handDropIndex(drag.keys, e.clientX || drag.startX));
  renderHand();
  renderControls();
  if (e.preventDefault) e.preventDefault();
}

function cancelHandDrag(e) {
  if (!handDrag || (handDrag.pointerId != null && e.pointerId !== handDrag.pointerId)) return;
  const drag = handDrag;
  handDrag = null;
  handEl.classList.remove("reordering");
  clearHandDropIndicator();
  setHandDraggingCards(drag.keys, false);
}

function handDropIndex(keys, clientX) {
  const moving = new Set(keys);
  const cards = [...handEl.children].filter(el => !moving.has(el.dataset.cardKey));
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return cards.length;
}

function clearHandDropIndicator() {
  [...handEl.children].forEach(el => el.classList.remove("drop-before", "drop-after"));
}

function updateHandDropIndicator(keys, targetIndex) {
  clearHandDropIndicator();
  const moving = new Set(keys);
  const cards = [...handEl.children].filter(el => !moving.has(el.dataset.cardKey));
  if (!cards.length) return;
  if (targetIndex >= cards.length) cards[cards.length - 1].classList.add("drop-after");
  else cards[targetIndex].classList.add("drop-before");
}

function setHandDraggingCards(keys, on) {
  const moving = new Set(keys);
  [...handEl.children].forEach(el => {
    if (!moving.has(el.dataset.cardKey)) return;
    el.classList.toggle("dragging", on);
    if (!on) el.style.transform = "";
  });
}

function moveHandDraggingCards(keys, dx, dy) {
  const moving = new Set(keys);
  [...handEl.children].forEach(el => {
    if (!moving.has(el.dataset.cardKey)) return;
    const lift = el.classList.contains("sel") ? -34 : 0;
    el.style.transform = "translate(" + dx + "px, " + (dy + lift) + "px) scale(1.04)";
  });
}

function reorderHandTo(keys, targetIndex) {
  const mine = hands[mySeat] || [];
  const moving = new Set(keys);
  const dragged = mine.filter(c => moving.has(cardKey(c)));
  if (!dragged.length) return;
  const rest = mine.filter(c => !moving.has(cardKey(c)));
  const to = Math.max(0, Math.min(targetIndex, rest.length));
  mine.length = 0;
  rest.slice(0, to).concat(dragged, rest.slice(to)).forEach(c => mine.push(c));
}

window.addEventListener("pointermove", updateHandDrag, { passive: false });
window.addEventListener("pointerup", finishHandDrag);
window.addEventListener("pointercancel", cancelHandDrag);
playBtn.addEventListener("click", humanPlay);
passBtn.addEventListener("click", () => { if (!passBtn.disabled) humanPass(); });

function humanPlay() {
  if (turn !== mySeat) return;
  const combo = classify(selectedCards());
  if (!isLegalPlay(combo)) { toast(t("invalidPlay")); return; }
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
  // Kill every next-round timer: the deal we're applying IS the next round. A
  // countdown or a staggered fallback left running here would fire into the live
  // round and deal it a SECOND time, re-dealing everyone's cards mid-hand.
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  if (openRestartTimer) { clearTimeout(openRestartTimer); openRestartTimer = null; }
  dealEpoch += 1;
  awaitingDeal = false;
  roundMoveNo = 0;
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
  if (dragon !== undefined) { toast(t("dragon", players[dragon].name)); dealActive = false; endHand(dragon, true); return; }
  beginTurn();
}

function beginTurn() {
  render();
  turnTrusted = !replayingSync;   // replay → we're reconstructing, not observing
  startTurnTimer();
  if (!dealActive) return;
  if (!online) {
    if (players[turn].isBot) botTimer = setTimeout(botAct, 750 + Math.floor(Math.random() * 500));
    return;
  }
  // Open table: a bot seat is played by the engine, broadcast as a normal stored
  // move by exactly one elected client. Never during a replay — we're
  // reconstructing history there, not producing it.
  if (!replayingSync && players[turn] && players[turn].isBot) scheduleBotMove(turn);
}
function botAct() {
  botTimer = null;
  if (!dealActive || online) return;
  const d = botDecision(turn);
  if (!d) return;
  if (d.kind === "pass") doPass(turn);
  else doPlay(turn, d.combo);
}

// ── Bot seats, online ────────────────────────────────────
// The engine's choice for `seat`, derived ONLY from replayable state (the seat's
// hand, the table, firstPlay). Every client computes the same answer, which is
// what makes a broadcast bot move verifiable: the sender does not get to pick
// the cards, the engine does — the same rule that guards a proxy cover.
function botDecision(seat) {
  const hand = hands[seat] || [];
  if (!hand.length) return null;
  const others = activeSeats().filter(s => s !== seat);
  const opponentMin = others.length ? Math.min(...others.map(s => (hands[s] || []).length)) : 13;
  const context = {
    opponentMin,
    urgent: !!table && table.seat !== seat && (hands[table.seat] || []).length <= 2,
  };
  if (!table) {
    const combo = botLead(hand, firstPlay, context);
    return combo ? { kind: "play", combo } : null;
  }
  const m = botFollow(hand, table.combo, context);
  return m ? { kind: "play", combo: m } : { kind: "pass" };
}
// One deterministic writer per bot seat: the lowest-seated human still in the
// room. Bot seats hold `null` in roomPlayerIds and are never in presentIds, so
// they can never elect themselves.
function botAuthorityId(seat) { return proxyAuthorityId(seat); }
function scheduleBotMove(seat) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (!online || !dealActive || netPaused) return;
  if (!players[seat] || !players[seat].isBot || players[seat].out) return;
  if (turn !== seat) return;
  if (botAuthorityId(seat) !== myId) return;              // not our bot to play
  const epoch = dealEpoch, moveNo = roundMoveNo;
  botTimer = setTimeout(function () {
    botTimer = null;
    if (!online || !dealActive || netPaused) return;
    if (epoch !== dealEpoch || moveNo !== roundMoveNo || turn !== seat) return;
    if (!players[seat] || !players[seat].isBot || players[seat].out) return;
    if (botAuthorityId(seat) !== myId) return;
    // Our own move is still awaiting its echo — sendMove would drop this on the
    // floor, so come back once the latch clears rather than stalling the seat.
    if (pendingAction) { scheduleBotMove(seat); return; }
    const d = botDecision(seat);
    if (!d) return;
    const mv = d.kind === "pass" ? { kind: "pass" } : { kind: "play", cards: d.combo.cards.map(cardWire) };
    mv.bot = true;
    sendMove(mv, seat, true);
  }, BOT_MOVE_MS);
}
// Nudge a bot seat that is on turn but has nobody driving it — after a replay,
// after a seat change, or after the elected authority disappeared. Idempotent.
function kickBotTurn() {
  if (!online || !dealActive || replayingSync) return;
  if (!players[turn] || !players[turn].isBot) return;
  if (botTimer) return;
  scheduleBotMove(turn);
}

function doPlay(seat, combo) {
  const hand = hands[seat];
  combo.cards.forEach(pc => { const idx = hand.findIndex(c => sameCard(c, pc)); if (idx >= 0) hand.splice(idx, 1); });
  table = { combo, seat };
  trickPlays.push({ seat, combo });
  firstPlay = false;
  passStreak = 0;                       // a play resets the consecutive-pass count
  lastAction[seat] = { kind: "play", text: comboName(combo) };
  if (hand.length === 0) { lastAction[seat] = { kind: "win", text: t("finished") }; dealActive = false; endHand(seat, false); return; }
  advanceTurn();
}
function doPass(seat) {
  passed.add(seat);
  passStreak += 1;
  lastAction[seat] = { kind: "pass", text: t("pass") };
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
  // The round is over — no move can legitimately be awaiting its echo now. Clear the
  // latch so a stale pendingAction (e.g. an own-move echo dropped mid-round) can never
  // block the host's next-round hostDeal() and freeze the whole table on the last trick.
  pendingAction = false;
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
function showHandOver(winnerSeat, deltas, newlyOut) {
  newlyOut = newlyOut || [];
  document.getElementById("handTitle").textContent = winnerSeat === mySeat ? t("youWonRound") : t("wonRound", players[winnerSeat].name);
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
    const tag = p.out ? '<span class="rv-foul">' + t("eliminatedTag") + "</span>" : (seat === winnerSeat ? t("wonTag") : t("cardsLeft", hands[seat].length));
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
    cd.innerHTML = t("nextRoundIn", '<span class="cd-num' + (pop ? " pop" : "") + '">' + left + "</span>");
  };
  renderCd(false);
  handCdInterval = setInterval(() => {
    left--;
    if (left < 0) left = 0;
    renderCd(true);
    if (left <= 0) {
      clearInterval(handCdInterval); handCdInterval = null;
      if (!online) startNextLocal();
      else scheduleNextDeal();
    }
  }, 1000);

  if (!online) {
    const next = document.createElement("button");
    next.className = "btn-next"; next.textContent = t("nextRound");
    next.addEventListener("click", startNextLocal);
    const quit = document.createElement("button");
    quit.className = "btn-quit"; quit.textContent = t("newGame");
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
// ── Who deals the next round ─────────────────────────────
// The platform has NO host migration (multiplayer.md): if player_ids[0] locks
// their phone, leaves, or is eliminated and walks away, nobody is promoted — and
// this used to be the ONLY client allowed to deal, so the table froze on "Next
// round in 0" forever. Every client now schedules the deal, staggered by rank, and
// stands down the moment someone else's deal lands. No election, no extra state:
// the worst case is a duplicate `deal` action, which the server orders so every
// client still lands on the same round.
const DEAL_STAGGER_MS = 2500;
function authoritySeats() {
  return roomPlayerIds.map((id, s) => s).filter(s => presentIds.has(roomPlayerIds[s]));
}
function authorityRank() { return authoritySeats().indexOf(mySeat); }
// Primary = lowest-seated client still in the room. Falls through to the host when
// presence is unknown, so behaviour is unchanged in a healthy room.
function isPrimaryAuthority() {
  if (!online) return false;
  const seats = authoritySeats();
  if (!seats.length) return isHostPlayer();
  return seats[0] === mySeat;
}
function scheduleNextDeal() {
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  if (!online || dealActive) return;
  awaitingDeal = true;
  const rank = authorityRank();
  if (rank < 0) return;
  if (rank === 0) { handOverlay.classList.remove("show"); hostDeal(); return; }
  const epoch = dealEpoch;
  dealTimer = setTimeout(() => {
    dealTimer = null;
    if (!online || dealActive || epoch !== dealEpoch) return;   // someone dealt — stand down
    handOverlay.classList.remove("show");
    hostDeal();
  }, rank * DEAL_STAGGER_MS);
}
// Re-run the election, but ONLY if the table is genuinely waiting on a deal (the
// countdown already finished). Called when the room changes under us or we come
// back from the background — the client that owed the deal may be the one that
// just disappeared. Never fires during the results countdown.
function retryNextDeal() {
  if (online && gameStarted && awaitingDeal && !dealActive) scheduleNextDeal();
}
function backToSetup() {
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  awaitingDeal = false;
  stopTurnTimer();
  handOverlay.classList.remove("show");
  dealActive = false;
  setupOverlay.classList.add("show");
}

// Game over: only one player has avoided the lose-at threshold — they win.
function showGameOver() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  stopTurnTimer();
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  awaitingDeal = false;   // the match is over — no fallback client should deal again
  handOverlay.classList.remove("show");
  dealActive = false;
  const survivors = activeSeats();
  const ranked = players.map((p, s) => s).sort((a, b) => players[a].total - players[b].total);
  const champ = survivors.length ? survivors[0] : ranked[0];
  recordOutcome(champ === mySeat);   // multiplayer-only, idempotent per match
  reportMatchResult(champ, ranked);  // host reports to the originating group or players' DMs
  document.getElementById("winnerName").textContent = champ === mySeat ? t("you") : players[champ].name;
  const sb = document.getElementById("finalScoreboard");
  sb.innerHTML = "";
  ranked.forEach(seat => {
    const p = players[seat];
    const row = document.createElement("div");
    row.className = "sb-row" + (seat === champ ? " lead" : "");
    row.innerHTML =
      '<div class="sb-dot" style="background:' + p.color + '"></div>' +
      '<div class="sb-name">' + escapeHtml(p.name) + "</div>" +
      '<div class="sb-rank" style="width:auto;opacity:.7">' + (seat === champ ? t("survived") : t("lostTag")) + "</div>" +
      '<div class="sb-score">' + p.total + "</div>";
    sb.appendChild(row);
  });
  document.getElementById("winnerOverlay").classList.add("show");
  scheduleOpenRestart();
}
// An open table does not really end: the champion screen sits for a few seconds
// and then the elected client deals a fresh match, so whoever is in the room
// (plus bots for the empty seats) simply keeps playing. PLAY AGAIN still works —
// it just brings the restart forward.
let openRestartTimer = null;
function scheduleOpenRestart() {
  if (openRestartTimer) { clearTimeout(openRestartTimer); openRestartTimer = null; }
  if (!online) return;
  const rank = authorityRank();
  if (rank < 0) return;
  const rs = document.getElementById("rematchStatus");
  if (rs) rs.textContent = t("openRestarting");
  openRestartTimer = setTimeout(function () {
    openRestartTimer = null;
    if (!online || dealActive) return;
    hostDeal(true);   // reset deal → every client zeroes the match and deals as one
  }, OPEN_RESTART_MS + rank * DEAL_STAGGER_MS);
}
// Play again. Offline: reset locally. Online: platform mode has no server-side
// restart event — the HOST restarts by broadcasting a normal stored `deal`
// action with reset:true (every client zeroes its match state in onDeal), and a
// non-host asks for one via Usion.game.requestRematch() (a pure broadcast: the
// other players' onRematchRequest fires, so the host sees who wants a rematch).
document.getElementById("playAgainBtn").addEventListener("click", () => {
  if (online) {
    if (isPrimaryAuthority()) { hostDeal(true); return; }   // reset deal → every client restarts
    try { if (window.Usion && Usion.game && Usion.game.requestRematch) Usion.game.requestRematch(); } catch (_) {}
    const rs = document.getElementById("rematchStatus");
    if (rs) rs.textContent = t("rematchWait");
    return;
  }
  document.getElementById("winnerOverlay").classList.remove("show");
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

// ── Quick chat (emoji reactions + canned phrases) ────────
// A tap sends a realtime "reaction" broadcast and pops a bubble over the
// sender's seat. Purely cosmetic — no game state, never blocks play.
// NB: the emoji/phrase lists live INSIDE buildChatPicker so applyLang() can
// call it during early module init without tripping a const TDZ.
function buildChatPicker() {
  const REACTION_EMOJIS = ["👍", "😂", "🔥", "👏", "🎉", "😎", "😴", "😱"];
  const REACTION_PHRASE_KEYS = ["qcHurry", "qcBad",  "qcGotit", "qcNice", "qcWow"];
  const em = document.getElementById("chatEmojis");
  const ph = document.getElementById("chatPhrases");
  if (!em || !ph) return;
  em.innerHTML = ""; ph.innerHTML = "";
  REACTION_EMOJIS.forEach(e => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chat-emoji"; b.textContent = e;
    b.addEventListener("click", () => sendReaction("emoji", e));
    em.appendChild(b);
  });
  REACTION_PHRASE_KEYS.forEach(k => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chat-phrase"; b.textContent = t(k);
    b.addEventListener("click", () => sendReaction("text", t(k)));
    ph.appendChild(b);
  });
  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "chat-phrase chat-custom-toggle";
  custom.textContent = t("customChat");
  custom.setAttribute("aria-expanded", "false");
  custom.addEventListener("click", () => setCustomChatOpen(true, true));
  ph.appendChild(custom);
}

let chatOpen = false;
function openChatPicker() {
  const p = document.getElementById("chatPicker");
  if (!p) return;
  chatOpen = true;
  p.classList.add("show"); p.setAttribute("aria-hidden", "false");
}
function closeChatPicker() {
  const p = document.getElementById("chatPicker");
  if (!p) return;
  setCustomChatOpen(false, false);
  chatOpen = false;
  p.classList.remove("show"); p.setAttribute("aria-hidden", "true");
}
function toggleChatPicker() { chatOpen ? closeChatPicker() : openChatPicker(); }

let lastReactionAt = 0;
function normalizeChatMessage(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_CHAT_LENGTH) : "";
}
function normalizeReaction(kind, value) {
  if (kind === "emoji") return typeof value === "string" ? value.trim().slice(0, 8) : "";
  if (kind === "text") return normalizeChatMessage(value);
  return "";
}
function updateChatKeyboardInset() {
  const picker = document.getElementById("chatPicker");
  if (!picker || !customChatOpen) return;
  const viewport = window.visualViewport;
  const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  setChatKeyboardInset(picker, inset + "px");
}
function setChatKeyboardInset(picker, value) {
  if (!picker) return;
  if (typeof picker.style.setProperty === "function") picker.style.setProperty("--chat-keyboard-inset", value);
  else picker.style["--chat-keyboard-inset"] = value;
}
function setCustomChatOpen(open, focusInput) {
  customChatOpen = Boolean(open);
  const picker = document.getElementById("chatPicker");
  const toggle = document.getElementById("chatToggle");
  const form = document.getElementById("customChatForm");
  const input = document.getElementById("customChatInput");
  const custom = picker && picker.querySelector(".chat-custom-toggle");
  if (picker) picker.classList.toggle("custom-mode", customChatOpen);
  if (toggle) toggle.classList.toggle("custom-mode", customChatOpen);
  if (form) form.hidden = !customChatOpen;
  if (custom) custom.setAttribute("aria-expanded", customChatOpen ? "true" : "false");
  if (customChatOpen) {
    updateChatKeyboardInset();
    if (focusInput && input) requestAnimationFrame(() => input.focus());
  } else {
    setChatKeyboardInset(picker, "0px");
    if (input && document.activeElement === input) input.blur();
  }
}
function sendReaction(kind, value) {
  const cleanValue = normalizeReaction(kind, value);
  if (!cleanValue) return false;
  const now = Date.now();
  if (now - lastReactionAt < 700) return false;   // throttle spam
  lastReactionAt = now;
  closeChatPicker();
  const seat = (typeof mySeat === "number" && mySeat >= 0) ? mySeat : 0;
  showReaction(seat, kind, cleanValue);
  if (online && window.Usion && Usion.game && Usion.game.realtime) {
    try { Usion.game.realtime("reaction", { kind: kind, value: cleanValue }); } catch (e) {}
  }
  return true;
}

// Pop a transient bubble anchored over a seat's on-screen element. Uses a
// fixed-position layer + live bounding rects so it survives seat re-renders.
function showReaction(seat, kind, value) {
  value = normalizeReaction(kind, value);
  if (!value) return;
  const layer = document.getElementById("reactionLayer");
  if (!layer) return;
  let anchor;
  if (seat === mySeat) anchor = document.querySelector(".me-bar") || document.querySelector(".me-area");
  else anchor = oppEl.querySelector('.opp[data-seat="' + seat + '"]');
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "reaction-bubble " + (kind === "emoji" ? "is-emoji" : "is-text");
  bubble.textContent = value;
  layer.appendChild(bubble);
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - bw - 6));
  const below = anchor.classList.contains("opp--top");   // top seat: drop the bubble below it
  let top = below ? r.bottom + 8 : r.top - bh - 8;
  top = Math.max(6, Math.min(top, window.innerHeight - bh - 6));
  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
  requestAnimationFrame(() => bubble.classList.add("pop"));
  setTimeout(() => bubble.classList.add("out"), 1900);
  setTimeout(() => bubble.remove(), 2400);
}

// The chat button is only meaningful once a match is on screen — i.e. seats are
// dealt and we're past the setup/lobby overlays (works for both offline vs-bots
// and online play; gameStarted is only set on the online path).
function updateChatButton() {
  const btn = document.getElementById("chatToggle");
  if (!btn) return;
  const setup = document.getElementById("setupOverlay");
  const lobby = document.getElementById("onlineOverlay");
  const show = players.length > 0 &&
    !(setup && setup.classList.contains("show")) &&
    !(lobby && lobby.classList.contains("show"));
  btn.classList.toggle("show-btn", show);
  if (!show && chatOpen) closeChatPicker();
}

document.getElementById("chatToggle").addEventListener("click", (e) => { e.stopPropagation(); toggleChatPicker(); });
document.getElementById("customChatBack").addEventListener("click", () => setCustomChatOpen(false, false));
document.getElementById("customChatForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("customChatInput");
  if (input && sendReaction("text", input.value)) input.value = "";
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateChatKeyboardInset);
  window.visualViewport.addEventListener("scroll", updateChatKeyboardInset);
}
// Tap anywhere outside the picker closes it.
document.addEventListener("click", (e) => {
  if (!chatOpen) return;
  const p = document.getElementById("chatPicker");
  const btn = document.getElementById("chatToggle");
  if (p && !p.contains(e.target) && e.target !== btn) closeChatPicker();
});
buildChatPicker();
// NB: no load-time updateChatButton() — it reads `gameStarted`, which is
// declared later (TDZ). The button stays hidden by default (CSS) until
// render() reveals it once a match begins.

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
  const myName = (document.getElementById("nameInput").value || t("you")).slice(0, 10);
  players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ name: i === 0 ? myName : t("botNames")[i], avatar: i === 0 ? myAvatar : null,
                   color: PLAYER_COLORS[i], isBot: i !== 0, total: 0, out: false });
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
let myId = null, myName = "", myAvatar = null;   // display-name fallback is t("you")
let roomPlayerIds = [];
let connectedCount = 0;
let isHost = false;
let gameStarted = false;
let lastSeq = 0;
let curSeed = 0;
let moveLog = [];
let checkpointVersion = 0;
let replayingSync = false;
// Replaying moves out of a CHECKPOINT, which is different from replaying the raw
// action log. Checkpoint moves were already validated by the client that wrote
// them and carry no sender id, so they are trusted. Raw log actions are not:
// anyone can write to the log, and the log keeps what the live table rejected.
// Skipping the sender checks for both (they used to share `replayingSync`) meant
// a forged fold or cover the whole table refused was still applied by whoever
// resynced next — the same live-vs-replay split that froze the deal path.
let replayTrusted = false;
let appliedSequences = new Set();
// High-water mark: every action at or below this sequence is already baked into
// our state (it came in via a checkpoint, whose individual sequences we can't
// enumerate). Without it, applying a checkpoint wiped `appliedSequences` and a
// following sync happily re-played moves the snapshot already contained —
// duplicate cards on the table. Replay only what is PROVABLY new.
let appliedBaseSeq = 0;
let pendingAction = false;
const playerMeta = {};
// ── Lobby (waiting room): who's connected + their ready state, pre-game ──
const presentIds = new Set();   // player ids currently in the room (connected)
// (An open table has no READY gate: nobody waits, so nothing tracks readiness.)

// ── Usion capabilities: cloud stats · leaderboard · checkpoint ──
// All wrappers are defensive: missing modules / standalone preview must never
// throw (a thrown error in init blanks the game). They no-op gracefully.
let myStats = { wins: 0, losses: 0, games: 0 };
let statsRecordedThisGame = false;
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
      Usion.leaderboard.submit(myStats.wins);
    }
  } catch (_) {}
}

// Record MY outcome exactly once per multiplayer match (idempotent across paths).
function recordOutcome(iWon) {
  if (statsRecordedThisGame || !online) return;
  statsRecordedThisGame = true;
  myStats.games += 1;
  if (iWon) {
    myStats.wins += 1;
  } else {
    myStats.losses += 1;
  }
  persistStats();
  submitLeaderboard();
  try { if (window.Usion && Usion.cloud && Usion.cloud.shared) Usion.cloud.shared.incr("games_total", 1); } catch (_) {}
}

// Report the authoritative 2–4 player result once. Explicit standings make the
// lower-is-better penalty system unambiguous. Usion routes the card to the
// originating group chat or to the players' DMs automatically.
let resultReportedThisGame = false;
function reportMatchResult(champSeat, rankedSeats) {
  if (resultReportedThisGame) return;
  // Primary authority, not strictly the host: while the host is present that IS
  // the host (seat 0), but an eliminated host who walked away must not take the
  // result card with them.
  if (!online || !isPrimaryAuthority()) return;
  if (!Array.isArray(roomPlayerIds) || roomPlayerIds.length < 2 || roomPlayerIds.length > 4) return;
  const champ = Number(champSeat);
  if (!Number.isInteger(champ) || champ < 0 || champ >= roomPlayerIds.length) return;
  // A bot can win an open table. There is no platform identity to hand the result
  // card to, so simply don't file one — the winner screen still shows the bot.
  if (roomPlayerIds[champ] == null) return;
  if (!window.Usion || !Usion.game || typeof Usion.game.reportResult !== "function") return;

  // Champion first, then the final lower-penalty ranking. This keeps a forfeit
  // winner first even when a folded player happened to have fewer penalty points.
  const forfeitedSeats = players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p, seat }) => seat !== champ && p && p.out && p.total < loseAt)
    .map(({ seat }) => seat);
  const orderedSeats = [champ];
  for (const seat of Array.isArray(rankedSeats) ? rankedSeats : []) {
    const s = Number(seat);
    if (Number.isInteger(s) && s >= 0 && s < roomPlayerIds.length &&
        !forfeitedSeats.includes(s) && !orderedSeats.includes(s)) orderedSeats.push(s);
  }
  for (let s = 0; s < roomPlayerIds.length; s++) {
    if (!forfeitedSeats.includes(s) && !orderedSeats.includes(s)) orderedSeats.push(s);
  }
  for (const seat of forfeitedSeats) if (!orderedSeats.includes(seat)) orderedSeats.push(seat);

  const payload = { winnerId: roomPlayerIds[champ] };
  // Standings and scores name PLAYERS, so bot seats drop out of both.
  const humanStandings = orderedSeats.map(seat => roomPlayerIds[seat]).filter(id => id != null);
  if (humanStandings.length > 2) payload.standings = humanStandings;

  // Normal elimination: penalty totals are meaningful (lower is better).
  // Forfeit/fold: omit them because they did not determine the placement.
  const hasForfeit = forfeitedSeats.length > 0;
  if (!hasForfeit) {
    const scores = {};
    for (let seat = 0; seat < roomPlayerIds.length; seat++) {
      if (roomPlayerIds[seat] == null) continue;
      if (players[seat] && Number.isFinite(Number(players[seat].total))) {
        scores[roomPlayerIds[seat]] = Number(players[seat].total);
      }
    }
    if (Object.keys(scores).length) {
      payload.scores = scores;
      payload.metric = "penalty points";
    }
  }

  resultReportedThisGame = true;
  try {
    Usion.game.reportResult(payload).catch(function () {});
  } catch (_) { /* result delivery must never block the winner screen */ }
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
    loseAt: loseAt,          // host's elimination threshold, so reconnects/late joiners match
    names: nameMap(),
    avatars: avatarMap(),
    // Freshness is the SERVER's action sequence, never a wall clock: `version`
    // used to be Date.now(), which is compared ACROSS DEVICES — a few seconds of
    // clock skew (routine on phones) made a stale snapshot look newer than a live
    // one, or a fresh one get rejected. `seq` is server-issued and monotonic.
    version: lastSeq,
    seq: lastSeq          // the action sequence this snapshot already includes
  };
}
// Is an incoming snapshot ahead of what we already applied? Prefer the server
// sequence; fall back to `version` only when a peer didn't send one (older build,
// whose version is a Date.now() timestamp and therefore incomparable to ours).
function snapshotIsNewer(state) {
  const seq = Number(state && state.seq);
  if (Number.isFinite(seq)) return seq > lastSeq;
  return Number((state && state.version) || 0) > checkpointVersion;
}
function writeCheckpoint() {
  try {
    if (window.Usion && Usion.game && Usion.game.setState) {
      const checkpoint = Usion.game.setState(currentCheckpoint());
      if (checkpoint && checkpoint.then) {
        checkpoint.then(res => {
          // STALE_STATE means the server has moves we haven't applied — we are
          // behind. The SDK contract is to resync, never to retry the write.
          if (res && res.success === false && res.code === "STALE_STATE") {
            try { Usion.game.requestSync(lastSeq); } catch (_) {}
          }
        }).catch(() => {});
      }
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
  if (!online || !dealActive || !isPrimaryAuthority()) return;
  try {
    if (window.Usion && Usion.game && Usion.game.realtime) Usion.game.realtime("state_push", currentCheckpoint());
  } catch (_) {}
}
// Apply a pushed/synced snapshot if it's newer than what we already have.
function applyStateSnapshot(state) {
  if (!state || state.seed === undefined || !Array.isArray(state.order)) return;
  if (!gameStarted || snapshotIsNewer(state)) applyCheckpoint(state);
}

// An open table's seat order carries `null` for every seat a bot is holding, so
// only the human ids have to be unique — and at least one of them must exist.
function validSeatOrder(order) {
  if (!Array.isArray(order) || order.length < 2 || order.length > 4) return false;
  const ids = order.filter(id => id != null);
  if (!ids.length) return false;
  return new Set(ids).size === ids.length;
}

function sameSeatOrder(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((id, i) => id === b[i]);
}
// An open table's roster legitimately changes mid-match (bot ↔ human, and a
// player who was released while away comes back to a DIFFERENT seat), so a
// recovery snapshot can no longer be required to match ours seat for seat — that
// rule locked a returning player out of the round for good. What still bounds a
// forged roster is unchanged: a peer's state_push is only read when it comes from
// the elected authority (onNetRealtime), and any snapshot must be strictly newer
// than what we have already applied (snapshotIsNewer).
function seatOrderCompatible(next) {
  return validSeatOrder(next) && Array.isArray(roomPlayerIds) &&
    (!roomPlayerIds.length || next.length === roomPlayerIds.length);
}

// The room's authoritative state no longer seats us: we were away long enough for
// the table to release our seat back to a bot, and it may already belong to
// somebody else. Clinging to it is what splits a table in two — every move the
// room makes for that seat is one we reject, forever. So drop back to the waiting
// state and let the table's own reconcileOpenSeats deal us in again.
function becomeUnseated() {
  stopLocalRound();
  gameStarted = false;
  dealActive = false;
  players = []; hands = []; moveLog = [];
  table = null; trickPlays = []; lastAction = {};
  handOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  showNotSeated();
  startSeatPoll();
  render();
}
// Every seat is taken by a human right now. Not an error on an open table — sit
// tight and the next seat that frees up is ours (startSeatPoll keeps asking).
function showNotSeated() {
  if (!gameStarted) mySeat = -1;   // we hold no seat — renderers must not draw one
  onlineOverlay.classList.add("show");
  const status = document.getElementById("onlineStatus");
  if (status) status.textContent = t("openWaitSeat");
}

// Rebuild the current round from a host checkpoint (received as game_state on a
// reconnect/join). Restores round-start state, re-deals the same seed, then
// replays the round's moves so the board matches everyone else's. Returns true
// if a valid checkpoint was applied.
function applyCheckpoint(state) {
  if (!state || typeof state !== "object" || state.seed === undefined || !validSeatOrder(state.order)) return false;
  if (state.order.indexOf(myId) < 0) {
    // Not in this snapshot's roster. Before the match that just means the table
    // is full and we are queuing for a seat.
    if (!gameStarted) { showNotSeated(); return false; }
    // Mid-match it means one of two very different things. A snapshot that is
    // BEHIND us simply predates our (re)seating — acting on it would throw away a
    // seat we do hold. A snapshot that is genuinely AHEAD of everything we have
    // applied is the room telling us our seat is gone, and arguing with it strands
    // us in a private copy of the round.
    const cpSeq = Number(state.seq);
    const ahead = Number.isFinite(cpSeq) ? cpSeq > syncResumePoint() : snapshotIsNewer(state);
    if (ahead) becomeUnseated();
    return false;
  }
  // A live match has frozen seating. A checkpoint may restore that match, but it
  // must never be able to replace its roster (including via a forged state_push).
  if (gameStarted && !seatOrderCompatible(state.order)) return false;
  applyNames(state.names);                              // host-supplied identities before seating
  applyAvatars(state.avatars);
  if (!gameStarted && !startOnlineGame({ order: state.order })) return false;
  roomPlayerIds = state.order.slice();
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  // restore round-start scores/elimination (startOnlineGame zeroes them), then
  // replaying the moves re-applies this round's penalties exactly once.
  if (Array.isArray(state.totals)) state.totals.forEach((total, s) => {
    const value = Number(total);
    if (players[s] && Number.isFinite(value) && value >= 0) players[s].total = value;
  });
  if (Array.isArray(state.outs)) state.outs.forEach((o, s) => { if (players[s]) players[s].out = o === true; });
  firstDeal = !!state.firstDeal;
  lastWinner = (typeof state.lastWinner === "number") ? state.lastWinner : -1;
  if (Number.isFinite(state.loseAt) && state.loseAt > 0) loseAt = state.loseAt;   // adopt host's elimination threshold
  curSeed = state.seed;
  moveLog = [];
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  startDeal(state.seed);                                 // same seed → same hands & lead
  checkpointVersion = Number(state.version || checkpointVersion || 0);
  appliedSequences = new Set();
  const cpSeq = Number(state.seq);
  if (Number.isFinite(cpSeq)) {
    appliedBaseSeq = cpSeq;
    lastSeq = Math.max(lastSeq, cpSeq);   // else a later requestSync(lastSeq) re-sends what we just applied
  }
  replayingSync = true;
  replayTrusted = true;
  (state.moves || []).forEach(mv => applyRemoteMove(mv));
  replayTrusted = false;
  replayingSync = false;
  // We just rebuilt the whole round from authoritative state, so nothing can
  // still be legitimately awaiting its echo. Checkpoint moves carry no sender id,
  // so the usual "my own move came back" release in applyRemoteMove cannot fire
  // for them — without this, a move recovered THROUGH a checkpoint would leave us
  // latched on "Sending…" forever. Re-sending after a false clear is harmless:
  // roundMoveNo has moved on, so the duplicate is dropped on `ti`.
  pendingAction = false;
  renderControls();
  kickBotTurn();   // we may have rebuilt straight into a bot's turn
  return true;
}
// Have we already applied this action sequence? Either explicitly, or implicitly
// because a checkpoint at/above it rebuilt our state.
function alreadyApplied(seq) {
  if (seq === undefined) return false;
  const n = Number(seq);
  if (!Number.isFinite(n)) return false;
  return n <= appliedBaseSeq || appliedSequences.has(n);
}
// Where a catch-up has to resume from: the highest point with NO holes below it.
// `lastSeq` is not that — it advances the moment an action is SEEN, even one we
// could not apply. A client that missed actions 8-19 and then received 20 has
// lastSeq 20, so requestSync(lastSeq) asks for "everything after 20" and the gap
// is gone for good. Walking the applied set instead asks from 7, where our state
// actually ends.
function syncResumePoint() {
  let n = appliedBaseSeq;
  while (appliedSequences.has(n + 1)) n++;
  return n;
}

// Legacy hint: some hosts pass a "play with bots"/solo ref or path. Kept only as
// a fallback signal inside launchedSolo (below) for SDKs that don't expose mode.
function isBotsLaunch(config) {
  try {
    let lp = {};
    if (window.Usion && typeof Usion.getLaunchParams === "function") lp = Usion.getLaunchParams() || {};
    const hint = [config && config.ref, config && config.launchPath, lp.ref, lp.path]
      .filter(Boolean).join(" ").toLowerCase();
    return /\b(bot|bots|solo|practice|single|ai|offline)\b/.test(hint);
  } catch (_) { return false; }
}

// Did the platform open us solo (GameTok / Explore) rather than a real chat
// game-invite? Trust the launch MODE — never infer from roomId alone, because a
// solo launch may still be handed an auto-created (standalone_) room for SDK
// plumbing (gametok.md / sdk-reference). Only a 'multiplayer' launch goes online.
function launchedSolo(config) {
  try {
    let lp = {};
    if (window.Usion && typeof Usion.getLaunchParams === "function") lp = Usion.getLaunchParams() || {};
    if (lp.mode === "single") return true;
    if (lp.mode === "multiplayer") return false;
    // SDK without the mode field: boolean shortcut, then the legacy bot/solo hint,
    // then "only a non-standalone roomId is a real multiplayer room".
    if (window.Usion && Usion.game && typeof Usion.game.isMultiplayer === "function")
      return !Usion.game.isMultiplayer();
    if (isBotsLaunch(config)) return true;
    const rid = config && config.roomId ? String(config.roomId) : "";
    return !rid || /^standalone[_-]/i.test(rid);
  } catch (_) { return false; }
}

if (window.Usion && Usion.init) {
  try {
    Usion.init(async function (config) {
      applyLang(detectLang());   // the platform's language setting is known now
      myId = config.userId;
      if (config.userName) myName = config.userName;
      if (config.userAvatar) myAvatar = normalizeAvatar(config.userAvatar);
      if (config.playerIds) roomPlayerIds = config.playerIds.slice();   // platform-provided roster (playerIds[0] = host)
      playerMeta[myId] = { name: myName || t("you"), avatar: myAvatar };
      presentIds.add(myId);
      loadStats(); // fire-and-forget; never block init/render
      // Registered up front REGARDLESS of launch mode: a solo launch can be
      // promoted into a live room mid-session via the host's Share button.
      try {
        if (Usion.game && Usion.game.onRoomAssigned) Usion.game.onRoomAssigned(function () { onRoomPromoted(); });
      } catch (_) {}
      // Solo launch (GameTok / Explore, mode 'single') → drop straight into a
      // zero-tap 4-player round vs bots (road to 20), no menu and no lobby. Only a
      // real multiplayer launch (chat game invite, roomId) goes online to the
      // waiting room — chat-invite play is preserved.
      if (!launchedSolo(config) && config.roomId) {
        online = true;
        setupOverlay.classList.remove("show");
        onlineOverlay.classList.add("show");
        await setupMultiplayer(config.roomId);
      } else {
        startBotsGame();   // GameTok / Explore solo → zero-tap you + 3 bots, road to 20
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
// Coming back from a paused link: the turn clock owes us the time we spent
// disconnected (we must not be auto-passed for a gap we couldn't play through),
// but NOT the time we merely spent backgrounded with a live connection.
function resumeFromPause() {
  if (netPaused && pausedAt) turnDeadline += Date.now() - pausedAt;
  pausedAt = 0;
  netPaused = false;
}
function foregroundResync() {
  if (!online || !gameStarted) return;
  resumeFromPause();
  try {
    if (window.Usion && Usion.game) {
      if (Usion.game.requestSync) Usion.game.requestSync(lastSeq);
      if (Usion.game.realtime) Usion.game.realtime("request_state", {});
    }
  } catch (_) {}
  // resume, never restart: the deadline is wall-clock, so a player can't win extra
  // thinking time by toggling out of the app and back.
  if (dealActive) { resumeTurnTimer(); render(); }
  retryNextDeal();   // we may have owed everyone the next deal while we were away
}

// On resume the host socket can take several seconds to reconnect + rejoin the
// room; a few fixed retries can ALL fire during that gap and get no response
// (observed: 5× requestSync, 0× sync back). So keep requesting until our own
// sequence actually advances (a response landed) or we hit a long timeout.
var _resyncBaseSeq = -1;
var _resyncDeadline = 0;
function beginResync(reason) {
  turnTrusted = false;   // we were frozen/dropped — our view of the active player's clock is meaningless
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

// ── Catch-up of last resort ──────────────────────────────────────────────
// Every OTHER resync trigger we have is an event: visibilitychange, the freeze
// watchdog above, or onReconnect. So a message lost while the socket stays up
// and the app stays in the foreground has no recovery path at all — and for our
// own action's echo that is permanent: pendingAction never clears, Play and Pass
// stay dead for the rest of the round, and hostDeal()/sendMove() both bail while
// it is set. These two nets close that hole without adding steady traffic:
// nothing here fires in a healthy game.
const CATCH_UP_DEBOUNCE_MS = 5000;
const PENDING_STUCK_MS = 6000;
const IDLE_SYNC_MS = 20000;
let lastCatchUpAt = 0;
let pendingSince = 0;
let lastNetAt = 0;      // when anything last arrived on a state-bearing channel
function requestCatchUp() {
  if (!online || !gameStarted || netPaused) return;
  const now = Date.now();
  if (now - lastCatchUpAt < CATCH_UP_DEBOUNCE_MS) return;   // never storm the server
  lastCatchUpAt = now;
  try { if (window.Usion && Usion.game && Usion.game.requestSync) Usion.game.requestSync(syncResumePoint()); } catch (_) {}
}
(function netWatchdog() {
  setInterval(function () {
    // netPaused already freezes everything and the reconnect path resyncs for us.
    if (!online || !gameStarted || netPaused) { pendingSince = 0; return; }
    const now = Date.now();
    // 1. our own action's echo never came back
    if (!pendingAction) pendingSince = 0;
    else if (!pendingSince) pendingSince = now;
    else if (now - pendingSince >= PENDING_STUCK_MS) { pendingSince = now; requestCatchUp(); }
    // 2. nothing at all is arriving. If the round is live and we are waiting on
    // SOMEBODY ELSE, silence past a turn's worth of thinking means we may simply
    // have stopped hearing the table — a client that misses every message has
    // nothing to reject and so no other way to notice. An up-to-date client just
    // gets an empty tail back, so this costs one small request per idle window.
    // 3. open table upkeep: seat anyone waiting, and make sure a bot seat that is
    // on turn actually has somebody driving it (the elected client may have
    // changed since the turn began).
    reconcileOpenSeats();
    kickBotTurn();
    if (!dealActive || turn === mySeat) { lastNetAt = now; return; }
    if (!lastNetAt) { lastNetAt = now; return; }
    if (now - lastNetAt >= IDLE_SYNC_MS) { lastNetAt = now; requestCatchUp(); }
  }, 1000);
})();

// All game handlers in one place, registered exactly once. Kept separate from
// setupMultiplayer so a solo launch can register them the moment it is PROMOTED
// into a room (onRoomAssigned) — per the multiplayer contract, never gate
// handler registration behind the launch mode.
let netHandlersRegistered = false;
function registerNetHandlers() {
  if (netHandlersRegistered) return;
  netHandlersRegistered = true;
  Usion.game.onJoined(onJoined);
  Usion.game.onPlayerJoined(onPlayerJoined);
  Usion.game.onPlayerLeft(onPlayerLeft);
  Usion.game.onAction(onNetAction);
  Usion.game.onRealtime(onNetRealtime);
  Usion.game.onSync(onNetSync);
  // A rematch request is a pure broadcast (no server-side restart in platform
  // mode) — surface WHO wants one; the actual restart is the host's reset deal.
  if (Usion.game.onRematchRequest) Usion.game.onRematchRequest((d) => {
    if (dealActive || !gameStarted) return;   // only meaningful on the game-over screen
    const seat = (d && d.player_id) ? roomPlayerIds.indexOf(d.player_id) : -1;
    const nm = (d && d.player_id && playerMeta[d.player_id] && playerMeta[d.player_id].name) ||
               (seat >= 0 && players[seat] && players[seat].name) || t("playerN", seat + 1);
    const rs = document.getElementById("rematchStatus");
    if (rs) rs.textContent = t("rematchWants", nm);
  });
  // Real pause on a dropped link: freeze the turn clock (so we can't be
  // auto-passed while offline) and tell the player. onTurnTimeout/startTurnTimer
  // both honor netPaused, so the clock sits frozen until we're back.
  if (Usion.game.onDisconnect) Usion.game.onDisconnect(() => {
    netPaused = true;
    pausedAt = Date.now();
    turnTrusted = false;   // we're about to miss whatever happens next
    stopTurnTimer();
    if (dealActive) toast(t("disconnectedPaused"));
  });
  if (Usion.game.onReconnect) Usion.game.onReconnect(() => {
    resumeFromPause();
    beginResync("reconnect");   // persistent retry — the round-trip can be flaky right after reconnect
    if (dealActive) resumeTurnTimer();   // give back the disconnected time, don't reset the clock
  });
}

async function setupMultiplayer(roomId) {
  try {
    await Usion.game.connect();
    registerNetHandlers();
    await Usion.game.join(roomId);
  } catch (err) {
    console.error("Multiplayer failed:", err);
    online = false; onlineOverlay.classList.remove("show"); setupOverlay.classList.add("show");
  }
}

// Solo → host promotion (SDK ≥ 2.20): the user tapped the host's top-bar Share
// button mid-solo and invited someone. The SDK has ALREADY updated
// getLaunchParams().roomId and is connect()+join()ing us as playerIds[0] — our
// job is to drop the bots round, register the handlers, and open the waiting
// room; onJoined lands right after and the normal lobby flow takes over.
function onRoomPromoted() {
  if (online) return;   // already in a room — nothing to flip
  stopLocalRound();
  // The room we are being promoted INTO is brand new, so nothing we may have
  // learned about a previous room should stop us opening a table in it.
  sawRoomCheckpoint = false; lastRoomActivityAt = 0;
  online = true; gameStarted = false; dealActive = false;
  presentIds.clear(); presentIds.add(myId);
  players = []; hands = [];
  setupOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  const s = document.getElementById("onlineStatus");
  if (s) s.textContent = t("connecting");
  onlineOverlay.classList.add("show");
  registerNetHandlers();
}

// Tear down a local (vs-bots) round completely: every timer that could fire
// into the promoted online state.
function stopLocalRound() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (dealWaitTimer) { clearInterval(dealWaitTimer); dealWaitTimer = null; }
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  awaitingDeal = false;
  stopTurnTimer();
  selected.clear();
}
// The host's player_info doubles as the lobby-settings broadcast: it already
// fires on join, on every (re)join of a peer, and on each ready toggle, so the
// match length reaches late arrivals without a channel of its own.
function sendPlayerInfo() {
  const info = { name: myName || t("you"), avatar: myAvatar || null };
  if (isHostPlayer()) info.loseAt = loseAt;
  Usion.game.realtime("player_info", info);
}
// Point targets offered in the waiting room. The deal carries the chosen value,
// so this list only has to agree with itself — older clients still adopt
// whatever the host deals.
const LOSE_OPTIONS = [15, 20, 30];
function joinedPlayerId(data) {
  if (data && data.player_id != null) return data.player_id;
  if (data && data.player && data.player.id != null) return data.player.id;
  return null;
}

function reconcilePresence(ids, confirmedId) {
  if (Array.isArray(ids)) {
    presentIds.clear();
    ids.forEach(id => {
      // player_ids is the room roster and may still contain another player whose
      // custom leave grace is running. Only the player named by THIS join event is
      // confirmed back; keep every other pending leaver absent.
      if (!pendingLeaves.has(id) || id === confirmedId) presentIds.add(id);
    });
  }
  if (confirmedId != null) presentIds.add(confirmedId);
}

function onJoined(data) {
  // Seats are locked to the roster the match was DEALT with (only the ready
  // players get seated), so once the game is running the server roster — which
  // also lists spectators who never got a seat — must not renumber us. Mid-game
  // seating comes from the checkpoint/deal `order` alone.
  if (!gameStarted) roomPlayerIds = data.player_ids || [];
  // The join acknowledgement is the authoritative CURRENT room membership.
  // Replace (rather than append to) presence so a leave missed while this client
  // was offline cannot keep a departed authority alive locally.
  reconcilePresence(data.player_ids || [], myId);
  connectedCount = Number(data.connected_count || 0);
  // data.sequence is the SERVER'S high-water mark, not proof that this client has
  // applied those actions. lastSeq advances only while processing onAction/onSync.
  isHost = roomPlayerIds[0] === myId;
  sendPlayerInfo(); updateOnlineStatus();
  // The join ack may carry the host's checkpoint as game_state — rebuild the
  // live round straight away so a rejoin resumes instead of stalling on
  // "Dealing…". Guarded by !dealActive (don't disturb an in-progress round);
  // applying it marks the game started so maybeStart won't re-deal.
  if (data.game_state && data.game_state.seed !== undefined) noteRoomActivity();
  if (!dealActive && data.game_state && data.game_state.seed !== undefined) applyCheckpoint(data.game_state);
  Usion.game.requestSync(0);   // SDK replays the stored deal + moves via onSync
  maybeStart();
  reconcileOpenSeats();
}
function onPlayerJoined(data) {
  const joinedId = joinedPlayerId(data);
  if (!gameStarted) {   // seats are frozen once dealt — see onJoined
    if (data.player_ids) roomPlayerIds = data.player_ids;
    else if (joinedId != null && !roomPlayerIds.includes(joinedId)) roomPlayerIds.push(joinedId);
  }
  reconcilePresence(data.player_ids, joinedId);
  if (typeof data.connected_count === "number") connectedCount = data.connected_count;
  else if (data.player && data.player.is_connected) connectedCount = Math.min(roomPlayerIds.length, connectedCount + 1);
  isHost = roomPlayerIds[0] === myId;
  // Cancel only the ID explicitly named by this join event. `player_ids` is a
  // roster, not evidence that every listed player just reconnected.
  if (joinedId != null && pendingLeaves.has(joinedId)) {
    clearForfeitGrace(joinedId);
    if (pendingLeaves.size) renderForfeitGrace();
    else render();
  }
  sendPlayerInfo(); updateOnlineStatus(); maybeStart();
  // Open table: the newcomer drops straight into the round by taking over the
  // lowest-scoring bot seat (and its points). One elected client writes it.
  reconcileOpenSeats();
  // Someone (re)joined — push them the current state so they catch up even if
  // their own sync is failing. Slight delay so they've finished rejoining the
  // room (and registered their realtime handlers) before the broadcast lands.
  if (gameStarted && dealActive) setTimeout(broadcastStatePush, 600);
}
// ── Forfeit grace period ──────────────────────────────────
// Defer every departure for a grace window so a quick rejoin does not create a
// durable fold. If the player stays gone, settle their seat after the deadline.
let forfeitTimer = null;
// More than one player can disappear inside the same grace window. Track each
// departure independently instead of letting the latest one overwrite the first.
const pendingLeaves = new Map();   // player id → { seat, deadline }
const FORFEIT_GRACE_MS = 20000;

function clearForfeitGrace(playerId) {
  if (playerId != null) pendingLeaves.delete(playerId);
  else pendingLeaves.clear();
  if (!pendingLeaves.size && forfeitTimer) {
    clearInterval(forfeitTimer);
    forfeitTimer = null;
  }
}

function renderForfeitGrace() {
  if (!pendingLeaves.size || !turnLine) return;
  let nearest = FORFEIT_GRACE_MS;
  pendingLeaves.forEach(p => { nearest = Math.min(nearest, Math.max(0, p.deadline - Date.now())); });
  turnLine.textContent = t("leftGrace", Math.max(1, Math.ceil(nearest / 1000)));
  turnLine.className = "turn-line";
}

function applyLeaveFold(seat) {
  if (seat < 0 || !players[seat] || players[seat].out) return;
  players[seat].out = true;
  passed.delete(seat);
  lastAction[seat] = { kind: "pass", text: t("leftGame") };
  if (!dealActive) return;

  // A folded seat is removed, not counted as a pass. Counting it after marking it
  // out lowers activeSeats().length and can clear the trick before the next live
  // player gets a chance to respond.
  if (table && passStreak >= activeSeats().length - 1) {
    clearTrick(table.seat);
  } else if (turn === seat) {
    turn = nextActiveAfter(seat);
    beginTurn();
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

// NB: nothing writes leave_fold / forfeit_win any more — an open table releases a
// departed seat back to a bot (sendSeatRelease) instead of folding it out of the
// match. applyRemoteMove still ACCEPTS both, so a log written by an older client
// still replays, and the checks there still reject a forged one.

function startForfeitGrace(seat, playerId) {
  if (seat < 0 || playerId == null) return;
  pendingLeaves.set(playerId, { seat, deadline: Date.now() + FORFEIT_GRACE_MS });
  renderForfeitGrace();
  if (forfeitTimer) return;
  forfeitTimer = setInterval(() => {
    if (!gameStarted) {
      clearForfeitGrace();
      render();
      return;
    }

    const now = Date.now();
    const expired = [];
    pendingLeaves.forEach((pending, id) => {
      if (presentIds.has(id) || (players[pending.seat] && players[pending.seat].out)) {
        pendingLeaves.delete(id);
      } else if (now >= pending.deadline) {
        expired.push([id, pending.seat]);
      }
    });

    // Open table: a seat whose player really is gone goes back to a bot (keeping
    // its score) instead of folding out of the match, so the room keeps running.
    expired.forEach(([id, seat]) => {
      pendingLeaves.delete(id);
      sendSeatRelease(seat);
    });

    if (!pendingLeaves.size) {
      clearForfeitGrace();
      render();
    } else {
      renderForfeitGrace();
    }
  }, 1000);
}

function onPlayerLeft(data) {
  connectedCount = Math.max(0, connectedCount - 1);
  if (!gameStarted) {
    if (data && data.player_ids) roomPlayerIds = data.player_ids;   // roster only changes pre-game; seats are fixed once started
    if (data && data.player_id != null) presentIds.delete(data.player_id);
    isHost = roomPlayerIds[0] === myId;
    renderLobby();
    return;
  }
  // mid-game: the player who left forfeits (their seat stays fixed).
  // Drop them from presence FIRST and on EVERY client: presence drives who deals
  // the next round and who covers a stalled turn, so if the leaver was the host we
  // must stop waiting on them everywhere, not just on the host's own client.
  if (data && data.player_id != null) presentIds.delete(data.player_id);
  const seat = (data && data.player_id != null) ? roomPlayerIds.indexOf(data.player_id) : -1;
  if (seat < 0 || !players[seat] || players[seat].out) {
    // Nothing to fold (spectator, or an already-eliminated player — including the
    // eliminated HOST walking away). But if the table is waiting on a deal, the
    // client that owed it may be the one that just left: re-rank and cover it.
    retryNextDeal();
    render();
    return;
  }

  // ALWAYS run a grace window before folding — a brief drop (backgrounded app,
  // network blip) surfaces as onPlayerLeft too, and folding immediately writes a
  // DURABLE leave_fold that permanently eliminates the player even after they
  // rejoin. Don't mutate yet; a rejoin by this player cancels the fold and
  // resumes the hand exactly where it was. Only if they're still gone when the
  // window expires is the outcome recorded:
  //   activeAfter ≤ 1 → match-ending forfeit;  else → plain fold, play continues.
  // EVERY client runs the countdown (it's also the on-screen "left — 20s" line);
  // exactly one elected live client writes each expired outcome.
  startForfeitGrace(seat, data.player_id);
}
function updateOnlineStatus() {
  const s = document.getElementById("onlineStatus");
  if (!s || gameStarted || dealActive) return;
  s.textContent = t("openStatus");
}
// Is somebody's table already running in this room? A late arrival must NOT deal
// a rival match over the top of one — it waits to be seated instead. Stored
// actions and checkpoints are the evidence: a genuinely fresh room has neither.
let sawRoomCheckpoint = false;
let lastRoomActivityAt = 0;
function noteRoomActivity() { sawRoomCheckpoint = true; lastRoomActivityAt = Date.now(); }
function roomAlreadyRunning() { return lastSeq > 0 || sawRoomCheckpoint; }

// No waiting room: an open table deals as soon as someone is in it, against bots
// for every empty seat. Everyone who arrives later is seated mid-match by
// reconcileOpenSeats() instead of gathering here.
let openStartTimer = null;
let seatPollTimer = null;
function maybeStart() {
  if (gameStarted || dealActive) { stopSeatPoll(); return; }
  if (online) loseAt = OPEN_LOSE_AT;   // open tables run one fixed road-to-20 match
  enterLobby();
  if (!online) return;
  scheduleOpenStart();
  startSeatPoll();
}
// Open the table. Seat 0 stays the platform host, but if the host never deals
// (asleep, or gone before the first hand) the next present client covers,
// staggered by rank — the same election that keeps later rounds moving.
function scheduleOpenStart() {
  if (openStartTimer || !online) return;
  const seats = roomPlayerIds.filter(id => id != null && presentIds.has(id));
  const rank = seats.indexOf(myId);
  if (rank < 0) return;
  openStartTimer = setTimeout(function () {
    openStartTimer = null;
    if (!online || gameStarted || dealActive) return;
    // A table is already live here and simply has no seat for us yet — wait for
    // reconcileOpenSeats to hand us one rather than dealing a second, rival
    // match into the same room. Only a room that has ALSO gone completely quiet
    // counts as dead and worth reopening.
    if (roomAlreadyRunning() && Date.now() - lastRoomActivityAt < OPEN_REVIVE_MS) {
      scheduleOpenStart();
      return;
    }
    const order = buildOpenOrder();
    if (order.indexOf(myId) < 0) return;      // four other humans got here first
    roomPlayerIds = order;
    numPlayers = OPEN_SEATS;
    isHost = roomPlayerIds[0] === myId;
    loseAt = OPEN_LOSE_AT;
    firstDeal = true; lastWinner = -1;
    hostDeal();
  }, OPEN_START_MS + rank * DEAL_STAGGER_MS);
}
// A client with no seat yet (it joined a table whose four seats are all human,
// or its seat claim hasn't landed) keeps asking for state until a checkpoint
// arrives with it seated.
function startSeatPoll() {
  if (seatPollTimer || !online) return;
  seatPollTimer = setInterval(function () {
    if (!online || gameStarted) { stopSeatPoll(); return; }
    try { if (window.Usion && Usion.game && Usion.game.requestSync) Usion.game.requestSync(0); } catch (_) {}
  }, 1500);
}
function stopSeatPoll() { if (seatPollTimer) { clearInterval(seatPollTimer); seatPollTimer = null; } }
function enterLobby() {
  if (gameStarted || dealActive) return;
  presentIds.add(myId);
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
  if (spinner) spinner.style.display = "block";   // an open table is always about to deal
  list.innerHTML = "";
  ids.forEach((id, i) => {
    const meta = playerMeta[id] || {};
    const nm = meta.name || (id === myId ? (myName || t("you")) : t("playerN", i + 1));
    const avatar = meta.avatar || (id === myId ? myAvatar : null);
    const row = document.createElement("div");
    row.className = "lobby-row" + (id === myId ? " me" : "");
    row.appendChild(makeAvatarEl(nm, avatar, "lobby-avatar", false));
    const nameEl = document.createElement("span");
    nameEl.className = "lobby-name";
    nameEl.textContent = nm;
    if (id === hostId) {
      const tag = document.createElement("span");
      tag.className = "lobby-tag";
      tag.textContent = " " + t("hostTag");
      nameEl.appendChild(tag);
    }
    row.appendChild(nameEl);
    list.appendChild(row);
  });
  const statusEl = document.getElementById("onlineStatus");
  if (statusEl) statusEl.textContent = t("openStatus");
  // An open table never gates on READY and never needs a Start press.
  const readyBtn = document.getElementById("readyBtn");
  if (readyBtn) readyBtn.style.display = "none";
  const startBtn = document.getElementById("startGameBtn");
  if (startBtn) { startBtn.style.display = "none"; startBtn.disabled = true; }
  renderLobbyLimit();
  const hint = document.getElementById("lobbyHint");
  if (hint) hint.textContent = t("openTableTag");
}
// Show the match length to everyone; only the host can change it. Hidden until
// we're actually in a room (the overlay also covers the "connecting…" state).
function renderLobbyLimit() {
  const wrap = document.getElementById("lobbyLimit");
  if (!wrap) return;
  // isHostPlayer() reads the roster directly — the `isHost` flag is only assigned
  // once onJoined lands, which would render the host's own picker read-only for
  // the first moment of the lobby.
  // Open tables run one fixed target (OPEN_LOSE_AT), so this is a read-only
  // reminder of the match length rather than a picker.
  wrap.style.display = (online && roomPlayerIds.length > 0) ? "block" : "none";
  wrap.classList.add("readonly");
  document.querySelectorAll("#lobbyLoseRow .count-btn").forEach(btn => {
    btn.classList.toggle("selected", Number(btn.dataset.lose) === loseAt);
    btn.disabled = true;
  });
}
// Host only: lock the seats to the present + ready players and deal.
// Start a solo offline game vs 3 bots (you + Bot Anh/Bat/Cag = 4 seats).
function startBotsGame() {
  online = false; gameStarted = false; dealActive = false;
  presentIds.clear();
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  setupOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  const nm = (myName || t("you")).slice(0, 10);
  numPlayers = 4;                       // "play with bots" is always you + 3 bots
  loseAt = 20;                          // GameTok: 4-player road to 20 points
  players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ name: i === 0 ? nm : t("botNames")[i], avatar: i === 0 ? myAvatar : null,
                   color: PLAYER_COLORS[i], isBot: i !== 0, total: 0, out: false });
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
  // READY and START are gone with the waiting room — an open table deals on its
  // own and seats arrivals mid-match. The elements stay in the markup so the
  // overlay keeps its layout while we are still connecting.
  if (readyBtn) readyBtn.style.display = "none";
  if (startBtn) { startBtn.style.display = "none"; startBtn.disabled = true; }
  if (botsBtn) botsBtn.addEventListener("click", leaveForBots);
})();
function startOnlineGame(data) {
  if (gameStarted) return true;
  if (!data || !validSeatOrder(data.order) || data.order.indexOf(myId) < 0) {
    showNotSeated();
    return false;
  }
  clearForfeitGrace();
  stopSeatPoll();
  if (openStartTimer) { clearTimeout(openStartTimer); openStartTimer = null; }
  gameStarted = true; online = true;
  statsRecordedThisGame = false;   // new match → allow recording its outcome once
  resultReportedThisGame = false;
  roomPlayerIds = data.order;
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  isHost = roomPlayerIds[0] === myId;
  firstDeal = true; lastWinner = -1;
  // A `null` seat in the order is a bot the open table filled in. Bots are real
  // seats: they hold cards, take penalties, and can be eliminated — they are just
  // played by the engine instead of by a person.
  players = roomPlayerIds.map((id, i) => id == null ? makeBotSeat(i) : ({
    name: (playerMeta[id] && playerMeta[id].name) || (id === myId ? (myName || t("you")) : t("playerN", i + 1)),
    avatar: (playerMeta[id] && playerMeta[id].avatar) || (id === myId ? myAvatar : null),
    color: PLAYER_COLORS[i], isBot: false, total: 0, out: false
  }));
  meNameEl.textContent = players[mySeat].name;
  setupOverlay.classList.remove("show");
  const os = document.getElementById("onlineStatus");
  if (os) os.textContent = t("dealing");
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
  return true;
}
// names the host knows for the current roster — carried in stored deal/checkpoint
// so every client (and reconnects) gets real names, not "Player N", even if they
// missed the ephemeral player_info broadcast.
function nameMap() {
  const m = {};
  roomPlayerIds.forEach(id => {
    if (id == null) return;                       // bot seat — no identity to carry
    const nm = playerMeta[id] && playerMeta[id].name;
    if (nm) m[id] = nm;
  });
  return m;
}
function avatarMap() {
  const m = {};
  roomPlayerIds.forEach(id => {
    if (id == null) return;
    const avatar = normalizeAvatar(playerMeta[id] && playerMeta[id].avatar);
    if (avatar) m[id] = avatar;
  });
  return m;
}
function applyNames(map) {
  if (!map) return;
  for (const id in map) playerMeta[id] = Object.assign(playerMeta[id] || {}, { name: map[id] });
}
function applyAvatars(map) {
  if (!map) return;
  for (const id in map) {
    const avatar = normalizeAvatar(map[id]);
    if (avatar) playerMeta[id] = Object.assign(playerMeta[id] || {}, { avatar: avatar });
  }
}
// ── Open-table seating ───────────────────────────────────
// The room is a persistent 4-seat table. Bots hold every seat no human is in;
// a human who arrives takes over a bot seat WITH ITS SCORE, and a human who
// leaves hands their seat (and score) back to a bot. Seat changes travel as
// stored `move` actions so they sit in the same sequenced, replayable log as
// every play — a reconnecting client rebuilds the roster exactly as it evolved.
function botSeatName(seat) {
  const pool = t("openBotNames") || [];
  return pool[seat % pool.length] || ("Bot " + (seat + 1));
}
function makeBotSeat(i) {
  return { name: botSeatName(i), avatar: null, color: PLAYER_COLORS[i], isBot: true, total: 0, out: false };
}
// Seats a newcomer could drop into: still in the match, still held by a bot.
function openBotSeats() {
  return players.map((p, s) => s).filter(s => players[s] && players[s].isBot && !players[s].out);
}
// WHICH bot a joining human replaces: the one carrying the FEWEST penalty points
// (the best-placed bot), lowest seat index breaking a tie. Computed from
// replayable state alone, so every client — live or replaying — picks the same
// seat and the log stays deterministic.
function takeoverSeat() {
  const seats = openBotSeats();
  if (!seats.length) return -1;
  let best = seats[0];
  seats.forEach(s => { if (players[s].total < players[best].total) best = s; });
  return best;
}
// Humans in the room with no seat yet, in a stable order.
function unseatedPresent() {
  const out = [];
  presentIds.forEach(id => { if (id != null && roomPlayerIds.indexOf(id) < 0) out.push(id); });
  return out.sort();
}
// Hand seat `seat` to a human. The seat's total/out/hand are untouched — that is
// the whole point: the newcomer inherits the bot's standing and its cards.
function seatHuman(seat, id) {
  if (!players[seat]) return;
  const meta = playerMeta[id] || {};
  roomPlayerIds[seat] = id;
  players[seat].isBot = false;
  players[seat].name = meta.name || (id === myId ? (myName || t("you")) : t("playerN", seat + 1));
  players[seat].avatar = normalizeAvatar(meta.avatar) || (id === myId ? myAvatar : null);
  presentIds.add(id);
  clearForfeitGrace(id);
  if (botTimer && turn === seat) { clearTimeout(botTimer); botTimer = null; }
  if (id === myId) {
    mySeat = seat;
    meNameEl.textContent = players[seat].name;
    onlineOverlay.classList.remove("show");
  }
  // The new owner gets a full clock rather than whatever the bot had left.
  if (dealActive && turn === seat) startTurnTimer();
  render();
}
// Hand a seat back to a bot, score and cards intact, so the table stays full.
function seatBot(seat) {
  if (!players[seat]) return;
  const id = roomPlayerIds[seat];
  roomPlayerIds[seat] = null;
  players[seat].isBot = true;
  players[seat].name = botSeatName(seat);
  players[seat].avatar = null;
  if (id != null) { presentIds.delete(id); clearForfeitGrace(id); }
  render();
  if (dealActive && turn === seat) scheduleBotMove(seat);
}
// Apply a seat change out of the action log. Every rule here reads replayable
// state (who holds the seat, the seats' totals), so a live client and a client
// replaying the same log reach the same verdict — the property that keeps the
// table from splitting in two.
function applySeatMove(move, fromId) {
  if (!gameStarted || !Array.isArray(players) || !players.length) return false;
  const seat = Number(move.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat >= numPlayers || !players[seat]) return false;
  if (move.kind === "seat_take") {
    const id = move.playerId;
    if (id == null || roomPlayerIds.indexOf(id) >= 0) return false;   // nobody sits twice
    // On a checkpoint replay the roster is already the post-change one, so the
    // "is this a bot seat" test would fail on a change we have in fact applied.
    if (!replayTrusted) {
      if (!players[seat].isBot || players[seat].out) return false;
      if (seat !== takeoverSeat()) return false;                       // must be THE lowest-scoring bot
      if (fromId != null && roomPlayerIds.indexOf(fromId) < 0 && fromId !== id) return false;
    } else if (!players[seat].isBot) return false;
    if (move.name) playerMeta[id] = Object.assign(playerMeta[id] || {}, { name: String(move.name).slice(0, 10) });
    if (move.avatar) {
      const av = normalizeAvatar(move.avatar);
      if (av) playerMeta[id] = Object.assign(playerMeta[id] || {}, { avatar: av });
    }
    seatHuman(seat, id);   // total / out / cards stay exactly as the bot left them
    // Our claim landed, so the rate limit has done its job — clear it and let the
    // next person in the queue be seated on the following tick instead of after
    // another full SEAT_RETRY_MS.
    if (fromId === myId) lastSeatClaimAt = 0;
    if (!replayingSync && id !== myId) toast(t("openJoined", players[seat].name));
    moveLog.push(move);
    if (!replayingSync && fromId === myId) writeCheckpoint();
    return true;
  }
  if (move.kind === "seat_release") {
    const id = roomPlayerIds[seat];
    if (id == null || players[seat].isBot) return false;               // already a bot
    if (id === myId) return false;                                     // we are right here
    if (!replayTrusted && presentIds.has(id)) return false;            // a present player is not gone
    if (!replayTrusted && (fromId == null || roomPlayerIds.indexOf(fromId) < 0)) return false;
    const gone = players[seat].name;
    seatBot(seat);                      // score stays on the seat; the bot inherits it
    if (!replayingSync) toast(t("openLeftBot", gone));
    moveLog.push(move);
    if (!replayingSync && fromId === myId) writeCheckpoint();
    return true;
  }
  return false;
}
// Claim a seat for the next unseated human. The lowest present seat writes it,
// but — exactly like scheduleNextDeal — every other seated client covers on a
// stagger, because a locked phone never leaves presentIds and a single elected
// writer asleep would lock newcomers out of the room forever. Duplicate claims
// are harmless: the second one finds the seat already human and is rejected by
// every client identically.
let lastSeatClaimAt = 0;
const seatWaitSince = new Map();   // unseated player id → when we first saw them waiting
function reconcileOpenSeats() {
  if (!online || !gameStarted || pendingAction) return;
  const waiting = unseatedPresent();
  seatWaitSince.forEach((_, id) => { if (waiting.indexOf(id) < 0) seatWaitSince.delete(id); });
  if (!waiting.length) return;
  const id = waiting[0];
  if (!seatWaitSince.has(id)) seatWaitSince.set(id, Date.now());
  const rank = authorityRank();
  if (rank < 0) return;                                                   // we hold no seat ourselves
  const now = Date.now();
  if (now - seatWaitSince.get(id) < rank * SEAT_STAGGER_MS) return;       // higher ranks go first
  if (now - lastSeatClaimAt < SEAT_RETRY_MS) return;                      // never storm the relay
  const seat = takeoverSeat();
  if (seat < 0) return;             // no bot to displace — they watch until a seat frees up
  const meta = playerMeta[id] || {};
  lastSeatClaimAt = now;
  try {
    Usion.game.action("move", { kind: "seat_take", seat: seat, playerId: id,
                                name: meta.name || null, avatar: meta.avatar || null })
      .catch(function () { lastSeatClaimAt = 0; });
  } catch (_) { lastSeatClaimAt = 0; }
}
// A departed seat goes back to a bot instead of folding out of the match: an
// open table must survive its players leaving.
function sendSeatRelease(seat) {
  if (!online || seat < 0 || !Array.isArray(roomPlayerIds)) return;
  const id = roomPlayerIds[seat];
  if (id == null || presentIds.has(id)) return;
  if (authorityRank() !== 0) return;          // exactly one elected writer
  try {
    Usion.game.action("move", { kind: "seat_release", seat: seat })
      .catch(function () { toast(t("leaveFail")); Usion.game.requestSync(lastSeq); });
  } catch (_) {}
}
// The 4-seat order this client would open the table with: present humans in
// roster order (so playerIds[0] keeps seat 0), bots — `null` — for the rest.
function buildOpenOrder() {
  const order = new Array(OPEN_SEATS).fill(null);
  let n = 0;
  roomPlayerIds.forEach(id => {
    if (id != null && presentIds.has(id) && n < OPEN_SEATS && order.indexOf(id) < 0) order[n++] = id;
  });
  presentIds.forEach(id => { if (n < OPEN_SEATS && order.indexOf(id) < 0) order[n++] = id; });
  return order;
}

// Deal a round. Callers decide WHO may call it: the opening deal comes from the
// staggered open-table election, later rounds go through scheduleNextDeal.
function hostDeal(reset) {
  if (pendingAction) return;
  curSeed = randomSeed();
  // carry the starter context so every client picks the SAME leader: firstDeal →
  // lowest-card holder leads; otherwise the previous round's winner leads. Without
  // this, a client with stale firstDeal/lastWinner computes a different starter.
  // reset:true = a REMATCH deal — every client zeroes its match state (totals,
  // eliminations) in onDeal before dealing, so the whole table restarts as one.
  const d = { seed: curSeed, order: roomPlayerIds, names: nameMap(), avatars: avatarMap(),
              firstDeal: reset ? true : firstDeal, lastWinner: reset ? -1 : lastWinner,
              loseAt: loseAt };   // host owns the elimination threshold → every client adopts it
  if (reset) d.reset = true;
  pendingAction = true;
  renderLobby();
  Usion.game.action("deal", d)
    .then(res => {
      if (res && res.success === false) {
        pendingAction = false;
        toast(t("dealFail"));
        renderLobby();
      }
    })
    .catch(() => {
      pendingAction = false;
      toast(t("dealFail"));
      renderLobby();
    });
}
// `seat` defaults to our own. `proxy` means we're covering a stalled player: the
// move belongs to THEIR seat, so it must not latch our own "sending…" state, and
// receivers must credit it to `move.seat` rather than to us, the sender.
function sendMove(move, seat, proxy) {
  if (pendingAction) return;
  move.seat = (seat === undefined) ? mySeat : seat;
  move.ti = roundMoveNo;          // the move index this was built for → duplicate covers collapse
  // A bot seat's move is already marked `bot` and validated against the engine's
  // own choice; only a cover for a HUMAN seat is an `auto` forced move.
  if (proxy && move.bot !== true) move.auto = true;
  if (!proxy) { pendingAction = true; renderControls(); }
  Usion.game.action("move", move)
    .then(res => {
      if (res && res.success === false) {
        pendingAction = false;
        if (!proxy) toast(t("moveFail"));
        render();
      }
    })
    .catch(() => {
      pendingAction = false;
      if (!proxy) toast(t("moveFail"));
      render();
    });
}
function proxyAuthorityId(targetSeat) {
  for (let s = 0; s < roomPlayerIds.length; s++) {
    if (s !== targetSeat && presentIds.has(roomPlayerIds[s])) return roomPlayerIds[s];
  }
  return null;
}

function decodeMoveCards(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5) return null;
  const decoded = [];
  for (const raw of values) {
    const value = Number(raw);
    if (!Number.isInteger(value)) return null;
    const card = wireCard(value);
    if (card.r < 3 || card.r > 15 || card.s < 0 || card.s > 3 || cardWire(card) !== value) return null;
    decoded.push(card);
  }
  return decoded;
}

function handOwnsCards(seat, cards) {
  const remaining = (hands[seat] || []).slice();
  for (const card of cards) {
    const index = remaining.findIndex(c => sameCard(c, card));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

// Validate an incoming action against the same deterministic state on every
// client. The relay sequences and stores actions; it does not know this game's
// hand/turn rules, so accepting first and "snapping" the turn to the sender lets
// a client play out of turn, fabricate cards, or force another seat to pass.
function applyRemoteMove(move, fromId) {
  // Our own move just landed — via the live echo (onNetAction) OR recovered through
  // a resync/checkpoint replay after a dropped echo. Clear the "sending…" latch on
  // EVERY path, not just the live one, or a resync-recovered own move leaves us
  // stuck on "Sending…" (dead buttons) — and if we're the host, a stuck pendingAction
  // silently blocks hostDeal(), freezing the WHOLE table on the next round transition.
  if (fromId != null && fromId === myId) { pendingAction = false; renderControls(); }
  if (!move || typeof move !== "object") return false;
  if (move.kind === "leave_fold" || move.kind === "forfeit_win") {
    const leaveSeat = Number(move.seat);
    if (!Number.isInteger(leaveSeat) || leaveSeat < 0 || leaveSeat >= numPlayers ||
        !players[leaveSeat] || players[leaveSeat].out) return false;
    if (!replayTrusted) {
      const targetId = roomPlayerIds[leaveSeat];
      // A connected player cannot be folded, and only the elected authority may
      // durably settle a departed seat. Enforced when replaying the raw action
      // log too, so a forged fold sitting in the log cannot eliminate a player on
      // whoever resyncs next.
      if (presentIds.has(targetId) || fromId !== proxyAuthorityId(leaveSeat)) return false;
    }
    const endMatch = activeSeats().filter(s => s !== leaveSeat).length <= 1;
    applyLeaveOutcome(leaveSeat, endMatch);
    moveLog.push(move);
    if (!replayingSync && fromId === myId) writeCheckpoint();   // the sender persists the outcome
    return true;
  }
  // Seat changes are legal BETWEEN rounds as well as during one — an open table
  // reseats the moment somebody arrives or leaves, mid-hand included.
  if (move.kind === "seat_take" || move.kind === "seat_release") return applySeatMove(move, fromId);
  if (!dealActive) return false;
  // Duplicate/stale guard. Two clients can legitimately cover the SAME stalled
  // seat (staggered proxies) and both actions reach the server; `ti` is the move
  // index each was built for, so the loser is dropped instead of being applied on
  // top and desynchronising the round.
  if (move.ti !== undefined &&
      (!Number.isInteger(Number(move.ti)) || Number(move.ti) !== roundMoveNo)) return false;

  const senderSeat = (fromId != null) ? roomPlayerIds.indexOf(fromId) : -1;
  const claimed = Number(move.seat);
  let seat = Number.isInteger(claimed) && claimed >= 0 && claimed < numPlayers ? claimed : -1;
  if (seat < 0) seat = senderSeat >= 0 ? senderSeat : turn;

  if (!replayTrusted) {
    if (senderSeat < 0) return false;
    if (move.bot === true) {
      // Any SEATED client may drive a bot seat. Deliberately not gated on
      // presence: presence cannot be reconstructed on replay, and a rule judged
      // differently live and on replay is precisely what splits a table in two.
      // The content check further down is the real guard — the sender does not
      // get to choose the cards, the engine does.
      if (seat === senderSeat) return false;
    } else if (move.auto === true) {
      if (seat === senderSeat || fromId !== proxyAuthorityId(seat)) return false;
    } else if (seat !== senderSeat) {
      return false;
    }
  } else if (move.auto !== true && move.bot !== true && senderSeat >= 0 && seat !== senderSeat) {
    return false;
  }

  if (!players[seat] || players[seat].out) return false;   // unknown/folded/eliminated seat can't act
  if (seat !== turn) return false;

  // A cover is a FORCED move, never a free one. Every client can derive it from
  // state alone (same deal seed → same hands), so it must be exactly what the
  // engine would have played for that seat: a pass when following, the engine's
  // own minimal lead when leading. Without this an `auto` move was just a normal
  // move wearing somebody else's seat, and the sender got to choose which cards
  // came out of the victim's hand.
  //
  // Checked HERE, outside the !replayingSync block, on purpose: the sender-side
  // checks above cannot run during replay (presence is not reconstructable), so
  // a forged cover that every live client rejected was still applied by anyone
  // who later resynced — a split table. This rule reads only replayable state,
  // so live and replay always reach the same verdict. `fromId` is absent for
  // moves replayed out of a checkpoint, so only validate the sender when we have
  // one.
  // A bot seat's move must be EXACTLY what the engine would play for that hand,
  // recomputed here from state every client already shares. Same principle as a
  // proxy cover, except the engine gets its full choice instead of a forced
  // minimal one — so relaying a bot can never smuggle in a chosen discard.
  if (move.bot === true) {
    if (!replayTrusted && (!players[seat] || !players[seat].isBot)) return false;
    if (fromId != null && (roomPlayerIds.indexOf(fromId) < 0 || fromId === roomPlayerIds[seat])) return false;
    const want = botDecision(seat);
    if (!want || want.kind !== move.kind) return false;
    if (want.kind === "play") {
      const wantCards = want.combo.cards.map(cardWire).sort((a, b) => a - b).join(",");
      const gotCards = Array.isArray(move.cards) ? move.cards.map(Number).sort((a, b) => a - b).join(",") : "";
      if (!wantCards || wantCards !== gotCards) return false;
    }
  }
  if (move.auto === true) {
    if (fromId != null && (roomPlayerIds.indexOf(fromId) < 0 || fromId === roomPlayerIds[seat])) return false;
    if (table) {
      if (move.kind !== "pass") return false;
    } else {
      const forced = botLead(hands[seat], firstPlay);
      const want = forced ? forced.cards.map(cardWire).sort((a, b) => a - b).join(",") : "";
      const got = Array.isArray(move.cards) ? move.cards.map(Number).sort((a, b) => a - b).join(",") : "";
      if (move.kind !== "play" || !want || want !== got) return false;
    }
  }

  let combo = null;
  if (move.kind === "pass") {
    if (!table) return false;                 // a lead can never pass
  } else if (move.kind === "play") {
    const cards = decodeMoveCards(move.cards);
    if (!cards || !handOwnsCards(seat, cards)) return false;
    combo = classify(cards);
    if (!isLegalPlay(combo)) return false;
  } else {
    return false;
  }

  roundMoveNo += 1;
  if (move.kind === "pass") doPass(seat);
  else doPlay(seat, combo);
  // Record it BEFORE checkpointing — the checkpoint carries moveLog, so appending
  // after the write would persist a snapshot that is missing the very move that
  // triggered it, and a client rebuilding from it would replay one move short.
  moveLog.push(move);
  // The ACTOR (the player who just moved) persists the fresh state — not the
  // host — so a move made while the host is backgrounded is never lost.
  if (!replayingSync && fromId === myId) writeCheckpoint();
  return true;
}
function onNetAction(data) {
  const sequence = Number(data.sequence);
  lastNetAt = Date.now();       // the table is still audible — see netWatchdog
  noteRoomActivity();           // and it proves a match is already running here
  if (Number.isFinite(sequence)) lastSeq = Math.max(lastSeq, sequence);
  // Clear our "sending…" state the moment we SEE our own action echoed — BEFORE
  // the dedup return. If a resync already applied this seq, the echo is a dup and
  // we'd skip out below; without clearing here first, pendingAction sticks true
  // forever and we can never move again ("Sending…" with the Play button dead).
  if (data.player_id === myId) pendingAction = false;
  if (Number.isFinite(sequence) && alreadyApplied(sequence)) { renderControls(); return; }
  const d = data.action_data || {};
  let applied = true;
  if (data.action_type === "deal") applied = onDeal(d, data.player_id) === true;
  // applyRemoteMove owns moveLog: it appends ONLY moves it actually applied, so a
  // move's index always equals its `ti` and checkpoint replay is bit-identical to
  // the live round.
  else if (data.action_type === "move") applied = applyRemoteMove(d, data.player_id) === true;
  // Record ONLY what actually landed. Marking a rejected action as applied
  // punches a permanent hole in the record: syncResumePoint() would step over it
  // and a later replay would skip the very action we still need.
  if (Number.isFinite(sequence) && applied) appliedSequences.add(sequence);
  // An action we could not apply usually means WE are the stale one — we missed
  // the move it builds on, so it lands out of turn / on the wrong `ti`. (The
  // benign causes — a losing deal race, a duplicate proxy cover, a forgery — are
  // rare, and requestCatchUp is debounced and idempotent.) This is the only thing
  // that notices a foreground client drifting behind on a healthy socket.
  if (!applied) requestCatchUp();
}
function onNetRealtime(data) {
  if (data.player_id === myId) return;
  const d = data.action_data || {};
  if (data.action_type === "player_info") {
    const previous = playerMeta[data.player_id] || {};
    playerMeta[data.player_id] = {
      name: (typeof d.name === "string" && d.name) ? d.name : previous.name,
      avatar: normalizeAvatar(d.avatar)
    };
    presentIds.add(data.player_id);

    // Adopt the match length only from the host, and only from the offered set —
    // it's the host's setting, and the deal will carry it authoritatively anyway.
    if (!gameStarted && data.player_id === roomPlayerIds[0] &&
        LOSE_OPTIONS.indexOf(Number(d.loseAt)) >= 0) loseAt = Number(d.loseAt);
    if (gameStarted) { refreshNames(); render(); } else renderLobby();
  } else if (data.action_type === "state_push") {
    // Only the elected current authority may push a recovery snapshot. Without
    // this check any peer can roll the table back with a forged/stale state.
    if (data.player_id !== proxyAuthorityId(-1)) return;
    applyStateSnapshot(d);
  } else if (data.action_type === "reaction") {
    // Cosmetic quick-chat: pop the sender's bubble over their seat.
    const seat = roomPlayerIds.indexOf(data.player_id);
    const value = normalizeReaction(d.kind, d.value);
    if (seat >= 0 && value) showReaction(seat, d.kind, value);
  }
}
// Catch-up replay (from requestSync). Each "deal" resets state, so replaying
// the whole log from sequence 0 deterministically rebuilds the current round.
function onNetSync(data) {
  lastNetAt = Date.now();
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const checkpoint = data.game_state;
  const hasCheckpoint = !!(checkpoint && checkpoint.seed !== undefined);
  // A checkpoint is also worth taking when it holds more UNBROKEN history than we
  // do, even if we have seen higher sequence numbers we could not use — that is
  // precisely the client with a hole in the middle, which no action tail can heal
  // once the log has been compacted past the gap.
  const cpSeq = Number(checkpoint && checkpoint.seq);
  const shouldApplyCheckpoint = hasCheckpoint &&
    (!gameStarted || snapshotIsNewer(checkpoint) || (Number.isFinite(cpSeq) && cpSeq > syncResumePoint()));
  const hasUnappliedActions = actions.some(a => a.sequence === undefined || !alreadyApplied(a.sequence));
  if (hasCheckpoint || actions.length) noteRoomActivity();   // somebody's table is live in this room

  // A join acknowledgement reports the server's top sequence before this client
  // has applied it. Therefore data.sequence/lastSeq equality cannot prove that the
  // checkpoint tail is already local; inspect the actual checkpoint and actions.
  if (!shouldApplyCheckpoint && !hasUnappliedActions) return;
  if (shouldApplyCheckpoint) applyCheckpoint(checkpoint);

  replayingSync = true;
  try {
    actions.forEach(a => {
      const sequence = Number(a.sequence);
      if (Number.isFinite(sequence) && alreadyApplied(sequence)) return;
      const d = a.action_data || {};
      let ok = true;
      if (a.action_type === "deal") ok = onDeal(d, a.player_id) === true;
      else if (a.action_type === "move") ok = applyRemoteMove(d, a.player_id) === true;
      // Advance only after this action has actually been considered locally, and
      // remember it as applied only if it really was — see onNetAction. Invalid
      // game actions still consume a server sequence and are safely ignored by
      // applyRemoteMove's deterministic validation.
      if (Number.isFinite(sequence)) {
        if (ok) appliedSequences.add(sequence);
        lastSeq = Math.max(lastSeq, sequence);
      }
    });
  } finally {
    replayingSync = false;
  }
  kickBotTurn();   // the tail may have left a bot seat on turn with nobody driving it
}
function onDeal(d, fromId) {
  // The deal we sent has landed (live echo, or recovered via resync/replay after a
  // dropped echo). Release the "sending…" latch on EVERY path: hostDeal() and
  // sendMove() both bail while it's set, so a latch stuck by a dropped deal echo
  // locked us out of playing for the whole round AND blocked the next deal.
  if (fromId != null && fromId === myId) pendingAction = false;
  if (!d || typeof d !== "object" || !validSeatOrder(d.order)) return false;
  // A deal is legal only between rounds. This also collapses two authorities that
  // raced before seeing each other's echo: the first stored deal wins and the
  // second cannot redeal everybody in the middle of the fresh hand.
  if (dealActive) return false;
  if (gameStarted) {
    // ANY SEATED PLAYER may deal the next round — that is exactly the staggered
    // election scheduleNextDeal() runs, so the acceptance here has to match it.
    // This used to demand proxyAuthorityId(-1) (the lowest seat still in
    // presentIds), which froze the whole table whenever that player's phone was
    // asleep: a locked phone never leaves presentIds, so every fallback deal was
    // rejected and no round was ever dealt. Worse, the rejected deals stayed in
    // the stored log and replay skipped this check, so the sleeper later woke
    // into a round of its own while everybody else was still on the old results
    // screen — a split table that never recovered.
    //
    // Deliberately NOT gated on presentIds or on replayingSync: seat order is
    // frozen for the match, so every client and every replay reaches the same
    // verdict, and a stored deal can never be applied by some clients and
    // dropped by others. Receiving the action is itself proof the sender is in
    // the room, and `if (dealActive) return false` above still collapses a deal
    // race to the first stored deal.
    if (fromId == null || !Array.isArray(roomPlayerIds) || roomPlayerIds.indexOf(fromId) < 0) return false;
  } else if (!replayingSync) {
    // Opening an OPEN table: the platform host normally deals it, but if they
    // never do (asleep, or already gone) the next present client covers — the
    // same staggered election that keeps later rounds moving. Accept a pre-game
    // deal from anyone the order seats, as long as it still puts the host at
    // seat 0 while the host is actually here.
    if (fromId == null || !Array.isArray(d.order) || d.order.indexOf(fromId) < 0) return false;
    const head = roomPlayerIds[0];
    if (head != null && presentIds.has(head) && d.order[0] !== head) return false;
  }
  // Not seated in this match (e.g. wasn't ready when the host started) → stay in
  // the room instead of crashing on a -1 seat.
  if (!gameStarted && Array.isArray(d.order) && d.order.indexOf(myId) < 0) { showNotSeated(); return; }
  applyNames(d.names);                 // adopt host-supplied identities before seating
  applyAvatars(d.avatars);
  if (!gameStarted && !startOnlineGame({ order: d.order })) return;
  if (gameStarted && !sameSeatOrder(d.order, roomPlayerIds)) return;
  else refreshNames();                 // later rounds: update any "Player N" already shown
  // Rematch: the host's reset deal zeroes the whole match before dealing, so
  // every client restarts on the same baseline (replay-safe: a reset deal in
  // the action log re-zeroes deterministically).
  if (d.reset) {
    players.forEach(p => { p.total = 0; p.out = false; });
    statsRecordedThisGame = false;
    resultReportedThisGame = false;
  }
  document.getElementById("winnerOverlay").classList.remove("show");
  const rs = document.getElementById("rematchStatus");
  if (rs) rs.textContent = "";
  // authoritative starter context from the host → identical leader on every client
  if (typeof d.firstDeal === "boolean") firstDeal = d.firstDeal;
  if (typeof d.lastWinner === "number") lastWinner = d.lastWinner;
  if (typeof d.loseAt === "number") loseAt = d.loseAt;   // adopt host's elimination threshold
  curSeed = d.seed; moveLog = [];
  handOverlay.classList.remove("show");
  numPlayers = d.order.length;
  startDeal(d.seed);
  // Whoever DEALT snapshots the fresh round — not "the host", since any client can
  // now deal when the higher-ranked ones are asleep.
  if (!replayingSync && fromId != null && fromId === myId) writeCheckpoint();
  return true;
}
function refreshNames() {
  roomPlayerIds.forEach((id, i) => {
    if (id == null || !players[i] || players[i].isBot || !playerMeta[id]) return;   // bots keep their own name
    if (playerMeta[id].name) players[i].name = playerMeta[id].name;
    players[i].avatar = normalizeAvatar(playerMeta[id].avatar);
  });
  renderMyPlayer();
}
