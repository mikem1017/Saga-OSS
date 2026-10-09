import type { Stack } from '../stack.ts';
import type { AddDecision, AddPreview, AddPreviewItem, AddResult, MediaType } from '../../shared/types.ts';
import type { LibraryService } from './library.ts';
import type { DownloadsService } from './downloads.ts';
import type { DiscoverService } from './discover.ts';
import { decide, loadRules, type TitleFacts } from './rules.ts';
import { bytesAheadOfNewJob } from './eta.ts';
import { mbToBytes } from '../connectors/sab.ts';
import { audit } from './audit.ts';
import { UpstreamError } from '../http.ts';

export interface AddRequestItem {
  mediaType: MediaType;
  tmdbId: number;
  /** Fields the admin changed in the confirm dialog. */
  overrides?: Partial<Pick<AddDecision, 'qualityProfileId' | 'rootFolderPath' | 'monitor' | 'minimumAvailability' | 'seriesType' | 'searchNow' | 'bumpOnGrab' | 'seasons'>>;
}

const MAX_BULK = 250;

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export interface AddJob {
  id: string;
  actor: string;
  total: number;
  results: AddResult[];
  done: boolean;
  startedAt: number;
  finishedAt?: number;
}

export class AddService {
  constructor(
    private readonly stack: Stack,
    private readonly library: LibraryService,
    private readonly downloads: DownloadsService,
    private readonly discover: DiscoverService,
  ) {}

  private async facts(type: MediaType, tmdbId: number): Promise<{ facts: TitleFacts; title: string; year?: number; posterPath?: string | null; raw: any }> {
    const raw = type === 'movie' ? await this.discover.rawMovie(tmdbId) : await this.discover.rawTv(tmdbId);
    const cert =
      type === 'movie'
        ? (raw.release_dates?.results ?? []).find((r: any) => r.iso_3166_1 === 'US')?.release_dates?.find((d: any) => d.certification)?.certification
        : (raw.content_ratings?.results ?? []).find((r: any) => r.iso_3166_1 === 'US')?.rating;
    const date: string | undefined = type === 'movie' ? raw.release_date : raw.first_air_date;
    return {
      facts: {
        mediaType: type,
        genres: (raw.genres ?? []).map((g: any) => g.name),
        certification: cert || undefined,
        language: raw.original_language,
        year: date ? Number(date.slice(0, 4)) : undefined,
      },
      title: type === 'movie' ? raw.title : raw.name,
      year: date ? Number(date.slice(0, 4)) : undefined,
      posterPath: raw.poster_path,
      raw,
    };
  }

  async decision(type: MediaType, tmdbId: number, overrides?: AddRequestItem['overrides']): Promise<AddDecision> {
    await this.library.ensureLoaded();
    const { facts } = await this.facts(type, tmdbId);
    return this.applyOverrides(type, decide(loadRules(this.stack.db), facts, this.ctx(type)), overrides);
  }

  private ctx(type: MediaType) {
    return type === 'movie'
      ? { profiles: this.library.radarrProfiles, roots: this.library.radarrRoots, preferredProfile: this.stack.config.DEFAULT_MOVIE_PROFILE }
      : { profiles: this.library.sonarrProfiles, roots: this.library.sonarrRoots, preferredProfile: this.stack.config.DEFAULT_TV_PROFILE };
  }

  private applyOverrides(type: MediaType, d: AddDecision, o?: AddRequestItem['overrides']): AddDecision {
    if (!o) return d;
    const out = { ...d };
    const ctx = this.ctx(type);
    if (o.qualityProfileId !== undefined) {
      const p = ctx.profiles.find((p) => p.id === o.qualityProfileId);
      if (!p) throw new Error(`Unknown quality profile ${o.qualityProfileId}`);
      out.qualityProfileId = p.id;
      out.qualityProfileName = p.name;
    }
    if (o.rootFolderPath !== undefined) {
      if (!ctx.roots.some((r) => r.path === o.rootFolderPath)) throw new Error(`Unknown root folder ${o.rootFolderPath}`);
      out.rootFolderPath = o.rootFolderPath;
    }
    for (const k of ['monitor', 'minimumAvailability', 'seriesType', 'searchNow', 'bumpOnGrab', 'seasons'] as const) if (o[k] !== undefined) (out as any)[k] = o[k];
    if (out.ruleName && Object.keys(o).length) out.ruleName = `${out.ruleName} (edited)`;
    return out;
  }

