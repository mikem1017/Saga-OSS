import type { Stack } from '../stack.ts';
import type { MediaType, TitleCard } from '../../shared/types.ts';
import type { LibraryService } from '../services/library.ts';
import type { DownloadsService } from '../services/downloads.ts';
import type { StateService } from '../services/state.ts';
import type { DiscoverService } from '../services/discover.ts';
import { toCard } from '../services/discover.ts';
import type { AddService } from '../services/add.ts';
import type { ResolveService } from '../services/resolve.ts';
import type { ListService } from '../services/lists.ts';
import { detectList } from '../services/lists.ts';
import type { HealthService } from '../services/health.ts';
import { Notifier } from './notify.ts';
import { PlexTv, plexClientId } from './plex.ts';
import { RequestService, guestState, type Coverage, type GuestState, type TitleInfo } from './requests.ts';
import { importFromSeerr } from './seerrImport.ts';
import type { Guest } from './guests.ts';
import { listGuests } from './guests.ts';
import { log } from '../log.ts';

export interface GuestCard {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  rating?: number;
  state: GuestState;
}

const GUEST_RAILS: Record<'guest' | 'kid', { id: string; title: string; type: MediaType; path: string; query?: Record<string, string | number> }[]> = {
  guest: [
    { id: 'trending-movie', title: 'Trending films', type: 'movie', path: '/trending/movie/week' },
    { id: 'trending-tv', title: 'Trending shows', type: 'tv', path: '/trending/tv/week' },
    { id: 'popular-movie', title: 'Popular films', type: 'movie', path: '/movie/popular' },
    { id: 'upcoming-movie', title: 'Coming to cinemas', type: 'movie', path: '/movie/upcoming' },
    { id: 'popular-tv', title: 'Popular shows', type: 'tv', path: '/tv/popular' },
    { id: 'top-movie', title: 'Top rated films', type: 'movie', path: '/movie/top_rated' },
  ],
  kid: [
    { id: 'family-movie', title: 'Family films', type: 'movie', path: '/discover/movie', query: { with_genres: '10751', certification_country: 'US', 'certification.lte': 'PG', sort_by: 'popularity.desc' } },
    { id: 'animated-movie', title: 'Animated films', type: 'movie', path: '/discover/movie', query: { with_genres: '16', certification_country: 'US', 'certification.lte': 'PG', sort_by: 'popularity.desc' } },
    { id: 'kids-tv', title: 'Kids shows', type: 'tv', path: '/discover/tv', query: { with_genres: '10762', sort_by: 'popularity.desc' } },
    { id: 'family-tv', title: 'Family shows', type: 'tv', path: '/discover/tv', query: { with_genres: '10751', without_genres: '10765,80,10768', sort_by: 'popularity.desc' } },
  ],
};

/** Everything the portal needs on the admin side: request logic, guest-safe discover, notifications. */
export class PortalService {
  readonly notifier: Notifier;
  readonly requests: RequestService;
  readonly plexTv: PlexTv;

  constructor(
    private readonly stack: Stack,
    private readonly s: {
      library: LibraryService;
      downloads: DownloadsService;
      state: StateService;
      discover: DiscoverService;
      add: AddService;
      resolver: ResolveService;
      lists: ListService;
      health: HealthService;
    },
  ) {
    this.notifier = new Notifier(stack.db, stack.config);
    this.plexTv = new PlexTv(plexClientId(stack.db), stack.config.PLEX_TOKEN);
    this.requests = new RequestService({
      db: stack.db,
      notifier: this.notifier,
      titleInfo: (t, id) => this.titleInfo(t, id),
      estimate: async (t, id, seasons) => {
        const p = await s.add.preview([{ mediaType: t, tmdbId: id, overrides: t === 'tv' ? { seasons } : undefined }]);
        return p.items[0]?.alreadyInLibrary ? 0 : (p.items[0]?.estBytes ?? 0);
      },
      addToArr: async (t, id, seasons, actor) => {
        const [r] = await s.add.add([{ mediaType: t, tmdbId: id, overrides: t === 'tv' && seasons ? { seasons } : undefined }], actor);
        return r ? { ok: r.ok, message: r.message, arrId: r.arrId } : { ok: false, message: 'no result' };
      },
      state: (t, id) => s.state.for(t, id),
      coverage: (t, id) => this.coverage(t, id),
    });
  }

