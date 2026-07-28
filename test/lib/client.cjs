// One simulated player: an isolated vm realm running the REAL 13/script.js on
// top of the stub DOM, the virtual clock and the fake Usion SDK.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Document } = require("./dom.cjs");
const { SDK } = require("./net.cjs");

const GAME_DIR = path.resolve(__dirname, "..", "..");
const HTML = fs.readFileSync(path.join(GAME_DIR, "index.html"), "utf8");
const SCRIPT = fs.readFileSync(path.join(GAME_DIR, "script.js"), "utf8");
const BODY_HTML = /<body>([\s\S]*?)<\/body>/i.exec(HTML)[1].replace(/<script[\s\S]*?<\/script>/gi, "");

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Injected into every realm: drives a move through the REAL UI path (card taps
// + the Play/Pass buttons), so the test exercises humanPlay/humanPass and the
// button-disabled logic rather than calling the engine behind the UI's back.
const UI_HELPERS = `
function __uiPlay() {
  if (!dealActive) return "no-deal";
  if (turn !== mySeat) return "not-my-turn";
  if (pendingAction) return "pending";
  var hand = hands[mySeat] || [];
  if (!hand.length) return "empty-hand";
  var combo = table ? botFollow(hand, table.combo) : botLead(hand, firstPlay);
  if (!combo) {
    if (!table) return "stuck-lead";
    if (passBtn.disabled) return "pass-disabled";
    passBtn.dispatch("click");
    return "pass";
  }
  var used = {}, idx = [];
  combo.cards.forEach(function (pc) {
    for (var i = 0; i < hand.length; i++) {
      if (!used[i] && sameCard(hand[i], pc)) { used[i] = 1; idx.push(i); break; }
    }
  });
  if (idx.length !== combo.cards.length) return "cards-missing";
  idx.forEach(function (i) { var el = handEl.children[i]; if (el) el.dispatch("click"); });
  if (playBtn.disabled) return "play-disabled";
  playBtn.dispatch("click");
  return "play";
}
function __snapshot() {
  return {
    online: online, gameStarted: gameStarted, dealActive: dealActive,
    turn: turn, mySeat: mySeat, numPlayers: numPlayers, loseAt: loseAt,
    pendingAction: pendingAction, awaitingDeal: awaitingDeal, netPaused: netPaused,
    lastSeq: lastSeq, roundMoveNo: roundMoveNo, dealEpoch: dealEpoch, curSeed: curSeed,
    firstDeal: firstDeal, lastWinner: lastWinner, passStreak: passStreak,
    tableLen: table ? table.combo.len : -1, tableSeat: table ? table.seat : -1,
    counts: (hands || []).map(function (h) { return h.length; }),
    totals: (players || []).map(function (p) { return p.total; }),
    outs: (players || []).map(function (p) { return !!p.out; }),
    names: (players || []).map(function (p) { return p.name; }),
    order: (roomPlayerIds || []).slice(),
    present: Array.from(presentIds),
    moveLogLen: moveLog.length,
    lastAction: JSON.parse(JSON.stringify(lastAction || {})),
    passed: Array.from(passed),
    turnLeft: turnLeft, turnTrusted: turnTrusted,
    overlays: {
      setup: setupOverlay.classList.contains("show"),
      lobby: onlineOverlay.classList.contains("show"),
      hand: handOverlay.classList.contains("show"),
      winner: document.getElementById("winnerOverlay").classList.contains("show"),
    },
    turnLine: turnLine.textContent,
    winnerName: document.getElementById("winnerName").textContent,
    status: document.getElementById("onlineStatus").textContent,
  };
}
`;

class Client {
  constructor(opts) {
    const { server, clock, id, name, launch, seed } = opts;
    this.id = id;
    this.name = name;
    this.clock = clock;
    this.server = server;
    this.errors = [];
    this.logs = [];
    this.sdk = new SDK(server, id, name, launch);
    this.sdk.onError = (e) => { this.errors.push(e); };

    const doc = new Document(BODY_HTML);
    this.doc = doc;
    const rnd = mulberry32(seed === undefined ? hash(id) : seed);
    const self = this;

    const store = new Map();
    const localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };

    class VDate extends Date {
      constructor(...a) { if (!a.length) super(clock.now); else super(...a); }
      static now() { return clock.now; }
    }

    const sandbox = {
      document: doc,
      localStorage,
      Date: VDate,
      Math: Object.assign(Object.create(Math), { random: rnd }),
      console: {
        log: (...a) => self.logs.push(a.join(" ")),
        warn: (...a) => self.logs.push("WARN " + a.join(" ")),
        error: (...a) => { self.logs.push("ERROR " + a.join(" ")); self.errors.push(new Error(a.join(" "))); },
      },
      setTimeout: (fn, ms) => clock.setTimeout(self.sdk, fn, ms),
      setInterval: (fn, ms) => clock.setInterval(self.sdk, fn, ms),
      clearTimeout: (id) => clock.clear(id),
      clearInterval: (id) => clock.clear(id),
      requestAnimationFrame: (fn) => clock.setTimeout(self.sdk, fn, 16),
      Usion: this.sdk.api(),
      innerWidth: 400,
      innerHeight: 800,
      navigator: { language: "mn-MN" },
      addEventListener: () => {},
      removeEventListener: () => {},
      JSON, Promise, Object, Array, String, Number, Boolean, Set, Map, Error, RegExp, Symbol,
      isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    this.ctx = vm.createContext(sandbox);
    this.sandbox = sandbox;

    vm.runInContext(SCRIPT, this.ctx, { filename: "script.js" });
    vm.runInContext(UI_HELPERS, this.ctx, { filename: "__ui_helpers" });
  }

  /** Fire the stored Usion.init callback with a launch config. */
  start(config) {
    this.initPromise = Promise.resolve()
      .then(() => this.sdk.initCb && this.sdk.initCb(config))
      .catch(e => { this.errors.push(e); });
    return this.initPromise;
  }
  read(expr) { return vm.runInContext("(" + expr + ")", this.ctx); }
  run(code) { return vm.runInContext(code, this.ctx); }
  snap() { return this.read("__snapshot()"); }
  uiPlay() { return this.read("__uiPlay()"); }
  el(id) { return this.doc.getElementById(id); }
  click(id) { const e = this.el(id); if (!e) throw new Error("no element #" + id); e.dispatch("click"); return e; }

  get frozen() { return this.sdk.frozen; }
  freeze() { this.sdk.freeze(); this.doc.hidden = true; this.doc.visibilityState = "hidden"; }
  thaw() {
    this.sdk.thaw();
    this.doc.hidden = false; this.doc.visibilityState = "visible";
    this.doc.dispatch("visibilitychange");
  }
  netDrop(notify = true) { this.sdk.netDrop(notify); }
  netRestore(notify = true) { this.sdk.netRestore(notify); }
  leaveRoom() { this.sdk.leaveRoom(); }
  /** Is this client's javascript still running? A dropped socket still is. */
  get alive() { return !this.sdk.frozen && !this.sdk.left; }
  get connected() { return this.sdk.connected; }
}

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

module.exports = { Client };
