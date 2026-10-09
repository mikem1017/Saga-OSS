import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb, pruneCache } from './db.ts';
import { buildStack } from './stack.ts';
import { bootstrapAdmin } from './auth.ts';
import { createApp } from './app.ts';
import { LibraryService } from './services/library.ts';
import { DownloadsService } from './services/downloads.ts';
import { StateService } from './services/state.ts';
import { DiscoverService } from './services/discover.ts';
import { AddService } from './services/add.ts';
import { ResolveService } from './services/resolve.ts';
import { ListService } from './services/lists.ts';
import { ThroughputService } from './services/throughput.ts';
import { HealthService } from './services/health.ts';
import { seedRules } from './services/rules.ts';
import { ControlPlane } from './services/controlPlane.ts';
import { SecretBox } from './crypto.ts';
import { startExtras } from './extras/routes.ts';
import { PortalService } from './portal/service.ts';
import { createInternalApp } from './portal/internal.ts';
import { log } from './log.ts';

const config = loadConfig();
if (!config.SAGA_SECRET_KEY) throw new Error('SAGA_SECRET_KEY is required (base64, 32 bytes)');
const db = openDb(config.DATA_DIR);
bootstrapAdmin(db, config);
const stack = buildStack(config, db);

const library = new LibraryService(stack);
const downloads = new DownloadsService(stack, library);
const state = new StateService(library, downloads);
const discover = stack.tmdb ? new DiscoverService(stack.tmdb, state, config.WATCH_REGION) : undefined;
const resolver = discover ? new ResolveService(stack, discover) : undefined;
const services = {
  library,
  downloads,
  state,
  discover,
  resolver,
  add: discover ? new AddService(stack, library, downloads, discover) : undefined,
  lists: discover && resolver ? new ListService(stack, discover, resolver, state) : undefined,
  throughput: new ThroughputService(stack, downloads),
  health: new HealthService(stack, downloads, library),
  control: new ControlPlane(stack, new SecretBox(config.SAGA_SECRET_KEY!)),
};

// Phase 5: the request portal's logic lives here; the public portal container only talks to the internal API.
const portal =
  discover && resolver && services.add && services.lists
    ? new PortalService(stack, { library, downloads, state, discover, add: services.add, resolver, lists: services.lists, health: services.health })
    : undefined;

const app = createApp(stack, { ...services, portal });

// The built web app (vite build → dist/web). Unknown non-API paths fall back to index.html for the SPA router.
const webRoot = join(process.cwd(), 'dist/web');
if (config.SAGA_SURFACE === 'admin' && existsSync(webRoot)) {
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('cache-control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root: './dist/web' }));
  app.get('*', (c) => c.html(indexHtml));
}

/** Run `fn` now and every `ms`, never overlapping itself. */
function every(name: string, ms: number, fn: () => Promise<unknown>, delayMs = 0) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error(`poller ${name}`, err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(tick, ms).unref();
  }, delayMs).unref();
}

if (config.POLLING === '1' && config.SAGA_SURFACE === 'admin') {
  every('library', 10 * 60_000, async () => {
    await library.refresh();
    seedRules(db, library.sonarrProfiles);
  });
  every('sab-queue', 20_000, () => downloads.pollQueue(), 2_000);
  every('arr-queue', 60_000, () => downloads.pollArr(), 5_000);
  every('host-feed', 60_000, () => downloads.pollFeed(), 1_000);
  every('sample', 60_000, () => downloads.sample(), 10_000);
  every('health', 2 * 60_000, () => services.health.refresh(), 15_000);
  every('prune', 3600_000, async () => pruneCache(db), 60_000);
  startExtras(stack, services, every); // Insights: pool samples + release-aware auto-bump
  if (portal) {
    every('request-availability', 2 * 60_000, () => portal.requests.checkAvailability(), 90_000);
    setTimeout(() => void portal.requests.approvePendingForTrusted().then((n) => n && log.info(`auto-approved ${n} waiting request(s) from trusted guests`)), 20_000).unref();
    every('watchlists', 6 * 3600_000, () => portal.runWatchlists(), 5 * 60_000);
  }
}

// Internal API for the portal container: its own port, never published, shared-secret only.
if (portal && config.INTERNAL_SECRET) {
  const internal = createInternalApp(db, config, portal);
  serve({ fetch: internal.fetch, port: config.INTERNAL_PORT, hostname: '0.0.0.0' }, (info) => log.info(`internal portal API on :${info.port}`));
}

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  const configured = ['radarr', 'sonarr', 'lidarr', 'prowlarr', 'sab', 'plex', 'tautulli', 'tmdb', 'seerr', 'feedHost', 'feedAgent'].filter((k) => (stack as any)[k]);
  log.info(`Saga (${config.SAGA_SURFACE}) listening on :${info.port}; connectors: ${configured.join(', ') || 'none'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    log.info(`${sig}: closing database`);
    db.close();
    process.exit(0);
  });
