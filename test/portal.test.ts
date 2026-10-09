import { describe, expect, it, beforeEach } from 'vitest';
import { openMemoryDb, setSetting, type DB } from '../src/server/db.ts';
import { loadConfig, type Config } from '../src/server/config.ts';
import { createInternalApp, H, type PortalBackend } from '../src/server/portal/internal.ts';
import { createPortalApp } from '../src/server/portal/app.ts';
import { Notifier } from '../src/server/portal/notify.ts';
import { RequestService, RequestError, GB, type Coverage, type TitleInfo } from '../src/server/portal/requests.ts';
import { createGuestSession, createInvite, getGuest, signInWithPlex, createMagicLink, redeemMagicLink } from '../src/server/portal/guests.ts';
import { mapSeerrRequest, importFromSeerr } from '../src/server/portal/seerrImport.ts';
import type { LibraryState, MediaType } from '../src/shared/types.ts';

const SECRET = 'i'.repeat(40);

function cfg(extra: Record<string, string> = {}): Config {
  return loadConfig({ SAGA_SECRET_KEY: 'k'.repeat(44), INTERNAL_SECRET: SECRET, PORTAL_PUBLIC_URL: 'http://portal.test', POLLING: '0', ...extra } as any);
}

interface World {
  db: DB;
  config: Config;
  reqs: RequestService;
  notifier: Notifier;
  titles: Map<string, TitleInfo>;
  coverage: Map<string, Coverage>;
  states: Map<string, LibraryState>;
  added: { type: MediaType; id: number; seasons: number[] | null }[];
  sizes: Map<string, number>;
}

function world(): World {
  const db = openMemoryDb();
  const config = cfg();
  const notifier = new Notifier(db, config, (async () => new Response('{}')) as any);
  const titles = new Map<string, TitleInfo>();
  const coverage = new Map<string, Coverage>();
  const states = new Map<string, LibraryState>();
  const sizes = new Map<string, number>();
  const added: World['added'] = [];
  const key = (t: MediaType, id: number) => `${t}:${id}`;
  const reqs = new RequestService({
    db,
    notifier,
    titleInfo: async (t, id) => titles.get(key(t, id)) ?? { mediaType: t, tmdbId: id, title: `T${id}`, genres: [], seasons: [], certification: 'PG-13' },
    estimate: async (t, id, seasons) => (sizes.get(key(t, id)) ?? 20 * GB) * (seasons?.length ?? 1),
    addToArr: async (t, id, seasons) => {
      added.push({ type: t, id, seasons });
      return { ok: true, message: 'Added; searching', arrId: 99 };
    },
    state: (t, id) => states.get(key(t, id)) ?? { kind: 'none' },
    coverage: (t, id) => coverage.get(key(t, id)) ?? { inLibrary: false, available: false, seasonsMonitored: [], seasonsComplete: [] },
  });
  return { db, config, reqs, notifier, titles, coverage, states, added, sizes };
}

