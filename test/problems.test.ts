import { describe, expect, it, beforeEach } from 'vitest';
import { openMemoryDb } from '../src/server/db.ts';
import { loadConfig } from '../src/server/config.ts';
import { buildStack } from '../src/server/stack.ts';
import { bootstrapAdmin } from '../src/server/auth.ts';
import { createApp } from '../src/server/app.ts';
import { LibraryService } from '../src/server/services/library.ts';
import { DownloadsService } from '../src/server/services/downloads.ts';
import { StateService } from '../src/server/services/state.ts';
import { ThroughputService } from '../src/server/services/throughput.ts';
import { HealthService } from '../src/server/services/health.ts';
import { ProblemsService, ProblemError } from '../src/server/services/problems.ts';
import { StackUpdates, StackError } from '../src/server/services/stackUpdates.ts';
import { AgentTaskClient, OpsClient, OpsRefused } from '../src/server/connectors/feeds.ts';
import { AgentTasks, AgentTaskError } from '../src/server/services/agentTasks.ts';

const baseEnv = { SAGA_SECRET_KEY: 'k'.repeat(44), SAGA_ADMIN_USER: 'admin', SAGA_ADMIN_PASSWORD: 'correct horse battery', POLLING: '0', PUBLIC_URL: 'http://localhost' };

function build(env: Record<string, string> = {}) {
  const config = loadConfig({ ...baseEnv, ...env } as any);
  const db = openMemoryDb();
  bootstrapAdmin(db, config);
  const stack = buildStack(config, db);
  const library = new LibraryService(stack);
  const downloads = new DownloadsService(stack, library);
  const svc = { library, downloads, state: new StateService(library, downloads), throughput: new ThroughputService(stack, downloads), health: new HealthService(stack, downloads, library) };
  return { app: createApp(stack, svc), stack };
}

async function login(app: ReturnType<typeof build>['app']) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
  });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return { cookie, csrf: ((await res.json()) as { csrf: string }).csrf };
}

describe('problems and stack routes', () => {
  it('need an admin session, and CSRF on writes', async () => {
    const { app } = build();
    for (const p of ['/api/problems', '/api/stack/versions', '/api/stack/runs', '/api/agent/tasks']) expect((await app.request(p)).status, p).toBe(401);
    const { cookie } = await login(app);
    const res = await app.request('/api/stack/update', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ services: 'all' }) });
    expect(res.status).toBe(403);
  });

  it("don't exist on the portal surface", async () => {
    const admin = build();
    const { cookie, csrf } = await login(admin.app);
    const portal = build({ SAGA_SURFACE: 'portal' });
    for (const p of ['/api/problems', '/api/stack/versions', '/api/stack/runs', '/api/problems/sab:abc/search', '/api/stack/update', '/api/agent/tasks', '/api/problems/sab:abc/agent']) {
      expect((await portal.app.request(p, { method: p.includes('/search') || p.endsWith('update') ? 'POST' : 'GET', headers: { cookie, 'x-csrf-token': csrf } })).status, p).toBe(404);
    }
  });

  it('validate ids and service names before anything leaves Saga', async () => {
    const { app } = build({ OPS_STACK_HOST: 'saga@127.0.0.1' });
    const { cookie, csrf } = await login(app);
    const h = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    expect((await app.request('/api/problems/..%2Fetc/search', { method: 'POST', headers: h })).status).toBe(400);
    expect((await app.request('/api/stack/update', { method: 'POST', headers: h, body: JSON.stringify({ services: ['radarr;id'] }) })).status).toBe(400);
    expect((await app.request('/api/stack/runs/../../x', { headers: h })).status).toBe(404);
    expect((await app.request('/api/stack/runs/2026-10-09/rollback', { method: 'POST', headers: h, body: '{}' })).status).toBe(400);
  });

  it('OpsClient refuses bad input without connecting', () => {
    const ops = new OpsClient('nobody@127.0.0.1', '/nonexistent', '/nonexistent');
    expect(() => ops.update(['radarr', 'x y'])).toThrow(OpsRefused);
    expect(() => ops.update([])).toThrow(OpsRefused);
    expect(() => ops.status('../../etc/passwd')).toThrow(OpsRefused);
    expect(() => ops.rollback('20261009-000000', 'a;b')).toThrow(OpsRefused);
    const agent = new AgentTaskClient('nobody@127.0.0.1', '/nonexistent', '/nonexistent');
    expect(() => agent.status('x; rm -rf /')).toThrow(OpsRefused);
  });
});

