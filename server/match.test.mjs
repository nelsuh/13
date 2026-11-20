import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from './match.mjs';

const bots = (k) => Array.from({ length: k }, (_, i) => ({ id: 'b' + i, name: 'B' + i, isBot: true }));

function playToEnd(g, maxMoves = 20000) {
  let moves = 0;
  while (g.m.phase !== 'over' && moves < maxMoves) {
    if (g.m.phase === 'hand' || g.m.phase === 'idle') { g.deal(); continue; }
    const r = g.act(g.m.turn, g.botDecision(g.m.turn));
    assert.ok(r.ok, 'bot move refused: ' + JSON.stringify(r));
    const held = g.m.hands.reduce((a, h) => a + h.length, 0);
    assert.ok(held <= 52);
    moves++;
  }
  return moves;
}

for (const k of [2, 3, 4]) {
  test(`${k} bots play a whole match to one champion`, () => {
    for (let i = 0; i < 20; i++) {
      const g = createMatch(bots(k), { loseAt: 30 });
      playToEnd(g);
      assert.equal(g.m.phase, 'over');
      assert.equal(g.m.players.filter(p => !p.out).length, 1);
      assert.equal(g.m.players[g.m.winner].out, false);
    }
  });
}

test('the deal: 13 each, no duplicates, the lowest card leads the first hand', () => {
  const g = createMatch(bots(4));
  g.deal();
  const all = g.m.hands.flat().map(c => c.r * 4 + c.s);
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52);
  const lead = g.m.turn;
  const low = Math.min(...g.m.hands.flat().map(c => c.r * 4 + [3, 1, 0, 2][c.s]));
  assert.ok(g.m.hands[lead].some(c => c.r * 4 + [3, 1, 0, 2][c.s] === low));
});

test('a player sees only their own hand', () => {
  const g = createMatch([{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }, { id: 'u3', name: 'C' }]);
  g.deal();
  const v = g.view('u2');
  assert.equal(v.mySeat, 1);
  assert.equal(v.myHand.length, 13);
  assert.deepEqual(v.players.map(p => p.count), [13, 13, 13]);
  assert.equal(JSON.stringify(v).includes('"hands"'), false);
  assert.equal(v.reveal, null, 'nobody else\'s cards while the hand is live');
  assert.equal(g.view(null).myHand.length, 0, 'a spectator sees no cards');
});

test('illegal moves are refused and change nothing', () => {
  const g = createMatch(bots(3));
  g.deal();
  const t = g.m.turn, other = (t + 1) % 3;
  const before = JSON.stringify(g.m.hands);
  assert.equal(g.play(other, [g.m.hands[other][0].r * 4 + g.m.hands[other][0].s]).error, 'not_your_turn');
  assert.equal(g.pass(t).error, 'must_lead');
  assert.equal(g.play(t, [g.m.hands[other][0].r * 4 + g.m.hands[other][0].s]).error, 'not_in_hand');
  assert.equal(g.play(t, [999]).error, 'not_in_hand');
  assert.equal(g.play(t, []).error, 'bad_cards');
  assert.equal(JSON.stringify(g.m.hands), before);
});

test('the clock\'s forced move is always legal', () => {
  for (let i = 0; i < 30; i++) {
    const g = createMatch(bots(4));
    g.deal();
    for (let k = 0; k < 40 && g.m.phase === 'playing'; k++) {
      const r = g.act(g.m.turn, k % 2 ? g.forcedDecision(g.m.turn) : g.botDecision(g.m.turn));
      assert.ok(r.ok, JSON.stringify(r));
    }
  }
});

test('folding the player on turn moves play on; the last one standing wins', () => {
  const g = createMatch([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
  g.deal();
  const t = g.m.turn;
  g.fold(t);
  assert.notEqual(g.m.turn, t);
  assert.equal(g.m.phase, 'playing');
  g.fold(g.m.turn);
  assert.equal(g.m.phase, 'over');
  assert.equal(g.m.players.filter(p => !p.out).length, 1);
});

test('a fold that completes the pass streak clears the trick to its owner', () => {
  const g = createMatch(bots(3));
  g.deal();
  const lead = g.m.turn;
  g.act(lead, g.forcedDecision(lead));       // lead something
  const p1 = g.m.turn;
  g.pass(p1);                                // one pass of the two needed
  const p2 = g.m.turn;
  g.fold(p2);                                // the other follower leaves
  assert.equal(g.m.table, null, 'trick cleared');
  assert.equal(g.m.turn, lead, 'back to the player who led');
});

test('an open seat changes hands keeping its cards and points', () => {
  const g = createMatch([{ id: 'u1', name: 'A' }, ...bots(3)]);
  g.deal();
  g.m.players[2].total = 7;
  const cards = g.m.hands[2].length;
  g.setOccupant(2, { id: 'u9', name: 'Z' });
  assert.equal(g.view('u9').mySeat, 2);
  assert.equal(g.view('u9').myHand.length, cards);
  assert.equal(g.m.players[2].total, 7);
  assert.equal(g.m.players[2].isBot, false);
  g.setOccupant(2, null);
  assert.equal(g.m.players[2].isBot, true);
  assert.equal(g.view('u9').mySeat, -1);
});
