import type { MediaType, Page, TitleCard } from '../../shared/types.ts';
import type { TmdbClient } from '../connectors/tmdb.ts';
import type { StateService } from './state.ts';

type Raw = Record<string, any>;

export function toCard(r: Raw, fallbackType?: MediaType): Omit<TitleCard, 'state'> | null {
  const mediaType: MediaType | undefined = r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : fallbackType;
  if (!mediaType) return null;
  const date: string | undefined = mediaType === 'movie' ? r.release_date : r.first_air_date;
  return {
    mediaType,
    tmdbId: r.id,
    title: mediaType === 'movie' ? (r.title ?? r.original_title) : (r.name ?? r.original_name),
    year: date ? Number(date.slice(0, 4)) || undefined : undefined,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    rating: typeof r.vote_average === 'number' ? Math.round(r.vote_average * 10) / 10 : undefined,
    overview: r.overview,
  };
}

export const RAILS: Record<MediaType, { id: string; title: string; path: string; query?: Record<string, string> }[]> = {
  movie: [
    { id: 'trending', title: 'Trending this week', path: '/trending/movie/week' },
    { id: 'popular', title: 'Popular', path: '/movie/popular' },
    { id: 'now_playing', title: 'In cinemas', path: '/movie/now_playing' },
    { id: 'upcoming', title: 'Upcoming', path: '/movie/upcoming' },
    { id: 'top_rated', title: 'Top rated', path: '/movie/top_rated' },
  ],
  tv: [
    { id: 'trending', title: 'Trending this week', path: '/trending/tv/week' },
    { id: 'popular', title: 'Popular', path: '/tv/popular' },
    { id: 'on_the_air', title: 'On the air', path: '/tv/on_the_air' },
    { id: 'airing_today', title: 'Airing today', path: '/tv/airing_today' },
    { id: 'top_rated', title: 'Top rated', path: '/tv/top_rated' },
  ],
};

export interface BrowseFilters {
  type: MediaType;
  page?: number;
  sort?: string;
  genre?: string;
  decade?: string; // "1990"
  yearFrom?: number;
  yearTo?: number;
  language?: string;
  country?: string;
  provider?: string;
  company?: string;
  network?: string;
  keyword?: string;
  person?: string;
  minVotes?: number;
  minRating?: number;
  hideInLibrary?: boolean;
}

export class DiscoverService {
  constructor(
    private readonly tmdb: TmdbClient,
    private readonly state: StateService,
    private readonly region: string,
  ) {}

  private page(raw: Raw, type?: MediaType, hideInLibrary = false): Page<TitleCard> {
    let cards = this.state.decorate((raw.results ?? []).map((r: Raw) => toCard(r, type)).filter(Boolean) as Omit<TitleCard, 'state'>[]);
    if (hideInLibrary) cards = cards.filter((c) => c.state.kind === 'none' || c.state.kind === 'requested');
    return { page: raw.page ?? 1, totalPages: Math.min(raw.total_pages ?? 1, 500), totalResults: raw.total_results ?? cards.length, results: cards };
  }

  /**
   * One page of results. With `hideOwned`, titles already in Radarr/Sonarr are dropped and further TMDB pages are
   * read (up to 5) until there are ~20 left, so rows don't thin out; `nextPage` says where to continue.
   */
  private async filled(fetchPage: (p: number) => Promise<Raw>, type: MediaType | undefined, start: number, hideOwned: boolean, want = 20): Promise<Page<TitleCard>> {
    if (!hideOwned) return this.page(await fetchPage(start), type);
    const seen = new Set<string>();
    const results: TitleCard[] = [];
    let p = start;
    let totalPages = start;
    let totalResults = 0;
    while (results.length < want && p <= totalPages && p < start + 5) {
      const raw = await fetchPage(p);
      totalPages = Math.min(raw.total_pages ?? 1, 500);
      totalResults = raw.total_results ?? 0;
      for (const c of this.page(raw, type, true).results) {
        const k = `${c.mediaType}:${c.tmdbId}`;
        if (!seen.has(k)) {
          seen.add(k);
          results.push(c);
        }
      }
      p++;
    }
    return { page: start, totalPages, totalResults, results, nextPage: p <= totalPages ? p : undefined, filtered: true };
  }