// ---------------------------------------------------------------- ProblemsService with fake clients

function fakeWorld() {
  const calls: string[] = [];
  const db = openMemoryDb();
  const movies: Record<number, { id: number; title: string; year: number; hasFile: boolean; tmdbId: number }> = {
    359: { id: 359, title: 'Nightfall', year: 2012, hasFile: false, tmdbId: 82507 },
    12: { id: 12, title: 'Harvest Moon', year: 1989, hasFile: true, tmdbId: 11361 },
    500: { id: 500, title: 'Lantern', year: 2020, hasFile: false, tmdbId: 508439 },
  };
  const failed = [
    { nzo_id: 'SABnzbd_nzo_nightfall', name: 'Nightfall.2012.BluRay.1080p.REMUX-FraMeSToR', category: 'movies', status: 'Failed', completed: Date.now() / 1000 - 3600, fail_message: 'RAR-based verification failed: Not a RAR file' },
    { nzo_id: 'SABnzbd_nzo_h5', name: 'Harvest.Moon.1989.2160p-W4NK3R', category: 'movies', status: 'Failed', completed: Date.now() / 1000 - 3600, fail_message: 'x' },
    { nzo_id: 'SABnzbd_nzo_tracked', name: 'Tracked.Movie.2020', category: 'movies', status: 'Failed', completed: Date.now() / 1000 - 3600, fail_message: 'x' },
    { nzo_id: 'SABnzbd_nzo_lantern', name: 'Lantern.2020.UHD', category: 'movies', status: 'Failed', completed: Date.now() / 1000 - 3600, fail_message: 'x' },
    { nzo_id: 'SABnzbd_nzo_old', name: 'Nightfall.2012.Old', category: 'movies', status: 'Failed', completed: Date.now() / 1000 - 30 * 86400, fail_message: 'x' },
    { nzo_id: 'SABnzbd_nzo_ep', name: 'Show.S01E02.1080p', category: 'tv', status: 'Failed', completed: Date.now() / 1000 - 60, fail_message: 'Aborted' },
  ];
  const parseMovie = (name: string) =>
    name.startsWith('Nightfall') ? movies[359] : name.startsWith('Harvest') ? movies[12] : name.startsWith('Lantern') ? movies[500] : undefined;
  const radarr = {
    parse: async (n: string) => ({ movie: parseMovie(n) }),
    request: async (p: string) => movies[Number(p.split('/').pop())],
    searchMovies: async (ids: number[]) => void calls.push(`radarr.search ${ids}`),
    removeQueueItem: async (id: number, o: any) => void calls.push(`radarr.remove ${id} blocklist=${o.blocklist} skip=${o.skipRedownload}`),
    grabRelease: async (g: string, i: number) => void calls.push(`radarr.grab ${g} ${i}`),
    releases: async () => [
      { guid: 'a', indexerId: 1, indexer: 'IndexerA', title: 'Nightfall.2012.BluRay.1080p.REMUX-FraMeSToR', size: 31e9, age: 1098, rejected: false, customFormatScore: 4450, protocol: 'usenet' },
      { guid: 'b', indexerId: 2, indexer: 'IndexerB', title: 'Nightfall.2012.BluRay.1080p.REMUX-LEGi0N', size: 27e9, age: 1218, rejected: false, customFormatScore: 2500, protocol: 'usenet' },
      { guid: 'c', indexerId: 2, indexer: 'IndexerB', title: 'Nightfall.2012.CAM', size: 1e9, age: 4000, rejected: true, rejections: ['Quality not wanted'], protocol: 'usenet' },
      { guid: 't', indexerId: 3, indexer: 'Tracker', title: 'Nightfall torrent', size: 1e9, age: 1, rejected: false, protocol: 'torrent' },
    ],
  };
  const sonarr = {
    parse: async () => ({ series: { id: 7, title: 'Show', tmdbId: 99 }, episodes: [{ id: 70, seasonNumber: 1, episodeNumber: 2, hasFile: false }] }),
    episodes: async () => [{ id: 70, hasFile: false }],
    searchEpisodes: async (ids: number[]) => void calls.push(`sonarr.search ${ids}`),
  };
  const sab = {
    failedHistory: async () => failed,
    retry: async (id: string) => void calls.push(`sab.retry ${id}`),
  };
  const stack = { db, radarr, sonarr, sab } as any;
  const downloads = {
    attention: () => [
      { app: 'sonarr', queueId: 41, title: 'Other Show', release: 'Other.S02E01', state: 'importBlocked', status: 'warning', messages: ['Episode file already imported'], mediaType: 'tv' },
    ],
    arrByDownloadId: new Map<string, any>([
      ['sabnzbd_nzo_tracked', { app: 'radarr', record: { id: 5, movieId: 1 } }],
      ['sabnzbd_nzo_q41', { app: 'sonarr', record: { id: 41, seriesId: 8, episodeId: 80, downloadId: 'SABnzbd_nzo_q41' } }],
    ]),
    arrByMovie: new Map<number, any[]>([[500, [{ id: 9, movieId: 500 }]]]), // Lantern is already re-downloading
    arrBySeries: new Map<number, any[]>(),
  } as any;
  return { svc: new ProblemsService(stack, downloads), calls, db };
}

