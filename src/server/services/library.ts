import type { Stack } from '../stack.ts';
import type { RadarrMovie, SonarrSeries, QualityProfile, RootFolder } from '../connectors/arr.ts';
import type { SeerrRequest } from '../connectors/seerr.ts';
import { log } from '../log.ts';

/**
 * In-memory mirror of the *arr libraries, keyed by TMDB/TVDB/IMDb id. Radarr's /movie is ~15 MB for
 * ~2,200 films, so it's refreshed every 10 minutes (and right after Saga adds something), never per request.
 */
export class LibraryService {
  movies = new Map<number, RadarrMovie>(); // tmdbId → movie
  moviesById = new Map<number, RadarrMovie>(); // radarr id → movie
  series = new Map<number, SonarrSeries>(); // tmdbId → series
  seriesByTvdb = new Map<number, SonarrSeries>();
  seriesById = new Map<number, SonarrSeries>();
  imdb = new Map<string, { mediaType: 'movie' | 'tv'; tmdbId: number }>();
  requests = new Map<string, string[]>(); // "movie:123" → requesters (pending/approved Seerr requests)
  radarrProfiles: QualityProfile[] = [];
  sonarrProfiles: QualityProfile[] = [];
  radarrRoots: RootFolder[] = [];
  sonarrRoots: RootFolder[] = [];
  lastRefresh = 0;
  lastError: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly stack: Stack) {}

  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async ensureLoaded(): Promise<void> {
    if (this.lastRefresh === 0) await this.refresh();
  }

  private async doRefresh(): Promise<void> {
    const { radarr, sonarr, seerr } = this.stack;
    const errors: string[] = [];
    const t0 = Date.now();
    await Promise.all([
      radarr &&
        Promise.all([radarr.movies(), radarr.qualityProfiles(), radarr.rootFolders()])
          .then(([movies, profiles, roots]) => {
            const byTmdb = new Map<number, RadarrMovie>();
            const byId = new Map<number, RadarrMovie>();
            for (const m of movies) {
              byTmdb.set(m.tmdbId, slimMovie(m));
              byId.set(m.id, byTmdb.get(m.tmdbId)!);
            }
            this.movies = byTmdb;
            this.moviesById = byId;
            this.radarrProfiles = profiles;
            this.radarrRoots = roots.map((r) => ({ id: r.id, path: r.path, freeSpace: r.freeSpace }));
          })
          .catch((e) => errors.push(String(e.message ?? e))),
      sonarr &&
        Promise.all([sonarr.series(), sonarr.qualityProfiles(), sonarr.rootFolders()])
          .then(([series, profiles, roots]) => {
            const byTmdb = new Map<number, SonarrSeries>();
            const byTvdb = new Map<number, SonarrSeries>();
            const byId = new Map<number, SonarrSeries>();
            for (const s of series) {
              if (s.tmdbId) byTmdb.set(s.tmdbId, s);
              byTvdb.set(s.tvdbId, s);
              byId.set(s.id, s);
            }
            this.series = byTmdb;
            this.seriesByTvdb = byTvdb;
            this.seriesById = byId;
            this.sonarrProfiles = profiles;
            this.sonarrRoots = roots.map((r) => ({ id: r.id, path: r.path, freeSpace: r.freeSpace }));
          })
          .catch((e) => errors.push(String(e.message ?? e))),
      seerr &&
        seerr
          .allRequests()
          .then((reqs) => (this.requests = indexRequests(reqs)))
          .catch((e) => errors.push(String(e.message ?? e))),
    ]);
    // Seerr was retired 2026-10-08: without it, the "requested" badge comes from Saga's own portal requests.
    if (!seerr) this.requests = this.portalRequests();
    const imdb = new Map<string, { mediaType: 'movie' | 'tv'; tmdbId: number }>();
    for (const m of this.movies.values()) if (m.imdbId) imdb.set(m.imdbId, { mediaType: 'movie', tmdbId: m.tmdbId });
    for (const s of this.series.values()) if (s.imdbId && s.tmdbId) imdb.set(s.imdbId, { mediaType: 'tv', tmdbId: s.tmdbId });
    this.imdb = imdb;
    this.lastRefresh = Date.now();
    this.lastError = errors.length ? errors.join('; ') : null;
    log.info(`library refreshed in ${Date.now() - t0} ms: ${this.movies.size} movies, ${this.series.size} series${errors.length ? ` (errors: ${this.lastError})` : ''}`);
  }

  /** Pending portal requests, keyed "movie:123" → requester names. Empty if the portal tables don't exist. */
  private portalRequests(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    try {
      const rows = this.stack.db
        .prepare(
          `SELECT r.media_type AS t, r.tmdb_id AS id, g.username AS who FROM requests r
             JOIN request_requesters rr ON rr.request_id = r.id JOIN guests g ON g.id = rr.guest_id
            WHERE r.status = 'pending'`,
        )
        .all() as { t: string; id: number; who: string }[];
      for (const r of rows) {
        const key = `${r.t}:${r.id}`;
        const list = out.get(key) ?? [];
        if (!list.includes(r.who)) list.push(r.who);
        out.set(key, list);
      }
    } catch {
      /* portal not set up */
    }
    return out;
  }

  /** Mean on-disk size of a film under a quality profile, from the films we already have. */
  movieSizeEstimate(qualityProfileId: number): { bytes: number; basis: string } {
    const sizes: number[] = [];
    for (const m of this.movies.values()) if (m.hasFile && m.qualityProfileId === qualityProfileId && m.movieFile?.size) sizes.push(m.movieFile.size);
    if (sizes.length >= 5) {
      const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      return { bytes: Math.round(mean), basis: `mean of ${sizes.length} films on this profile` };
    }
    return { bytes: 20 * 1024 ** 3, basis: 'default 20 GB (too few films on this profile)' };
  }

  /** Mean episode size under a quality profile. */
  episodeSizeEstimate(qualityProfileId: number): { bytes: number; basis: string } {
    let bytes = 0;
    let files = 0;
    for (const s of this.seriesById.values()) {
      if (s.qualityProfileId !== qualityProfileId || !s.statistics?.episodeFileCount) continue;
      bytes += s.statistics.sizeOnDisk;
      files += s.statistics.episodeFileCount;
    }
    if (files >= 10) return { bytes: Math.round(bytes / files), basis: `mean of ${files} episodes on this profile` };
    return { bytes: 1.5 * 1024 ** 3, basis: 'default 1.5 GB/episode' };
  }
}

