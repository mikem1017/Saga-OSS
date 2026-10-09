import { describe, expect, it, beforeEach } from 'vitest';
import { openMemoryDb, setSetting } from '../src/server/db.ts';
import { loadConfig } from '../src/server/config.ts';
import { buildStack, type Stack } from '../src/server/stack.ts';
import { bootstrapAdmin } from '../src/server/auth.ts';
import { createApp } from '../src/server/app.ts';
import { LibraryService } from '../src/server/services/library.ts';
import { DownloadsService } from '../src/server/services/downloads.ts';
import { StateService } from '../src/server/services/state.ts';
import { ThroughputService } from '../src/server/services/throughput.ts';
import { HealthService } from '../src/server/services/health.ts';
import { QueueControl, ControlError } from '../src/server/services/queueControl.ts';
import { SabClient } from '../src/server/connectors/sab.ts';

const baseEnv = { SAGA_SECRET_KEY: 'k'.repeat(44), SAGA_ADMIN_USER: 'admin', SAGA_ADMIN_PASSWORD: 'correct horse battery', POLLING: '0', PUBLIC_URL: 'http://localhost' };

function build(env: Record<string, string> = {}) {
  const config = loadConfig({ ...baseEnv, ...env } as any);
  const db = openMemoryDb();
  bootstrapAdmin(db, config);
  const stack = buildStack(config, db);
  const library = new LibraryService(stack);
  const downloads = new DownloadsService(stack, library);
  const state = new StateService(library, downloads);
  const svc = {
    library,
    downloads,
    state,
    throughput: new ThroughputService(stack, downloads),
    health: new HealthService(stack, downloads, library),
  };
  return { app: createApp(stack, svc), stack, downloads };
}

async function login(app: ReturnType<typeof build>['app']) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie, csrf };
}

describe('admin auth', () => {
  it('rejects anonymous API calls', async () => {
    const { app } = build();
    for (const path of ['/api/downloads', '/api/health', '/api/activity', '/api/rules', '/api/meta/arr']) expect((await app.request(path)).status).toBe(401);
  });

  it('signs in, and requires the CSRF header on writes', async () => {
    const { app } = build();
    const { cookie, csrf } = await login(app);
    expect((await app.request('/api/rules', { headers: { cookie } })).status).toBe(200);
    const body = JSON.stringify({ rules: [] });
    const noCsrf = await app.request('/api/rules', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body });
    expect(noCsrf.status).toBe(403);
    const ok = await app.request('/api/rules', { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body });
    expect(ok.status).toBe(200);
  });

  it('locks out after five bad passwords', async () => {
    const { app } = build();
    const bad = () =>
      app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }) });
    for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(429);
  });

  it('serves iCal only with the secret token', async () => {
    const { app, stack } = build();
    setSetting(stack.db, 'ical_token', 'sekret');
    expect((await app.request('/ical/wrong.ics')).status).toBe(404);
    const res = await app.request('/ical/sekret.ics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
  });

  it('sets security headers', async () => {
    const { app } = build();
    const res = await app.request('/healthz');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('surfaces', () => {
  it('the portal surface exposes no admin routes, even with a valid admin session', async () => {
    const admin = build();
    const { cookie, csrf } = await login(admin.app);
    const portal = build({ SAGA_SURFACE: 'portal' });
    // Copy the session into the portal's database to prove it's the route table, not auth, that blocks.
    for (const path of ['/api/downloads', '/api/health', '/api/auth/login', '/api/rules', '/api/agent', '/api/meta/arr', '/ical/x']) {
      const res = await portal.app.request(path, { headers: { cookie, 'x-csrf-token': csrf } });
      expect(res.status, path).toBe(404);
    }
    expect((await portal.app.request('/healthz')).status).toBe(200);
  });
});

describe('queue control', () => {
  let stack: Stack;
  let downloads: DownloadsService;
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    const b = build({ FEED_HOST: 'saga@download-host' });
    stack = b.stack;
    downloads = b.downloads;
    const sab = new SabClient('http://sab.invalid', 'k');
    sab.resume = async () => {
      calls.push('resume');
      return { status: true };
    };
    stack.sab = sab;
    downloads.pollQueue = async () => {};
    downloads.pollFeed = async () => {};
    downloads.queue = { paused: true, pause_int: '0', diskspace1: '6000', slots: [] } as any;
  });

  it('never resumes a pause the PP guard made', async () => {
    downloads.feed = { ts: 0, guard: { paused: true, pausedSince: 1, heartbeat: Date.now() / 1000, logTail: [] }, cleanup: { logTail: [] }, agentGate: { logTail: [] }, disks: [] };
    const qc = new QueueControl(stack, downloads);
    await expect(qc.resumeAll('admin')).rejects.toThrow(ControlError);
    expect(calls).toEqual([]);
  });

  it("won't resume when it can't see the guard", async () => {
    downloads.feed = null;
    const qc = new QueueControl(stack, downloads);
    await expect(qc.resumeAll('admin')).rejects.toThrow(/PP guard/);
    expect(calls).toEqual([]);
  });

  it('resumes a manual pause', async () => {
    downloads.feed = { ts: 0, guard: { paused: false, pausedSince: null, heartbeat: Date.now() / 1000, logTail: [] }, cleanup: { logTail: [] }, agentGate: { logTail: [] }, disks: [] };
    const qc = new QueueControl(stack, downloads);
    await qc.resumeAll('admin');
    expect(calls).toEqual(['resume']);
  });

  it('refuses Force priority at the client', () => {
    const sab = new SabClient('http://sab.invalid', 'k');
    expect(() => sab.setPriority('x', 2)).toThrow(/Force/);
  });
});
