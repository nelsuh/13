import test from 'node:test';
import assert from 'node:assert/strict';
import { createRooms, TURN_MS, AFK_TURN_MS, GONE_MS, HAND_PAUSE_MS, OPEN_RESTART_MS } from './rooms.mjs';

function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}

function world() {
  const clock = fakeClock();
  const inbox = new Map();
  const over = [];
  const send = (id, ev, data) => { if (!inbox.has(id)) inbox.set(id, []); inbox.get(id).push({ ev, data }); };
  const rooms = createRooms({ send, clock, log: { error() {} }, onMatchOver: (room, g) => over.push({ key: room.key, winner: g.m.winner }) });
  const last = (id) => { const l = (inbox.get(id) || []).filter(x => x.ev === 'state'); return l.length ? l[l.length - 1].data : null; };
  const join = (id, name) => rooms.connect(id, { name: name || id });
  return { clock, rooms, inbox, last, join, over };
}

// Play `id`'s turn with the engine's own choice, through the public move API.
function playFor(w, id) {
  const room = w.rooms.roomOf(id);
  const g = room.match;
  const seat = g.m.players.findIndex(p => p.id === id);
  if (g.m.phase !== 'playing' || g.m.turn !== seat) return false;
  const d = g.botDecision(seat);
  const r = w.rooms.move(id, Object.assign({ moveNo: g.m.moveNo }, d));
  assert.ok(r.ok, JSON.stringify(r));
  return true;
}

test('open: the first player gets a table of bots and a dealt hand at once', () => {
  const w = world();
  w.join('u1');
  w.rooms.joinOpen('u1');
  const s = w.last('u1');
  assert.equal(s.room.mode, 'open');
  assert.equal(s.game.phase, 'playing');
  assert.equal(s.game.myHand.length, 13);
  assert.equal(s.game.players.filter(p => p.isBot).length, 3);
});

test('open: a second player takes over the lowest-scoring bot seat at the same table', () => {
  const w = world();
  w.join('u1'); w.rooms.joinOpen('u1');
  const g = w.rooms.roomOf('u1').match;
  g.m.players.forEach((p, s) => { if (p.isBot) p.total = 10 + s; });
  const cheapest = g.m.players.findIndex(p => p.isBot && p.total === Math.min(...g.m.players.filter(q => q.isBot).map(q => q.total)));
  w.join('u2'); w.rooms.joinOpen('u2');
  assert.equal(w.rooms.roomOf('u2'), w.rooms.roomOf('u1'));
  assert.equal(w.last('u2').game.mySeat, cheapest);
  assert.equal(w.last('u2').game.myHand.length, g.m.hands[cheapest].length);
});

test('open: a fifth player opens a second table', () => {
  const w = world();
  for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) { w.join(id); w.rooms.joinOpen(id); }
  assert.equal(w.rooms.roomOf('u4'), w.rooms.roomOf('u1'));
  assert.notEqual(w.rooms.roomOf('u5'), w.rooms.roomOf('u1'));
});

test('open: bots move by themselves and a match runs to the champion, then restarts', () => {
  const w = world();
  w.join('u1'); w.rooms.joinOpen('u1');
  const room = w.rooms.roomOf('u1');
  for (let i = 0; i < 4000 && room.match.m.phase !== 'over'; i++) { playFor(w, 'u1'); w.clock.advance(1000); }
  assert.equal(room.match.m.phase, 'over');
  assert.equal(w.over.length, 1);
  w.clock.advance(OPEN_RESTART_MS + 10);
  assert.equal(w.rooms.roomOf('u1').match.m.phase, 'playing', 'a new match on the same table');
  assert.equal(w.rooms.roomOf('u1').match.m.handNo, 1);
});

test('the clock plays for an absent player, and gets short after two misses', () => {
  const w = world();
  w.join('u1'); w.rooms.joinOpen('u1');
  const room = w.rooms.roomOf('u1');
  const g = room.match;
  const seat = g.m.players.findIndex(p => p.id === 'u1');
  // run bots until it's u1's turn
  for (let i = 0; i < 50 && !(g.m.phase === 'playing' && g.m.turn === seat); i++) w.clock.advance(1000);
  assert.equal(g.m.turn, seat);
  assert.ok(room.deadline - w.clock.now() <= TURN_MS && room.deadline - w.clock.now() > TURN_MS - 2000);
  const mv = g.m.moveNo;
  w.clock.advance(TURN_MS + 10);
  assert.ok(g.m.moveNo > mv || g.m.handNo > 1, 'the clock moved for them');
  w.clock.advance(1);
  for (let i = 0; i < 50 && !(g.m.phase === 'playing' && g.m.turn === seat); i++) w.clock.advance(1000);
  w.clock.advance(TURN_MS + 10);
  for (let i = 0; i < 50 && !(g.m.phase === 'playing' && g.m.turn === seat); i++) w.clock.advance(1000);
  if (g.m.phase === 'playing' && g.m.turn === seat) assert.ok(room.deadline - w.clock.now() <= AFK_TURN_MS, 'two misses → the short clock');
});

