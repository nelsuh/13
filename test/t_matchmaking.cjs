const { World, openWorld, arrive, eventually, startMatch, dump } = require('./lib/world.cjs');
const { test, ok, eq, run } = require('./lib/tap.cjs');

test('new arrival chooses three humans at table 2 over one human at table 1', async () => {
  const w = await openWorld(1);
  await startMatch(w);
  for (let i = 2; i <= 8; i++) {
    const c = arrive(w, 'u' + i, 'Player ' + i);
    ok(await eventually(w, () => c.snap().gameStarted && c.snap().mySeat >= 0, 60000, 250), dump(w));
  }
  eq(w.clients.slice(0,4).map(c => c.sdk.room.id), Array(4).fill('public-13-1'));
  eq(w.clients.slice(4).map(c => c.sdk.room.id), Array(4).fill('public-13-2'));
  w.clients.slice(1,4).forEach(c => c.leaveRoom());
  w.clients[7].leaveRoom();
  await w.advance(28000); // leave grace expires and both live tables publish occupancy
  const one = w.server.sharedKV.get('public13.table.v1.0');
  const three = w.server.sharedKV.get('public13.table.v1.1');
  eq(one.humans, 1); eq(three.humans, 3); ok(three.freeSeats > 0);
  const newcomer = arrive(w, 'new', 'New player');
  ok(await eventually(w, () => newcomer.snap().gameStarted && newcomer.snap().mySeat >= 0, 60000, 250), dump(w));
  eq(newcomer.sdk.room.id, 'public-13-2', 'choose the fullest available table');
  ok(!w.clients[0].snap().order.includes('new'), 'never take a probe seat at the less populated table');
  // The directory may still advertise the last seat that was just taken.
  const next = arrive(w, 'next', 'Next player');
  ok(await eventually(w, () => next.snap().gameStarted && next.snap().mySeat >= 0, 60000, 250), dump(w));
  eq(next.sdk.room.id, 'public-13-1', 'live full-table check falls back to the next available candidate');
  eq(w.errors(), []);
});

test('directory ignores full, expired, future and malformed entries; ties use the first table', async () => {
  const w = new World();
  const c = w.add('chooser', 'Chooser', {mode:'single',pick:'none'});
  const now = w.clock.now;
  const put = (shard, data) => w.server.sharedKV.set('public13.table.v1.' + shard,
    {version:1, humans:2, freeSeats:2, updatedAt:now, ...data});
  put(0, {}); put(1, {});
  put(2, {humans:4,freeSeats:0}); put(3, {humans:3,updatedAt:now-46000});
  put(4, {humans:3,freeSeats:0}); put(5, {humans:3,updatedAt:now+6000});
  put(6, {humans:'3'});
  eq(await c.run('fullestOpenShard(7)'), 0);
  put(1, {humans:3,freeSeats:1});
  eq(await c.run('fullestOpenShard(7)'), 1);
});

test('a stalled directory never delays joining indefinitely or overrides a switch to bots', async () => {
  const w = new World();
  const c = w.add('slow', 'Slow', {mode:'single',roomId:'standalone_slow',pick:'none'});
  c.start({userId:'slow',roomId:'standalone_slow',playerIds:['slow']}); await w.advance(100);
  c.run('Usion.cloud.shared.get = () => new Promise(() => {})');
  c.click('menuOnlineBtn'); await w.advance(100);
  c.run('menuPlayBots()'); await w.advance(2000);
  eq(c.snap().online, false); eq(c.snap().dealActive, true); eq(c.sdk.room, null);
});

module.exports.run = () => run('MATCHMAKING');
if (require.main === module) module.exports.run().then(r => process.exit(r.fails.length ? 1 : 0));