  async titleInfo(type: MediaType, tmdbId: number): Promise<TitleInfo> {
    const raw = type === 'movie' ? await this.s.discover.rawMovie(tmdbId) : await this.s.discover.rawTv(tmdbId);
    const cert =
      type === 'movie'
        ? (raw.release_dates?.results ?? []).find((r: any) => r.iso_3166_1 === 'US')?.release_dates?.find((d: any) => d.certification)?.certification
        : (raw.content_ratings?.results ?? []).find((r: any) => r.iso_3166_1 === 'US')?.rating;
    const date: string | undefined = type === 'movie' ? raw.release_date : raw.first_air_date;
    return {
      mediaType: type,
      tmdbId,
      title: type === 'movie' ? raw.title : raw.name,
      year: date ? Number(date.slice(0, 4)) || undefined : undefined,
      posterPath: raw.poster_path ?? null,
      certification: cert || undefined,
      genres: (raw.genres ?? []).map((g: any) => g.name),
      seasons: (raw.seasons ?? []).filter((x: any) => x.season_number > 0).map((x: any) => ({ seasonNumber: x.season_number, episodeCount: x.episode_count, airDate: x.air_date })),
    };
  }

  coverage(type: MediaType, tmdbId: number): Coverage {
    if (type === 'movie') {
      const m = this.s.library.movies.get(tmdbId);
      return { inLibrary: !!m, available: !!m?.hasFile, seasonsMonitored: [], seasonsComplete: [] };
    }
    const series = this.s.library.series.get(tmdbId);
    if (!series) return { inLibrary: false, available: false, seasonsMonitored: [], seasonsComplete: [] };
    const regular = series.seasons.filter((x) => x.seasonNumber > 0);
    return {
      inLibrary: true,
      available: (series.statistics?.episodeFileCount ?? 0) > 0,
      seasonsMonitored: regular.filter((x) => x.monitored).map((x) => x.seasonNumber),
      seasonsComplete: regular
        .filter((x) => (x.statistics?.episodeCount ?? 0) > 0 && (x.statistics?.episodeFileCount ?? 0) >= (x.statistics?.episodeCount ?? 0))
        .map((x) => x.seasonNumber),
    };
  }

  private cards(raw: any[], type?: MediaType): GuestCard[] {
    return raw
      .map((r) => toCard(r, type))
      .filter((c): c is Omit<TitleCard, 'state'> => !!c)
      .map((c) => ({ mediaType: c.mediaType, tmdbId: c.tmdbId, title: c.title, year: c.year, posterPath: c.posterPath, rating: c.rating, state: guestState(this.s.state.for(c.mediaType, c.tmdbId)) }));
  }

  rails(guest: Guest) {
    return GUEST_RAILS[guest.role].map(({ id, title, type }) => ({ id, title, type }));
  }

  async rail(guest: Guest, railId: string, page = 1) {
    const rail = GUEST_RAILS[guest.role].find((r) => r.id === railId);
    if (!rail) throw new Error('Unknown rail');
    await this.s.library.ensureLoaded();
    const raw = await this.s.discover.tmdbGet<any>(rail.path, { page, region: rail.id.startsWith('upcoming') ? this.stack.config.WATCH_REGION : undefined, ...rail.query }, rail.id.startsWith('trending') ? 3600_000 : 6 * 3600_000);
    return { page: raw.page ?? 1, totalPages: Math.min(raw.total_pages ?? 1, 50), results: this.cards(raw.results ?? [], rail.type) };
  }

  /** Search or paste-a-link, guest-safe. A pasted link to a single title returns `match`. */
  async search(q: string, page = 1) {
    await this.s.library.ensureLoaded();
    const res = await this.s.resolver.resolve(q, page);
    return {
      match: res.match ?? null,
      page: res.results.page,
      totalPages: res.results.totalPages,
      results: res.results.results.map((c) => ({ mediaType: c.mediaType, tmdbId: c.tmdbId, title: c.title, year: c.year, posterPath: c.posterPath, rating: c.rating, state: guestState(c.state) })),
    };
  }

  /** A reduced title page: no file paths, profiles, requester names or *arr internals. */
  async title(guest: Guest, type: MediaType, tmdbId: number) {
    await this.s.library.ensureLoaded();
    const d = await this.s.discover.title(type, tmdbId);
    const info = await this.titleInfo(type, tmdbId);
    const cov = this.coverage(type, tmdbId);
    const mine = this.requests.guestRequestFor(guest.id, type, tmdbId);
    return {
      mediaType: type,
      tmdbId,
      title: d.title,
      year: d.year,
      posterPath: d.posterPath,
      backdropPath: d.backdropPath,
      overview: d.overview,
      tagline: d.tagline,
      runtime: d.runtime,
      rating: d.rating,
      certification: info.certification ?? null,
      genres: d.genres.map((g: { name: string }) => g.name),
      trailerKey: d.trailerKey,
      cast: d.cast.slice(0, 10).map((c: any) => ({ name: c.name, character: c.character, profilePath: c.profilePath })),
      seasons: type === 'tv' ? info.seasons.filter((x) => x.episodeCount > 0).map((x) => ({ ...x, inPlex: cov.seasonsComplete.includes(x.seasonNumber), coming: cov.seasonsMonitored.includes(x.seasonNumber) })) : undefined,
      state: guestState(this.s.state.for(type, tmdbId)),
      allowed: this.requests.ratingAllowed(guest, info),
      myRequest: mine,
      recommendations: (d.recommendations ?? [])
        .slice(0, 12)
        .map((c: TitleCard): GuestCard => ({ mediaType: c.mediaType, tmdbId: c.tmdbId, title: c.title, year: c.year, posterPath: c.posterPath, rating: c.rating, state: guestState(c.state) })),
    };
  }

