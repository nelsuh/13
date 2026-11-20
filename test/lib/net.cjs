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
  // `lingeringCount` models a relay whose connected_count counts room MEMBERSHIP
  // rather than live sockets, so somebody who closed the app days ago is still
  // reported as connected. A client cannot then use the count to tell a live
  // opponent from a ghost — which is how a departed player keeps appearing at
  // the table.
  connectedCount() { return this.server.opts.lingeringCount ? this.roster.length : this.connectedIds().length; }
  peers(exceptId) { return [...this.members.values()].filter(s => s.id !== exceptId); }
}

class Server {
  constructor(clock, opts) {
    this.clock = clock;
    // bareJoinAck models a relay whose join acknowledgement carries the roster
    // but NOT the room's checkpoint — the state only ever arrives on requestSync.
    // A client cannot tell from that ack whether the table it just walked into is
    // running, which is the condition the live "everybody stuck on the cover"
    // report was made under.
    this.opts = Object.assign({ latency: 20, syncModel: "tail", bareJoinAck: false }, opts || {});
    this.rooms = new Map();
    this.sharedKV = new Map();
    this.reports = [];               // every Usion.game.reportResult payload
    // strictRooms: the REAL relay's rules (backend realtime/game_handlers.py
    // handle_game_join): a room must have been created over REST
    // (POST /games/rooms) and you must be one of its players (POST
    // /games/rooms/{id}/join) before game:join admits you. Without it this fake
    // makes up any room you name — which is how the first tournament build
    // passed here and seated nobody in production.
    this.roomSeq = 0;
    this.worldSeq = 0;
    this.restLog = [];
    this.dropNext = [];              // [{ to, type }] one-shot delivery drops
    this.log = [];                   // transport trace, for debugging a failure
  }
  room(id) {
    if (!this.rooms.has(id)) this.rooms.set(id, new Room(this, id));
    return this.rooms.get(id);
  }
  /** POST /games/rooms — the server names the room; the creator is its first player. */
  createRoom(hostId, max) {
    const r = this.room("room_" + (++this.roomSeq));
    r.created = true; r.players = [hostId]; r.max = max || 4;
    return r;
  }
  /**
   * mm:join {mode:"world"} — backend realtime/matchmaking_handlers.py _join_world:
   * the world you are already in → atomic backfill into a world with space →
   * a fresh world. max_players comes from the service (13: 4).
   */
  joinWorld(userId) {
    const worlds = [...this.rooms.values()].filter(r => r.world);
    let r = worlds.find(w => w.players.includes(userId));
    if (!r) {
      r = worlds.find(w => w.players.length < w.max);
      if (r) r.players.push(userId);
    }
    if (!r) {
      r = this.room("world_" + (++this.worldSeq));
      r.created = true; r.world = true; r.players = [userId]; r.max = this.opts.worldMax || 4;
    }
    return { roomId: r.id, playerIds: r.players.slice() };
  }
  /** A fetch() for one user speaking the two room endpoints, with relay latency. */
  restFetch(userId) {
    return (url, init) => new Promise(resolve => {
      this.clock.setTimeout(null, () => {
        const m = /\/games\/rooms(?:\/([^/?]+)\/join)?$/.exec(String(url));
        let status = 200, body;
        if (!m || (init && init.method) !== "POST") { status = 404; body = { detail: "Not Found" }; }
        else if (!m[1]) {
          const r = this.createRoom(userId);
          body = { id: r.id, player_ids: r.players.slice(), max_players: r.max, status: "waiting" };
        } else {
          const r = this.rooms.get(decodeURIComponent(m[1]));
          if (!r || !r.created) { status = 404; body = { detail: "Game room not found" }; }
          else if (!r.players.includes(userId) && r.players.length >= r.max) { status = 400; body = { detail: "Game room is full" }; }
          else {
            if (!r.players.includes(userId)) r.players.push(userId);
            body = { id: r.id, player_ids: r.players.slice(), max_players: r.max };
          }
        }
        this.restLog.push({ userId, url: String(url), status });
        resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
      }, this.opts.latency);
    });
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
    this.calls = { reportResult: [], leaderboard: [], rematch: 0, setState: 0, setStateStale: 0, requestSync: 0, action: 0 };
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
    if (!notifyLeft || !this.room) return;
    // What the real relay does with a dropped socket (backend server.py
    // disconnect + _game_disconnect_grace): "reconnecting" now, then "gone"
    // 15 s later unless the player rejoined. It NEVER sends player_left for a
    // drop — only game:leave and a heartbeat prune do. This fake used to send
    // player_left, which is how a game that ignored "gone" passed here and left
    // dropped players seated forever in production.
    // dropModel "left" keeps the old shortcut for a test that wants it.
    const room = this.room;
    if (this.server.opts.dropModel === "left") {
      const ids = room.roster.filter(x => x !== this.id);
      room.peers(this.id).forEach(p => this.server.push(p, "playerLeft",
        { player_id: this.id, player_ids: room.started ? room.roster.slice() : ids, connected_count: room.connectedCount() }));
      return;
    }
    const drop = this.dropEpoch = (this.dropEpoch || 0) + 1;
    room.peers(this.id).forEach(p => this.server.push(p, "playerConnection",
      { room_id: room.id, player_id: this.id, state: "reconnecting" }));
    this.clock.setTimeout(null, () => {
      if (this.connected || this.dropEpoch !== drop || this.room !== room) return;
      room.peers(this.id).forEach(p => this.server.push(p, "playerConnection",
        { room_id: room.id, player_id: this.id, state: "gone" }));
    }, Server.DISCONNECT_GRACE_MS);
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
    // World seats free up on leave so backfill can hand them out (handle_game_leave).
    if (room.world) room.players = room.players.filter(x => x !== this.id);
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
      cloud: { get: () => Promise.resolve(null), set: () => Promise.resolve({}), shared: {
        incr: () => Promise.resolve({}),
        get: key => Promise.resolve(srv.sharedKV.has(key) ? JSON.parse(JSON.stringify(srv.sharedKV.get(key))) : null),
        set: (key, value) => { srv.sharedKV.set(key, JSON.parse(JSON.stringify(value))); return Promise.resolve({success:true}); },
        keys: () => Promise.resolve([...srv.sharedKV.keys()]),
        remove: key => Promise.resolve({ success: true, removed: srv.sharedKV.delete(key) })
      } },
      leaderboard: { submit: (v) => { self.calls.leaderboard.push(v); return Promise.resolve({ success: true }); } },
      game: {
        // `failConnect` simulates a relay we cannot reach at all, so the game has
        // to fall back to a local table instead of stranding the player.
        connect: () => later(() => {
          if (self.failConnect) throw new Error("connect failed");
          return { success: true };
        }),
        join: (roomId) => later(() => {
          if (srv.opts.strictRooms) {
            const r = srv.rooms.get(roomId);
            if (!r || !r.created) throw new Error("Game room not found");
            if (!r.players.includes(self.id)) {
              // World rooms auto-admit non-members while there is space.
              if (!r.world) throw new Error("Not a participant in this room");
              if (r.players.length >= r.max) throw new Error("World room is full");
              r.players.push(self.id);
            }
          }
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
            game_state: srv.opts.bareJoinAck ? null : room.state,
          };
          srv.push(self, "joined", ack);
          room.peers(self.id).forEach(p => srv.push(p, "playerJoined",
            { player_id: self.id, player_ids: room.roster.slice(), connected_count: room.connectedCount() }));
          return { room_id: roomId, player_id: self.id, sequence: room.seq };
        }),
        // The real SDK keeps the room it last joined on game.roomId.
        get roomId() { return self.room ? self.room.id : null; },
        leave: () => { self.leaveRoom(); return Promise.resolve({ success: true }); },
        // Only on a world-tagged service (opts.worlds); otherwise the SDK call
        // fails with NOT_WORLD_SERVICE, as 13 does until it carries the tag.
        joinWorld: () => later(() => {
          if (!srv.opts.worlds) { const e = new Error("Service does not support world rooms"); e.code = "NOT_WORLD_SERVICE"; throw e; }
          return srv.joinWorld(self.id);
        }),
        isMultiplayer: () => self.launch.mode === "multiplayer",
        action: (type, data) => later(() => {
          self.calls.action++;
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
          self.calls.requestSync++;
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
        onPlayerConnection: (cb) => { self.handlers.playerConnection = cb; },
        onAction: (cb) => { self.handlers.action = cb; },
        onRealtime: (cb) => { self.handlers.realtime = cb; },
        onSync: (cb) => { self.handlers.sync = cb; },
        onDisconnect: (cb) => { self.handlers.disconnect = cb; },
        onReconnect: (cb) => { self.handlers.reconnect = cb; },
        onRematchRequest: (cb) => { self.handlers.rematch = cb; },
        onRoomAssigned: (cb) => { self.handlers.roomAssigned = cb; },
        // The host's friend picker. launch.inviteRoom = the room the host makes
        // when somebody is picked; launch.inviteCancel = the player closes it.
        // Like the real host: set roomId, fire onRoomAssigned, join us, resolve.
        invite() {
          const game = this;
          self.calls.invite = (self.calls.invite || 0) + 1;
          return later(() => {
            if (self.launch.inviteCancel || !self.launch.inviteRoom) return { success: false, invited: [] };
            const rid = self.launch.inviteRoom;
            self.launch.roomId = rid;
            self.fire("roomAssigned", { roomId: rid });
            game.join(rid).catch(() => {});
            return { success: true, roomId: rid, invited: [] };
          });
        },
      },
    };
  }
}

// backend realtime/server.py GAME_DISCONNECT_GRACE_S
Server.DISCONNECT_GRACE_MS = 15000;

module.exports = { Server, SDK, SYNC_MODELS };