  async rail(type: MediaType, railId: string, page = 1, hideOwned = false): Promise<Page<TitleCard>> {
    const rail = RAILS[type].find((r) => r.id === railId);
    if (!rail) throw new Error(`unknown rail ${railId}`);
    const ttl = railId === 'trending' ? 3600_000 : 6 * 3600_000;
    return this.filled(
      (p) => this.tmdb.get<Raw>(rail.path, { page: p, region: railId === 'upcoming' || railId === 'now_playing' ? this.region : undefined, ...rail.query }, ttl),
      type,
      page,
      hideOwned,
    );
  }

  async browse(f: BrowseFilters): Promise<Page<TitleCard>> {
    const isMovie = f.type === 'movie';
    const dateKey = isMovie ? 'primary_release_date' : 'first_air_date';
    let from = f.yearFrom;
    let to = f.yearTo;
    if (f.decade) {
      from = Number(f.decade);
      to = from + 9;
    }
    const q: Record<string, string | number | boolean | undefined> = {
      sort_by: f.sort || 'popularity.desc',
      with_genres: f.genre,
      [`${dateKey}.gte`]: from ? `${from}-01-01` : undefined,
      [`${dateKey}.lte`]: to ? `${to}-12-31` : undefined,
      with_original_language: f.language,
      with_origin_country: f.country,
      with_watch_providers: f.provider,
      watch_region: f.provider ? this.region : undefined,
      with_companies: f.company,
      with_networks: isMovie ? undefined : f.network,
      with_keywords: f.keyword,
      with_people: isMovie ? f.person : undefined,
      'vote_count.gte': f.minVotes ?? (f.sort?.startsWith('vote_average') ? 200 : undefined),
      'vote_average.gte': f.minRating,
      include_adult: false,
    };
    return this.filled((p) => this.tmdb.get<Raw>(`/discover/${f.type}`, { ...q, page: p }), f.type, f.page ?? 1, !!f.hideInLibrary);
  }

  async search(query: string, page = 1): Promise<Page<TitleCard>> {
    const raw = await this.tmdb.get<Raw>('/search/multi', { query, page, include_adult: false }, 3600_000);
    return this.page({ ...raw, results: (raw.results ?? []).filter((r: Raw) => r.media_type !== 'person') });
  }

  async searchPeople(query: string) {
    const raw = await this.tmdb.get<Raw>('/search/person', { query }, 3600_000);
    return (raw.results ?? []).slice(0, 8).map((p: Raw) => ({ id: p.id, name: p.name, profilePath: p.profile_path, knownFor: p.known_for_department }));
  }

  async genres(type: MediaType) {
    const raw = await this.tmdb.get<{ genres: { id: number; name: string }[] }>(`/genre/${type}/list`, {}, 7 * 86400_000);
    return raw.genres;
  }

