import { requestJson, type RequestOptions } from '../http.ts';

export interface ArrHealth {
  source: string;
  type: 'ok' | 'notice' | 'warning' | 'error';
  message: string;
  wikiUrl?: string;
}

export interface QualityProfile {
  id: number;
  name: string;
  /** Summary of the profile as configured in the *arr (Saga never copies or edits the values). */
  upgradeAllowed?: boolean;
  cutoff?: string;
  allowed?: string[];
  scoredFormats?: number;
  cutoffFormatScore?: number;
  minFormatScore?: number;
  /** No custom formats and no upgrades: an untuned default profile. */
  stock?: boolean;
}

/** Turn a raw *arr quality profile into the summary above. */
export function summariseProfile(p: any): QualityProfile {
  const name = (i: any) => i.name ?? i.quality?.name;
  const allowed: string[] = (p.items ?? []).filter((i: any) => i.allowed).map(name);
  const cutoffItem = (p.items ?? []).find((i: any) => (i.id ?? i.quality?.id) === p.cutoff);
  const scored = (p.formatItems ?? []).filter((f: any) => f.score).length;
  return {
    id: p.id,
    name: p.name,
    upgradeAllowed: !!p.upgradeAllowed,
    cutoff: cutoffItem ? name(cutoffItem) : undefined,
    allowed,
    scoredFormats: scored,
    cutoffFormatScore: p.cutoffFormatScore,
    minFormatScore: p.minFormatScore,
    stock: scored === 0 && !p.upgradeAllowed,
  };
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace?: number;
}

export interface ArrQuality {
  quality: { id: number; name: string; source?: string; resolution?: number; modifier?: string };
}

export interface ArrQueueRecord {
  id: number;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  seasonNumber?: number;
  title: string;
  size: number;
  sizeleft: number;
  status: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title: string; messages: string[] }[];
  errorMessage?: string;
  downloadId?: string;
  protocol: string;
  downloadClient?: string;
  indexer?: string;
  quality?: ArrQuality;
  added?: string;
}

export interface ArrHistoryRecord {
  id: number;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  sourceTitle: string;
  date: string;
  eventType: string;
  downloadId?: string;
  quality?: ArrQuality;
  data?: Record<string, string>;
}

/** Shared Servarr v3 client. Lidarr and Prowlarr use v1. */
export class ArrClient {
  constructor(
    readonly app: string,
    readonly baseUrl: string,
    private readonly apiKey: string,
    readonly apiVersion: 'v3' | 'v1' = 'v3',
  ) {}

  request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return requestJson<T>(this.app, this.baseUrl, `/api/${this.apiVersion}${path}`, {
      ...opts,
      headers: { 'X-Api-Key': this.apiKey, ...opts.headers },
    });
  }

  systemStatus() {
    return this.request<{ version: string; appName?: string; instanceName?: string }>('/system/status');
  }

  health() {
    return this.request<ArrHealth[]>('/health');
  }

  async qualityProfiles(): Promise<QualityProfile[]> {
    return (await this.request<any[]>('/qualityprofile')).map(summariseProfile);
  }

  rootFolders() {
    return this.request<RootFolder[]>('/rootfolder');
  }

  async queueAll(extra: Record<string, string | number | boolean> = {}): Promise<ArrQueueRecord[]> {
    const res = await this.request<{ totalRecords: number; records: ArrQueueRecord[] }>('/queue', {
      query: { page: 1, pageSize: 5000, includeUnknownMovieItems: false, includeUnknownSeriesItems: false, ...extra },
      timeoutMs: 60_000,
    });
    return res.records;
  }

  /** Imports (eventType 3 = downloadFolderImported) since a date, newest first. */
  async importsSince(since: Date, maxPages = 10): Promise<ArrHistoryRecord[]> {
    const out: ArrHistoryRecord[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request<{ records: ArrHistoryRecord[] }>('/history', {
        query: { page, pageSize: 250, sortKey: 'date', sortDirection: 'descending', eventType: 3 },
      });
      for (const r of res.records) {
        if (new Date(r.date) < since) return out;
        out.push(r);
      }
      if (res.records.length < 250) break;
    }
    return out;
  }

  /** Grabs and failures, newest first, for the failure-rate stat. */
  async historySince(since: Date, eventType: number, maxPages = 6): Promise<ArrHistoryRecord[]> {
    const out: ArrHistoryRecord[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request<{ records: ArrHistoryRecord[] }>('/history', {
        query: { page, pageSize: 250, sortKey: 'date', sortDirection: 'descending', eventType },
      });
      for (const r of res.records) {
        if (new Date(r.date) < since) return out;
        out.push(r);
      }
      if (res.records.length < 250) break;
    }
    return out;
  }

  calendar(start: Date, end: Date, extra: Record<string, string | boolean> = {}) {
    return this.request<any[]>('/calendar', {
      query: { start: start.toISOString(), end: end.toISOString(), unmonitored: false, ...extra },
    });
  }

  /** Read-only connectivity test of every download client. */
  testAllDownloadClients() {
    return this.request<{ id: number; isValid: boolean; validationFailures: { errorMessage: string }[] }[]>(
      '/downloadclient/testall',
      { method: 'POST', timeoutMs: 30_000 },
    );
  }

  command(name: string, body: Record<string, unknown> = {}) {
    return this.request<{ id: number; status: string }>('/command', { method: 'POST', body: { name, ...body } });
  }

  removeQueueItem(id: number, opts: { removeFromClient: boolean; blocklist: boolean; skipRedownload: boolean }) {
    return this.request<void>(`/queue/${id}`, { method: 'DELETE', query: opts });
  }

  /** Interactive search: every release the indexers return, with the *arr's accept/reject decision. Slow (hits indexers). */
  releases(query: { movieId?: number; episodeId?: number; seriesId?: number; seasonNumber?: number }) {
    return this.request<ArrRelease[]>('/release', { query, timeoutMs: 180_000 });
  }

  /** Grab one release from an interactive search, so the *arr tracks the download. */
  grabRelease(guid: string, indexerId: number) {
    return this.request<unknown>('/release', { method: 'POST', body: { guid, indexerId }, timeoutMs: 60_000 });
  }

  /** What the *arr makes of a release or folder name. */
  parse(title: string) {
    return this.request<ArrParse>('/parse', { query: { title } });
  }

  /** History for one download (SAB nzo_id), newest first. */
  async historyForDownload(downloadId: string): Promise<ArrHistoryRecord[]> {
    const res = await this.request<{ records: ArrHistoryRecord[] }>('/history', { query: { page: 1, pageSize: 50, downloadId } });
    return res.records;
  }
}

