// Tables and who sits at them. Drives match.mjs with the clock: bot moves, the
// turn timer, the pause between hands, and what happens when somebody goes.
//
//   open table  — anyone, 4 seats, bots fill the gaps; a newcomer takes over the
//                 lowest-scoring bot seat (and its points) mid-hand; somebody who
//                 goes is replaced by a bot; restarts by itself after a match.
//   invite room — the Usion chat room's people: waiting room, READY, the host
//                 deals; a player who goes is folded out of the match.
//
// Nothing here touches a socket: `send(userId, event, data)` is injected, and so
// is the clock, so the whole thing runs under a fake clock in tests.
import { createMatch } from './match.mjs';

export const TURN_MS = 90000;          // a connected player's turn
export const AFK_TURN_MS = 20000;      // …after missing two turns in a row
export const GONE_MS = 15000;          // disconnected this long = gone (seat settled)
export const BOT_MS = 900;             // a bot "thinks"
export const HAND_PAUSE_MS = 7500;     // last trick on the table + the results screen
export const OPEN_RESTART_MS = 8000;   // champion screen, then the open table goes again
export const OPEN_LOSE_AT = 20;
export const OPEN_SEATS = 4;
const LOSE_AT_CHOICES = [20, 30, 50];

export function createRooms({ send, clock = { now: () => Date.now(), setTimeout, clearTimeout }, log = console, onMatchOver = () => {}, timing = {} } = {}) {
  // Tests shorten these; production uses the exported values.
  const T = Object.assign({ TURN_MS, AFK_TURN_MS, GONE_MS, BOT_MS, HAND_PAUSE_MS, OPEN_RESTART_MS }, timing);
  const rooms = new Map();             // key → room
  const users = new Map();             // userId → { profile, connected, roomKey, goneTimer }
  let openSeq = 0;

  const user = (id) => {
    if (!users.has(id)) users.set(id, { id, profile: { id, name: '', avatar: '' }, connected: false, roomKey: null, goneTimer: null });
    return users.get(id);
  };

  // ── views ─────────────────────────────────────────────────────────────
  function meta(room, forId) {
    const out = { key: room.key, mode: room.mode, deadline: room.deadline ? Math.max(0, room.deadline - clock.now()) : 0 };
    if (room.mode === 'invite') {
      out.lobby = { hostId: room.lobby[0] || null, loseAt: room.loseAt, ready: Object.assign({}, room.ready),
        players: room.lobby.map(id => Object.assign({}, user(id).profile, { connected: user(id).connected })) };
    }
    if (room.match) out.connected = room.match.m.players.map(p => p.isBot || (p.id != null && user(p.id).connected));
    if (room.restartAt) out.restartIn = Math.max(0, room.restartAt - clock.now());
    return out;
  }
  function stateFor(room, id) {
    return Object.assign({ room: meta(room, id) }, room.match ? { game: room.match.view(id) } : { game: null });
  }
  function broadcast(room) {
    for (const id of members(room)) if (user(id).connected) send(id, 'state', stateFor(room, id));
  }
  function members(room) {
    const ids = new Set(room.mode === 'invite' ? room.lobby : []);
    if (room.match) room.match.m.players.forEach(p => { if (!p.isBot && p.id != null) ids.add(p.id); });
    return [...ids];
  }

  // ── timers ────────────────────────────────────────────────────────────
  function clearTurn(room) { if (room.timer) { clock.clearTimeout(room.timer); room.timer = null; } room.deadline = 0; }
  function later(room, ms, fn) {
    clearTurn(room);
    room.deadline = clock.now() + ms;
    room.timer = clock.setTimeout(() => { room.timer = null; room.deadline = 0; try { fn(); } catch (e) { log.error('room timer', room.key, e); } }, ms);
  }

  // Whatever the match is waiting for next, arm it.
  function schedule(room) {
    const g = room.match;
    if (!g) { clearTurn(room); return; }
    const m = g.m;
    if (m.phase === 'hand') { later(room, T.HAND_PAUSE_MS, () => { g.deal(); afterMove(room); }); return; }
    if (m.phase === 'over') { clearTurn(room); matchOver(room); return; }
    if (m.phase !== 'playing') { clearTurn(room); return; }
    const p = m.players[m.turn];
    if (p.isBot) { later(room, T.BOT_MS, () => { g.act(m.turn, g.botDecision(m.turn)); afterMove(room); }); return; }
    const u = user(p.id);
    const ms = (room.missed.get(p.id) || 0) >= 2 ? T.AFK_TURN_MS : T.TURN_MS;
    const seat = m.turn, moveNo = m.moveNo, handNo = m.handNo;
    later(room, ms, () => {
      if (m.turn !== seat || m.moveNo !== moveNo || m.handNo !== handNo || m.phase !== 'playing') return;
      room.missed.set(p.id, (room.missed.get(p.id) || 0) + 1);
      g.act(seat, g.forcedDecision(seat));
      afterMove(room);
    });
    void u;
  }
  function afterMove(room) { schedule(room); broadcast(room); }

  function matchOver(room) {
    const g = room.match;
    try { onMatchOver(room, g); } catch (e) { log.error('onMatchOver', e); }
    if (room.mode === 'open') {
      room.restartAt = clock.now() + T.OPEN_RESTART_MS;
      room.restartTimer = clock.setTimeout(() => { room.restartTimer = null; room.restartAt = 0; restartOpen(room); }, T.OPEN_RESTART_MS);
    }
  }

  // ── open tables ───────────────────────────────────────────────────────
  function humansAt(room) { return room.match ? room.match.m.players.filter(p => !p.isBot && p.id != null).length : 0; }
  function newOpen() {
    const room = { key: 'open-' + (++openSeq), mode: 'open', match: null, timer: null, deadline: 0, missed: new Map(), restartTimer: null, restartAt: 0 };
    rooms.set(room.key, room);
    return room;
  }
  function startOpen(room, humans) {
    const seats = [];
    for (let i = 0; i < OPEN_SEATS; i++) seats.push(humans[i] ? Object.assign({}, user(humans[i]).profile) : { id: null, name: '', isBot: true });
    room.match = createMatch(seats, { loseAt: OPEN_LOSE_AT });
    room.missed = new Map();
    room.match.deal();
    afterMove(room);
  }
  function restartOpen(room) {
    const humans = room.match ? room.match.m.players.filter(p => !p.isBot && p.id != null && user(p.id).connected).map(p => p.id) : [];
    if (!humans.length) { destroy(room); return; }
    startOpen(room, humans);
  }

  function joinOpen(id) {
    const u = user(id);
    const here = u.roomKey && rooms.get(u.roomKey);
    if (here && here.mode === 'open' && here.match && here.match.m.players.some(p => p.id === id)) { broadcast(here); return here; }
    leave(id);
    // The fullest table with a bot seat to take; a finished table is restarting, skip it.
    let best = null;
    for (const r of rooms.values()) {
      if (r.mode !== 'open' || !r.match || r.match.m.phase === 'over') continue;
      const h = humansAt(r);
      if (h < OPEN_SEATS && (!best || h > humansAt(best))) best = r;
    }
    if (!best) { const r = newOpen(); u.roomKey = r.key; startOpen(r, [id]); return r; }
    const m = best.match.m;
    let seat = -1;
    m.players.forEach((p, s) => { if (p.isBot && (seat < 0 || p.total < m.players[seat].total)) seat = s; });
    best.match.setOccupant(seat, u.profile);
    u.roomKey = best.key;
    best.missed.delete(id);
    schedule(best);                     // the seat may be on turn: a human clock now, not a bot's
    broadcast(best);
    return best;
  }

  // ── invite rooms ──────────────────────────────────────────────────────
  function joinInvite(id, roomId) {
    const key = 'invite:' + roomId;
    let room = rooms.get(key);
    if (!room) {
      room = { key, mode: 'invite', roomId, lobby: [], ready: {}, loseAt: 30, match: null, timer: null, deadline: 0, missed: new Map() };
      rooms.set(key, room);
    }
    const u = user(id);
    if (u.roomKey && u.roomKey !== key) leave(id);
    u.roomKey = key;
    if (!room.lobby.includes(id)) {
      // Once dealt the seats are fixed: a late arrival watches until the next match.
      room.lobby.push(id);
    }
    broadcast(room);
    return room;
  }
  function setReady(id, ready) {
    const room = roomOf(id);
    if (!room || room.mode !== 'invite' || (room.match && room.match.m.phase !== 'over')) return;
    room.ready[id] = !!ready;
    broadcast(room);
  }
  function startInvite(id, { loseAt } = {}) {
    const room = roomOf(id);
    if (!room || room.mode !== 'invite') return { error: 'no_room' };
    if (room.lobby[0] !== id) return { error: 'not_host' };
    if (room.match && room.match.m.phase !== 'over') return { error: 'in_progress' };
    const seated = room.lobby.filter(p => user(p).connected && room.ready[p]).slice(0, 4);
    if (seated.length < 2) return { error: 'need_two' };
    if (LOSE_AT_CHOICES.includes(Number(loseAt))) room.loseAt = Number(loseAt);
    room.match = createMatch(seated.map(p => Object.assign({}, user(p).profile)), { loseAt: room.loseAt });
    room.missed = new Map();
    room.ready = {};
    room.match.deal();
    afterMove(room);
    return { ok: true };
  }

  // ── moves ─────────────────────────────────────────────────────────────
  function move(id, { kind, cards, moveNo } = {}) {
    const room = roomOf(id);
    const g = room && room.match;
    if (!g) return { error: 'no_match' };
    const seat = g.m.players.findIndex(p => p.id === id);
    if (seat < 0) return { error: 'not_seated' };
    // A tap built for an older position (the clock already moved for them) is stale.
    if (moveNo != null && Number(moveNo) !== g.m.moveNo) return { error: 'stale' };
    const r = kind === 'pass' ? g.pass(seat) : kind === 'play' ? g.play(seat, Array.isArray(cards) ? cards.map(Number) : null) : { error: 'bad_kind' };
    if (r.ok) { room.missed.delete(id); afterMove(room); }
    return r;
  }

  // ── presence ──────────────────────────────────────────────────────────
  function roomOf(id) { const k = users.get(id) && users.get(id).roomKey; return k ? rooms.get(k) || null : null; }

  function connect(id, profile) {
    const u = user(id);
    if (profile) u.profile = { id, name: String(profile.name || '').slice(0, 40), avatar: String(profile.avatar || '').slice(0, 500) };
    u.connected = true;
    if (u.goneTimer) { clock.clearTimeout(u.goneTimer); u.goneTimer = null; }
    const room = roomOf(id);
    if (room) {
      // Keep their seat's name/avatar fresh and let everyone see they're back.
      if (room.match) room.match.m.players.forEach(p => { if (p.id === id) { p.name = u.profile.name || p.name; p.avatar = u.profile.avatar || p.avatar; } });
      broadcast(room);
    }
    return room;
  }

  function disconnect(id) {
    const u = users.get(id);
    if (!u) return;
    u.connected = false;
    const room = roomOf(id);
    if (room) broadcast(room);
    if (u.goneTimer) clock.clearTimeout(u.goneTimer);
    u.goneTimer = clock.setTimeout(() => { u.goneTimer = null; if (!u.connected) leave(id); }, T.GONE_MS);
  }

  /** Off the table for good: an open seat goes to a bot, an invite seat folds. */
  function leave(id) {
    const u = users.get(id);
    const room = roomOf(id);
    if (!u || !room) { if (u) u.roomKey = null; return; }
    u.roomKey = null;
    if (room.mode === 'invite') {
      room.lobby = room.lobby.filter(x => x !== id);
      delete room.ready[id];
    }
    const g = room.match;
    if (g) {
      const seat = g.m.players.findIndex(p => p.id === id);
      if (seat >= 0) {
        if (room.mode === 'open') g.setOccupant(seat, null);
        else if (g.m.phase !== 'over') g.fold(seat);
      }
    }
    if (!members(room).some(x => users.get(x) && users.get(x).roomKey === room.key)) { destroy(room); return; }
    if (g) schedule(room);
    broadcast(room);
  }

  function destroy(room) {
    clearTurn(room);
    if (room.restartTimer) clock.clearTimeout(room.restartTimer);
    rooms.delete(room.key);
  }

  function relay(id, event, data) {
    const room = roomOf(id);
    if (!room) return;
    for (const other of members(room)) if (other !== id && user(other).connected) send(other, event, Object.assign({ from: id }, data));
  }

  return { joinOpen, joinInvite, setReady, startInvite, move, connect, disconnect, leave, relay, roomOf, stateFor,
    rooms, users, _schedule: schedule };
}
