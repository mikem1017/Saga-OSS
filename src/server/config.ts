import { z } from 'zod';

const optionalUrl = z.string().url().optional().or(z.literal('').transform(() => undefined));
const optional = z.string().optional().or(z.literal('').transform(() => undefined));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(3000),
  /** Which surface this process serves. The request portal (phase 5) runs as its own container. */
  SAGA_SURFACE: z.enum(['admin', 'portal']).default('admin'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  /** Base64 32-byte key: session signing + secrets-at-rest encryption. */
  SAGA_SECRET_KEY: z.string().min(32).optional(), // required by the admin surface; the portal process never has it
  SAGA_ADMIN_USER: z.string().default('admin'),
  SAGA_ADMIN_PASSWORD: optional,
  /** Comma-separated reverse-proxy addresses whose X-Forwarded-For / X-Real-IP Saga believes. Add your proxy's IP. */
  TRUSTED_PROXIES: z.string().default('127.0.0.1,::1,::ffff:127.0.0.1'),

  RADARR_URL: optionalUrl,
  RADARR_API_KEY: optional,
  SONARR_URL: optionalUrl,
  SONARR_API_KEY: optional,
  LIDARR_URL: optionalUrl,
  LIDARR_API_KEY: optional,
  PROWLARR_URL: optionalUrl,
  PROWLARR_API_KEY: optional,
  SAB_URL: optionalUrl,
  SAB_API_KEY: optional,
  PLEX_URL: optionalUrl,
  PLEX_TOKEN: optional,
  TAUTULLI_URL: optionalUrl,
  TAUTULLI_API_KEY: optional,
  SEERR_URL: optionalUrl,
  SEERR_API_KEY: optional,
  TMDB_API_KEY: optional,
  TRAKT_CLIENT_ID: optional,
  // Optional SSH integrations (see docs/integrations.md). Each target pins Saga's key to one forced command.
  /** user@host whose forced command prints the download host's status JSON (PP guard, logs, disks, leftovers). */
  FEED_HOST: optional,
  /** user@host whose forced command prints the maintenance agent's status JSON (journal, log tail). */
  FEED_AGENT_HOST: optional,
  FEED_SSH_KEY: z.string().default('/ssh/id_ed25519'),
  FEED_KNOWN_HOSTS: z.string().default('/ssh/known_hosts'),
  /** user@host running deploy/hosts/download-host/saga-ops (stack updates). Uses a separate key from the read-only feeds. */
  OPS_STACK_HOST: optional,
  OPS_SSH_KEY: z.string().default('/ssh/ops_ed25519'),
  /** user@host running deploy/hosts/agent-host/saga-agent-task ("Ask the agent"). Same ops key. */
  OPS_AGENT_HOST: optional,
  /** Quality profile picked when no add rule sets one. Unset: the profile with the most scored custom formats. */
  DEFAULT_MOVIE_PROFILE: optional,
  DEFAULT_TV_PROFILE: optional,
  /** Mount points in the download host's disk feed: the media library pool and the download cache. */
  MEDIA_MOUNT: z.string().default('/mnt/media'),
  CACHE_MOUNT: z.string().default('/mnt/cache'),
  /** SABnzbd's "minimum free space" (download_free), for storage forecasts. */
  SAB_MIN_FREE_GB: z.coerce.number().default(500),
  /** Region for streaming-provider discovery. */
  WATCH_REGION: z.string().default('US'),
  /** Set to 0 to stop background polling (tests, offline dev). */
  POLLING: z.string().default('1'),
  // Request portal. The admin process serves a small internal API on INTERNAL_PORT (compose network
  // only); the portal process holds nothing but INTERNAL_URL + INTERNAL_SECRET.
  INTERNAL_PORT: z.coerce.number().default(3001),
  INTERNAL_SECRET: z.string().min(32).optional().or(z.literal('').transform(() => undefined)),
  INTERNAL_URL: z.string().default('http://saga:3001'),
  /** Public URL of the request portal (used in invite links and emails). */
  PORTAL_PUBLIC_URL: z.string().default('http://localhost:3002'),
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  RESEND_API_KEY: optional,
  MAIL_FROM: z.string().default('Saga Requests <saga@example.com>'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
