import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Stack } from './stack.ts';
import { getSetting, setSetting } from './db.ts';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  clientIp,
  createSession,
  destroySession,
  hashPassword,
  loginAllowed,
  lookupSession,
  recordLogin,
  requireAdmin,
  setSessionCookie,
  verifyPassword,
  type SessionUser,
} from './auth.ts';
import type { LibraryService } from './services/library.ts';
import type { DownloadsService } from './services/downloads.ts';
import type { StateService } from './services/state.ts';
import { RAILS, type DiscoverService } from './services/discover.ts';
import type { AddService } from './services/add.ts';
import type { ResolveService } from './services/resolve.ts';
import { detectList, type ListService } from './services/lists.ts';
import type { ThroughputService } from './services/throughput.ts';
import type { HealthService } from './services/health.ts';
import { QueueControl, ControlError } from './services/queueControl.ts';
import { ProblemsService, ProblemError } from './services/problems.ts';
import { StackUpdates, StackError } from './services/stackUpdates.ts';
import { AgentTasks, AgentTaskError } from './services/agentTasks.ts';
import { calendarEvents, toIcs } from './services/calendar.ts';
import { plexOverview } from './services/plex.ts';
import { audit, recentActivity } from './services/audit.ts';
import { loadRules, saveRules } from './services/rules.ts';
import { UpstreamError } from './http.ts';
import type { ControlPlane } from './services/controlPlane.ts';
import { sealWithPassphrase } from './crypto.ts';
import { mountExtras } from './extras/routes.ts';
import type { PortalService } from './portal/service.ts';
import { registerPortalAdminRoutes } from './portal/adminRoutes.ts';
import { log } from './log.ts';
import type { MediaType } from '../shared/types.ts';

export interface Services {
  library: LibraryService;
  downloads: DownloadsService;
  state: StateService;
  discover?: DiscoverService;
  add?: AddService;
  resolver?: ResolveService;
  lists?: ListService;
  throughput: ThroughputService;
  health: HealthService;
  control?: ControlPlane;
  portal?: PortalService;
}

type Env = { Variables: { user: SessionUser; ip: string } };

const mediaType = z.enum(['movie', 'tv']);
const decisionOverrides = z
  .object({
    qualityProfileId: z.number().int().optional(),
    rootFolderPath: z.string().optional(),
    monitor: z.enum(['all', 'future', 'missing', 'existing', 'firstSeason', 'lastSeason', 'pilot', 'none', 'movieOnly']).optional(),
    minimumAvailability: z.enum(['announced', 'inCinemas', 'released']).optional(),
    seriesType: z.enum(['standard', 'anime', 'daily']).optional(),
    searchNow: z.boolean().optional(),
    bumpOnGrab: z.boolean().optional(),
    seasons: z.array(z.number().int().min(0)).nullable().optional(),
  })
  .strict();
const addItems = z.object({
  items: z.array(z.object({ mediaType, tmdbId: z.number().int().positive(), overrides: decisionOverrides.optional() })).min(1).max(250),
});

function securityHeaders(app: Hono<any>) {
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https://image.tmdb.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });
}

