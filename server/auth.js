// Shared-secret auth. The office can type into your terminals, so it is never served open:
// a login page trades OFFICE_TOKEN for a signed, HttpOnly session cookie.
import crypto from 'node:crypto';

const COOKIE = 'ho_session';
const MAX_AGE = 60 * 60 * 24 * 30;

export function makeAuth(token) {
  const sign = (v) => crypto.createHmac('sha256', token).update(v).digest('hex');
  const session = sign('herdr-office-session-v1');
  const eq = (a, b) => {
    const A = Buffer.from(String(a)), B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  };
  const fails = new Map(); // ip -> [timestamps]

  return {
    enabled: !!token,
    isAuthed(req) {
      if (!token) return true;
      const m = /(?:^|;\s*)ho_session=([0-9a-f]+)/.exec(req.headers.cookie || '');
      if (m && eq(m[1], session)) return true;
      const h = req.headers.authorization;
      return !!(h && h.startsWith('Bearer ') && eq(h.slice(7), token));
    },
    tryLogin(ip, supplied) {
      const now = Date.now();
      const recent = (fails.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
      if (recent.length >= 8) return { ok: false, limited: true };
      if (token && eq(supplied || '', token)) return { ok: true };
      recent.push(now);
      fails.set(ip, recent);
      return { ok: false };
    },
    cookie(secure) {
      return `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
    },
    clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`; },
  };
}
