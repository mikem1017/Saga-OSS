import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db.ts';
import type { Config } from '../config.ts';
import { detectList } from '../services/lists.ts';
import { UpstreamError } from '../http.ts';
import { log } from '../log.ts';
import {
  createGuestSession,
  createMagicLink,
  destroyGuestSession,
  lookupGuestSession,
  portalAuthAllowed,
  recordPortalAuth,
  redeemMagicLink,
  signInWithPlex,
  usableInvite,
  type Guest,
  type SignInResult,
} from './guests.ts';
import { RequestError } from './requests.ts';
import type { PortalService } from './service.ts';

/** Header names shared with the portal process. */
export const H = {
  secret: 'x-saga-internal',
  ip: 'x-saga-client-ip',
  session: 'x-saga-session',
  setSession: 'x-saga-session-set',
  clearSession: 'x-saga-session-clear',
} as const;

export type PortalBackend = Pick<PortalService, 'requests' | 'notifier' | 'rails' | 'rail' | 'search' | 'title' | 'comingSoon' | 'status'> & {
  plexTv: Pick<PortalService['plexTv'], 'createPin' | 'authUrl' | 'pinToken' | 'account' | 'relation'>;
};

type Env = { Variables: { guest: Guest; ip: string } };

const mediaType = z.enum(['movie', 'tv']);

/**
 * The admin process's internal API for the portal: mounted on its own port that only the compose network can
 * reach, and every call must carry INTERNAL_SECRET. Guest identity comes from the guest's session token, which
 * the portal forwards; the portal is never trusted to say who the guest is.
 */