function guest(db: DB, name: string, extra: Record<string, unknown> = {}) {
  const cols = ['username', 'created_at', ...Object.keys(extra)];
  const res = db.prepare(`INSERT INTO guests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(name, Date.now(), ...(Object.values(extra) as any[]));
  return getGuest(db, Number(res.lastInsertRowid))!;
}

function backend(w: World): PortalBackend {
  return {
    requests: w.reqs,
    notifier: w.notifier,
    rails: () => [{ id: 'trending-movie', title: 'Trending', type: 'movie' }],
    rail: async () => ({ page: 1, totalPages: 1, results: [] }),
    search: async () => ({ match: null, page: 1, totalPages: 1, results: [] }),
    title: async (g: any, type: MediaType, id: number) => ({ title: `T${id}`, myRequest: w.reqs.guestRequestFor(g.id, type, id) }) as any,
    comingSoon: async (g: any) => ({ onTheWay: w.reqs.forGuest(g.id), readyForYou: [], newInLibrary: [] }),
    status: () => ({ posts: [], auto: [], updatedAt: 0 }),
    plexTv: {
      createPin: async () => ({ id: 1, code: 'c' }),
      authUrl: () => 'https://app.plex.tv/auth#?x',
      pinToken: async () => 'tok',
      account: async () => ({ id: 555, uuid: 'u', username: 'friend' }),
      relation: async () => ({ owner: false, friend: false }),
    },
  } as unknown as PortalBackend;
}

describe('requests: limits, merging, approval', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it('merges a second request for the same film into one, and only the first requester is charged', async () => {
    const a = guest(w.db, 'alice');
    const b = guest(w.db, 'bob');
    const r1 = await w.reqs.create(a, { mediaType: 'movie', tmdbId: 10 });
    const r2 = await w.reqs.create(b, { mediaType: 'movie', tmdbId: 10 });
    expect(r1.outcome).toBe('created');
    expect(r2.outcome).toBe('merged');
    expect(r2.request.id).toBe(r1.request.id);
    expect(w.reqs.requesterIds(r1.request.id).sort()).toEqual([a.id, b.id].sort());
    expect(w.reqs.usage(a.id).moviesWeek).toBe(1);
    expect(w.reqs.usage(b.id).moviesWeek).toBe(0);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 1 });
  });

  it('filters the admin list by requester; a merged request matches each of its requesters', async () => {
    const a = guest(w.db, 'alice');
    const b = guest(w.db, 'bob');
    await w.reqs.create(a, { mediaType: 'movie', tmdbId: 10 });
    await w.reqs.create(b, { mediaType: 'movie', tmdbId: 10 }); // merged into alice's
    await w.reqs.create(b, { mediaType: 'movie', tmdbId: 11 });
    w.db.prepare("INSERT INTO requests (media_type, tmdb_id, title, status, source, created_at) VALUES ('movie', 12, 'Imported', 'available', 'seerr', ?)").run(Date.now());
    const ids = (list: { tmdbId: number }[]) => list.map((r) => r.tmdbId).sort();
    expect(ids(w.reqs.adminList(undefined, a.id))).toEqual([10]);
    expect(ids(w.reqs.adminList(undefined, b.id))).toEqual([10, 11]);
    expect(ids(w.reqs.adminList(undefined, 'none'))).toEqual([12]);
    expect(ids(w.reqs.adminList())).toEqual([10, 11, 12]);
    expect(w.reqs.adminList('available', b.id)).toEqual([]);
    const s = w.reqs.requesterSummary();
    expect(s.none).toBe(1);
    expect(s.guests.map((g) => [g.username, g.total])).toEqual([
      ['alice', 1],
      ['bob', 2],
    ]);
  });

  it('enforces films per week and GB per month on the server', async () => {
    const a = guest(w.db, 'alice', { limit_movies_week: 2, limit_gb_month: 50 });
    await w.reqs.create(a, { mediaType: 'movie', tmdbId: 1 });
    await w.reqs.create(a, { mediaType: 'movie', tmdbId: 2 });
    await expect(w.reqs.create(a, { mediaType: 'movie', tmdbId: 3 })).rejects.toMatchObject({ code: 'quota' });
    const b = guest(w.db, 'bob', { limit_gb_month: 50 });
    w.sizes.set('movie:7', 60 * GB);
    await expect(w.reqs.create(b, { mediaType: 'movie', tmdbId: 7 })).rejects.toThrow(/GB/);
  });

  it('counts TV in seasons and merges extra seasons into a pending request', async () => {
    w.titles.set('tv:5', { mediaType: 'tv', tmdbId: 5, title: 'Show', genres: [], seasons: [1, 2, 3].map((n) => ({ seasonNumber: n, episodeCount: 8 })) });
    const a = guest(w.db, 'alice', { limit_seasons_week: 2 });
    const b = guest(w.db, 'bob');
    await expect(w.reqs.create(a, { mediaType: 'tv', tmdbId: 5 })).rejects.toMatchObject({ code: 'quota' }); // all 3 seasons
    const r1 = await w.reqs.create(a, { mediaType: 'tv', tmdbId: 5, seasons: [1] });
    const r2 = await w.reqs.create(b, { mediaType: 'tv', tmdbId: 5, seasons: [1, 2] });
    expect(r2.request.id).toBe(r1.request.id);
    expect(w.reqs.get(r1.request.id)!.seasons).toEqual([1, 2]);
    expect(w.reqs.usage(b.id).seasonsWeek).toBe(1);
  });

  it('auto-approves under the size limit and adds with the normal rules', async () => {
    const a = guest(w.db, 'alice', { auto_approve_gb: 30 });
    const r = await w.reqs.create(a, { mediaType: 'movie', tmdbId: 11 });
    expect(r.outcome).toBe('auto-approved');
    expect(w.added).toEqual([{ type: 'movie', id: 11, seasons: null }]);
    w.sizes.set('movie:12', 40 * GB);
    const big = await w.reqs.create(a, { mediaType: 'movie', tmdbId: 12 });
    expect(big.outcome).toBe('created');
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE guest_id IS NULL AND kind = 'request.new'").get()).toEqual({ n: 1 });
  });

  it('refuses titles already in Plex, and attaches to titles already on their way without charging', async () => {
    const a = guest(w.db, 'alice');
    w.coverage.set('movie:20', { inLibrary: true, available: true, seasonsMonitored: [], seasonsComplete: [] });
    await expect(w.reqs.create(a, { mediaType: 'movie', tmdbId: 20 })).rejects.toMatchObject({ code: 'already' });
    w.coverage.set('movie:21', { inLibrary: true, available: false, seasonsMonitored: [], seasonsComplete: [] });
    const r = await w.reqs.create(a, { mediaType: 'movie', tmdbId: 21 });
    expect(r.outcome).toBe('already-coming');
    expect(w.reqs.usage(a.id).moviesWeek).toBe(0);
  });

  it('caps kid profiles by rating', async () => {
    const k = guest(w.db, 'kiddo', { role: 'kid' });
    w.titles.set('movie:30', { mediaType: 'movie', tmdbId: 30, title: 'Scary', genres: [], seasons: [], certification: 'R' });
    w.titles.set('movie:31', { mediaType: 'movie', tmdbId: 31, title: 'Cartoon', genres: [], seasons: [], certification: 'G' });
    await expect(w.reqs.create(k, { mediaType: 'movie', tmdbId: 30 })).rejects.toMatchObject({ code: 'rating' });
    expect((await w.reqs.create(k, { mediaType: 'movie', tmdbId: 31 })).outcome).toBe('created');
  });

  it('marks approved requests available and tells every requester', async () => {
    const a = guest(w.db, 'alice', { auto_approve_gb: 100 });
    const b = guest(w.db, 'bob');
    const r = await w.reqs.create(a, { mediaType: 'movie', tmdbId: 40 });
    await w.reqs.create(b, { mediaType: 'movie', tmdbId: 40 });
    w.coverage.set('movie:40', { inLibrary: true, available: true, seasonsMonitored: [], seasonsComplete: [] });
    expect(await w.reqs.checkAvailability()).toBe(1);
    expect(w.reqs.get(r.request.id)!.status).toBe('available');
    const told = w.db.prepare("SELECT guest_id FROM notifications WHERE kind = 'request.available' ORDER BY guest_id").all() as { guest_id: number }[];
    expect(told.map((t) => t.guest_id)).toEqual([a.id, b.id]);
  });

  it('watchlist sync stops at the limit and never exceeds it', async () => {
    const a = guest(w.db, 'alice', { limit_movies_week: 2 });
    const items = [1, 2, 3, 4].map((id) => ({ mediaType: 'movie' as const, tmdbId: 100 + id, state: { kind: 'none' } as LibraryState }));
    const res = await w.reqs.syncWatchlist(a.id, items);
    expect(res.added).toBe(2);
    expect(res.note).toMatch(/limit/);
    expect(w.reqs.usage(a.id).moviesWeek).toBe(2);
  });
});

describe('sign-in', () => {
  it('invite-only: an invite works once; strangers are refused; friends allowed only when the setting is on', () => {
    const db = openMemoryDb();
    const inv = createInvite(db, { createdBy: 'admin', role: 'kid' });
    const first = signInWithPlex(db, { id: 1, uuid: 'a', username: 'ann' }, { inviteCode: inv.code.toLowerCase(), isFriend: false });
    expect(first.ok && first.created && first.guest.role).toBe('kid');
    const reuse = signInWithPlex(db, { id: 2, uuid: 'b', username: 'ben' }, { inviteCode: inv.code, isFriend: false });
    expect(reuse.ok).toBe(false);
    expect(signInWithPlex(db, { id: 3, uuid: 'c', username: 'cat' }, { isFriend: false }).ok).toBe(false);
    expect(signInWithPlex(db, { id: 3, uuid: 'c', username: 'cat' }, { isFriend: true }).ok).toBe(true);
    setSetting(db, 'portal.settings', { allowPlexFriends: false });
    expect(signInWithPlex(db, { id: 4, uuid: 'd', username: 'dan' }, { isFriend: true }).ok).toBe(false);
    // Returning user signs in without an invite.
    expect(signInWithPlex(db, { id: 1, uuid: 'a', username: 'ann' }, { isFriend: false }).ok).toBe(true);
  });

  it('links a Seerr-imported guest to their Plex account on first sign-in', () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO guests (username, email, seerr_user_id, created_at) VALUES ('zoe', 'zoe@example.com', 7, 0)").run();
    const r = signInWithPlex(db, { id: 77, uuid: 'z', username: 'zoe' }, { isFriend: false });
    expect(r.ok && !r.created && r.guest.plexId).toBe(77);
  });

  it('magic links: only for invited addresses, single use', () => {
    const db = openMemoryDb();
    expect(createMagicLink(db, 'nobody@example.com')).toBeNull();
    createInvite(db, { createdBy: 'admin', email: 'Pat@Example.com' });
    const t = createMagicLink(db, 'pat@example.com')!;
    expect(redeemMagicLink(db, t).ok).toBe(true);
    expect(redeemMagicLink(db, t).ok).toBe(false);
  });
});

describe('Seerr import', () => {
  const req = (over: any) => ({ id: 1, status: 2, createdAt: '2026-07-01T00:00:00Z', type: 'movie', is4k: false, media: { tmdbId: 603, status: 3, mediaType: 'movie' }, requestedBy: { id: 5 }, ...over });

  it('maps statuses and seasons', () => {
    expect(mapSeerrRequest(req({}) as any)?.status).toBe('approved');
    expect(mapSeerrRequest(req({ status: 1 }) as any)?.status).toBe('pending');
    expect(mapSeerrRequest(req({ status: 3 }) as any)?.status).toBe('declined');
    expect(mapSeerrRequest(req({ media: { tmdbId: 603, status: 5 } }) as any)?.status).toBe('available');
    expect(mapSeerrRequest(req({ type: 'tv', seasons: [{ seasonNumber: 2 }, { seasonNumber: 0 }, { seasonNumber: 1 }] }) as any)?.seasons).toEqual([1, 2]);
    expect(mapSeerrRequest(req({ media: {} }) as any)).toBeNull();
  });

  it('dry run writes nothing; the real run is idempotent and skips admins as guests', async () => {
    const db = openMemoryDb();
    const data = {
      users: [
        { id: 1, plexUsername: 'owner', permissions: 2 },
        { id: 5, plexUsername: 'sam', email: 'sam@example.com', plexId: 500 },
      ],
      requests: [req({ id: 11 }), req({ id: 12, requestedBy: { id: 1 }, media: { tmdbId: 604, status: 5 } })],
    } as any;
    const info = async () => ({ title: 'X', year: 2000, posterPath: null });
    const dry = await importFromSeerr(db, data, info, { dryRun: true, actor: 'admin' });
    expect(dry.users).toMatchObject({ admins: 1, new: 1 });
    expect(dry.requests.new).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM requests').get() as any).n).toBe(0);
    await importFromSeerr(db, data, info, { dryRun: false, actor: 'admin' });
    const again = await importFromSeerr(db, data, info, { dryRun: false, actor: 'admin' });
    expect(again.requests).toMatchObject({ new: 0, existing: 2 });
    expect(again.users).toMatchObject({ new: 0, existing: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM request_requesters').get() as any).n).toBe(1); // sam only
  });
});

describe('portal surface and internal API', () => {
  let w: World;
  let portal: ReturnType<typeof createPortalApp>;
  let internal: ReturnType<typeof createInternalApp>;
  beforeEach(() => {
    w = world();
    internal = createInternalApp(w.db, w.config, backend(w));
    portal = createPortalApp(w.config, async (path, init) => internal.request(path, init));
  });

  const signIn = (name: string) => {
    const g = guest(w.db, name);
    const { token, csrf } = createGuestSession(w.db, g.id, 'test');
    return { g, cookie: `saga_req=${token}`, csrf };
  };

  it('exposes no admin routes and no internal routes', async () => {
    const { cookie, csrf } = signIn('alice');
    for (const path of ['/api/downloads', '/api/auth/login', '/api/rules', '/api/guests', '/api/requests', '/api/control/providers', '/internal/portal/me', '/api/portal/../downloads'])
      expect((await portal.request(path, { headers: { cookie, 'x-csrf-token': csrf } })).status, path).not.toBe(200);
    expect((await portal.request('/api/downloads', { headers: { cookie } })).status).toBe(404);
    expect((await portal.request('/healthz')).status).toBe(200);
  });

  it('the internal API refuses calls without the shared secret', async () => {
    expect((await internal.request('/internal/portal/config')).status).toBe(403);
    expect((await internal.request('/internal/portal/config', { headers: { [H.secret]: 'x'.repeat(40) } })).status).toBe(403);
    expect((await internal.request('/internal/portal/config', { headers: { [H.secret]: SECRET } })).status).toBe(200);
  });

  it('guests see only their own requests, and nothing admin-side', async () => {
    const a = signIn('alice');
    const b = signIn('bob');
    const post = (s: typeof a, body: unknown) =>
      portal.request('/api/portal/requests', { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(a, { mediaType: 'movie', tmdbId: 50 })).status).toBe(200);
    expect((await post(b, { mediaType: 'movie', tmdbId: 51 })).status).toBe(200);
    const mine = (await (await portal.request('/api/portal/requests', { headers: { cookie: a.cookie } })).json()) as any[];
    expect(mine.map((r) => r.tmdbId)).toEqual([50]);
    const me = (await (await portal.request('/api/portal/me', { headers: { cookie: a.cookie } })).json()) as any;
    expect(Object.keys(me).sort()).toEqual(['autoApproveAll', 'csrf', 'email', 'limits', 'notifyEmail', 'role', 'thumb', 'unlimited', 'usage', 'username', 'watchlist']);
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/bob|requesters|decidedBy|lastError|estBytes/);
  });

  it('needs a session and the CSRF header', async () => {
    expect((await portal.request('/api/portal/requests')).status).toBe(401);
    const a = signIn('alice');
    const res = await portal.request('/api/portal/requests', { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json' }, body: '{"mediaType":"movie","tmdbId":1}' });
    expect(res.status).toBe(403);
  });

  it('quota refusals come back as 409 with a readable message', async () => {
    const a = signIn('alice');
    w.db.prepare('UPDATE guests SET limit_movies_week = 0 WHERE id = ?').run(a.g.id);
    const res = await portal.request('/api/portal/requests', { method: 'POST', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' }, body: '{"mediaType":"movie","tmdbId":1}' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/film requests/);
  });

  it('turns the internal session header into an HttpOnly cookie and never forwards it', async () => {
    const inv = createInvite(w.db, { createdBy: 'admin' });
    await portal.request('/api/portal/auth/plex/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const res = await portal.request('/api/portal/auth/plex/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinId: 1, invite: inv.code }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^saga_req=.+HttpOnly/);
    expect(res.headers.get(H.setSession)).toBeNull();
  });
});

import { signInWithPlex as signIn2 } from '../src/server/portal/guests.ts';
import { openMemoryDb as openDb2 } from '../src/server/db.ts';
describe('owner sign-in', () => {
  it('lets the server owner in without an invite, and nobody else', () => {
    const db = openDb2();
    const acct = { id: 4623136, uuid: 'u', username: 'owner', title: 'Owner' } as any;
    expect(signIn2(db, { ...acct, id: 1 }, { isFriend: false, isOwner: false }).ok).toBe(false);
    expect(signIn2(db, acct, { isFriend: false, isOwner: true }).ok).toBe(true);
  });
});

describe('per-guest approval flags', () => {
  it('maps unlimited and auto-approve-all from the guest row', async () => {
    const { rowToGuest } = await import('../src/server/portal/guests.ts');
    const db = openDb2();
    const g = rowToGuest(db, { id: 1, username: 'a', role: 'guest', enabled: 1, unlimited: 0, auto_approve_all: 1, created_at: 0 });
    expect(g.autoApproveAll).toBe(true);
    expect(g.unlimited).toBe(false);
  });
});