function slimMovie(m: RadarrMovie): RadarrMovie {
  // Drop the heavy fields (alternate titles, images, keywords) we never use.
  return {
    id: m.id,
    title: m.title,
    year: m.year,
    tmdbId: m.tmdbId,
    imdbId: m.imdbId,
    hasFile: m.hasFile,
    monitored: m.monitored,
    isAvailable: m.isAvailable,
    status: m.status,
    qualityProfileId: m.qualityProfileId,
    rootFolderPath: m.rootFolderPath,
    sizeOnDisk: m.sizeOnDisk,
    added: m.added,
    certification: m.certification,
    genres: m.genres,
    path: m.path,
    collection: m.collection,
    movieFile: m.movieFile ? { quality: m.movieFile.quality, size: m.movieFile.size, mediaInfo: m.movieFile.mediaInfo } : undefined,
  };
}

function indexRequests(reqs: SeerrRequest[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of reqs) {
    if (r.status !== 1 && r.status !== 2) continue; // pending or approved
    const key = `${r.type}:${r.media.tmdbId}`;
    const who = r.requestedBy.displayName || r.requestedBy.plexUsername || r.requestedBy.username || r.requestedBy.email || `user ${r.requestedBy.id}`;
    const list = out.get(key) ?? [];
    if (!list.includes(who)) list.push(who);
    out.set(key, list);
  }
  return out;
}