export interface ArrRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  age: number;
  rejected: boolean;
  rejections?: string[];
  customFormatScore?: number;
  quality?: ArrQuality;
  protocol: string;
  publishDate?: string;
}

export interface ArrParse {
  movie?: { id: number; title: string; year: number; hasFile: boolean; tmdbId: number };
  series?: { id: number; title: string; tmdbId?: number };
  episodes?: { id: number; seasonNumber: number; episodeNumber: number; hasFile: boolean }[];
}

export interface RadarrMovie {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  imdbId?: string;
  hasFile: boolean;
  monitored: boolean;
  isAvailable?: boolean;
  status: string;
  qualityProfileId: number;
  rootFolderPath?: string;
  sizeOnDisk?: number;
  added?: string;
  certification?: string;
  genres?: string[];
  movieFile?: { quality: ArrQuality; size: number; mediaInfo?: { resolution?: string } };
  images?: { coverType: string; remoteUrl?: string }[];
  path?: string;
  collection?: { tmdbId?: number; title?: string };
}

export class RadarrClient extends ArrClient {
  constructor(baseUrl: string, apiKey: string) {
    super('Radarr', baseUrl, apiKey, 'v3');
  }

  movies() {
    return this.request<RadarrMovie[]>('/movie', { timeoutMs: 90_000 });
  }

  lookupTmdb(tmdbId: number) {
    return this.request<RadarrMovie & Record<string, unknown>>('/movie/lookup/tmdb', { query: { tmdbId } });
  }

  addMovie(movie: Record<string, unknown>) {
    return this.request<RadarrMovie>('/movie', { method: 'POST', body: movie });
  }

  searchMovies(movieIds: number[]) {
    return this.command('MoviesSearch', { movieIds });
  }
}

export interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  tmdbId?: number;
  imdbId?: string;
  monitored: boolean;
  status: string;
  qualityProfileId: number;
  rootFolderPath?: string;
  seriesType?: string;
  network?: string;
  genres?: string[];
  certification?: string;
  seasons: { seasonNumber: number; monitored: boolean; statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount: number; sizeOnDisk: number } }[];
  statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount: number; sizeOnDisk: number; percentOfEpisodes: number; seasonCount: number };
  added?: string;
}

export class SonarrClient extends ArrClient {
  constructor(baseUrl: string, apiKey: string) {
    super('Sonarr', baseUrl, apiKey, 'v3');
  }

  series() {
    return this.request<SonarrSeries[]>('/series', { timeoutMs: 60_000 });
  }

  lookup(term: string) {
    return this.request<(SonarrSeries & Record<string, unknown>)[]>('/series/lookup', { query: { term } });
  }

  addSeries(series: Record<string, unknown>) {
    return this.request<SonarrSeries>('/series', { method: 'POST', body: series });
  }

  updateSeries(series: SonarrSeries) {
    return this.request<SonarrSeries>(`/series/${series.id}`, { method: 'PUT', body: series });
  }

  getSeries(id: number) {
    return this.request<SonarrSeries>(`/series/${id}`);
  }

  episodes(seriesId: number) {
    return this.request<{ id: number; seasonNumber: number; episodeNumber: number; title: string; airDateUtc?: string; hasFile: boolean; monitored: boolean }[]>(
      '/episode',
      { query: { seriesId } },
    );
  }

  searchSeason(seriesId: number, seasonNumber: number) {
    return this.command('SeasonSearch', { seriesId, seasonNumber });
  }

  searchEpisodes(episodeIds: number[]) {
    return this.command('EpisodeSearch', { episodeIds });
  }
}

export class LidarrClient extends ArrClient {
  constructor(baseUrl: string, apiKey: string) {
    super('Lidarr', baseUrl, apiKey, 'v1');
  }
}

export class ProwlarrClient extends ArrClient {
  constructor(baseUrl: string, apiKey: string) {
    super('Prowlarr', baseUrl, apiKey, 'v1');
  }

  indexers() {
    return this.request<{ id: number; name: string; enable: boolean; protocol: string; priority: number; fields: { name: string; value?: unknown }[] }[]>(
      '/indexer',
    );
  }

  indexerStatus() {
    return this.request<{ indexerId: number; disabledTill?: string; mostRecentFailure?: string; initialFailure?: string }[]>('/indexerstatus');
  }

  indexerStats() {
    return this.request<{ indexers: { indexerId: number; indexerName: string; numberOfQueries: number; numberOfGrabs: number; numberOfFailedQueries: number; numberOfFailedGrabs: number; averageResponseTime: number }[] }>(
      '/indexerstats',
    );
  }
}
