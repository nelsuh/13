// Scenario helpers: build a table of simulated clients, run the lobby, drive a
// match to its end, and scream if the table ever stops making progress.

const { Clock, flush } = require("./clock.cjs");
const { Server } = require("./net.cjs");
const { Client } = require("./client.cjs");

const NAMES = ["Alice", "Bob", "Chuck", "Dana"];

class World {
  constructor(opts = {}) {
    this.clock = new Clock();
    this.server = new Server(this.clock, { latency: opts.latency || 20, syncModel: opts.syncModel || "tail" });
    this.roomId = opts.roomId || "room1";
    this.clients = [];
    this.trace = [];
  }
  add(id, name, launch) {
    const c = new Client({ server: this.server, clock: this.clock, id, name, launch });
    this.clients.push(c);
    return c;
  }
  byId(id) { return this.clients.find(c => c.id === id); }
  get room() { return this.server.rooms.get(this.roomId); }
  async advance(ms) { await this.clock.advance(ms, flush); }
  /** Every client that could still be running javascript. */
  live() { return this.clients.filter(c => c.alive); }
  /**
   * Clients we let take their turn: running, and either offline-by-design (a
   * solo vs-bots game, which needs no server) or actually reachable.
   */
  drivers() { return this.clients.filter(c => c.alive && (c.connected || !c.sdk.room)); }
  errors() {
    const out = [];
    this.clients.forEach(c => c.errors.forEach(e => out.push(c.id + ": " + (e && e.stack || e))));
    return out;
  }
}

/** Create `n` online clients that have connected + joined the room. */
async function onlineWorld(n, opts = {}) {
  const w = new World(opts);
  for (let i = 0; i < n; i++) {
    const id = "u" + (i + 1);
    const c = w.add(id, NAMES[i], { mode: "multiplayer", roomId: w.roomId });
    c.start({ userId: id, userName: NAMES[i], userAvatar: opts.avatars && opts.avatars[i],
              roomId: w.roomId, playerIds: [] });
    await w.advance(50);       // stagger joins so the roster order is deterministic
  }
  await w.advance(600);
  return w;
}

/** Advance in slices until `pred()` holds; returns whether it ever did. */
async function eventually(w, pred, ms = 60000, step = 500) {
  const until = w.clock.now + ms;
  while (w.clock.now < until) {
    if (pred()) return true;
    await w.advance(step);
  }
  return !!pred();
}

/** Ready everyone up and let the host deal. Returns once the first round is live. */
async function startMatch(w, opts = {}) {
  const seats = opts.seats || w.clients;
  const host = seats[0];
  for (const c of seats) { c.click("readyBtn"); await w.advance(120); }
  if (opts.loseAt) {
    const btn = host.doc.querySelectorAll("#lobbyLoseRow .count-btn").find(b => Number(b.getAttribute("data-lose")) === opts.loseAt);
    if (btn) { btn.dispatch("click"); await w.advance(200); }
  }
  // Wait for the ready broadcasts to land before pressing Start — on a slow link
  // the button is still disabled, and a disabled button ignores the press.
  const armed = await eventually(w, () => host.el("startGameBtn").disabled === false, 30000, 250);
  if (!armed) throw new Error("Start never unlocked:\n" + dump(w));
  host.click("startGameBtn");
  await eventually(w, () => seats.every(c => c.snap().dealActive), 30000, 250);
  if (w.room) w.room.started = true;
  return w;
}

const STALL_MS = 6 * 60 * 1000;         // > (90s turn + 90s untrusted proxy + 10s grace)

function signature(w) {
  return w.live().map(c => {
    const s = c.snap();
    return [c.id, s.dealActive, s.turn, s.counts.join(","), s.totals.join(","), s.outs.join(","),
      s.overlays.winner, s.overlays.hand, s.moveLogLen].join("|");
  }).join(" ;; ");
}

/**
 * Tick the world forward, making every live client take its turn through the UI,
 * until `done()` or the budget runs out. Any long stretch with no state change at
 * all is reported as a DEAD END, with a dump of what every client believed.
 */