  /** What's on its way to this guest, what landed for them recently, and what's new in the library. */
  async comingSoon(guest: Guest) {
    const mine = this.requests.forGuest(guest.id);
    const fortnight = Date.now() - 14 * 86400_000;
    const newInLibrary: GuestCard[] = [];
    try {
      const since = new Date(Date.now() - 7 * 86400_000);
      const seen = new Set<string>();
      const recs = [
        ...(this.stack.radarr ? (await this.stack.radarr.importsSince(since, 2)).map((r) => ({ type: 'movie' as const, id: r.movieId })) : []),
        ...(this.stack.sonarr ? (await this.stack.sonarr.importsSince(since, 2)).map((r) => ({ type: 'tv' as const, id: r.seriesId })) : []),
      ];
      for (const r of recs) {
        if (newInLibrary.length >= 24 || !r.id) continue;
        const item = r.type === 'movie' ? this.s.library.moviesById.get(r.id) : this.s.library.seriesById.get(r.id);
        const tmdbId = item?.tmdbId;
        if (!item || !tmdbId || seen.has(`${r.type}:${tmdbId}`)) continue;
        seen.add(`${r.type}:${tmdbId}`);
        if (guest.ratingCap && !(item.certification && guest.ratingCap.includes(item.certification))) continue;
        const raw = await this.s.discover.tmdbGet<any>(`/${r.type}/${tmdbId}`, {}, 30 * 86400_000).catch(() => null);
        if (raw) newInLibrary.push(...this.cards([raw], r.type));
      }
    } catch (err) {
      log.warn(`coming soon: ${err instanceof Error ? err.message : err}`);
    }
    return {
      onTheWay: mine.filter((r) => r.status === 'pending' || r.status === 'approved' || r.status === 'failed').filter((r) => r.step !== 'available'),
      readyForYou: mine.filter((r) => r.step === 'available' && (r.availableAt ?? r.createdAt) > fortnight),
      newInLibrary,
    };
  }

  /** Admin-posted notes plus automatic, non-technical notices derived from health and throughput. */
  status() {
    const posts = this.stack.db
      .prepare('SELECT id, message, level, created_at AS createdAt FROM status_posts WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC')
      .all(Date.now()) as { id: number; message: string; level: string; createdAt: number }[];
    const auto: { level: string; message: string }[] = [];
    const health = new Map(this.s.health.list().map((h) => [h.id, h]));
    if (health.get('plex')?.status === 'error') auto.push({ level: 'warn', message: "Plex is having trouble right now, so some things may not play. It's being looked at." });
    const q = this.s.downloads.queue;
    const reason = this.s.downloads.pauseReason();
    if (q?.paused && reason && !reason.startsWith('PP guard') && !reason.startsWith('Timed')) auto.push({ level: 'warn', message: 'Downloads are paused at the moment, so new requests will wait a bit longer.' });
    else {
      const { bps, windowMin } = this.s.downloads.rate();
      if (windowMin > 0 && bps !== null && bps < 15 * 1024 ** 2 && (q?.noofslots_total ?? 0) > 0) auto.push({ level: 'info', message: 'Downloads are slower than usual tonight, so ready-times may slip.' });
    }
    return { posts, auto, updatedAt: Date.now() };
  }

  /** Every linked watchlist, within each guest's limits. */
  async runWatchlists(): Promise<void> {
    for (const g of listGuests(this.stack.db)) {
      if (!g.enabled || !g.watchlistUrl) continue;
      const ref = detectList(g.watchlistUrl);
      if (!ref) continue;
      try {
        const list = await this.s.lists.resolve(ref);
        await this.requests.syncWatchlist(
          g.id,
          list.items.map((i) => ({ mediaType: i.mediaType, tmdbId: i.tmdbId, state: i.state })),
        );
      } catch (err) {
        this.stack.db.prepare('UPDATE guests SET watchlist_synced_at = ?, watchlist_note = ? WHERE id = ?').run(Date.now(), `couldn't read the list: ${err instanceof Error ? err.message.slice(0, 200) : err}`, g.id);
      }
    }
  }

  async seerrImport(dryRun: boolean, actor: string) {
    const seerr = this.stack.seerr;
    if (!seerr) throw new Error('Seerr is not configured');
    const [users, requests] = await Promise.all([seerr.users(), seerr.allRequests()]);
    return importFromSeerr(this.stack.db, { users, requests }, (t, id) => this.titleInfo(t, id), { dryRun, actor });
  }
}
