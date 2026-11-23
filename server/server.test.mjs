// node --test server/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from './index.mjs';
import { memoryStore } from './store.mjs';
import { createIdentity, createNotifier } from './usion.mjs';

const MIN = 60000;
const SECRET = 'test-secret-0123456789';

async function setup({ notify = true, failFirst = 0 } = {}) {
  let clock = Date.parse('2026-11-19T12:00:00Z');
  const pushes = [];
  let failures = failFirst;
  const fetcher = async (url, init) => {
    if (url.endsWith('/iframe/verify-token')) {
      const { token } = JSON.parse(init.body);
      return token.startsWith('tok-') ? { ok: true, status: 200, json: async () => ({ user_id: token.slice(4) }) }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.includes('/notify')) {
      if (failures-- > 0) return { ok: false, status: 502, json: async () => ({}) };
      pushes.push({ url, body: JSON.parse(init.body), sig: init.headers['X-Usion-Signature'], raw: init.body });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    throw new Error('unexpected ' + url);
  };
  const store = memoryStore();
  const identity = createIdentity({ serviceId: 'svc13', apiUrl: 'https://api.test', fetcher });
  const notifier = createNotifier({ serviceId: 'svc13', secret: notify ? SECRET : '', apiUrl: 'https://api.test', fetcher });
  const app = createApp({ store, identity, notifier, now: () => clock, log: { error() {}, warn() {} } });
  const server = createServer(app.handle);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, user, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
      ...(user ? { Authorization: 'Bearer tok-' + user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  };
  return { app, call, pushes, base, setClock: v => { clock = v; }, get clock() { return clock; },
    close: () => new Promise(r => server.close(r)) };
}

test('serves the game, and nothing but the game', async () => {
  const s = await setup();
  try {
    const page = await fetch(s.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /usion-sdk\.js/);
    assert.equal((await fetch(s.base + '/script.js?v=85')).status, 200);
    for (const p of ['/server/index.mjs', '/package.json', '/.git/config', '/test/run_all.cjs', '/../AGENTS.md', '/.env'])
      assert.equal((await fetch(s.base + p)).status, 404, p);
    assert.equal((await s.call('GET', '/healthz')).data.ok, true);
    assert.equal((await s.call('GET', '/health')).data.ok, true, 'the game host checks /health');
  } finally { await s.close(); }
});

test('the server clock is public and uncached, for the tournament', async () => {
  const s = await setup();
  try {
    const r = await s.call('GET', '/api/time');
    assert.equal(r.status, 200, 'no token needed');
    assert.equal(r.data.now, s.clock);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    s.setClock(s.clock + 12345);
    assert.equal((await s.call('GET', '/api/time')).data.now, s.clock);
    assert.equal((await s.call('POST', '/api/time')).status, 401, 'only GET is the clock');
  } finally { await s.close(); }
});

test('the api needs a real Usion token', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('GET', '/api/reminder')).status, 401);
    const r = await s.call('GET', '/api/reminder', 'u1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { configured: true, decided: false, enabled: false, events: [], lead_ms: 180000 });
  } finally { await s.close(); }
});

test('consented + registered players get one push 3 minutes before the start', async () => {
  const s = await setup();
  try {
    const startsAt = s.clock + 60 * MIN;
    await s.call('PUT', '/api/reminder', 'alice', { enabled: true, locale: 'mn' });
    await s.call('POST', '/api/reminder/event', 'alice', { startsAt });
    await s.call('PUT', '/api/reminder', 'bob', { enabled: true, locale: 'en' });
    await s.call('POST', '/api/reminder/event', 'bob', { startsAt });
    await s.call('POST', '/api/reminder/event', 'carol', { startsAt });                 // registered, never allowed
    await s.call('PUT', '/api/reminder', 'dave', { enabled: true });                     // allowed, not registered
    await s.call('PUT', '/api/reminder', 'erin', { enabled: true });
    await s.call('POST', '/api/reminder/event', 'erin', { startsAt });
    await s.call('PUT', '/api/reminder', 'erin', { enabled: false });                    // turned it off again
    await s.call('PUT', '/api/reminder', 'fred', { enabled: true });
    await s.call('POST', '/api/reminder/event', 'fred', { startsAt });
    await s.call('DELETE', '/api/reminder/event', 'fred', { startsAt });                 // withdrew

    assert.deepEqual((await s.call('GET', '/api/reminder', 'alice')).data.events, [startsAt]);

    s.setClock(startsAt - 3 * MIN - 1000);
    await s.app.runDue();
    assert.equal(s.pushes.length, 0, 'nothing before the 3-minute mark');

    s.setClock(startsAt - 3 * MIN + 5000);
    await s.app.runDue();
    await s.app.runDue();
    assert.deepEqual(s.pushes.map(p => p.body.user_id).sort(), ['alice', 'bob']);
    const a = s.pushes.find(p => p.body.user_id === 'alice'), b = s.pushes.find(p => p.body.user_id === 'bob');
    assert.match(a.body.title, /3 минутын дараа/);
    assert.match(b.body.title, /starts in 3 minutes/);
    assert.equal(a.body.path, '/tournament');
    assert.equal(a.url, 'https://api.test/services/svc13/notify');
    assert.equal(a.sig, createHmac('sha256', SECRET).update(a.raw).digest('hex'), 'signed with the service secret');

    s.setClock(startsAt - MIN);
    await s.app.runDue();
    assert.equal(s.pushes.length, 2, 'never twice');
  } finally { await s.close(); }
});

test('a failed push is retried a minute later, but never after the start', async () => {
  const s = await setup({ failFirst: 1 });
  try {
    const startsAt = s.clock + 30 * MIN;
    await s.call('PUT', '/api/reminder', 'alice', { enabled: true });
    await s.call('POST', '/api/reminder/event', 'alice', { startsAt });
    s.setClock(startsAt - 3 * MIN);
    await s.app.runDue();
    assert.equal(s.pushes.length, 0);
    s.setClock(startsAt - 3 * MIN + 30000);
    await s.app.runDue();
    assert.equal(s.pushes.length, 0, 'waits out the retry minute');
    s.setClock(startsAt - 2 * MIN + 1000);
    await s.app.runDue();
    assert.equal(s.pushes.length, 1);

    const s2 = await setup({ failFirst: 99 });
    try {
      const at = s2.clock + 30 * MIN;
      await s2.call('PUT', '/api/reminder', 'bob', { enabled: true });
      await s2.call('POST', '/api/reminder/event', 'bob', { startsAt: at });
      s2.setClock(at - 3 * MIN); await s2.app.runDue();
      s2.setClock(at + 1000); await s2.app.runDue();
      assert.equal(s2.pushes.length, 0, 'too late to be useful');
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('without the notify secret: reminders report unconfigured and refuse to turn on', async () => {
  const s = await setup({ notify: false });
  try {
    assert.equal((await s.call('GET', '/api/reminder', 'u1')).data.configured, false);
    assert.equal((await s.call('PUT', '/api/reminder', 'u1', { enabled: true })).status, 409);
    assert.equal((await s.call('PUT', '/api/reminder', 'u1', { enabled: false })).status, 200, '"Later" still saves');
  } finally { await s.close(); }
});

test('rejects nonsense event times', async () => {
  const s = await setup();
  try {
    for (const startsAt of [0, 'x', s.clock - 2 * 60 * MIN, s.clock + 3 * 24 * 60 * MIN])
      assert.equal((await s.call('POST', '/api/reminder/event', 'u1', { startsAt })).status, 400, String(startsAt));
  } finally { await s.close(); }
});