function fail(c: Context, err: unknown) {
  if (err instanceof ControlError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof ProblemError || err instanceof StackError || err instanceof AgentTaskError) return c.json({ error: err.message }, 409);
  if (err instanceof z.ZodError) return c.json({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  if (err instanceof UpstreamError) return c.json({ error: err.message, upstream: err.app }, 502);
  log.error(`${c.req.method} ${c.req.path}`, err);
  return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
}

export function createApp(stack: Stack, svc: Services): Hono<Env> {
  const app = new Hono<Env>();
  securityHeaders(app);
  app.onError((err, c) => fail(c, err));
  const trusted = new Set(stack.config.TRUSTED_PROXIES.split(',').map((s) => s.trim()));
  const secureCookies = stack.config.PUBLIC_URL.startsWith('https://');

  app.get('/healthz', (c) => c.json({ ok: true, surface: stack.config.SAGA_SURFACE }));

  if (stack.config.SAGA_SURFACE === 'portal') {
    // Phase 5: the request portal mounts only /api/portal/* here. Nothing below this line is registered
    // on the portal surface, so its routes cannot reach admin APIs or secrets (see test/surfaces.test.ts).
    app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
    return app;
  }

  // ---------- auth ----------
  app.post('/api/auth/login', async (c) => {
    const ip = clientIp(c, trusted);
    const gate = loginAllowed(stack.db, ip);
    if (!gate.ok) {
      c.header('Retry-After', String(gate.retryAfterSec ?? 900));
      return c.json({ error: `Too many failed sign-ins. Try again in ${Math.ceil((gate.retryAfterSec ?? 900) / 60)} min.` }, 429);
    }
    const body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }).parse(await c.req.json());
    const user = stack.db.prepare('SELECT id, password_hash, role FROM users WHERE username = ?').get(body.username) as
      | { id: number; password_hash: string; role: string }
      | undefined;
    // Verify even for unknown users so timing doesn't reveal which usernames exist.
    const ok = verifyPassword(body.password, user?.password_hash ?? hashPassword('x')) && !!user && user.role === 'admin';
    recordLogin(stack.db, ip, ok);
    if (!ok) {
      audit(stack.db, body.username, 'auth.login', null, `failed from ${ip}`, false);
      return c.json({ error: 'Wrong username or password' }, 401);
    }
    const { token, csrf } = createSession(stack.db, user!.id, ip, c.req.header('user-agent') ?? '');
    setSessionCookie(c, token, secureCookies);
    audit(stack.db, body.username, 'auth.login', null, `from ${ip}`);
    return c.json({ username: body.username, role: user!.role, csrf });
  });

  app.post('/api/auth/logout', (c) => {
    destroySession(stack.db, getCookie(c, SESSION_COOKIE));
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', (c) => {
    const user = lookupSession(stack.db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    return c.json({ username: user.username, role: user.role, csrf: user.csrf });
  });

  // iCal is fetched by calendar apps that can't sign in, so it's guarded by a secret token instead.
  app.get('/ical/:token', async (c) => {
    const token = getSetting<string | null>(stack.db, 'ical_token', null);
    const sent = c.req.param('token').replace(/\.ics$/, '');
    if (!token || sent !== token) return c.text('Not found', 404);
    const start = new Date(Date.now() - 14 * 86400_000);
    const end = new Date(Date.now() + 90 * 86400_000);
    const events = await calendarEvents(stack, start, end);
    return c.body(toIcs(events), 200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'max-age=900' });
  });

  // ---------- everything below requires an admin session ----------
  const api = new Hono<Env>();
  api.use('*', requireAdmin(stack.db));
  const actor = (c: Context<Env>) => c.get('user').username;
  const control = new QueueControl(stack, svc.downloads);
  const problems = new ProblemsService(stack, svc.downloads);
  const stackUpdates = new StackUpdates(stack);
  const agentTasks = new AgentTasks(stack, problems);

  const need = <T>(v: T | undefined, what: string): T => {
    if (!v) throw new ControlError(`${what} is not configured`, 503);
    return v;
  };

  api.post('/auth/password', async (c) => {
    const body = z.object({ current: z.string(), next: z.string().min(12).max(500) }).parse(await c.req.json());
    const u = stack.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(c.get('user').id) as { password_hash: string };
    if (!verifyPassword(body.current, u.password_hash)) return c.json({ error: 'Current password is wrong' }, 400);
    stack.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.next), c.get('user').id);
    stack.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(c.get('user').id, c.get('user').sessionId);
    audit(stack.db, actor(c), 'auth.password', null, 'changed; other sessions signed out');
    return c.json({ ok: true });
  });

  // Discover
  api.get('/discover/rails', (c) => c.json(RAILS[mediaType.parse(c.req.query('type') ?? 'movie')].map(({ id, title }) => ({ id, title }))));
  api.get('/discover/rail/:rail', async (c) => {
    const d = need(svc.discover, 'TMDB');
    await svc.library.ensureLoaded();
    return c.json(await d.rail(mediaType.parse(c.req.query('type') ?? 'movie'), c.req.param('rail'), Number(c.req.query('page') ?? 1), c.req.query('hide') === '1'));
  });
  api.get('/discover/browse', async (c) => {
    const d = need(svc.discover, 'TMDB');
    await svc.library.ensureLoaded();
    const q = c.req.query();
    return c.json(
      await d.browse({
        type: mediaType.parse(q.type ?? 'movie'),
        page: Number(q.page ?? 1),
        sort: q.sort,
        genre: q.genre,
        decade: q.decade,
        language: q.language,
        country: q.country,
        provider: q.provider,
        company: q.company,
        network: q.network,
        keyword: q.keyword,
        person: q.person,
        minRating: q.minRating ? Number(q.minRating) : undefined,
        hideInLibrary: q.hideInLibrary === '1',
      }),
    );
  });
  api.get('/meta/genres', async (c) => c.json(await need(svc.discover, 'TMDB').genres(mediaType.parse(c.req.query('type') ?? 'movie'))));
  api.get('/meta/providers', async (c) => c.json(await need(svc.discover, 'TMDB').providers(mediaType.parse(c.req.query('type') ?? 'movie'))));
  api.get('/meta/languages', async (c) => c.json(await need(svc.discover, 'TMDB').languages()));
  api.get('/meta/companies', async (c) => c.json(await need(svc.discover, 'TMDB').searchCompanies(c.req.query('q') ?? '')));
  api.get('/meta/keywords', async (c) => c.json(await need(svc.discover, 'TMDB').searchKeywords(c.req.query('q') ?? '')));
  api.get('/meta/people', async (c) => c.json(await need(svc.discover, 'TMDB').searchPeople(c.req.query('q') ?? '')));
  api.get('/meta/company/:id', async (c) => c.json(await need(svc.discover, 'TMDB').company(Number(c.req.param('id')))));
  api.get('/meta/network/:id', async (c) => c.json(await need(svc.discover, 'TMDB').network(Number(c.req.param('id')))));
  api.get('/meta/arr', async (c) => {
    await svc.library.ensureLoaded();
    return c.json({
      radarr: { profiles: svc.library.radarrProfiles, roots: svc.library.radarrRoots, defaultProfile: stack.config.DEFAULT_MOVIE_PROFILE ?? null },
      sonarr: { profiles: svc.library.sonarrProfiles, roots: svc.library.sonarrRoots, defaultProfile: stack.config.DEFAULT_TV_PROFILE ?? null },
    });
  });

  api.get('/title/:type/:id', async (c) => {
    await svc.library.ensureLoaded();
    const type = mediaType.parse(c.req.param('type'));
    const id = Number(c.req.param('id'));
    const detail = await need(svc.discover, 'TMDB').title(type, id);
    let library: Record<string, unknown> | undefined;
    if (type === 'movie') {
      const m = svc.library.movies.get(id);
      if (m)
        library = {
          app: 'radarr',
          id: m.id,
          monitored: m.monitored,
          hasFile: m.hasFile,
          quality: m.movieFile?.quality.quality.name,
          sizeOnDisk: m.movieFile?.size ?? m.sizeOnDisk,
          profile: svc.library.radarrProfiles.find((p) => p.id === m.qualityProfileId)?.name,
          path: m.path,
          added: m.added,
        };
    } else {
      const s = svc.library.series.get(id);
      if (s)
        library = {
          app: 'sonarr',
          id: s.id,
          monitored: s.monitored,
          profile: svc.library.sonarrProfiles.find((p) => p.id === s.qualityProfileId)?.name,
          seasons: s.seasons.map((x) => ({ seasonNumber: x.seasonNumber, monitored: x.monitored, have: x.statistics?.episodeFileCount ?? 0, total: x.statistics?.totalEpisodeCount ?? 0, aired: x.statistics?.episodeCount ?? 0, sizeOnDisk: x.statistics?.sizeOnDisk ?? 0 })),
          sizeOnDisk: s.statistics?.sizeOnDisk,
          seriesType: s.seriesType,
        };
    }
    return c.json({ ...detail, library });
  });
  api.get('/collection/:id', async (c) => {
    await svc.library.ensureLoaded();
    return c.json(await need(svc.discover, 'TMDB').collection(Number(c.req.param('id'))));
  });
  api.get('/person/:id', async (c) => {
    await svc.library.ensureLoaded();
    return c.json(await need(svc.discover, 'TMDB').person(Number(c.req.param('id'))));
  });
  api.get('/search', async (c) => {
    await svc.library.ensureLoaded();
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ source: 'search', results: { page: 1, totalPages: 1, totalResults: 0, results: [] } });
    // A pasted list URL is offered as a list rather than a title.
    const list = detectList(q);
    if (list) return c.json({ source: 'list', list, results: { page: 1, totalPages: 1, totalResults: 0, results: [] } });
    return c.json(await need(svc.resolver, 'TMDB').resolve(q, Number(c.req.query('page') ?? 1)));
  });
  api.post('/states', async (c) => {
    const body = z.object({ items: z.array(z.object({ mediaType, tmdbId: z.number().int() })).max(500) }).parse(await c.req.json());
    return c.json(body.items.map((i) => ({ ...i, state: svc.state.for(i.mediaType as MediaType, i.tmdbId) })));
  });

  // Lists
  api.get('/lists', (c) => c.json(need(svc.lists, 'TMDB').saved()));
  api.post('/lists', async (c) => {
    const body = z.object({ url: z.string().url().max(500), name: z.string().max(200).optional() }).parse(await c.req.json());
    const ref = detectList(body.url);
    if (!ref) return c.json({ error: 'Not a list URL Saga understands (IMDb, Letterboxd, MDBList, TMDB or Trakt)' }, 400);
    const resolved = await need(svc.lists, 'TMDB').resolve(ref);
    svc.lists!.save(ref, body.name || resolved.name);
    return c.json({ ok: true, name: resolved.name });
  });
  api.delete('/lists/:id', (c) => {
    need(svc.lists, 'TMDB').remove(Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  api.get('/lists/view', async (c) => {
    await svc.library.ensureLoaded();
    const url = c.req.query('url') ?? '';
    const ref = detectList(url) ?? (c.req.query('kind') ? { kind: c.req.query('kind') as any, ref: url } : null);
    if (!ref) return c.json({ error: 'Unknown list' }, 400);
    return c.json(await need(svc.lists, 'TMDB').resolve(ref));
  });

  // Add
  api.get('/add/decision', async (c) => {
    const d = await need(svc.add, 'TMDB').decision(mediaType.parse(c.req.query('type')), Number(c.req.query('id')));
    return c.json(d);
  });
  api.post('/add/preview', async (c) => c.json(await need(svc.add, 'TMDB').preview(addItems.parse(await c.req.json()).items)));
  api.post('/add', async (c) => c.json(await need(svc.add, 'TMDB').add(addItems.parse(await c.req.json()).items, actor(c))));
  api.post('/add/jobs', async (c) => {
    const job = need(svc.add, 'TMDB').startJob(addItems.parse(await c.req.json()).items, actor(c));
    return c.json({ id: job.id, total: job.total });
  });
  api.get('/add/jobs/:id', (c) => {
    const job = need(svc.add, 'TMDB').job(c.req.param('id'));
    if (!job) return c.json({ error: 'No such job (they are kept for an hour)' }, 404);
    return c.json(job);
  });

  // Rules
  api.get('/rules', (c) => c.json(loadRules(stack.db)));
  api.put('/rules', async (c) => {
    const rule = z.object({
      name: z.string().min(1).max(100),
      enabled: z.boolean(),
      mediaType: z.enum(['movie', 'tv', 'any']),
      conditions: z.object({
        genresAny: z.array(z.string()).optional(),
        genresNone: z.array(z.string()).optional(),
        certificationIn: z.array(z.string()).optional(),
        languageIn: z.array(z.string()).optional(),
        yearMin: z.number().int().optional(),
        yearMax: z.number().int().optional(),
      }),
      actions: decisionOverrides.omit({ seasons: true }),
    });
    const body = z.object({ rules: z.array(rule).max(100) }).parse(await c.req.json());
    saveRules(stack.db, body.rules.map((r, i) => ({ ...r, position: i })));
    audit(stack.db, actor(c), 'rules.save', null, `${body.rules.length} rule(s)`);
    return c.json(loadRules(stack.db));
  });

  // Downloads
  api.get('/downloads', (c) => {
    const q = c.req.query();
    return c.json(svc.downloads.snapshot({ offset: Number(q.offset ?? 0), limit: Number(q.limit ?? 50), search: q.search, category: q.category || undefined }));
  });
  api.get('/downloads/attention', (c) => c.json(svc.downloads.attention()));
  api.post('/downloads/refresh', async (c) => {
    await Promise.all([svc.downloads.pollQueue(), svc.downloads.pollFeed()]);
    return c.json({ ok: true });
  });
  api.post('/downloads/pause', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    await control.pauseAll(z.object({ minutes: z.number().int().min(1).max(1440).default(60) }).parse(body).minutes, actor(c));
    return c.json({ ok: true });
  });
  api.post('/downloads/resume', async (c) => {
    await control.resumeAll(actor(c));
    return c.json({ ok: true });
  });
  api.post('/downloads/job/:nzo/:action', async (c) => {
    const nzo = c.req.param('nzo');
    const body = await c.req.json().catch(() => ({}));
    switch (c.req.param('action')) {
      case 'bump':
        await control.bump(nzo, actor(c));
        break;
      case 'priority':
        await control.setPriority(nzo, z.object({ priority: z.enum(['Low', 'Normal', 'High']) }).parse(body).priority, actor(c));
        break;
      case 'move':
        await control.move(nzo, z.object({ index: z.number().int().min(0) }).parse(body).index, actor(c));
        break;
      case 'pause':
        await control.pauseJob(nzo, actor(c));
        break;
      case 'resume':
        await control.resumeJob(nzo, actor(c));
        break;
      case 'cancel':
        await control.cancel(nzo, z.object({ blocklist: z.boolean().default(false) }).parse(body), actor(c));
        break;
      default:
        return c.json({ error: 'Unknown action' }, 400);
    }
    return c.json({ ok: true });
  });

  // Download problems (Downloads → Problems)
  const problemId = z.string().regex(/^(arr:(radarr|sonarr):\d+|sab:[A-Za-z0-9_-]+)$/);
  api.get('/problems', async (c) => c.json(await problems.list(c.req.query('refresh') === '1')));
  api.get('/problems/:id/releases', async (c) => c.json(await problems.releases(problemId.parse(c.req.param('id')))));
  api.post('/problems/:id/:action', async (c) => {
    const id = problemId.parse(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    switch (c.req.param('action')) {
      case 'search':
        return c.json({ message: await problems.search(id, actor(c)) });
      case 'grab': {
        const b = z.object({ guid: z.string().min(1).max(2000), indexerId: z.number().int().positive(), bump: z.boolean().default(true) }).parse(body);
        return c.json({ message: await problems.grab(id, b.guid, b.indexerId, b.bump, actor(c)) });
      }
      case 'retry':
        return c.json({ message: await problems.retry(id, actor(c)) });
      case 'dismiss':
        problems.dismiss(id, actor(c));
        return c.json({ message: 'Dismissed' });
      case 'agent':
        return c.json(await agentTasks.forProblem(id, actor(c)));
      default:
        return c.json({ error: 'Unknown action' }, 400);
    }
  });

  // Stack updates (download host saga-ops)
  const svcName = z.string().regex(/^[a-z0-9_-]+$/);
  const runId = z.string().regex(/^\d{8}-\d{6}$/);
  api.get('/stack/versions', async (c) => c.json(await stackUpdates.versions(c.req.query('refresh') === '1')));
  api.get('/stack/runs', async (c) => c.json(await stackUpdates.runs()));
  api.get('/stack/runs/:id', async (c) => c.json(await stackUpdates.status(runId.parse(c.req.param('id')))));
  api.post('/stack/update', async (c) => {
    const b = z.object({ services: z.union([z.literal('all'), z.array(svcName).min(1).max(20)]), allowStreaming: z.boolean().default(false) }).parse(await c.req.json());
    return c.json(await stackUpdates.start(b.services, actor(c), { allowStreaming: b.allowStreaming }));
  });
  api.post('/stack/runs/:id/rollback', async (c) => {
    const b = z.object({ service: svcName.optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await stackUpdates.rollback(runId.parse(c.req.param('id')), b.service, actor(c)));
  });
  api.post('/stack/runs/:id/recover-lost', async (c) => c.json(await stackUpdates.recoverLost(runId.parse(c.req.param('id')), actor(c))));
  api.post('/stack/runs/:id/agent', async (c) => c.json(await agentTasks.forRun(runId.parse(c.req.param('id')), actor(c))));

  // Maintenance-agent hand-off (agent host saga-agent-task)
  const taskId = z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
  api.get('/agent/tasks', async (c) => c.json(await agentTasks.list()));
  api.get('/agent/tasks/:id', async (c) => c.json(await agentTasks.status(taskId.parse(c.req.param('id')))));

  // Dashboard
  api.get('/throughput', async (c) => c.json(await svc.throughput.get()));
  api.get('/health', (c) => c.json(svc.health.list()));
  api.post('/health/refresh', async (c) => {
    await svc.health.refresh();
    return c.json(svc.health.list());
  });
  api.get('/agent', (c) => c.json({ feed: svc.health.agent, error: svc.health.agentError, gateTail: svc.downloads.feed?.agentGate.logTail ?? [], cleanupTail: svc.downloads.feed?.cleanup.logTail ?? [] }));
  api.get('/plex', async (c) => c.json(await plexOverview(stack)));
  api.get('/plex/thumb', async (c) => {
    const path = c.req.query('path') ?? '';
    // Only Plex library artwork; never an arbitrary URL.
    if (!/^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/.test(path) || !stack.plex) return c.text('Not found', 404);
    const res = await fetch(`${stack.config.PLEX_URL}/photo/:/transcode?width=240&height=360&minSize=1&upscale=1&url=${encodeURIComponent(path)}`, {
      headers: { 'X-Plex-Token': stack.config.PLEX_TOKEN! },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return c.text('Not found', 404);
    return c.body(Buffer.from(await res.arrayBuffer()), 200, { 'content-type': res.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'private, max-age=86400' });
  });

  // Calendar
  api.get('/calendar', async (c) => {
    const start = new Date(c.req.query('start') ?? Date.now() - 7 * 86400_000);
    const end = new Date(c.req.query('end') ?? Date.now() + 30 * 86400_000);
    if (end.getTime() - start.getTime() > 120 * 86400_000) return c.json({ error: 'Range too long (max 120 days)' }, 400);
    return c.json(await calendarEvents(stack, start, end));
  });
  api.get('/calendar/ical', (c) => {
    const token = getSetting<string | null>(stack.db, 'ical_token', null);
    return c.json({ url: token ? `${stack.config.PUBLIC_URL}/ical/${token}.ics` : null });
  });
  api.post('/calendar/ical', (c) => {
    const token = randomBytes(24).toString('base64url');
    setSetting(stack.db, 'ical_token', token);
    audit(stack.db, actor(c), 'ical.rotate', null);
    return c.json({ url: `${stack.config.PUBLIC_URL}/ical/${token}.ics` });
  });

  // Activity
  api.get('/activity', (c) => c.json(recentActivity(stack.db, Math.min(Number(c.req.query('limit') ?? 200), 500), c.req.query('before') ? Number(c.req.query('before')) : undefined)));

  // Library summary for the dashboard
  api.get('/library/summary', async (c) => {
    await svc.library.ensureLoaded();
    let moviesWithFile = 0;
    let movieBytes = 0;
    const byQuality = new Map<string, number>();
    for (const m of svc.library.movies.values()) {
      if (!m.hasFile) continue;
      moviesWithFile++;
      movieBytes += m.movieFile?.size ?? 0;
      const q = m.movieFile?.quality.quality.name ?? 'Unknown';
      byQuality.set(q, (byQuality.get(q) ?? 0) + 1);
    }
    let episodes = 0;
    let episodeFiles = 0;
    let tvBytes = 0;
    for (const s of svc.library.seriesById.values()) {
      episodes += s.statistics?.episodeCount ?? 0;
      episodeFiles += s.statistics?.episodeFileCount ?? 0;
      tvBytes += s.statistics?.sizeOnDisk ?? 0;
    }
    return c.json({
      movies: svc.library.movies.size,
      moviesWithFile,
      movieBytes,
      byQuality: [...byQuality.entries()].map(([quality, count]) => ({ quality, count })).sort((a, b) => b.count - a.count),
      series: svc.library.seriesById.size,
      episodes,
      episodeFiles,
      tvBytes,
      refreshedAt: svc.library.lastRefresh,
    });
  });
  api.post('/library/refresh', async (c) => {
    await svc.library.refresh();
    return c.json({ ok: true });
  });

  // Control plane (phase 4: import, records, drift; nothing is pushed to SAB/Prowlarr yet)
  const ctl = () => need(svc.control, 'Control plane');
  api.get('/control/providers', async (c) => c.json(await ctl().providers()));
  api.get('/control/indexers', async (c) => c.json(await ctl().indexers()));
  api.post('/control/import', async (c) => {
    const body = z.object({ overwrite: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await ctl().importLive(actor(c), body.overwrite));
  });
  const providerPatch = z
    .object({
      displayName: z.string().max(100),
      host: z.string().max(253),
      port: z.number().int().min(1).max(65535),
      ssl: z.boolean(),
      connections: z.number().int().min(1).max(200),
      priority: z.number().int().min(0).max(100),
      retentionDays: z.number().int().min(0),
      enabled: z.boolean(),
      optional: z.boolean(),
      username: z.string().max(200).nullable(),
      password: z.string().max(500),
      planType: z.enum(['unlimited', 'block']),
      renewalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      price: z.number().min(0).nullable(),
      billingPeriod: z.enum(['month', 'year', 'once']).nullable(),
      blockSizeBytes: z.number().int().min(0).nullable(),
      dataCapBytes: z.number().int().min(0).nullable(),
      notes: z.string().max(2000).nullable(),
      resetBlockBaseline: z.boolean(),
    })
    .partial()
    .strict();
  api.patch('/control/providers/:id', async (c) => {
    const patch: Record<string, unknown> = providerPatch.parse(await c.req.json());
    if (patch.resetBlockBaseline) {
      // Baseline = SAB's lifetime byte counter for this server right now.
      const row = stack.db.prepare('SELECT sab_name, host FROM providers WHERE id = ?').get(Number(c.req.param('id'))) as { sab_name: string; host: string } | undefined;
      const stats = await need(stack.sab, 'SABnzbd').serverStats();
      const usage = row ? (stats.servers[row.sab_name] ?? stats.servers[row.host]) : undefined;
      if (!usage) return c.json({ error: 'SAB has no usage counter for this server yet' }, 409);
      patch.currentTotalBytes = usage.total;
    }
    ctl().updateProvider(Number(c.req.param('id')), patch, actor(c));
    return c.json({ ok: true });
  });
  api.patch('/control/indexers/:id', async (c) => {
    const patch = z
      .object({
        name: z.string().max(100),
        baseUrl: z.string().url().max(500),
        apiKey: z.string().max(500),
        enabled: z.boolean(),
        priority: z.number().int().min(1).max(50),
        apiLimitDay: z.number().int().min(0).nullable(),
        grabLimitDay: z.number().int().min(0).nullable(),
        vipExpiry: z.string().max(40).nullable(),
        renewalPrice: z.number().min(0).nullable(),
        notes: z.string().max(2000).nullable(),
      })
      .partial()
      .strict()
      .parse(await c.req.json());
    ctl().updateIndexer(Number(c.req.param('id')), patch, actor(c));
    return c.json({ ok: true });
  });
  api.get('/control/providers/:id/plan', async (c) => c.json(await ctl().providerPlan(Number(c.req.param('id')))));
  api.post('/control/providers/:id/push', async (c) => c.json(await ctl().pushProvider(Number(c.req.param('id')), actor(c))));
  api.post('/control/providers', async (c) => {
    const v = z
      .object({
        displayName: z.string().min(1).max(100),
        host: z.string().min(3).max(253).regex(/^[a-z0-9.-]+$/i),
        port: z.number().int().min(1).max(65535),
        ssl: z.boolean(),
        connections: z.number().int().min(1).max(200),
        priority: z.number().int().min(0).max(100),
        retentionDays: z.number().int().min(0).optional(),
        username: z.string().max(200).nullable().optional(),
        password: z.string().max(500).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json({ id: ctl().createProvider(v, actor(c)) });
  });
  api.get('/control/indexers/:id/plan', async (c) => c.json(await ctl().indexerPlan(Number(c.req.param('id')))));
  api.post('/control/indexers/:id/push', async (c) => c.json(await ctl().pushIndexer(Number(c.req.param('id')), actor(c))));
  api.post('/control/indexers', async (c) => {
    const v = z
      .object({
        name: z.string().min(1).max(100),
        baseUrl: z.string().url().max(500),
        apiKey: z.string().min(1).max(500),
        priority: z.number().int().min(1).max(50).optional(),
        apiLimitDay: z.number().int().min(0).nullable().optional(),
        grabLimitDay: z.number().int().min(0).nullable().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json({ id: ctl().createIndexer(v, actor(c)) });
  });
  api.get('/control/snapshots', (c) => c.json(ctl().snapshots()));
  api.post('/control/export', async (c) => {
    const { passphrase } = z.object({ passphrase: z.string().min(12).max(500) }).parse(await c.req.json());
    const blob = sealWithPassphrase(passphrase, ctl().exportPlain());
    audit(stack.db, actor(c), 'control.export', null, 'encrypted backup downloaded');
    return c.body(blob, 200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="saga-control-${new Date().toISOString().slice(0, 10)}.sagabak"` });
  });

  mountExtras(api, stack, svc); // phase 6 Insights: /api/extras/*
  // Request portal administration (phase 5): approvals, problems, guests, invites, settings.
  registerPortalAdminRoutes(api, stack, svc.portal, actor);

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
