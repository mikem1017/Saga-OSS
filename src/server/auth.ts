import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from './db.ts';
import type { Config } from './config.ts';

export const SESSION_COOKIE = 'saga_sid';
const SESSION_DAYS = 30;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const N = Number(n);
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N, r: Number(r), p: Number(p), maxmem: 128 * N * Number(r) * 2 });
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionUser {
  id: number;
  username: string;
  role: string;
  csrf: string;
  sessionId: string;
}

/** Create the first admin from the environment. Existing users are never overwritten. */
export function bootstrapAdmin(db: DB, config: Config): void {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(config.SAGA_ADMIN_USER);
  if (exists || !config.SAGA_ADMIN_PASSWORD) return;
  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
    config.SAGA_ADMIN_USER,
    hashPassword(config.SAGA_ADMIN_PASSWORD),
    'admin',
    Date.now(),
  );
}

export function createSession(db: DB, userId: number, ip: string, ua: string): { token: string; csrf: string } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    csrf,
    now,
    now + SESSION_DAYS * 86400_000,
    ip,
    ua.slice(0, 200),
  );
  return { token, csrf };
}

export function lookupSession(db: DB, token: string | undefined): SessionUser | null {
  if (!token) return null;
  const id = sha256(token);
  const row = db
    .prepare('SELECT s.id AS sid, s.csrf, s.expires_at, u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .get(id) as { sid: string; csrf: string; expires_at: number; id: number; username: string; role: string } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  // Sliding expiry, written at most once a day.
  if (row.expires_at - Date.now() < (SESSION_DAYS - 1) * 86400_000)
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + SESSION_DAYS * 86400_000, id);
  return { id: row.id, username: row.username, role: row.role, csrf: row.csrf, sessionId: row.sid };
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

/** Login throttling: 5 failures per IP per 15 minutes, 30 overall (slows a distributed guess too). */
export function loginAllowed(db: DB, ip: string): { ok: boolean; retryAfterSec?: number } {
  const since = Date.now() - 15 * 60_000;
  const perIp = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM login_attempts WHERE ip = ? AND ok = 0 AND ts > ?').get(ip, since) as { n: number; first: number | null };
  const global = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND ts > ?').get(since) as { n: number };
  if (perIp.n >= 5) return { ok: false, retryAfterSec: Math.ceil(((perIp.first ?? Date.now()) + 15 * 60_000 - Date.now()) / 1000) };
  if (global.n >= 30) return { ok: false, retryAfterSec: 300 };
  return { ok: true };
}

export function recordLogin(db: DB, ip: string, ok: boolean): void {
  db.prepare('INSERT INTO login_attempts (ip, ts, ok) VALUES (?, ?, ?)').run(ip, Date.now(), ok ? 1 : 0);
}

export function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** The real client address: X-Real-IP / X-Forwarded-For only when the TCP peer is a trusted proxy (TRUSTED_PROXIES). */
export function clientIp(c: Context, trusted: Set<string>): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress ?? 'unknown';
  if (trusted.has(peer)) {
    const real = c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (real) return real;
  }
  return peer;
}

type Vars = { user: SessionUser; ip: string };

export function requireAdmin(db: DB): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const user = lookupSession(db, getCookie(c, SESSION_COOKIE));
    if (!user || user.role !== 'admin') return c.json({ error: 'Not signed in' }, 401);
    // CSRF: every state-changing request carries the per-session token in a header. A cross-site form
    // can't set custom headers, and SameSite=Lax already keeps the cookie off cross-site POSTs.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const sent = c.req.header('x-csrf-token') ?? '';
      const a = Buffer.from(sent);
      const b = Buffer.from(user.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'CSRF token missing or wrong' }, 403);
    }
    c.set('user', user);
    await next();
  };
}