export function createInternalApp(db: DB, config: Config, backend: PortalBackend): Hono<Env> {
  const app = new Hono<Env>();
  const secret = Buffer.from(config.INTERNAL_SECRET ?? '');
  const pins = new Map<number, { createdAt: number }>();

  app.use('*', async (c, next) => {
    const sent = Buffer.from(c.req.header(H.secret) ?? '');
    if (!secret.length || sent.length !== secret.length || !timingSafeEqual(sent, secret)) return c.json({ error: 'Forbidden' }, 403);
    c.set('ip', c.req.header(H.ip) ?? 'unknown');
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof RequestError) return c.json({ error: err.message, code: err.code }, err.code === 'quota' || err.code === 'already' || err.code === 'state' ? 409 : 400);
    if (err instanceof z.ZodError) return c.json({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    if (err instanceof UpstreamError) return c.json({ error: 'A service Saga depends on is not answering. Try again in a minute.' }, 502);
    log.error(`internal ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: 'Something went wrong' }, 500);
  });

  const p = new Hono<Env>();

  const signedIn = (c: Context<Env>, r: SignInResult) => {
    const ip = c.get('ip');
    if (!r.ok) {
      recordPortalAuth(db, ip, false);
      return c.json({ error: r.reason }, 403);
    }
    recordPortalAuth(db, ip, true);
    const { token, csrf } = createGuestSession(db, r.guest.id, ip);
    c.header(H.setSession, token);
    return c.json({ ok: true, username: r.guest.username, created: r.created, csrf });
  };
  const throttled = (c: Context<Env>) => {
    if (portalAuthAllowed(db, c.get('ip'))) return null;
    return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  };

  // ---------- public (no session) ----------
  p.get('/config', (c) => c.json({ vapidPublicKey: config.VAPID_PUBLIC_KEY ?? null, emailSignIn: backend.notifier.emailEnabled }));

  p.get('/auth/invite/:code', (c) => {
    const t = throttled(c);
    if (t) return t;
    const inv = usableInvite(db, c.req.param('code'));
    if (!inv) recordPortalAuth(db, c.get('ip'), false);
    return c.json({ valid: !!inv, email: inv?.email ?? null, role: inv?.role ?? null });
  });

  p.post('/auth/plex/pin', async (c) => {
    const t = throttled(c);
    if (t) return t;
    const body = z.object({ invite: z.string().max(40).optional(), next: z.string().max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    const pin = await backend.plexTv.createPin();
    for (const [id, v] of pins) if (Date.now() - v.createdAt > 15 * 60_000) pins.delete(id);
    pins.set(pin.id, { createdAt: Date.now() });
    const fwd = new URL('/login', config.PORTAL_PUBLIC_URL);
    fwd.searchParams.set('pin', String(pin.id));
    if (body.invite) fwd.searchParams.set('invite', body.invite);
    if (body.next?.startsWith('/')) fwd.searchParams.set('next', body.next);
    return c.json({ pinId: pin.id, authUrl: backend.plexTv.authUrl(pin.code, fwd.toString()) });
  });

  p.post('/auth/plex/check', async (c) => {
    const t = throttled(c);
    if (t) return t;
    const body = z.object({ pinId: z.number().int(), invite: z.string().max(40).optional() }).parse(await c.req.json());
    if (!pins.has(body.pinId)) return c.json({ error: 'That sign-in attempt expired. Start again.' }, 400);
    const token = await backend.plexTv.pinToken(body.pinId);
    if (!token) return c.json({ pending: true });
    pins.delete(body.pinId);
    const acct = await backend.plexTv.account(token);
    let rel = { owner: false, friend: false };
    try {
      rel = await backend.plexTv.relation(acct);
    } catch (err) {
      log.warn(`plex owner/friends check failed: ${err instanceof Error ? err.message : err}`);
    }
    return signedIn(c, signInWithPlex(db, acct, { inviteCode: body.invite, isFriend: rel.friend, isOwner: rel.owner }));
  });

  p.post('/auth/magic/request', async (c) => {
    const t = throttled(c);
    if (t) return t;
    const { email } = z.object({ email: z.string().email().max(200) }).parse(await c.req.json());
    const token = createMagicLink(db, email);
    if (token) await backend.notifier.email(email.trim().toLowerCase(), { kind: 'auth.magic', title: 'Your Saga Requests sign-in link', body: 'This link signs you in once and expires in 20 minutes.', url: `/auth/magic?token=${token}` });
    else recordPortalAuth(db, c.get('ip'), false);
    // Same answer either way, so the form can't be used to find out who is invited.
    return c.json({ ok: true });
  });

  p.post('/auth/magic/redeem', async (c) => {
    const t = throttled(c);
    if (t) return t;
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(await c.req.json());
    return signedIn(c, redeemMagicLink(db, token));
  });

  p.post('/auth/logout', (c) => {
    destroyGuestSession(db, c.req.header(H.session));
    c.header(H.clearSession, '1');
    return c.json({ ok: true });
  });

  // ---------- signed in ----------
  const g = new Hono<Env>();
  g.use('*', async (c, next) => {
    const s = lookupGuestSession(db, c.req.header(H.session));
    if (!s) {
      c.header(H.clearSession, '1');
      return c.json({ error: 'Not signed in' }, 401);
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const a = Buffer.from(c.req.header('x-csrf-token') ?? '');
      const b = Buffer.from(s.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'CSRF token missing or wrong' }, 403);
    }
    c.set('guest', s.guest);
    await next();
  });

  g.get('/me', (c) => {
    const guest = c.get('guest');
    const s = lookupGuestSession(db, c.req.header(H.session))!;
    const u = backend.requests.usage(guest.id);
    return c.json({
      username: guest.username,
      thumb: guest.thumb,
      email: guest.email,
      role: guest.role,
      notifyEmail: guest.notifyEmail,
      limits: guest.limits,
      unlimited: guest.unlimited,
      autoApproveAll: guest.autoApproveAll,
      usage: u,
      watchlist: { url: guest.watchlistUrl, syncedAt: guest.watchlistSyncedAt, note: guest.watchlistNote },
      csrf: s.csrf,
    });
  });

  g.patch('/me', async (c) => {
    const guest = c.get('guest');
    const body = z.object({ notifyEmail: z.boolean().optional(), watchlistUrl: z.string().url().max(500).nullable().optional() }).strict().parse(await c.req.json());
    if (body.notifyEmail !== undefined) db.prepare('UPDATE guests SET notify_email = ? WHERE id = ?').run(body.notifyEmail ? 1 : 0, guest.id);
    if (body.watchlistUrl !== undefined) {
      if (body.watchlistUrl && !detectList(body.watchlistUrl)) return c.json({ error: 'Use a Letterboxd, IMDb, MDBList, TMDB or Trakt list/watchlist link' }, 400);
      db.prepare('UPDATE guests SET watchlist_url = ?, watchlist_synced_at = NULL, watchlist_note = NULL WHERE id = ?').run(body.watchlistUrl, guest.id);
    }
    return c.json({ ok: true });
  });

  g.get('/rails', (c) => c.json(backend.rails(c.get('guest'))));
  g.get('/rail/:id', async (c) => c.json(await backend.rail(c.get('guest'), c.req.param('id'), Number(c.req.query('page') ?? 1))));
  g.get('/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 300);
    if (!q) return c.json({ match: null, page: 1, totalPages: 1, results: [] });
    return c.json(await backend.search(q, Number(c.req.query('page') ?? 1)));
  });
  g.get('/title/:type/:id', async (c) => c.json(await backend.title(c.get('guest'), mediaType.parse(c.req.param('type')), Number(c.req.param('id')))));

  g.get('/requests', (c) => c.json(backend.requests.forGuest(c.get('guest').id)));
  g.post('/requests', async (c) => {
    const body = z.object({ mediaType, tmdbId: z.number().int().positive(), seasons: z.array(z.number().int().min(1).max(500)).max(100).nullable().optional() }).parse(await c.req.json());
    return c.json(await backend.requests.create(c.get('guest'), body));
  });

  g.get('/problems', (c) => c.json(backend.requests.guestProblems(c.get('guest').id)));
  g.post('/problems', async (c) => {
    const body = z
      .object({ mediaType, tmdbId: z.number().int().positive(), kind: z.enum(['audio', 'subtitles', 'video', 'wrong_file', 'other']), note: z.string().max(1000).optional() })
      .parse(await c.req.json());
    return c.json(await backend.requests.reportProblem(c.get('guest'), body));
  });

  g.get('/coming-soon', async (c) => c.json(await backend.comingSoon(c.get('guest'))));
  g.get('/status', (c) => c.json(backend.status()));

  g.get('/notifications', (c) =>
    c.json(db.prepare('SELECT id, kind, title, body, url, created_at AS createdAt, read_at AS readAt FROM notifications WHERE guest_id = ? ORDER BY created_at DESC LIMIT 50').all(c.get('guest').id)),
  );
  g.post('/notifications/read', (c) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE guest_id = ? AND read_at IS NULL').run(Date.now(), c.get('guest').id);
    return c.json({ ok: true });
  });

  const sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
  g.post('/push/subscribe', async (c) => {
    backend.notifier.subscribe(c.get('guest').id, sub.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  g.post('/push/unsubscribe', async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(await c.req.json());
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND guest_id = ?').run(endpoint, c.get('guest').id);
    return c.json({ ok: true });
  });

  p.route('/', g);
  app.route('/internal/portal', p);
  app.all('*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
