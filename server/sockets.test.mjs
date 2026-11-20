// Real sockets end to end: http server + socket.io + rooms, two clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as connect } from 'socket.io-client';
import { attachSockets } from './sockets.mjs';
import { createIdentity } from './usion.mjs';

async function boot() {
  const http = createServer((req, res) => { res.writeHead(404); res.end(); });
  const { io } = attachSockets(http, { identity: createIdentity({ devMode: true }), log: { error() {} } });
  await new Promise(r => http.listen(0, r));
  const url = 'http://127.0.0.1:' + http.address().port;
  const clients = [];
  const client = (id, name) => {
    const s = connect(url, { auth: { token: 'dev:' + id, name }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.states = [];
    s.on('state', st => s.states.push(st));
    clients.push(s);
    return s;
  };
  const close = async () => { clients.forEach(c => c.close()); io.close(); await new Promise(r => http.close(r)); };
  return { url, client, close };
}
const ack = (s, ev, data) => new Promise(r => s.emit(ev, data || {}, r));
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)); } return pred(); };
const last = s => s.states[s.states.length - 1];

test('no token, no connection', async () => {
  const b = await boot();
  const s = connect(b.url, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false, forceNew: true });
  const err = await new Promise(r => s.on('connect_error', e => r(e.message)));
  assert.equal(err, 'unauthorized');
  s.close(); await b.close();
});

test('two players at an open table: same game, each sees only their own cards', async () => {
  const b = await boot();
  const a = b.client('u1', 'Alice'), c = b.client('u2', 'Bob');
  await until(() => a.connected && c.connected);
  assert.deepEqual(await ack(a, 'open:join'), { ok: true });
  assert.deepEqual(await ack(c, 'open:join'), { ok: true });
  await until(() => last(a)?.game?.players.some(p => p.id === 'u2') && last(c)?.game?.mySeat >= 0);
  const sa = last(a).game, sc = last(c).game;
  assert.equal(sa.myHand.length > 0, true);
  assert.notDeepEqual(sa.myHand, sc.myHand);
  assert.equal(sa.myHand.some(x => sc.myHand.includes(x)), false, 'no card in two hands');
  assert.deepEqual(sa.players.map(p => p.name).filter(Boolean).sort(), ['Alice', 'Bob']);
  await b.close();
});

test('a move goes through the server and both players see it', async () => {
  const b = await boot();
  const a = b.client('a', 'A'), c = b.client('b', 'B');
  await until(() => a.connected && c.connected);
  await ack(a, 'invite:join', { roomId: 'room_x' });
  await ack(c, 'invite:join', { roomId: 'room_x' });
  await ack(a, 'ready', { ready: true }); await ack(c, 'ready', { ready: true });
  assert.deepEqual(await ack(a, 'start', { loseAt: 20 }), { ok: true });
  await until(() => last(a)?.game?.phase === 'playing' && last(c)?.game?.phase === 'playing');
  const g = last(a).game;
  const onTurn = g.turn === last(a).game.mySeat ? a : c;
  const mine = last(onTurn).game;
  // lead the lowest single
  const card = Math.min(...mine.myHand.map(v => Math.floor(v / 4) * 4 + [3, 1, 0, 2][v % 4]));
  const wire = mine.myHand.find(v => Math.floor(v / 4) * 4 + [3, 1, 0, 2][v % 4] === card);
  assert.deepEqual(await ack(onTurn, 'move', { kind: 'play', cards: [wire], moveNo: mine.moveNo }), { ok: true });
  await until(() => last(a).game.table && last(c).game.table);
  assert.deepEqual(last(a).game.table.cards, [wire]);
  assert.deepEqual(last(c).game.table.cards, [wire]);
  const other = onTurn === a ? c : a;
  assert.equal((await ack(other, 'move', { kind: 'play', cards: [wire], moveNo: 0 })).error !== undefined, true);
  await b.close();
});

test('reactions reach the rest of the table, not the sender', async () => {
  const b = await boot();
  const a = b.client('r1', 'A'), c = b.client('r2', 'B');
  await until(() => a.connected && c.connected);
  await ack(a, 'open:join'); await ack(c, 'open:join');
  const got = [];
  c.on('react', d => got.push(d));
  a.on('react', d => got.push(Object.assign({ wrong: true }, d)));
  await ack(a, 'react', { kind: 'emoji', value: '🔥' });
  await until(() => got.length > 0);
  assert.deepEqual(got, [{ from: 'r1', kind: 'emoji', value: '🔥' }]);
  await b.close();
});
