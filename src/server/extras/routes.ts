import type { Hono } from 'hono';
import { z } from 'zod';
import type { Stack } from '../stack.ts';
import type { LibraryService } from '../services/library.ts';
import type { DownloadsService } from '../services/downloads.ts';
import type { StateService } from '../services/state.ts';
import type { DiscoverService } from '../services/discover.ts';
import { ExtrasService } from './service.ts';
import { NlDiscover } from './nl.ts';

export interface ExtrasDeps {
  library: LibraryService;
  downloads: DownloadsService;
  state: StateService;
  discover?: DiscoverService;
}

/** One instance per stack, shared by the routes and the background jobs. */
const instances = new WeakMap<Stack, { extras: ExtrasService; nl: NlDiscover | null }>();
export function extrasFor(stack: Stack, deps: ExtrasDeps) {
  let i = instances.get(stack);
  if (!i) {
    i = { extras: new ExtrasService(stack, deps.library, deps.downloads, deps.state, deps.discover), nl: deps.discover ? new NlDiscover(stack, deps.discover) : null };
    instances.set(stack, i);
  }
  return i;
}

/** Insights routes under /api/extras/*. Mounted on the admin-only sub-app (session + CSRF already enforced). */
export function mountExtras(api: Hono<any>, stack: Stack, deps: ExtrasDeps) {
  const { extras, nl } = extrasFor(stack, deps);
  const actor = (c: any): string => c.get('user').username;

  api.get('/extras/upgrades', async (c) => c.json(await extras.upgrades(c.req.query('refresh') === '1')));
  api.post('/extras/upgrades/search', async (c) => {
    const { keys } = z.object({ keys: z.array(z.string().max(60)).min(1).max(50) }).parse(await c.req.json());
    return c.json(await extras.searchUpgrades(keys, actor(c)));
  });
  api.get('/extras/forecast', async (c) => c.json(await extras.forecast()));
  api.get('/extras/hygiene', async (c) => c.json(await extras.hygiene(Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30))))));
  api.get('/extras/foryou', async (c) => c.json(await extras.forYou()));
  api.get('/extras/autobump', async (c) => c.json(await extras.autoBumpStatus()));
  api.put('/extras/autobump', async (c) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    extras.setAutoBump(enabled, actor(c));
    return c.json(await extras.autoBumpStatus());
  });
  api.get('/extras/nl', (c) => c.json(nl ? nl.status() : { enabled: false, model: null, capUsd: 0, costUsd: 0, queries: 0, recent: [] }));
  api.put('/extras/nl', async (c) => {
    if (!nl) return c.json({ error: 'TMDB is not configured' }, 503);
    const { capUsd } = z.object({ capUsd: z.number().min(0).max(500) }).parse(await c.req.json());
    nl.setCap(capUsd, actor(c));
    return c.json(nl.status());
  });
  api.post('/extras/nl', async (c) => {
    if (!nl) return c.json({ error: 'TMDB is not configured' }, 503);
    const { prompt } = z.object({ prompt: z.string().min(3).max(400) }).parse(await c.req.json());
    try {
      return c.json(await nl.run(prompt, actor(c)));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}

/** Background jobs: hourly pool-usage samples, auto-bump every 5 minutes. */
export function startExtras(stack: Stack, deps: ExtrasDeps, every: (name: string, ms: number, fn: () => Promise<unknown>, delayMs?: number) => void) {
  const { extras } = extrasFor(stack, deps);
  every('extras-disks', 3600_000, async () => extras.recordDisks(), 90_000);
  every('extras-autobump', 5 * 60_000, () => extras.runAutoBump(), 120_000);
}