  async preview(items: AddRequestItem[]): Promise<AddPreview> {
    if (items.length > MAX_BULK) throw new Error(`At most ${MAX_BULK} titles per bulk add`);
    await this.library.ensureLoaded();
    const rules = loadRules(this.stack.db);
    // TMDB lookups in parallel (6 at a time); results keep the request order.
    const facts = await pool(items, 6, (i) => this.facts(i.mediaType, i.tmdbId));
    const out: AddPreviewItem[] = [];
    for (const [idx, item] of items.entries()) {
      const f = facts[idx]!;
      const decision = this.applyOverrides(item.mediaType, decide(rules, f.facts, this.ctx(item.mediaType)), item.overrides);
      const already =
        item.mediaType === 'movie' ? this.library.movies.has(item.tmdbId) : this.library.series.has(item.tmdbId) && !decision.seasons;
      let est: { bytes: number; basis: string };
      if (item.mediaType === 'movie') {
        est = this.library.movieSizeEstimate(decision.qualityProfileId);
      } else {
        const per = this.library.episodeSizeEstimate(decision.qualityProfileId);
        const seasons: { season_number: number; episode_count: number; air_date?: string }[] = f.raw.seasons ?? [];
        const regular = seasons.filter((s) => s.season_number > 0);
        let eps: number;
        if (decision.seasons) eps = regular.filter((s) => decision.seasons!.includes(s.season_number)).reduce((a, s) => a + s.episode_count, 0);
        else if (decision.monitor === 'future' || decision.monitor === 'none') eps = 0;
        else if (decision.monitor === 'firstSeason') eps = regular[0]?.episode_count ?? 0;
        else if (decision.monitor === 'lastSeason') eps = regular[regular.length - 1]?.episode_count ?? 0;
        else if (decision.monitor === 'pilot') eps = 1;
        else eps = regular.reduce((a, s) => a + s.episode_count, 0);
        est = { bytes: per.bytes * eps, basis: `${eps} episodes × ${(per.bytes / 1024 ** 3).toFixed(1)} GB (${per.basis})` };
      }
      out.push({
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        title: f.title,
        year: f.year,
        posterPath: f.posterPath,
        decision,
        alreadyInLibrary: already,
        estBytes: already ? 0 : est.bytes,
        estBasis: already ? 'already in library' : est.basis,
      });
    }
    const toAdd = out.filter((i) => !i.alreadyInLibrary);
    const totalBytes = toAdd.reduce((a, i) => a + i.estBytes, 0);
    const rate = this.downloads.rate().bps;
    const slots = (this.downloads.queue?.slots ?? []).map((s) => ({ leftBytes: mbToBytes(s.mbleft), priority: s.priority, status: s.status }));
    // Movies arrive at Radarr's category default (Normal); TV is assumed to be sent at High.
    const allTv = toAdd.length > 0 && toAdd.every((i) => i.mediaType === 'tv');
    const backAhead = bytesAheadOfNewJob(slots, allTv ? 'High' : 'Normal', false);
    const bumpAhead = bytesAheadOfNewJob(slots, 'High', true);
    return {
      items: out,
      toAdd: toAdd.length,
      totalBytes,
      etaBackSec: rate ? Math.round((backAhead + totalBytes) / rate) : null,
      etaBumpedSec: rate ? Math.round((bumpAhead + totalBytes) / rate) : null,
      rateBps: rate,
      queueBytesAhead: backAhead,
    };
  }

  private jobs = new Map<string, AddJob>();

  /**
   * Big adds run in the background so the browser (and the reverse proxy's timeout) isn't held for minutes:
   * each title is a TMDB lookup, an *arr lookup and a POST, done one at a time to be gentle with Radarr.
   */
  startJob(items: AddRequestItem[], actor: string): AddJob {
    if (items.length > MAX_BULK) throw new Error(`At most ${MAX_BULK} titles per bulk add`);
    const job: AddJob = { id: crypto.randomUUID(), actor, total: items.length, results: [], done: false, startedAt: Date.now() };
    this.jobs.set(job.id, job);
    for (const [id, j] of this.jobs) if (j.done && Date.now() - (j.finishedAt ?? 0) > 3600_000) this.jobs.delete(id);
    void this.add(items, actor, (r) => job.results.push(r)).finally(() => {
      job.done = true;
      job.finishedAt = Date.now();
    });
    return job;
  }

  job(id: string): AddJob | undefined {
    return this.jobs.get(id);
  }

