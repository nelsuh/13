// Reminder records. MongoDB when MONGODB_URI is set (the game host container is
// read-only and replaced on every deploy), otherwise memory (local runs and tests).
//
//   prefs  { _id: userId, enabled, decided, locale, updatedAt }
//   events { _id: "<startsAt>:<userId>", userId, startsAt, status, retryAt, claimedAt }
//          status: pending → sending → sent | skipped   (one reminder per player per event)

const CLAIM_STALE_MS = 2 * 60 * 1000;   // a send that never finished (crash) becomes claimable again

export function memoryStore() {
  const prefs = new Map(), events = new Map();
  return {
    kind: 'memory',
    async getPref(userId) { return prefs.get(userId) || null; },
    async setPref(userId, patch) {
      const next = { ...(prefs.get(userId) || {}), ...patch, _id: userId, updatedAt: new Date() };
      prefs.set(userId, next); return next;
    },
    async addEvent(userId, startsAt) {
      const id = `${startsAt}:${userId}`;
      if (!events.has(id)) events.set(id, { _id: id, userId, startsAt, status: 'pending', retryAt: 0, claimedAt: 0 });
    },
    async removeEvent(userId, startsAt) {
      const e = events.get(`${startsAt}:${userId}`);
      if (e && e.status === 'pending') events.delete(e._id);
    },
    async upcomingEvents(userId, now) {
      return [...events.values()].filter(e => e.userId === userId && e.startsAt > now).map(e => e.startsAt).sort((a, b) => a - b);
    },
    /** Atomically take the events whose reminder is due now. */
    async claimDue(now, leadMs, limit) {
      const out = [];
      for (const e of events.values()) {
        if (out.length >= limit) break;
        if (e.startsAt - leadMs > now || e.startsAt <= now) continue;
        const free = (e.status === 'pending' && e.retryAt <= now) || (e.status === 'sending' && e.claimedAt < now - CLAIM_STALE_MS);
        if (!free) continue;
        e.status = 'sending'; e.claimedAt = now;
        out.push({ ...e });
      }
      return out;
    },
    async finish(id, status, extra = {}) { const e = events.get(id); if (e) Object.assign(e, { status }, extra); },
    async prune(before) { for (const [id, e] of events) if (e.startsAt < before) events.delete(id); },
    async close() {},
  };
}

export async function mongoStore(uri, dbName = 't13') {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(dbName);
  const prefs = db.collection('reminder_prefs'), events = db.collection('reminder_events');
  await events.createIndex({ status: 1, startsAt: 1 });
  await events.createIndex({ userId: 1, startsAt: 1 });
  return {
    kind: 'mongo',
    async getPref(userId) { return prefs.findOne({ _id: userId }); },
    async setPref(userId, patch) {
      return prefs.findOneAndUpdate({ _id: userId }, { $set: { ...patch, updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' });
    },
    async addEvent(userId, startsAt) {
      await events.updateOne({ _id: `${startsAt}:${userId}` },
        { $setOnInsert: { userId, startsAt, status: 'pending', retryAt: 0, claimedAt: 0 } }, { upsert: true });
    },
    async removeEvent(userId, startsAt) { await events.deleteOne({ _id: `${startsAt}:${userId}`, status: 'pending' }); },
    async upcomingEvents(userId, now) {
      const list = await events.find({ userId, startsAt: { $gt: now } }, { projection: { startsAt: 1 } }).sort({ startsAt: 1 }).toArray();
      return list.map(e => e.startsAt);
    },
    async claimDue(now, leadMs, limit) {
      const out = [];
      const window = { startsAt: { $gt: now, $lte: now + leadMs } };
      while (out.length < limit) {
        const e = await events.findOneAndUpdate(
          { ...window, $or: [{ status: 'pending', retryAt: { $lte: now } },
                             { status: 'sending', claimedAt: { $lt: now - CLAIM_STALE_MS } }] },
          { $set: { status: 'sending', claimedAt: now } }, { returnDocument: 'after' });
        if (!e) break;
        out.push(e);
      }
      return out;
    },
    async finish(id, status, extra = {}) { await events.updateOne({ _id: id }, { $set: { status, ...extra } }); },
    async prune(before) { await events.deleteMany({ startsAt: { $lt: before } }); },
    async close() { await client.close(); },
  };
}
