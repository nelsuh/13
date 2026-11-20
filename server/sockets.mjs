// The live table connection. Socket.io on the same http server as the page, so
// the game talks to its own origin (13.games.usions.com) — no CORS, and Caddy
// proxies the websocket as it is.
//
// Handshake: auth = { token, name, avatar }. The player id comes ONLY from
// Usion's verify-token; name/avatar are display text the client supplies.
//
// client → server                         server → client
//   open:join                               state   { room, game }  (per player)
//   invite:join  { roomId }                 react   { from, kind, value }
//   ready        { ready }
//   start        { loseAt }     (host)
//   move         { kind, cards, moveNo }
//   leave
//   react        { kind, value }  (chat / emoji, relayed to the table)
import { Server } from 'socket.io';
import { createRooms } from './rooms.mjs';

const ROOM_ID = /^[A-Za-z0-9_\-:.]{1,120}$/;

export function attachSockets(httpServer, { identity, log = console, clock, onMatchOver } = {}) {
  const io = new Server(httpServer, { serveClient: true, pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 16 * 1024 });
  const sockets = new Map();     // userId → Set<socket>
  const send = (id, ev, data) => { const set = sockets.get(id); if (set) for (const s of set) s.emit(ev, data); };
  const rooms = createRooms({ send, clock, log, onMatchOver });

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    try {
      const user = await identity.verify(auth.token);
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      socket.data.profile = { name: String(auth.name || '').slice(0, 40), avatar: String(auth.avatar || '').slice(0, 500) };
      next();
    } catch { next(new Error('usion_unavailable')); }
  });

  io.on('connection', (socket) => {
    const id = socket.data.userId;
    if (!sockets.has(id)) sockets.set(id, new Set());
    sockets.get(id).add(socket);
    const room = rooms.connect(id, socket.data.profile);
    if (room) socket.emit('state', rooms.stateFor(room, id));
    else socket.emit('state', { room: null, game: null });

    // Cheap flood guard: a client never needs more than a few messages a second.
    let budget = 20, refill = Date.now();
    const ok = () => {
      const now = Date.now();
      budget = Math.min(20, budget + (now - refill) / 250); refill = now;
      if (budget < 1) return false;
      budget -= 1; return true;
    };
    const on = (ev, fn) => socket.on(ev, (data, cb) => {
      if (!ok()) { if (typeof cb === 'function') cb({ error: 'rate_limited' }); return; }
      let r;
      try { r = fn(data && typeof data === 'object' ? data : {}); } catch (e) { log.error('socket', ev, e); r = { error: 'server_error' }; }
      if (typeof cb === 'function') cb(r || { ok: true });
    });

    on('open:join', () => { rooms.joinOpen(id); return { ok: true }; });
    on('invite:join', ({ roomId }) => {
      if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return { error: 'bad_room' };
      rooms.joinInvite(id, roomId); return { ok: true };
    });
    on('ready', ({ ready }) => { rooms.setReady(id, !!ready); return { ok: true }; });
    on('start', ({ loseAt }) => rooms.startInvite(id, { loseAt }));
    on('move', (d) => rooms.move(id, { kind: d.kind, cards: d.cards, moveNo: d.moveNo }));
    on('leave', () => { rooms.leave(id); socket.emit('state', { room: null, game: null }); return { ok: true }; });
    on('react', ({ kind, value }) => {
      if (typeof kind !== 'string' || kind.length > 20) return { error: 'bad' };
      rooms.relay(id, 'react', { kind, value: typeof value === 'string' ? value.slice(0, 80) : value });
      return { ok: true };
    });

    socket.on('disconnect', () => {
      const set = sockets.get(id);
      if (set) { set.delete(socket); if (!set.size) { sockets.delete(id); rooms.disconnect(id); } }
    });
  });

  return { io, rooms };
}
