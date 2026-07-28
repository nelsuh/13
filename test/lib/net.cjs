// Fake Usion relay + per-client SDK.
//
// Modelled on usion-app/references/{sdk-reference,multiplayer}.md:
//   action()    → server-sequenced, STORED, broadcast to everyone (sender included)
//   realtime()  → fire-and-forget broadcast, never stored, lost if you're away
//   setState()  → CAS-versioned server checkpoint, "not host-only"
//   requestSync → onSync{game_state, actions} = "load checkpoint + replay tail"
//
// Messages pushed at a frozen (suspended WebView) or disconnected client are
// DROPPED, exactly like a postMessage into a sleeping WebView. Recovery is only
// ever via requestSync — which is what the tests are here to prove.

const SYNC_MODELS = {
  // whole stored log every time (most forgiving server)
  full: (room) => room.log.slice(),
  // everything the caller has not seen (the usual reading of requestSync(lastSeq))
  tail: (room, lastSeq) => room.log.filter(a => a.sequence > lastSeq),
  // compacted log: pre-checkpoint entries are gone and the tail RE-INCLUDES the
  // action the checkpoint already contains (the adversarial model that produced
  // the connect_four phantom-move bug)
  cpTailInclusive: (room, lastSeq) => {
    if (room.stateSeq < 0) return room.log.slice();
    return room.log.filter(a => a.sequence >= room.stateSeq);
  },
};

class Room {
  constructor(server, id) {
    this.server = server;
    this.id = id;
    this.seq = 0;
    this.log = [];
    this.state = null;
    this.stateSeq = -1;
    this.roster = [];                 // player_ids; [0] is the host, order is stable
    this.members = new Map();         // id → sdk
    this.started = false;             // set by tests once seats are frozen
  }
  connectedIds() { return this.roster.filter(id => { const s = this.members.get(id); return s && s.connected; }); }
  connectedCount() { return this.connectedIds().length; }
  peers(exceptId) { return [...this.members.values()].filter(s => s.id !== exceptId); }
}

class Server {
  constructor(clock, opts) {
    this.clock = clock;
    this.opts = Object.assign({ latency: 20, syncModel: "tail" }, opts || {});
    this.rooms = new Map();
    this.reports = [];               // every Usion.game.reportResult payload
    this.dropNext = [];              // [{ to, type }] one-shot delivery drops
    this.log = [];                   // transport trace, for debugging a failure
  }
  room(id) {
    if (!this.rooms.has(id)) this.rooms.set(id, new Room(this, id));
    return this.rooms.get(id);
  }
  /** Deliver later, from the server's own timer, so a frozen target loses it. */
  push(target, type, payload) {
    this.clock.setTimeout(null, () => {
      if (!target.connected || target.frozen) {
        this.log.push({ t: this.clock.now, drop: type, to: target.id, why: target.frozen ? "frozen" : "offline" });
        return;
      }
      const i = this.dropNext.findIndex(d => d.to === target.id && (!d.type || d.type === type) &&
        (!d.match || d.match(payload)));
      if (i >= 0) {
        this.dropNext.splice(i, 1);
        this.log.push({ t: this.clock.now, drop: type, to: target.id, why: "forced" });
        return;
      }
      this.log.push({ t: this.clock.now, deliver: type, to: target.id });
      target.fire(type, payload);
    }, this.opts.latency);
  }
}

