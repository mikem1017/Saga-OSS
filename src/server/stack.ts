import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { RadarrClient, SonarrClient, LidarrClient, ProwlarrClient } from './connectors/arr.ts';
import { SabClient } from './connectors/sab.ts';
import { PlexClient } from './connectors/plex.ts';
import { TautulliClient } from './connectors/tautulli.ts';
import { TmdbClient } from './connectors/tmdb.ts';
import { SeerrClient } from './connectors/seerr.ts';
import { AgentTaskClient, FeedClient, OpsClient } from './connectors/feeds.ts';

/** Every upstream client, present only when configured. The browser never sees any of these keys. */
export interface Stack {
  config: Config;
  db: DB;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  lidarr?: LidarrClient;
  prowlarr?: ProwlarrClient;
  sab?: SabClient;
  plex?: PlexClient;
  tautulli?: TautulliClient;
  tmdb?: TmdbClient;
  seerr?: SeerrClient;
  feedHost?: FeedClient;
  feedAgent?: FeedClient;
  opsStack?: OpsClient;
  opsAgent?: AgentTaskClient;
}

export function buildStack(config: Config, db: DB): Stack {
  const s: Stack = { config, db };
  if (config.RADARR_URL && config.RADARR_API_KEY) s.radarr = new RadarrClient(config.RADARR_URL, config.RADARR_API_KEY);
  if (config.SONARR_URL && config.SONARR_API_KEY) s.sonarr = new SonarrClient(config.SONARR_URL, config.SONARR_API_KEY);
  if (config.LIDARR_URL && config.LIDARR_API_KEY) s.lidarr = new LidarrClient(config.LIDARR_URL, config.LIDARR_API_KEY);
  if (config.PROWLARR_URL && config.PROWLARR_API_KEY) s.prowlarr = new ProwlarrClient(config.PROWLARR_URL, config.PROWLARR_API_KEY);
  if (config.SAB_URL && config.SAB_API_KEY) s.sab = new SabClient(config.SAB_URL, config.SAB_API_KEY);
  if (config.PLEX_URL && config.PLEX_TOKEN) s.plex = new PlexClient(config.PLEX_URL, config.PLEX_TOKEN);
  if (config.TAUTULLI_URL && config.TAUTULLI_API_KEY) s.tautulli = new TautulliClient(config.TAUTULLI_URL, config.TAUTULLI_API_KEY);
  if (config.TMDB_API_KEY) s.tmdb = new TmdbClient(config.TMDB_API_KEY, db);
  if (config.SEERR_URL && config.SEERR_API_KEY) s.seerr = new SeerrClient(config.SEERR_URL, config.SEERR_API_KEY);
  if (config.FEED_HOST) s.feedHost = new FeedClient(config.FEED_HOST, config.FEED_SSH_KEY, config.FEED_KNOWN_HOSTS);
  if (config.FEED_AGENT_HOST) s.feedAgent = new FeedClient(config.FEED_AGENT_HOST, config.FEED_SSH_KEY, config.FEED_KNOWN_HOSTS);
  if (config.OPS_STACK_HOST) s.opsStack = new OpsClient(config.OPS_STACK_HOST, config.OPS_SSH_KEY, config.FEED_KNOWN_HOSTS);
  if (config.OPS_AGENT_HOST) s.opsAgent = new AgentTaskClient(config.OPS_AGENT_HOST, config.OPS_SSH_KEY, config.FEED_KNOWN_HOSTS);
  return s;
}