  async add(items: AddRequestItem[], actor: string, onResult?: (r: AddResult) => void): Promise<AddResult[]> {
    if (items.length > MAX_BULK) throw new Error(`At most ${MAX_BULK} titles per bulk add`);
    await this.library.ensureLoaded();
    const rules = loadRules(this.stack.db);
    const results: AddResult[] = [];
    for (const item of items) {
      let title = `${item.mediaType}:${item.tmdbId}`;
      try {
        const f = await this.facts(item.mediaType, item.tmdbId);
        title = f.year ? `${f.title} (${f.year})` : f.title;
        const d = this.applyOverrides(item.mediaType, decide(rules, f.facts, this.ctx(item.mediaType)), item.overrides);
        const res = item.mediaType === 'movie' ? await this.addMovie(item.tmdbId, d) : await this.addSeries(item.tmdbId, d);
        if (d.bumpOnGrab && res.arrId)
          this.stack.db
            .prepare('INSERT INTO pending_bumps (app, item_id, created_at, expires_at, actor) VALUES (?, ?, ?, ?, ?)')
            .run(item.mediaType === 'movie' ? 'radarr' : 'sonarr', res.arrId, Date.now(), Date.now() + 6 * 3600_000, actor);
        audit(this.stack.db, actor, item.mediaType === 'movie' ? 'radarr.add' : 'sonarr.add', title, `${res.message}; rule: ${d.ruleName}; profile ${d.qualityProfileName}; ${d.rootFolderPath}${d.bumpOnGrab ? '; bump on grab' : ''}`);
        results.push({ tmdbId: item.tmdbId, mediaType: item.mediaType, title, ok: true, message: res.message, arrId: res.arrId });
        onResult?.(results[results.length - 1]!);
      } catch (err) {
        const msg = err instanceof UpstreamError ? err.message : err instanceof Error ? err.message : String(err);
        audit(this.stack.db, actor, item.mediaType === 'movie' ? 'radarr.add' : 'sonarr.add', title, msg, false);
        results.push({ tmdbId: item.tmdbId, mediaType: item.mediaType, title, ok: false, message: msg });
        onResult?.(results[results.length - 1]!);
      }
    }
    // Pick the new titles up quickly so their badges flip to "monitored/queued".
    void this.library.refresh().then(() => this.downloads.pollArr());
    return results;
  }

  private async addMovie(tmdbId: number, d: AddDecision): Promise<{ arrId?: number; message: string }> {
    const radarr = this.stack.radarr;
    if (!radarr) throw new Error('Radarr is not configured');
    const existing = this.library.movies.get(tmdbId);
    if (existing) {
      if (d.searchNow && !existing.hasFile) await radarr.searchMovies([existing.id]);
      return { arrId: existing.id, message: existing.hasFile ? 'Already in library' : 'Already monitored; search started' };
    }
    const lookup = await radarr.lookupTmdb(tmdbId);
    const added = await radarr.addMovie({
      ...lookup,
      id: undefined,
      qualityProfileId: d.qualityProfileId,
      rootFolderPath: d.rootFolderPath,
      monitored: true,
      minimumAvailability: d.minimumAvailability,
      tags: [],
      addOptions: { searchForMovie: d.searchNow, monitor: 'movieOnly' },
    });
    return { arrId: added.id, message: d.searchNow ? 'Added; searching' : 'Added (no search)' };
  }

  private async addSeries(tmdbId: number, d: AddDecision): Promise<{ arrId?: number; message: string }> {
    const sonarr = this.stack.sonarr;
    if (!sonarr) throw new Error('Sonarr is not configured');
    const existing = this.library.series.get(tmdbId);
    if (existing) {
      // Adding seasons to a series we already have.
      if (!d.seasons?.length) return { arrId: existing.id, message: 'Already in library (pick seasons to add more)' };
      const full = await sonarr.getSeries(existing.id);
      const newly: number[] = [];
      full.seasons = full.seasons.map((s) => {
        if (d.seasons!.includes(s.seasonNumber) && !s.monitored) newly.push(s.seasonNumber);
        return d.seasons!.includes(s.seasonNumber) ? { ...s, monitored: true } : s;
      });
      full.monitored = true;
      await sonarr.updateSeries(full);
      if (d.searchNow) for (const n of newly) await sonarr.searchSeason(existing.id, n);
      return { arrId: existing.id, message: newly.length ? `Monitoring season(s) ${newly.join(', ')}${d.searchNow ? '; searching' : ''}` : 'Those seasons were already monitored' };
    }
    const ext = await this.discover.externalIds('tv', tmdbId);
    if (!ext.tvdb_id) throw new Error('TMDB has no TVDB id for this show, so Sonarr cannot add it');
    const [lookup] = await sonarr.lookup(`tvdb:${ext.tvdb_id}`);
    if (!lookup) throw new Error(`Sonarr found nothing for tvdb:${ext.tvdb_id}`);
    const body: Record<string, unknown> = {
      ...lookup,
      qualityProfileId: d.qualityProfileId,
      rootFolderPath: d.rootFolderPath,
      seriesType: d.seriesType,
      seasonFolder: true,
      monitored: true,
      tags: [],
    };
    if (d.seasons) {
      body.seasons = (lookup.seasons ?? []).map((s) => ({ ...s, monitored: d.seasons!.includes(s.seasonNumber) }));
      body.addOptions = { searchForMissingEpisodes: d.searchNow, searchForCutoffUnmetEpisodes: false, ignoreEpisodesWithFiles: true };
    } else {
      body.addOptions = { monitor: d.monitor === 'movieOnly' ? 'all' : d.monitor, searchForMissingEpisodes: d.searchNow, searchForCutoffUnmetEpisodes: false };
    }
    const added = await sonarr.addSeries(body);
    return { arrId: added.id, message: d.searchNow ? 'Added; searching' : 'Added (no search)' };
  }
}