describe('ProblemsService', () => {
  let w: ReturnType<typeof fakeWorld>;
  beforeEach(() => {
    w = fakeWorld();
  });

  it('finds untracked SAB failures for titles still missing, and skips the rest', async () => {
    const list = await w.svc.list();
    const ids = list.map((p) => p.id).sort();
    expect(ids).toEqual(['arr:sonarr:41', 'sab:SABnzbd_nzo_ep', 'sab:SABnzbd_nzo_nightfall']);
    const sin = list.find((p) => p.id === 'sab:SABnzbd_nzo_nightfall')!;
    expect(sin).toMatchObject({ kind: 'sab-failed', app: 'radarr', title: 'Nightfall (2012)', tracked: false, movieId: 359, tmdbId: 82507 });
    expect(sin.messages[0]).toContain('Not a RAR file');
    const ep = list.find((p) => p.id === 'sab:SABnzbd_nzo_ep')!;
    expect(ep).toMatchObject({ app: 'sonarr', title: 'Show S01E02', episodeIds: [70], seriesId: 7 });
    const stuck = list.find((p) => p.id === 'arr:sonarr:41')!;
    expect(stuck).toMatchObject({ kind: 'arr-stuck', tracked: true, queueId: 41, episodeIds: [80] });
  });

  it('search: an untracked movie gets a fresh search; a tracked item is blocklisted and re-searched by the *arr', async () => {
    await w.svc.search('sab:SABnzbd_nzo_nightfall', 'admin');
    await w.svc.search('arr:sonarr:41', 'admin').catch(() => {});
    expect(w.calls).toContain('radarr.search 359');
    expect((await w.svc.list()).map((p) => p.id)).not.toContain('sab:SABnzbd_nzo_nightfall');
  });

  it('releases: usenet only, accepted first by score, the failed release flagged', async () => {
    const rels = await w.svc.releases('sab:SABnzbd_nzo_nightfall');
    expect(rels.map((r) => r.guid)).toEqual(['a', 'b', 'c']);
    expect(rels[0]!.sameAsFailed).toBe(true);
    expect(rels[1]!.sameAsFailed).toBe(false);
    expect(rels[2]).toMatchObject({ rejected: true, rejections: ['Quality not wanted'] });
  });

  it('grab goes through the *arr and queues a bump', async () => {
    await w.svc.grab('sab:SABnzbd_nzo_nightfall', 'b', 2, true, 'admin');
    expect(w.calls).toContain('radarr.grab b 2');
    expect(w.db.prepare('SELECT app, item_id FROM pending_bumps').all()).toEqual([{ app: 'radarr', item_id: 359 }]);
  });

  it('retry is only for SAB failures; dismiss hides; unknown ids are refused', async () => {
    await expect(w.svc.retry('arr:sonarr:41', 'admin')).rejects.toBeInstanceOf(ProblemError);
    await w.svc.retry('sab:SABnzbd_nzo_ep', 'admin');
    expect(w.calls).toContain('sab.retry SABnzbd_nzo_ep');
    w.svc.dismiss('arr:sonarr:41', 'admin');
    expect((await w.svc.list()).map((p) => p.id)).not.toContain('arr:sonarr:41');
    await expect(w.svc.search('sab:nope', 'admin')).rejects.toBeInstanceOf(ProblemError);
  });
});

