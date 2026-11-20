// One 13 match, server side: the authoritative state. Pure — no sockets, no
// timers. The room layer (rooms.mjs) drives it and decides when bots and the
// clock act; this file only knows the rules.
//
// Mirrors the client engine in script.js (startDeal / doPlay / doPass /
// clearTrick / endHand / applyLeaveFold) so a table plays exactly the same,
// with one difference that is the point of having a server: the deck is
// shuffled with crypto randomness here and each player only ever sees their
// own hand. A seeded shuffle (dealHands) would let anyone recover the seed from
// their 13 cards and read every hand at the table.
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';

const R = createRequire(import.meta.url)('../rules.js');
const { buildDeck, sortCards, sameCard, cardStrength, lowestCard, classify, canBeat,
  botLead, botFollow, deduction, wireCard, cardWire } = R;

export function cryptoShuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

/**
 * seats: [{ id, name, avatar, isBot }]  (2–4, seat order)
 * opts:  { loseAt = 30, shuffle = cryptoShuffle }
 */
export function createMatch(seats, { loseAt = 30, shuffle = cryptoShuffle } = {}) {
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 4) throw new Error('2–4 seats');
  const m = {
    loseAt,
    players: seats.map(s => ({ id: s.id ?? null, name: s.name || '', avatar: s.avatar || '', isBot: !!s.isBot, total: 0, out: false })),
    hands: seats.map(() => []),
    table: null,            // { combo, seat }
    trickPlays: [],         // [{ seat, cards }] this trick, for the table history
    lastAction: {},         // seat → { kind: 'play'|'pass'|'win'|'left', cards? }
    turn: 0,
    passStreak: 0,
    phase: 'idle',          // idle → playing → hand (results) → playing … → over
    firstDeal: true,
    lastWinner: -1,
    handNo: 0,
    moveNo: 0,              // moves this hand; a client echoes it so a stale tap is refused
    lastHand: null,         // { winner, deltas, newlyOut, dragon } of the hand just finished
    winner: -1,             // the champion seat once phase === 'over'
  };

  const n = () => m.players.length;
  const activeSeats = () => m.players.map((p, s) => s).filter(s => !m.players[s].out);
  const nextActiveAfter = (seat) => {
    for (let i = 1; i <= n(); i++) { const s = (seat + i) % n(); if (!m.players[s].out) return s; }
    return seat;
  };

  function deal() {
    if (m.phase === 'over') return false;
    const active = activeSeats();
    const deck = shuffle(buildDeck());
    m.hands = m.players.map(() => []);
    active.forEach((s, i) => { m.hands[s] = sortCards(deck.slice(i * 13, i * 13 + 13)); });
    m.table = null; m.trickPlays = []; m.lastAction = {}; m.passStreak = 0; m.moveNo = 0; m.lastHand = null;
    m.handNo += 1;
    let starter;
    if (m.firstDeal) {
      starter = active[0];
      active.forEach(s => { if (cardStrength(lowestCard(m.hands[s])) < cardStrength(lowestCard(m.hands[starter]))) starter = s; });
    } else {
      starter = (m.lastWinner >= 0 && !m.players[m.lastWinner].out) ? m.lastWinner : active[0];
    }
    m.firstDeal = false;
    m.turn = starter;
    m.phase = 'playing';
    // Dragon: all 13 ranks in one hand wins outright.
    const dragon = active.find(s => new Set(m.hands[s].map(c => c.r)).size === 13);
    if (dragon !== undefined) endHand(dragon, true);
    return true;
  }

  function endHand(winner, dragon) {
    m.lastWinner = winner;
    const deltas = Array(n()).fill(0);
    for (let s = 0; s < n(); s++) {
      if (m.players[s].out || s === winner) continue;
      const left = m.hands[s].length;
      deltas[s] = dragon ? 3 * left : deduction(left);
      m.players[s].total += deltas[s];
    }
    const newlyOut = [];
    for (let s = 0; s < n(); s++) {
      if (!m.players[s].out && m.players[s].total >= m.loseAt) { m.players[s].out = true; newlyOut.push(s); }
    }
    m.lastHand = { winner, deltas, newlyOut, dragon: !!dragon };
    m.lastAction[winner] = { kind: 'win' };
    finishOrPause();
  }

  function finishOrPause() {
    const live = activeSeats();
    if (live.length <= 1) { m.phase = 'over'; m.winner = live.length ? live[0] : (m.lastHand ? m.lastHand.winner : -1); }
    else m.phase = 'hand';
  }

  function clearTrick(winnerSeat) {
    m.table = null; m.trickPlays = []; m.passStreak = 0;
    for (const k in m.lastAction) if (m.lastAction[k] && m.lastAction[k].kind !== 'win' && m.lastAction[k].kind !== 'left') delete m.lastAction[k];
    m.turn = m.players[winnerSeat].out ? nextActiveAfter(winnerSeat) : winnerSeat;
  }

  /** The seat on turn plays these cards (wire numbers). → { ok } | { error } */
  function play(seat, wire) {
    if (m.phase !== 'playing') return { error: 'not_playing' };
    if (seat !== m.turn) return { error: 'not_your_turn' };
    if (!Array.isArray(wire) || wire.length < 1 || wire.length > 5) return { error: 'bad_cards' };
    if (new Set(wire).size !== wire.length) return { error: 'bad_cards' };
    const hand = m.hands[seat];
    const cards = [];
    for (const v of wire) {
      if (!Number.isInteger(v)) return { error: 'bad_cards' };
      const c = hand.find(h => cardWire(h) === v);
      if (!c) return { error: 'not_in_hand' };
      cards.push(c);
    }
    const combo = classify(cards);
    if (!combo) return { error: 'not_a_combo' };
    if (!canBeat(combo, m.table ? m.table.combo : null)) return { error: 'too_low' };
    combo.cards.forEach(pc => { const i = hand.findIndex(c => sameCard(c, pc)); if (i >= 0) hand.splice(i, 1); });
    m.table = { combo, seat };
    m.trickPlays.push({ seat, cards: combo.cards.map(cardWire) });
    m.passStreak = 0;
    m.moveNo += 1;
    m.lastAction[seat] = { kind: 'play', cards: combo.cards.map(cardWire) };
    if (!hand.length) { endHand(seat, false); return { ok: true, handOver: true }; }
    m.turn = nextActiveAfter(seat);
    return { ok: true };
  }

  function pass(seat) {
    if (m.phase !== 'playing') return { error: 'not_playing' };
    if (seat !== m.turn) return { error: 'not_your_turn' };
    if (!m.table) return { error: 'must_lead' };
    m.passStreak += 1;
    m.moveNo += 1;
    m.lastAction[seat] = { kind: 'pass' };
    if (m.passStreak >= activeSeats().length - 1) clearTrick(m.table.seat);
    else m.turn = nextActiveAfter(seat);
    return { ok: true };
  }

  /** What the engine plays for a seat: a bot's free choice. */
  function botDecision(seat) {
    const hand = m.hands[seat] || [];
    if (!hand.length) return null;
    const others = activeSeats().filter(s => s !== seat);
    const context = {
      opponentMin: others.length ? Math.min(...others.map(s => m.hands[s].length)) : 13,
      urgent: !!m.table && m.table.seat !== seat && m.hands[m.table.seat].length <= 2,
    };
    if (!m.table) { const c = botLead(hand, false, context); return c ? { kind: 'play', cards: c.cards.map(cardWire) } : null; }
    const f = botFollow(hand, m.table.combo, context);
    return f ? { kind: 'play', cards: f.cards.map(cardWire) } : { kind: 'pass' };
  }

  /** The clock ran out on a human: pass when following, the minimal lead when leading. */
  function forcedDecision(seat) {
    if (m.table) return { kind: 'pass' };
    const c = botLead(m.hands[seat] || [], false);
    return c ? { kind: 'play', cards: c.cards.map(cardWire) } : null;
  }

  function act(seat, d) {
    if (!d) return { error: 'no_move' };
    return d.kind === 'pass' ? pass(seat) : play(seat, d.cards);
  }

  /** Invite / tournament: a departed player is folded out of the match. */
  function fold(seat) {
    const p = m.players[seat];
    if (!p || p.out) return false;
    p.out = true;
    m.lastAction[seat] = { kind: 'left' };
    if (m.phase === 'playing') {
      if (activeSeats().length <= 1) { finishOrPause(); return true; }
      if (m.table && m.passStreak >= activeSeats().length - 1) clearTrick(m.table.seat);
      else if (m.turn === seat) m.turn = nextActiveAfter(seat);
    } else if (m.phase === 'hand') {
      finishOrPause();
    }
    return true;
  }

  /** Open table: hand a seat to a bot or a human, keeping its hand and points. */
  function setOccupant(seat, who) {
    const p = m.players[seat];
    if (!p) return false;
    p.id = who ? who.id : null;
    p.name = who ? who.name || '' : '';
    p.avatar = who ? who.avatar || '' : '';
    p.isBot = !who;
    return true;
  }

  /** What one viewer may see. `forId` null = a spectator. */
  function view(forId) {
    const me = m.players.findIndex(p => p.id != null && p.id === forId);
    return {
      phase: m.phase, handNo: m.handNo, moveNo: m.moveNo, loseAt: m.loseAt,
      turn: m.turn, mySeat: me,
      players: m.players.map((p, s) => ({ id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot,
        total: p.total, out: p.out, count: m.hands[s].length })),
      myHand: me >= 0 ? m.hands[me].map(cardWire) : [],
      table: m.table ? { seat: m.table.seat, cards: m.table.combo.cards.map(cardWire) } : null,
      trickPlays: m.trickPlays.slice(),
      lastAction: Object.assign({}, m.lastAction),
      lastHand: m.lastHand,
      winner: m.winner,
      // A finished hand shows everybody's leftover cards on the results screen.
      reveal: m.phase === 'hand' || m.phase === 'over' ? m.hands.map(h => h.map(cardWire)) : null,
    };
  }

  return { m, deal, play, pass, act, botDecision, forcedDecision, fold, setOccupant, view, activeSeats, wireCard };
}
