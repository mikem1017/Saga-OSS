// Entry point for the public request portal container (SAGA_SURFACE=portal). No database, no upstream keys.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { createPortalApp } from './portal/app.ts';
import { log } from './log.ts';

const config = loadConfig({ ...process.env, SAGA_SURFACE: 'portal' });
if (!config.INTERNAL_SECRET) throw new Error('INTERNAL_SECRET is required for the portal');
// Make sure no admin secret leaked into this container's environment.
for (const k of ['SAGA_SECRET_KEY', 'RADARR_API_KEY', 'SONARR_API_KEY', 'SAB_API_KEY', 'PROWLARR_API_KEY', 'PLEX_TOKEN', 'TAUTULLI_API_KEY', 'SEERR_API_KEY', 'RESEND_API_KEY', 'VAPID_PRIVATE_KEY'])
  if (process.env[k]) throw new Error(`${k} must not be set in the portal container`);

const app = createPortalApp(config);
const webRoot = join(process.cwd(), 'dist/portal');
if (existsSync(webRoot)) {
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('cache-control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root: './dist/portal' }));
  // Admin-shaped paths get a plain 404 rather than the guest SPA, so nothing on the public host looks like an admin route.
  app.all('/internal/*', (c) => c.text('Not found', 404));
  app.all('/ical/*', (c) => c.text('Not found', 404));
  app.get('*', (c) => c.html(indexHtml));
}

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => log.info(`Saga portal listening on :${info.port}; internal API ${config.INTERNAL_URL}`));
