import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Stack } from '../stack.ts';
import type { PortalService } from './service.ts';
import { createInvite, getGuest, listGuests, listInvites, revokeInvite } from './guests.ts';
import { portalSettings, savePortalSettings } from './settings.ts';
import { RequestError } from './requests.ts';
import { audit } from '../services/audit.ts';

/** Admin-side routes for the portal: approvals, problems, guests, invites, settings, status posts, Seerr import. */
export function registerPortalAdminRoutes(api: Hono<any>, stack: Stack, portal: PortalService | undefined, actor: (c: Context<any>) => string): void {
  const db = stack.db;
  const need = () => {
    if (!portal) throw new RequestError('The request portal needs TMDB to be configured', 'state');
    return portal;
  };
  const fail = (c: Context, err: unknown) => {
    if (err instanceof RequestError) return c.json({ error: err.message }, 409);
    throw err;
  };

  api.get('/requests', (c) => {
    const raw = c.req.query('by');
    const by = raw === 'none' ? 'none' : raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    return c.json(need().requests.adminList(c.req.query('status') || undefined, by));
  });
  api.get('/requests/requesters', (c) => c.json(need().requests.requesterSummary()));
  api.get('/requests/counts', (c) => c.json(need().requests.counts()));
  api.post('/requests/:id/approve', async (c) => {
    try {
      return c.json(await need().requests.approve(Number(c.req.param('id')), actor(c)));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.post('/requests/:id/decline', async (c) => {
    const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(await c.req.json().catch(() => ({})));
    try {
      return c.json(await need().requests.decline(Number(c.req.param('id')), reason ?? null, actor(c)));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.delete('/requests/:id', (c) => {
    const r = need().requests.get(Number(c.req.param('id')));
    if (!r) return c.json({ error: 'No such request' }, 404);
    db.prepare('DELETE FROM requests WHERE id = ?').run(r.id);
    audit(db, actor(c), 'request.delete', r.title);
    return c.json({ ok: true });
  });

  api.get('/problems', (c) => c.json(need().requests.adminProblems(c.req.query('status') || undefined)));
  api.post('/problems/:id/resolve', async (c) => {
    const { note } = z.object({ note: z.string().max(1000).nullable().optional() }).parse(await c.req.json().catch(() => ({})));
    try {
      await need().requests.resolveProblem(Number(c.req.param('id')), note ?? null, actor(c));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.get('/guests', (c) =>
    c.json(
      listGuests(db).map((g) => ({
        ...g,
        usage: need().requests.usage(g.id),
        requests: (db.prepare('SELECT COUNT(*) AS n FROM request_requesters WHERE guest_id = ?').get(g.id) as { n: number }).n,
      })),
    ),
  );
  api.patch('/guests/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const g = getGuest(db, id);
    if (!g) return c.json({ error: 'No such guest' }, 404);
    const body = z
      .object({
        enabled: z.boolean(),
        unlimited: z.boolean(),
        autoApproveAll: z.boolean(),
        role: z.enum(['guest', 'kid']),
        moviesPerWeek: z.number().int().min(0).max(1000).nullable(),
        seasonsPerWeek: z.number().int().min(0).max(1000).nullable(),
        gbPerMonth: z.number().int().min(0).max(100_000).nullable(),
        autoApproveGb: z.number().int().min(0).max(10_000).nullable(),
        ratingCap: z.array(z.string().max(20)).max(30).nullable(),
      })
      .partial()
      .strict()
      .parse(await c.req.json());
    const cols: Record<string, string> = {
      enabled: 'enabled',
      unlimited: 'unlimited',
      autoApproveAll: 'auto_approve_all',
      role: 'role',
      moviesPerWeek: 'limit_movies_week',
      seasonsPerWeek: 'limit_seasons_week',
      gbPerMonth: 'limit_gb_month',
      autoApproveGb: 'auto_approve_gb',
      ratingCap: 'rating_cap',
    };
    for (const [k, v] of Object.entries(body)) {
      const val = typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : v;
      db.prepare(`UPDATE guests SET ${cols[k]} = ? WHERE id = ?`).run(val as any, id);
    }
    if (body.enabled === false) db.prepare('DELETE FROM guest_sessions WHERE guest_id = ?').run(id);
    audit(db, actor(c), 'guest.update', g.username, Object.keys(body).join(', '));
    if (body.unlimited || body.autoApproveAll) await portal?.requests.approvePendingForTrusted(id);
    return c.json(getGuest(db, id));
  });

  api.get('/invites', (c) => c.json(listInvites(db).map((i) => ({ ...i, url: `${stack.config.PORTAL_PUBLIC_URL}/invite/${i.code}` }))));
  api.post('/invites', async (c) => {
    const body = z
      .object({ email: z.string().email().max(200).nullable().optional(), note: z.string().max(200).nullable().optional(), role: z.enum(['guest', 'kid']).default('guest'), expiresDays: z.number().int().min(1).max(365).nullable().optional(), send: z.boolean().default(false) })
      .parse(await c.req.json());
    const inv = createInvite(db, { email: body.email, note: body.note, role: body.role, expiresDays: body.expiresDays ?? 30, createdBy: actor(c) });
    const url = `${stack.config.PORTAL_PUBLIC_URL}/invite/${inv.code}`;
    let sent = false;
    if (body.send && inv.email && portal?.notifier.emailEnabled) {
      await portal.notifier.email(inv.email, { kind: 'invite', title: "You're invited to Saga Requests", body: 'Ask for films and shows to be added to the Plex server. Sign in with your Plex account (or this email address) to get started.', url: `/invite/${inv.code}` });
      sent = true;
    }
    audit(db, actor(c), 'invite.create', inv.email ?? inv.note ?? inv.code, sent ? 'emailed' : null);
    return c.json({ ...inv, url, sent });
  });
  api.delete('/invites/:id', (c) => {
    revokeInvite(db, Number(c.req.param('id')));
    audit(db, actor(c), 'invite.revoke', c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/portal-settings', (c) =>
    c.json({ ...portalSettings(db), portalUrl: stack.config.PORTAL_PUBLIC_URL, pushEnabled: portal?.notifier.pushEnabled ?? false, emailEnabled: portal?.notifier.emailEnabled ?? false, vapidPublicKey: stack.config.VAPID_PUBLIC_KEY ?? null }),
  );
  api.put('/portal-settings', async (c) => {
    const s = z
      .object({
        allowPlexFriends: z.boolean(),
        defaults: z.object({ moviesPerWeek: z.number().int().min(0).max(1000), seasonsPerWeek: z.number().int().min(0).max(1000), gbPerMonth: z.number().int().min(0).max(100_000), autoApproveGb: z.number().int().min(0).max(10_000) }),
        kidRatings: z.array(z.string().max(20)).max(30),
        watchlistMaxPerRun: z.number().int().min(0).max(50),
      })
      .parse(await c.req.json());
    savePortalSettings(db, s);
    audit(db, actor(c), 'portal.settings', null);
    return c.json(portalSettings(db));
  });

  api.get('/status-posts', (c) => c.json(db.prepare('SELECT id, message, level, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt FROM status_posts ORDER BY created_at DESC LIMIT 50').all()));
  api.post('/status-posts', async (c) => {
    const b = z.object({ message: z.string().min(1).max(500), level: z.enum(['info', 'warn']).default('info'), hours: z.number().min(1).max(24 * 30).nullable().optional() }).parse(await c.req.json());
    db.prepare('INSERT INTO status_posts (message, level, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(b.message, b.level, actor(c), Date.now(), b.hours ? Date.now() + b.hours * 3600_000 : null);
    audit(db, actor(c), 'status.post', b.message.slice(0, 100));
    return c.json({ ok: true });
  });
  api.delete('/status-posts/:id', (c) => {
    db.prepare('DELETE FROM status_posts WHERE id = ?').run(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.post('/seerr-import', async (c) => {
    const { dryRun } = z.object({ dryRun: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await need().seerrImport(dryRun, actor(c)));
  });

  // Admin web push: new requests and problems.
  const sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
  api.post('/push/subscribe', async (c) => {
    need().notifier.subscribe(null, sub.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  api.post('/push/test', async (c) => {
    await need().notifier.toAdmin({ kind: 'test', title: 'Saga push works', body: "You'll get these for new requests and reported problems.", url: '/requests' });
    return c.json({ ok: true });
  });
  api.get('/admin-notifications', (c) => c.json(db.prepare('SELECT id, kind, title, body, url, created_at AS createdAt, read_at AS readAt FROM notifications WHERE guest_id IS NULL ORDER BY created_at DESC LIMIT 50').all()));
}
