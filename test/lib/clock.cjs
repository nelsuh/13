// Virtual clock shared by every simulated client.
//
// The point of a virtual clock here is not speed, it is FREEZING. A backgrounded
// / locked phone runs no javascript at all, yet wall-clock time keeps moving —
// that is exactly the condition that used to hang this game's table. An owner
// marked `frozen` keeps accruing time but fires no timers, and (see net.cjs)
// drops every message the server pushes at it.

class Clock {
  constructor(start) {
    this.now = start || 1780000000000;      // fixed epoch → reproducible runs
    this.timers = new Map();
    this.nextId = 1;
    this.fired = 0;
  }
  _add(owner, fn, ms, interval) {
    const id = this.nextId++;
    this.timers.set(id, { id, owner, fn, time: this.now + Math.max(0, ms | 0), interval });
    return id;
  }
  setTimeout(owner, fn, ms) { return this._add(owner, fn, ms, 0); }
  setInterval(owner, fn, ms) { return this._add(owner, fn, ms, Math.max(1, ms | 0)); }
  clear(id) { this.timers.delete(id); }
  /** Timers belonging to an owner that will never run again. */
  dropOwner(owner) {
    for (const [id, t] of this.timers) if (t.owner === owner) this.timers.delete(id);
  }
  _nextDue(limit) {
    let best = null;
    for (const t of this.timers.values()) {
      if (t.owner && t.owner.frozen) continue;      // suspended WebView: no JS runs
      if (t.time > limit) continue;
      if (!best || t.time < best.time || (t.time === best.time && t.id < best.id)) best = t;
    }
    return best;
  }
  /**
   * Advance virtual time by `ms`, firing due timers in order. `flush` is awaited
   * after every callback so promise continuations inside the game run too.
   */
  async advance(ms, flush) {
    const limit = this.now + ms;
    let guard = 0;
    for (;;) {
      const t = this._nextDue(limit);
      if (!t) break;
      if (++guard > 500000) throw new Error("clock.advance: runaway timer loop");
      if (t.time > this.now) this.now = t.time;
      if (t.interval) t.time = this.now + t.interval;    // no backlog: one catch-up fire
      else this.timers.delete(t.id);
      this.fired++;
      try { t.fn(); } catch (e) { if (t.owner && t.owner.onError) t.owner.onError(e); else throw e; }
      if (flush) await flush();
    }
    this.now = limit;
    if (flush) await flush();
  }
}

const flush = () => new Promise(r => setImmediate(r));

module.exports = { Clock, flush };
