// 13 on the Usion game host: serves the game and sends the tournament reminder.
//
// Usion.notify only reaches a player while the app is open, so the reminder has to
// come from a server: players who allowed notifications and registered for an event
// get a push REMIND_LEAD_MS (3 min) before it starts, app closed or not.
//
// «Every evening» registrants are reminded for every event (store.dailyUsers).
//   GET    /api/reminder            → { configured, decided, enabled, daily, events, lead_ms }
//   PUT    /api/reminder            { enabled, locale }   on/off (after Usion's permission prompt)
//   POST   /api/reminder/event      { startsAt, daily? }  "I registered for this event (every evening)"
//   DELETE /api/reminder/event      { startsAt, daily? }  "I withdrew (from every evening too)"
//   GET    /api/time                → { now }   server clock, no token (tournament timing)
//
// Every /api call carries the Usion iframe token (Authorization: Bearer …); the
// player id comes from Usion's verify-token, never from the client.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity, createNotifier } from './usion.mjs';
import { memoryStore, mongoStore } from './store.mjs';
import { attachSockets } from './sockets.mjs';
import { tourCurrentStart } from './schedule.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only the game itself is public: never the server code, tests or .git.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/rules.js': ['rules.js', 'text/javascript; charset=utf-8'],
  '/script.js': ['script.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const DAY = 24 * 60 * 60 * 1000;

export function createApp({ store, identity, notifier, leadMs = 180000, now = () => Date.now(), log = console } = {}) {
  const files = new Map();
  async function serveStatic(req, res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) return false;
    let body = files.get(entry[0]);
    if (!body) { body = await readFile(path.join(ROOT, entry[0])); if (process.env.NODE_ENV === 'production') files.set(entry[0], body); }
    res.writeHead(200, { 'Content-Type': entry[1],
      // index.html bumps ?v= on script/style, so only the page itself must never be cached.
      'Cache-Control': entry[0] === 'index.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 4096) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}; }
    catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }
  async function view(userId) {
    const p = await store.getPref(userId);
    return { configured: notifier.enabled, decided: !!p?.decided, enabled: !!p?.enabled, daily: !!p?.daily,
      events: await store.upcomingEvents(userId, now()), lead_ms: leadMs };
  }
  // An event a client may register: today's or tomorrow's, nothing far off or long past.
  const validStart = (v) => Number.isSafeInteger(v) && v > now() - 60 * 60 * 1000 && v < now() + 2 * DAY;

  async function api(req, res, pathname) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    let user;
    try { user = await identity.verify(token); }
    catch { return json(res, 503, { error: 'usion_unavailable' }); }
    if (!user) return json(res, 401, { error: 'unauthorized' });
    const body = ['PUT', 'POST', 'DELETE'].includes(req.method) ? await readBody(req) : {};

    if (pathname === '/api/reminder' && req.method === 'GET') {
      // Opening the tournament keeps an «every evening» subscription alive.
      const p = await store.getPref(user.id);
      if (p?.daily) await store.setPref(user.id, { dailySeen: now() });
      return json(res, 200, await view(user.id));
    }
    if (pathname === '/api/reminder' && req.method === 'PUT') {
      if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be boolean' });
      if (body.enabled && !notifier.enabled) return json(res, 409, { error: 'not_configured' });
      await store.setPref(user.id, { enabled: body.enabled, decided: true, locale: body.locale === 'en' ? 'en' : 'mn' });
      return json(res, 200, await view(user.id));
    }
    if (pathname === '/api/reminder/event' && (req.method === 'POST' || req.method === 'DELETE')) {
      const startsAt = Number(body.startsAt);
      if (!validStart(startsAt)) return json(res, 400, { error: 'bad startsAt' });
      if (req.method === 'POST') {
        await store.addEvent(user.id, startsAt);
        if (body.daily === true) await store.setPref(user.id, { daily: true, dailySeen: now() });
      } else {
        await store.removeEvent(user.id, startsAt);
        if (body.daily === false) await store.setPref(user.id, { daily: false });
      }
      return json(res, 200, await view(user.id));
    }
    return json(res, 404, { error: 'not_found' });
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname === '/health' || pathname === '/healthz') return json(res, 200, { ok: true, store: store.kind, notify: notifier.enabled });
      // The tournament's clock. Every phone runs the event on its own clock, and a
      // phone set by hand can be minutes off: it registers after the draw, deals
      // early, stamps results in the future. The page measures its offset from this.
      if (pathname === '/api/time' && (req.method === 'GET' || req.method === 'HEAD')) return json(res, 200, { now: now() });
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    } catch (e) {
      if (!e.status) log.error('request failed', req.method, pathname, e.message);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'server_error' });
    }
  }

  // ── The reminder clock ────────────────────────────────────────────────
  // «Every evening» subscribers get tonight's event filed for them once it is
  // due. Each event is claimed atomically before sending, so a restart or a
  // second replica never pushes the same reminder twice. A failed push is
  // retried every minute until the event starts; after that it would be useless.
  let running = false;
  async function runDue() {
    if (running || !notifier.enabled) return { sent: 0 };
    running = true;
    let sent = 0;
    try {
      const t0 = now(), start = tourCurrentStart(t0);
      if (start > t0 && start - leadMs <= t0) {
        for (const id of await store.dailyUsers(t0)) await store.addEvent(id, start);
      }
      for (;;) {
        const t = now();
        const batch = await store.claimDue(t, leadMs, 8);
        if (!batch.length) break;
        await Promise.all(batch.map(async (e) => {
          const p = await store.getPref(e.userId);
          if (!p?.enabled) return store.finish(e._id, 'skipped');
          try {
            await notifier.send(e.userId, { locale: p.locale, leadMs });
            sent++;
            await store.finish(e._id, 'sent', { sentAt: now() });
          } catch (err) {
            log.warn('reminder failed', e._id, err.message);
            await store.finish(e._id, 'pending', { retryAt: t + 60000 });
          }
        }));
      }
      return { sent };
    } finally { running = false; }
  }

  return { handle, runDue, prune: () => store.prune(now() - 3 * DAY) };
}