test('open: a player who disconnects is replaced by a bot after 15 s, not before', () => {
  const w = world();
  w.join('u1'); w.rooms.joinOpen('u1');
  w.join('u2'); w.rooms.joinOpen('u2');
  const g = w.rooms.roomOf('u1').match;
  const seat = g.m.players.findIndex(p => p.id === 'u2');
  w.rooms.disconnect('u2');
  w.clock.advance(GONE_MS - 1000);
  assert.equal(g.m.players[seat].id, 'u2', 'still seated inside the grace');
  assert.equal(w.last('u1').room.connected[seat], false, 'shown as disconnected');
  w.clock.advance(2000);
  assert.equal(g.m.players[seat].isBot, true, 'a bot has the seat');
  assert.equal(w.last('u1').game.players[seat].isBot, true, 'and u1 sees it');
});

test('a reconnect inside 15 s keeps the seat', () => {
  const w = world();
  w.join('u1'); w.rooms.joinOpen('u1');
  w.join('u2'); w.rooms.joinOpen('u2');
  const g = w.rooms.roomOf('u1').match;
  const seat = g.m.players.findIndex(p => p.id === 'u2');
  w.rooms.disconnect('u2');
  w.clock.advance(10000);
  w.join('u2');
  w.clock.advance(30000);
  assert.equal(g.m.players[seat].id, 'u2');
});

test('invite: waiting room, READY, only the host deals, and seats are the ready players', () => {
  const w = world();
  for (const id of ['a', 'b', 'c']) { w.join(id); w.rooms.joinInvite(id, 'room_1'); }
  assert.equal(w.last('a').room.lobby.hostId, 'a');
  assert.equal(w.rooms.startInvite('a').error, 'need_two');
  w.rooms.setReady('a', true); w.rooms.setReady('b', true);
  assert.equal(w.rooms.startInvite('b').error, 'not_host');
  assert.ok(w.rooms.startInvite('a', { loseAt: 20 }).ok);
  const s = w.last('a');
  assert.equal(s.game.players.length, 2);
  assert.equal(s.game.loseAt, 20);
  assert.equal(w.last('c').game.mySeat, -1, 'c was not ready: watches');
  assert.equal(w.last('c').game.myHand.length, 0);
});

test('invite: a player who disconnects for good is folded after 15 s and the match goes on', () => {
  const w = world();
  for (const id of ['a', 'b', 'c']) { w.join(id); w.rooms.joinInvite(id, 'room_2'); w.rooms.setReady(id, true); }
  w.rooms.startInvite('a');
  const g = w.rooms.roomOf('a').match;
  w.rooms.disconnect('c');
  w.clock.advance(GONE_MS + 100);
  assert.equal(g.m.players[2].out, true);
  assert.equal(g.m.phase, 'playing');
  assert.notEqual(g.m.turn, 2);
});

test('moves: out of turn and stale taps are refused', () => {
  const w = world();
  for (const id of ['a', 'b']) { w.join(id); w.rooms.joinInvite(id, 'room_3'); w.rooms.setReady(id, true); }
  w.rooms.startInvite('a');
  const g = w.rooms.roomOf('a').match;
  const onTurn = g.m.players[g.m.turn].id, off = onTurn === 'a' ? 'b' : 'a';
  assert.equal(w.rooms.move(off, { kind: 'pass', moveNo: 0 }).error, 'not_your_turn');
  assert.equal(w.rooms.move(onTurn, { kind: 'pass', moveNo: 5 }).error, 'stale');
  assert.equal(w.rooms.move('zz', { kind: 'pass' }).error, 'no_match');
});

test('the last player leaving tears the table down', () => {
  const w = world();
  w.join('u1'); w.rooms.joinOpen('u1');
  assert.equal(w.rooms.rooms.size, 1);
  w.rooms.leave('u1');
  assert.equal(w.rooms.rooms.size, 0);
  w.clock.advance(HAND_PAUSE_MS * 10);
});
