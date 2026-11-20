// Usion platform calls made by the 13 server: who is this player (iframe token),
// and a push to one player while the app is closed (signed with the service secret).
import { createHmac } from 'node:crypto';

/** Verifies an iframe token server-side; never trust a playerId sent by the client. */
export function createIdentity({ serviceId = '', apiUrl = 'https://mobile.mongolai.mn', fetcher = fetch, devMode = false } = {}) {
  const cache = new Map(); // token -> { user, expires }
  return {
    enforced: Boolean(serviceId),
    /** { id } when valid, null when not. Throws when Usion is unreachable. */
    async verify(token) {
      if (typeof token !== 'string' || token.length < 5 || token.length > 4096) return null;
      // Local runs without a service id: "dev:<id>" stands in for a token.
      if (!serviceId) return devMode && token.startsWith('dev:') ? { id: token.slice(4, 80) } : null;
      const hit = cache.get(token);
      if (hit && hit.expires > Date.now()) return hit.user;
      const response = await fetcher(`${apiUrl}/iframe/verify-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, expected_service_id: serviceId }), signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 500) throw new Error('USION_UNAVAILABLE');
      const data = response.ok ? await response.json() : null;
      if (!data?.user_id) return null;
      const user = { id: String(data.user_id) };
      if (cache.size > 2000) cache.clear();
      cache.set(token, { user, expires: Date.now() + 60000 });
      return user;
    },
  };
}

const TEXT = {
  mn: (min) => ({ title: `Тэмцээн ${min} минутын дараа эхэлнэ! 🏆`,
    body: 'Таны ширээ бэлэн. Одоо орж хүлээгээрэй — эхлэх цагаас 1 минутын дотор ороогүй бол хасагдана.' }),
  en: (min) => ({ title: `The tournament starts in ${min} minutes! 🏆`,
    body: 'Your table is ready. Sit down now — anyone not seated within a minute of the start is out.' }),
};

export function createNotifier({ serviceId = '', secret = '', apiUrl = 'https://mobile.mongolai.mn', fetcher = fetch } = {}) {
  const enabled = Boolean(serviceId && secret.length >= 16);
  return {
    enabled,
    async send(userId, { locale = 'mn', leadMs = 180000 } = {}) {
      if (!enabled) throw new Error('NOTIFY_NOT_CONFIGURED');
      const text = (TEXT[locale] || TEXT.mn)(Math.round(leadMs / 60000));
      const body = JSON.stringify({ user_id: userId, title: text.title, body: text.body, path: '/tournament' });
      const response = await fetcher(`${apiUrl}/services/${encodeURIComponent(serviceId)}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'X-Usion-Signature': createHmac('sha256', secret).update(body).digest('hex') },
        body, signal: AbortSignal.timeout(5000),
      });
      const result = response.ok ? await response.json().catch(() => null) : null;
      if (!result?.success) throw new Error('NOTIFY_DELIVERY_FAILED');
      return result;
    },
  };
}
