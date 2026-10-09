import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Config } from '../config.ts';
import { H } from './internal.ts';

/**
 * The public request portal process (SAGA_SURFACE=portal). It is the only thing behind Cloudflare Tunnel, and
 * it holds no upstream keys and no database: every /api/portal/* call is forwarded to the admin container's
 * internal API with INTERNAL_SECRET, carrying the guest's session token. Its route table has nothing else.
 */

export type InternalFetch = (path: string, init: RequestInit) => Promise<Response>;

const MAX_BODY = 64 * 1024;
const FORWARD_HEADERS = ['content-type', 'accept', 'x-csrf-token'];

/** Fixed-window limiter, per client IP. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear();
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

export function portalCookieName(config: Config) {
  return config.PORTAL_PUBLIC_URL.startsWith('https://') ? '__Host-saga_req' : 'saga_req';
}

export function createPortalApp(config: Config, fetchInternal?: InternalFetch): Hono {
  const app = new Hono();
  const internal: InternalFetch = fetchInternal ?? ((path, init) => fetch(new URL(path, config.INTERNAL_URL), { ...init, signal: AbortSignal.timeout(60_000) }));
  const cookieName = portalCookieName(config);
  const secure = config.PORTAL_PUBLIC_URL.startsWith('https://');
  const general = new Limiter(600, 5 * 60_000);
  const auth = new Limiter(40, 15 * 60_000);

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https://image.tmdb.org https://plex.tv https://*.plex.tv; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  app.get('/healthz', (c) => c.json({ ok: true, surface: 'portal' }));

  // The portal is only reachable through cloudflared, which sets cf-connecting-ip.
  const clientIp = (c: Context) => {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return c.req.header('cf-connecting-ip') ?? env?.incoming?.socket?.remoteAddress ?? 'unknown';
  };

  app.all('/api/portal/*', async (c) => {
    const ip = clientIp(c);
    const rest = c.req.path.slice('/api/portal'.length) || '/';
    if (!general.allow(ip) || (rest.startsWith('/auth/') && !auth.allow(ip))) return c.json({ error: 'Slow down a little and try again shortly.' }, 429);
    const headers: Record<string, string> = { [H.secret]: config.INTERNAL_SECRET ?? '', [H.ip]: ip };
    for (const h of FORWARD_HEADERS) {
      const v = c.req.header(h);
      if (v) headers[h] = v;
    }
    const token = getCookie(c, cookieName);
    if (token) headers[H.session] = token;
    let body: string | undefined;
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (Number(c.req.header('content-length') ?? 0) > MAX_BODY) return c.json({ error: 'Request too large' }, 413);
      body = await c.req.text();
      if (body.length > MAX_BODY) return c.json({ error: 'Request too large' }, 413);
    }
    const url = new URL(c.req.url);
    let res: Response;
    try {
      res = await internal(`/internal/portal${rest}${url.search}`, { method: c.req.method, headers, body });
    } catch {
      return c.json({ error: 'Saga is restarting; try again in a moment.' }, 503);
    }
    const set = res.headers.get(H.setSession);
    if (set) setCookie(c, cookieName, set, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 60 * 86400 });
    else if (res.headers.get(H.clearSession) && token) deleteCookie(c, cookieName, { path: '/', secure });
    return c.body(await res.text(), res.status as 200, {
      'content-type': res.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