/** The `Usion` namespace handed to one simulated client. */
class SDK {
  constructor(server, id, name, launch) {
    this.server = server;
    this.clock = server.clock;
    this.id = id;
    this.name = name;
    this.launch = launch || {};
    this.connected = false;
    this.frozen = false;
    this.room = null;
    this.handlers = {};
    this.initCb = null;
    this.left = false;
    this.calls = { reportResult: [], leaderboard: [], notify: [], rematch: 0, setState: 0, setStateStale: 0 };
  }
  fire(type, payload) {
    const h = this.handlers[type];
    if (h) h(payload);
  }
  // ── transport control used by the tests ───────────────────────────────
  freeze() { this.frozen = true; }
  thaw() { this.frozen = false; }
  netDrop(notifyLeft = true) {
    if (!this.connected) return;
    this.connected = false;
    this.fire("disconnect");
    if (notifyLeft && this.room) {
      const ids = this.room.roster.filter(x => x !== this.id);
      this.room.peers(this.id).forEach(p => this.server.push(p, "playerLeft",
        { player_id: this.id, player_ids: this.room.started ? this.room.roster.slice() : ids, connected_count: this.room.connectedCount() }));
    }
  }
  netRestore(notifyJoin = true) {
    if (this.connected || this.left) return;
    this.connected = true;
    this.fire("reconnect");
    if (notifyJoin && this.room) {
      this.room.peers(this.id).forEach(p => this.server.push(p, "playerJoined",
        { player_id: this.id, player_ids: this.room.roster.slice(), connected_count: this.room.connectedCount() }));
    }
  }
  leaveRoom() {
    if (!this.room) return;
    const room = this.room;
    this.left = true;
    this.connected = false;
    if (!room.started) room.roster = room.roster.filter(x => x !== this.id);
    room.members.delete(this.id);
    room.peers(this.id).forEach(p => this.server.push(p, "playerLeft",
      { player_id: this.id, player_ids: room.roster.slice(), connected_count: room.connectedCount() }));
    this.room = null;
  }
  // ── the Usion API surface the game actually uses ──────────────────────
  api() {
    const self = this;
    const srv = this.server;
    const later = (fn) => new Promise((res, rej) => {
      this.clock.setTimeout(self, () => { try { res(fn()); } catch (e) { rej(e); } }, srv.opts.latency);
    });
    return {
      init(cb) { self.initCb = cb; },
      getLanguage: () => "mn",
      getLaunchParams: () => Object.assign({}, self.launch),
      permissions: { request: () => Promise.resolve({ granted: false }) },
      notify: { send: (m) => { self.calls.notify.push(m); return Promise.resolve({ delivered: "blocked" }); } },
      cloud: { get: () => Promise.resolve(null), set: () => Promise.resolve({}), shared: { incr: () => Promise.resolve({}) } },
      leaderboard: { submit: (v) => { self.calls.leaderboard.push(v); return Promise.resolve({ success: true }); } },
      game: {
        connect: () => later(() => ({ success: true })),
        join: (roomId) => later(() => {
          const room = srv.room(roomId);
          self.room = room;
          self.left = false;
          self.connected = true;
          if (!room.roster.includes(self.id)) room.roster.push(self.id);
          room.members.set(self.id, self);
          const ack = {
            player_ids: room.roster.slice(),
            connected_count: room.connectedCount(),
            sequence: room.seq,
            game_state: room.state,
          };
          srv.push(self, "joined", ack);
          room.peers(self.id).forEach(p => srv.push(p, "playerJoined",
            { player_id: self.id, player_ids: room.roster.slice(), connected_count: room.connectedCount() }));
          return { room_id: roomId, player_id: self.id, sequence: room.seq };
        }),
        leave: () => { self.leaveRoom(); return Promise.resolve({ success: true }); },
        isMultiplayer: () => self.launch.mode === "multiplayer",
        action: (type, data) => later(() => {
          if (!self.connected || !self.room) throw new Error("offline");
          const room = self.room;
          const entry = {
            sequence: ++room.seq, player_id: self.id,
            action_type: type, action_data: JSON.parse(JSON.stringify(data || {})),
          };
          room.log.push(entry);
          [...room.members.values()].forEach(p => srv.push(p, "action", JSON.parse(JSON.stringify(entry))));
          return { success: true, sequence: entry.sequence };
        }),
        realtime: (type, data) => {
          if (!self.connected || !self.room) return Promise.resolve({ success: false });
          const payload = { player_id: self.id, action_type: type, action_data: JSON.parse(JSON.stringify(data || {})) };
          self.room.peers(self.id).forEach(p => srv.push(p, "realtime", JSON.parse(JSON.stringify(payload))));
          return Promise.resolve({ success: true });
        },
        setState: (state) => later(() => {
          self.calls.setState++;
          if (!self.connected || !self.room) return { success: false, code: "OFFLINE" };
          const room = self.room;
          const seq = Number(state && state.seq);
          if (Number.isFinite(seq) && seq < room.stateSeq) {
            self.calls.setStateStale++;
            return { success: false, code: "STALE_STATE" };
          }
          room.state = JSON.parse(JSON.stringify(state));
          room.stateSeq = Number.isFinite(seq) ? seq : room.seq;
          return { success: true };
        }),
        requestSync: (lastSeq) => {
          if (!self.connected || !self.room) return Promise.resolve({ success: false });
          const room = self.room;
          const from = Number(lastSeq) || 0;
          const actions = SYNC_MODELS[srv.opts.syncModel](room, from).map(a => JSON.parse(JSON.stringify(a)));
          srv.push(self, "sync", { actions, game_state: room.state ? JSON.parse(JSON.stringify(room.state)) : null, sequence: room.seq });
          return Promise.resolve({ success: true });
        },
        requestRematch: () => {
          self.calls.rematch++;
          if (self.room) self.room.peers(self.id).forEach(p => srv.push(p, "rematch", { player_id: self.id }));
          return Promise.resolve({ success: true });
        },
        reportResult: (r) => {
          const rec = { by: self.id, payload: JSON.parse(JSON.stringify(r)) };
          self.calls.reportResult.push(rec);
          srv.reports.push(rec);
          return Promise.resolve({ success: true });
        },
        getLastSequence: () => (self.room ? self.room.seq : 0),
        onJoined: (cb) => { self.handlers.joined = cb; },
        onPlayerJoined: (cb) => { self.handlers.playerJoined = cb; },
        onPlayerLeft: (cb) => { self.handlers.playerLeft = cb; },
        onAction: (cb) => { self.handlers.action = cb; },
        onRealtime: (cb) => { self.handlers.realtime = cb; },
        onSync: (cb) => { self.handlers.sync = cb; },
        onDisconnect: (cb) => { self.handlers.disconnect = cb; },
        onReconnect: (cb) => { self.handlers.reconnect = cb; },
        onRematchRequest: (cb) => { self.handlers.rematch = cb; },
        onRoomAssigned: (cb) => { self.handlers.roomAssigned = cb; },
      },
    };
  }
}

module.exports = { Server, SDK, SYNC_MODELS };