async function playOut(w, opts = {}) {
  const done = opts.done || (() => w.live().every(c => c.snap().overlays.winner));
  const budget = opts.budget || 60 * 60 * 1000;
  const step = opts.step || 250;
  let sig = signature(w), sigAt = w.clock.now;
  let divergedAt = 0, divergence = "";
  const tolerate = opts.divergenceMs || 30000;
  const start = w.clock.now;
  while (w.clock.now - start < budget) {
    const skip = opts.skip || [];
    for (const c of (opts.driveOffline ? w.live() : w.drivers())) {
      if (skip.includes(c.id)) continue;
      const s = c.snap();
      if (s.dealActive && s.turn === s.mySeat && !s.pendingAction) {
        const r = c.uiPlay();
        // "play"/"pass" are the healthy outcomes; anything else means the UI
        // refused a move it was being asked for — record it for the assertions.
        if (r !== "play" && r !== "pass") w.trace.push({ t: w.clock.now, who: c.id, uiPlay: r });
      }
      if (opts.each) opts.each(c, s);
    }
    await w.advance(step);
    if (done()) return { ok: true, elapsed: w.clock.now - start };
    if (opts.consistency !== false) {
      const d = consistency(w);
      if (d) {
        // Only a divergence that PERSISTS unchanged is a desync; clients that are
        // catching up flap through different intermediate disagreements.
        if (!divergedAt || d !== divergence) { divergedAt = w.clock.now; divergence = d; }
        else if (w.clock.now - divergedAt > tolerate) {
          return { ok: false, reason: "DESYNC held for " + Math.round((w.clock.now - divergedAt) / 1000) + "s: " + divergence, dump: dump(w) };
        }
      } else { divergedAt = 0; divergence = ""; }
    }
    const now = signature(w);
    if (now !== sig) { sig = now; sigAt = w.clock.now; }
    else if (w.clock.now - sigAt > (opts.stallMs || STALL_MS)) {
      return { ok: false, reason: "DEAD END: no progress for " + Math.round((w.clock.now - sigAt) / 1000) + "s", dump: dump(w) };
    }
  }
  return { ok: false, reason: "budget exhausted (" + Math.round(budget / 1000) + "s) without finishing", dump: dump(w) };
}

function dump(w) {
  return w.clients.map(c => {
    const s = c.snap();
    return `  ${c.id}${c.alive ? "" : c.sdk.frozen ? " [FROZEN]" : c.sdk.left ? " [LEFT]" : " [OFFLINE]"}: ` +
      `seat=${s.mySeat} deal=${s.dealActive} turn=${s.turn} pending=${s.pendingAction} awaitingDeal=${s.awaitingDeal} ` +
      `counts=[${s.counts}] totals=[${s.totals}] outs=[${s.outs}] ` +
      `overlays=${Object.keys(s.overlays).filter(k => s.overlays[k]).join("+") || "none"} ` +
      `line="${s.turnLine}" status="${s.status}"`;
  }).join("\n");
}

/** Every running, connected, seated client must believe the same thing. */
function consistency(w) {
  const live = w.clients.filter(c => c.alive && c.connected && c.snap().gameStarted);
  if (live.length < 2) return null;
  const keys = ["dealActive", "turn", "curSeed", "roundMoveNo", "passStreak", "tableLen", "tableSeat"];
  const base = live[0].snap();
  for (const c of live.slice(1)) {
    const s = c.snap();
    for (const k of keys) {
      if (JSON.stringify(s[k]) !== JSON.stringify(base[k])) {
        return `${c.id}.${k}=${JSON.stringify(s[k])} but ${live[0].id}.${k}=${JSON.stringify(base[k])}\n` + dump(w);
      }
    }
    for (const k of ["counts", "totals", "outs"]) {
      if (JSON.stringify(s[k]) !== JSON.stringify(base[k])) {
        return `${c.id}.${k}=${JSON.stringify(s[k])} but ${live[0].id}.${k}=${JSON.stringify(base[k])}\n` + dump(w);
      }
    }
  }
  return null;
}

/** The SDK's auto-rejoin after a real exit: join the room again from scratch. */
async function rejoin(w, c, ms = 1500) {
  c.run(`Usion.game.join(${JSON.stringify(w.roomId)}).catch(function () {})`);
  await w.advance(ms);
}

/** Drive the table until `pred()` holds, without letting `skip` clients act. */
async function driveUntil(w, pred, opts = {}) {
  return playOut(w, Object.assign({ done: pred, budget: 10 * 60 * 1000, consistency: false }, opts));
}

module.exports = { World, onlineWorld, startMatch, playOut, driveUntil, rejoin, eventually, consistency, dump, signature, NAMES, flush };