  async providers(type: MediaType) {
    const raw = await this.tmdb.get<{ results: { provider_id: number; provider_name: string; logo_path: string; display_priorities?: Record<string, number> }[] }>(
      `/watch/providers/${type}`,
      { watch_region: this.region },
      7 * 86400_000,
    );
    return raw.results
      .map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path, priority: p.display_priorities?.[this.region] ?? 999 }))
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 60);
  }

  async languages() {
    const raw = await this.tmdb.get<{ iso_639_1: string; english_name: string }[]>('/configuration/languages', {}, 30 * 86400_000);
    return raw.map((l) => ({ code: l.iso_639_1, name: l.english_name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async searchCompanies(query: string) {
    const raw = await this.tmdb.get<Raw>('/search/company', { query }, 86400_000);
    return (raw.results ?? []).slice(0, 10).map((c: Raw) => ({ id: c.id, name: c.name, logoPath: c.logo_path, country: c.origin_country }));
  }

  async searchKeywords(query: string) {
    const raw = await this.tmdb.get<Raw>('/search/keyword', { query }, 86400_000);
    return (raw.results ?? []).slice(0, 10).map((k: Raw) => ({ id: k.id, name: k.name }));
  }

  /** Full detail page for a title, with library state for it and everything it links to. */
  async title(type: MediaType, id: number) {
    const append =
      type === 'movie'
        ? 'credits,recommendations,similar,videos,external_ids,watch/providers,release_dates,keywords'
        : 'aggregate_credits,recommendations,similar,videos,external_ids,watch/providers,content_ratings,keywords';
    const raw = await this.tmdb.get<Raw>(`/${type}/${id}`, { append_to_response: append });
    const card = toCard(raw, type)!;
    const credits = type === 'movie' ? raw.credits : raw.aggregate_credits;
    const cast = (credits?.cast ?? []).slice(0, 20).map((c: Raw) => ({
      id: c.id,
      name: c.name,
      character: c.character ?? c.roles?.[0]?.character,
      profilePath: c.profile_path,
    }));
    const crewWanted = new Set(['Director', 'Screenplay', 'Writer', 'Original Music Composer', 'Director of Photography', 'Executive Producer', 'Creator']);
    const crew = (credits?.crew ?? [])
      .map((c: Raw) => ({ id: c.id, name: c.name, job: c.job ?? c.jobs?.[0]?.job, profilePath: c.profile_path }))
      .filter((c: Raw) => crewWanted.has(c.job))
      .slice(0, 12);
    if (type === 'tv') for (const c of raw.created_by ?? []) crew.unshift({ id: c.id, name: c.name, job: 'Creator', profilePath: c.profile_path });
    const providers = raw['watch/providers']?.results?.[this.region];
    const trailer = (raw.videos?.results ?? []).find((v: Raw) => v.site === 'YouTube' && v.type === 'Trailer');
    const rating =
      type === 'movie'
        ? (raw.release_dates?.results ?? []).find((r: Raw) => r.iso_3166_1 === 'US')?.release_dates?.find((d: Raw) => d.certification)?.certification
        : (raw.content_ratings?.results ?? []).find((r: Raw) => r.iso_3166_1 === 'US')?.rating;
    const seasons =
      type === 'tv'
        ? (raw.seasons ?? []).map((s: Raw) => ({
            seasonNumber: s.season_number,
            name: s.name,
            episodeCount: s.episode_count,
            airDate: s.air_date,
            posterPath: s.poster_path,
          }))
        : undefined;
    return {
      ...card,
      state: this.state.for(type, id),
      tagline: raw.tagline,
      runtime: raw.runtime ?? raw.episode_run_time?.[0],
      genres: (raw.genres ?? []).map((g: Raw) => ({ id: g.id, name: g.name })),
      status: raw.status,
      releaseDate: raw.release_date ?? raw.first_air_date,
      certification: rating || undefined,
      originalLanguage: raw.original_language,
      voteCount: raw.vote_count,
      imdbId: raw.external_ids?.imdb_id ?? raw.imdb_id,
      tvdbId: raw.external_ids?.tvdb_id,
      homepage: raw.homepage,
      trailerKey: trailer?.key,
      collection: raw.belongs_to_collection ? { id: raw.belongs_to_collection.id, name: raw.belongs_to_collection.name } : undefined,
      companies: (raw.production_companies ?? []).slice(0, 4).map((c: Raw) => ({ id: c.id, name: c.name })),
      networks: (raw.networks ?? []).map((n: Raw) => ({ id: n.id, name: n.name })),
      keywords: ((raw.keywords?.keywords ?? raw.keywords?.results) ?? []).slice(0, 12).map((k: Raw) => ({ id: k.id, name: k.name })),
      providers: providers
        ? {
            link: providers.link,
            flatrate: (providers.flatrate ?? []).map((p: Raw) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path })),
          }
        : undefined,
      cast,
      crew,
      seasons,
      numberOfSeasons: raw.number_of_seasons,
      numberOfEpisodes: raw.number_of_episodes,
      recommendations: this.state.decorate((raw.recommendations?.results ?? []).slice(0, 20).map((r: Raw) => toCard(r, type)!).filter(Boolean)),
      similar: this.state.decorate((raw.similar?.results ?? []).slice(0, 20).map((r: Raw) => toCard(r, type)!).filter(Boolean)),
    };
  }

  async collection(id: number) {
    const raw = await this.tmdb.get<Raw>(`/collection/${id}`);
    const parts = this.state
      .decorate((raw.parts ?? []).map((p: Raw) => toCard(p, 'movie')!).filter(Boolean))
      .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
    const have = parts.filter((p) => p.state.kind !== 'none' && p.state.kind !== 'requested').length;
    return { id, name: raw.name, overview: raw.overview, posterPath: raw.poster_path, backdropPath: raw.backdrop_path, have, total: parts.length, parts };
  }

  async person(id: number) {
    const raw = await this.tmdb.get<Raw>(`/person/${id}`, { append_to_response: 'combined_credits,external_ids' });
    const seen = new Set<string>();
    const credits: TitleCard[] = [];
    const add = (c: Raw, role: string) => {
      const card = toCard(c);
      if (!card) return;
      const key = `${card.mediaType}:${card.tmdbId}`;
      if (seen.has(key)) return;
      seen.add(key);
      credits.push({ ...card, role, state: this.state.for(card.mediaType, card.tmdbId) });
    };
    const isCrewFirst = raw.known_for_department && raw.known_for_department !== 'Acting';
    const crew = (raw.combined_credits?.crew ?? []).filter((c: Raw) => !isCrewFirst || ['Director', 'Writer', 'Screenplay', 'Creator', 'Producer', 'Original Music Composer'].includes(c.job));
    const cast = (raw.combined_credits?.cast ?? []).filter((c: Raw) => !(c.media_type === 'tv' && (c.genre_ids ?? []).some((g: number) => g === 10767 || g === 10763))); // drop talk/news show cameos
    for (const c of isCrewFirst ? [...crew.map((c: Raw) => [c, c.job]), ...cast.map((c: Raw) => [c, c.character])] : [...cast.map((c: Raw) => [c, c.character]), ...crew.map((c: Raw) => [c, c.job])])
      add(c[0], c[1] ?? '');
    credits.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return {
      id,
      name: raw.name,
      biography: raw.biography,
      profilePath: raw.profile_path,
      knownFor: raw.known_for_department,
      birthday: raw.birthday,
      deathday: raw.deathday,
      imdbId: raw.external_ids?.imdb_id,
      credits,
    };
  }

  async company(id: number) {
    const raw = await this.tmdb.get<Raw>(`/company/${id}`, {}, 30 * 86400_000);
    return { id, name: raw.name, logoPath: raw.logo_path, country: raw.origin_country };
  }

  async network(id: number) {
    const raw = await this.tmdb.get<Raw>(`/network/${id}`, {}, 30 * 86400_000);
    return { id, name: raw.name, logoPath: raw.logo_path, country: raw.origin_country };
  }

  /** TMDB → external ids; used to add TV to Sonarr (TVDB) and to resolve pasted links. */
  externalIds(type: MediaType, id: number) {
    return this.tmdb.get<{ imdb_id?: string; tvdb_id?: number }>(`/${type}/${id}/external_ids`, {}, 30 * 86400_000);
  }

  find(externalId: string, source: 'imdb_id' | 'tvdb_id') {
    return this.tmdb.get<{ movie_results: Raw[]; tv_results: Raw[] }>(`/find/${externalId}`, { external_source: source }, 30 * 86400_000);
  }

  tmdbGet<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, ttlMs?: number) {
    return this.tmdb.get<T>(path, query, ttlMs);
  }

  rawMovie(id: number) {
    return this.tmdb.get<Raw>(`/movie/${id}`, { append_to_response: 'release_dates' });
  }

  rawTv(id: number) {
    return this.tmdb.get<Raw>(`/tv/${id}`, { append_to_response: 'content_ratings,external_ids' });
  }
}
