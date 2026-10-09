import type { DB } from '../db.ts';
import { getSetting, setSetting } from '../db.ts';

export interface PortalSettings {
  /** Plex friends/shared users of the server owner may sign in without an invite. */
  allowPlexFriends: boolean;
  defaults: {
    moviesPerWeek: number;
    seasonsPerWeek: number;
    gbPerMonth: number;
    /** Requests estimated at or under this many GB are approved automatically. 0 = everything waits for approval. */
    autoApproveGb: number;
  };
  /** Certifications a kid profile may request (US). Unrated titles are refused. */
  kidRatings: string[];
  /** Watchlist sync adds at most this many requests per guest per run. */
  watchlistMaxPerRun: number;
}

export const DEFAULT_PORTAL_SETTINGS: PortalSettings = {
  allowPlexFriends: true,
  defaults: { moviesPerWeek: 5, seasonsPerWeek: 3, gbPerMonth: 750, autoApproveGb: 0 },
  kidRatings: ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG'],
  watchlistMaxPerRun: 5,
};

export function portalSettings(db: DB): PortalSettings {
  const s = getSetting<Partial<PortalSettings>>(db, 'portal.settings', {});
  return { ...DEFAULT_PORTAL_SETTINGS, ...s, defaults: { ...DEFAULT_PORTAL_SETTINGS.defaults, ...(s.defaults ?? {}) } };
}

export function savePortalSettings(db: DB, s: PortalSettings): void {
  setSetting(db, 'portal.settings', s);
}