describe('StackUpdates', () => {
  it('refuses to restart Plex while someone is streaming, unless confirmed', async () => {
    const started: unknown[] = [];
    const stack = {
      db: openMemoryDb(),
      tautulli: { activity: async () => ({ stream_count: '2' }) },
      opsStack: { update: async (s: unknown) => (started.push(s), { runId: '20261009-120000', services: ['plex'] }) },
    } as any;
    const su = new StackUpdates(stack);
    await expect(su.start(['plex'], 'admin')).rejects.toBeInstanceOf(StackError);
    await expect(su.start('all', 'admin')).rejects.toThrow(/2 Plex streams are playing/);
    expect(started).toEqual([]);
    await su.start(['radarr'], 'admin');
    await su.start(['plex'], 'admin', { allowStreaming: true });
    expect(started).toEqual([['radarr'], ['plex']]);
  });

  it('re-searches lost SAB jobs that still lack files', async () => {
    const calls: string[] = [];
    const stack = {
      db: openMemoryDb(),
      opsStack: { status: async () => ({ lostJobs: ['Show.S01E02', 'Nightfall.2012', 'Gibberish'] }) },
      sonarr: {
        parse: async (n: string) => (n.startsWith('Show') ? { series: { id: 1 }, episodes: [{ id: 70, hasFile: false }, { id: 71, hasFile: true }] } : {}),
        searchEpisodes: async (ids: number[]) => void calls.push(`eps ${ids}`),
      },
      radarr: {
        parse: async (n: string) => (n.startsWith('Nightfall') ? { movie: { id: 359, hasFile: false } } : {}),
        searchMovies: async (ids: number[]) => void calls.push(`movies ${ids}`),
      },
    } as any;
    const r = await new StackUpdates(stack).recoverLost('20261009-120000', 'admin');
    expect(r).toEqual({ movies: 1, episodes: 1, unmatched: ['Gibberish'] });
    expect(calls.sort()).toEqual(['eps 70', 'movies 359']);
  });
});

describe('AgentTasks (agent hand-off)', () => {
  it('sends a structured task built from Saga records, and links it to the problem', async () => {
    const w = fakeWorld();
    const sent: any[] = [];
    const stack = { db: w.db, opsAgent: { start: async (t: unknown) => (sent.push(t), { id: '20261009-120000-abcdef' }) } } as any;
    const tasks = new AgentTasks(stack, w.svc);
    const r = await tasks.forProblem('sab:SABnzbd_nzo_nightfall', 'admin');
    expect(r).toEqual({ taskId: '20261009-120000-abcdef' });
    expect(sent[0]).toMatchObject({
      kind: 'download-problem',
      title: 'Nightfall (2012): failed in SAB, not tracked',
      requestedBy: 'admin',
      details: { app: 'radarr', movieId: 359, tracked: false, sabNzoId: 'SABnzbd_nzo_nightfall', release: 'Nightfall.2012.BluRay.1080p.REMUX-FraMeSToR' },
    });
    expect(sent[0].summary).toContain('no *arr is tracking it');
    const p = (await w.svc.list()).find((x) => x.id === 'sab:SABnzbd_nzo_nightfall')!;
    expect(p.agentTaskId).toBe('20261009-120000-abcdef');
  });

  it('is refused cleanly when not configured or the problem is gone', async () => {
    const w = fakeWorld();
    await expect(new AgentTasks({ db: w.db } as any, w.svc).forProblem('sab:SABnzbd_nzo_nightfall', 'admin')).rejects.toBeInstanceOf(AgentTaskError);
    const stack = { db: w.db, opsAgent: { start: async () => ({ id: 'x' }) } } as any;
    await expect(new AgentTasks(stack, w.svc).forProblem('sab:nope', 'admin')).rejects.toBeInstanceOf(AgentTaskError);
  });
});