async function main() {
  const env = process.env;
  // USION_* names and the game host guide names (SERVICE_ID, API_URL, NOTIFY_SECRET) both work.
  const apiUrl = env.USION_API_URL || env.API_URL || 'https://mobile.mongolai.mn';
  const serviceId = env.USION_SERVICE_ID || env.SERVICE_ID || '';
  const secret = env.USION_NOTIFY_SECRET || env.NOTIFY_SECRET || '';
  const store = env.MONGODB_URI ? await mongoStore(env.MONGODB_URI, env.MONGODB_DB || 't13') : memoryStore();
  const identity = createIdentity({ serviceId, apiUrl, devMode: env.NODE_ENV !== 'production' });
  const notifier = createNotifier({ serviceId, secret, apiUrl });
  const app = createApp({ store, identity, notifier, leadMs: Number(env.REMIND_LEAD_MS) || 180000 });
  const port = Number(env.PORT) || 3000;
  const http = createServer(app.handle);
  // Live tables: the server deals, keeps every hand and runs the clock (sockets.mjs).
  attachSockets(http, { identity });
  http.listen(port, () => console.log(
    `13 on :${port} · store ${store.kind} · reminders ${notifier.enabled ? 'on' : 'off (service id or notify secret missing)'}`));
  if (store.kind === 'memory' && env.NODE_ENV === 'production') console.warn('MONGODB_URI is not set: reminder sign-ups are lost on every restart.');
  setInterval(() => app.runDue().catch(e => console.error('reminder tick', e.message)), 15000);
  setInterval(() => app.prune().catch(() => {}), 6 * 60 * 60 * 1000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
