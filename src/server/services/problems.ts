import type { Stack } from '../stack.ts';
import type { ArrRelease, ArrClient } from '../connectors/arr.ts';
import type { SabHistorySlot } from '../connectors/sab.ts';
import type { DownloadsService } from './downloads.ts';
import type { Problem, ReleaseOption } from '../../shared/types.ts';
import { getSetting, setSetting } from '../db.ts';
import { audit } from './audit.ts';
import { log } from '../log.ts';

const DISMISSED = 'problems.dismissed';
/** problem id (or "run:<id>") -> maintenance-agent task id, written by AgentTasks. */
export const AGENT_TASKS = 'agent.tasks';
const LOOKBACK_MS = 14 * 86400_000;
const CACHE_MS = 5 * 60_000;

export class ProblemError extends Error {}

/** What a failed SAB job was for, resolved once per nzo_id. */
interface Target {
  app: 'radarr' | 'sonarr';
  title: string;
  tmdbId?: number;
  movieId?: number;
  seriesId?: number;
  episodeIds?: number[];
  seasonNumber?: number;
  missing: boolean;
}

/**
 * Download problems the admin can act on, beyond the *arr's own queue warnings:
 *   arr-stuck   a Radarr/Sonarr queue item in a warning/error state (DownloadsService.attention)
 *   sab-failed  a job SABnzbd failed that no *arr is tracking any more, for a title that still has no file.
 *               Nothing re-searches these by itself (e.g. a job that failed verification and was
 *               deleted in SAB).
 */
export class ProblemsService {
  private cache: { at: number; list: Problem[] } | null = null;
  private targets = new Map<string, Target | null>();

  constructor(
    private readonly stack: Stack,
    private readonly downloads: DownloadsService,
  ) {}

  async list(force = false): Promise<Problem[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.filterDismissed(this.cache.list);
    const list = [...this.arrStuck(), ...(await this.sabFailed())];
    this.cache = { at: Date.now(), list };
    return this.filterDismissed(list);
  }

  private filterDismissed(list: Problem[]) {
    const dismissed = getSetting<Record<string, number>>(this.stack.db, DISMISSED, {});
    const tasks = getSetting<Record<string, string>>(this.stack.db, AGENT_TASKS, {});
    return list.filter((p) => !dismissed[p.id]).map((p) => (tasks[p.id] ? { ...p, agentTaskId: tasks[p.id] } : p));
  }

  private arrStuck(): Problem[] {
    return this.downloads.attention().map((a) => {
      const link = [...this.downloads.arrByDownloadId.values()].find((l) => l.app === a.app && l.record.id === a.queueId);
      const r = link?.record;
      return {
        id: `arr:${a.app}:${a.queueId}`,
        kind: 'arr-stuck',
        app: a.app,
        title: a.title,
        mediaType: a.mediaType,
        tmdbId: a.tmdbId,
        release: a.release,
        messages: a.messages,
        state: a.state ?? a.status ?? null,
        at: a.added ? Date.parse(a.added) : null,
        tracked: true,
        queueId: a.queueId,
        nzoId: r?.downloadId,
        movieId: r?.movieId,
        seriesId: r?.seriesId,
        episodeIds: r?.episodeId ? [r.episodeId] : undefined,
        seasonNumber: r?.seasonNumber,
        actions: ['search', 'releases', 'dismiss'],
      } satisfies Problem;
    });
  }

  private async sabFailed(): Promise<Problem[]> {
    const { sab } = this.stack;
    if (!sab) return [];
    let failed: SabHistorySlot[];
    try {
      failed = await sab.failedHistory(200);
    } catch (err) {
      log.error('problems: SAB failed history', err);
      return [];
    }
    const cutoff = Date.now() - LOOKBACK_MS;
    const out: Problem[] = [];
    for (const f of failed) {
      if (f.completed * 1000 < cutoff || !['movies', 'tv'].includes(f.category)) continue;
      if (this.downloads.arrByDownloadId.has(f.nzo_id.toLowerCase())) continue; // tracked: the *arr handles it (arr-stuck)
      const t = await this.resolve(f);
      if (!t || !t.missing || this.redownloading(t)) continue;
      out.push({
        id: `sab:${f.nzo_id}`,
        kind: 'sab-failed',
        app: t.app,
        title: t.title,
        mediaType: t.app === 'radarr' ? 'movie' : 'tv',
        tmdbId: t.tmdbId,
        release: f.name,
        messages: [f.fail_message || 'Failed in SABnzbd'],
        state: 'failed in SAB, not tracked',
        at: f.completed * 1000,
        tracked: false,
        nzoId: f.nzo_id,
        movieId: t.movieId,
        seriesId: t.seriesId,
        episodeIds: t.episodeIds,
        seasonNumber: t.seasonNumber,
        actions: ['search', 'releases', 'retry', 'dismiss'],
      });
    }
    return out;
  }

  /** Something for this title is already in an *arr queue, so a re-download is under way. */
  private redownloading(t: Target): boolean {
    if (t.app === 'radarr') return !!(t.movieId && this.downloads.arrByMovie.get(t.movieId)?.length);
    const recs = t.seriesId ? this.downloads.arrBySeries.get(t.seriesId) ?? [] : [];
    return !!t.episodeIds?.length && t.episodeIds.every((id) => recs.some((r) => r.episodeId === id));
  }

  private async resolve(f: SabHistorySlot): Promise<Target | null> {
    if (this.targets.has(f.nzo_id)) {
      const t = this.targets.get(f.nzo_id)!;
      if (t) t.missing = await this.stillMissing(t).catch(() => t.missing);
      return t;
    }
    const { radarr, sonarr } = this.stack;
    let t: Target | null = null;
    try {
      if (f.category === 'movies' && radarr) {
        const p = await radarr.parse(f.name);
        if (p.movie) t = { app: 'radarr', title: `${p.movie.title} (${p.movie.year})`, tmdbId: p.movie.tmdbId, movieId: p.movie.id, missing: !p.movie.hasFile };
      } else if (f.category === 'tv' && sonarr) {
        const p = await sonarr.parse(f.name);
        if (p.series && p.episodes?.length) {
          const eps = p.episodes;
          t = {
            app: 'sonarr',
            title: `${p.series.title} ${eps.map((e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`).join(' ')}`,
            tmdbId: p.series.tmdbId,
            seriesId: p.series.id,
            episodeIds: eps.map((e) => e.id),
            seasonNumber: eps[0]!.seasonNumber,
            missing: eps.some((e) => !e.hasFile),
          };
        }
      }
    } catch (err) {
      log.error(`problems: resolve ${f.name}`, err);
      return null; // don't cache: try again next time
    }
    this.targets.set(f.nzo_id, t);
    return t;
  }

  private async stillMissing(t: Target): Promise<boolean> {
    if (t.app === 'radarr') return !this.stack.radarr || !(await this.stack.radarr.request<{ hasFile: boolean }>(`/movie/${t.movieId}`)).hasFile;
    if (!this.stack.sonarr || !t.seriesId) return t.missing;
    const eps = await this.stack.sonarr.episodes(t.seriesId);
    return eps.some((e) => t.episodeIds?.includes(e.id) && !e.hasFile);
  }

  async get(id: string): Promise<Problem> {
    const p = (await this.list()).find((x) => x.id === id) ?? (await this.list(true)).find((x) => x.id === id);
    if (!p) throw new ProblemError('That problem is gone (fixed, dismissed, or no longer failing).');
    return p;
  }

  private arr(p: Problem): ArrClient {
    const c = p.app === 'radarr' ? this.stack.radarr : this.stack.sonarr;
    if (!c) throw new ProblemError(`${p.app} isn't configured`);
    return c;
  }

  /** Blocklist the failed release (when tracked) and search for another. */
  async search(id: string, actor: string): Promise<string> {
    const p = await this.get(id);
    const arr = this.arr(p);
    let detail: string;
    if (p.tracked && p.queueId) {
      // skipRedownload=false: the *arr blocklists this release and searches for the next best one itself.
      await arr.removeQueueItem(p.queueId, { removeFromClient: true, blocklist: true, skipRedownload: false });
      detail = 'blocklisted the release and started a search';
    } else if (p.app === 'radarr' && p.movieId) {
      await this.stack.radarr!.searchMovies([p.movieId]);
      detail = 'started a movie search';
    } else if (p.app === 'sonarr' && p.episodeIds?.length) {
      await this.stack.sonarr!.searchEpisodes(p.episodeIds);
      detail = `started a search for ${p.episodeIds.length} episode(s)`;
    } else throw new ProblemError('Nothing to search for');
    this.handled(p);
    audit(this.stack.db, actor, 'problem.search', p.title, `${p.release}: ${detail}`);
    return detail;
  }

  /** Interactive search for the problem's title: accepted releases first, best score first. */
  async releases(id: string): Promise<ReleaseOption[]> {
    const p = await this.get(id);
    const arr = this.arr(p);
    const q =
      p.app === 'radarr'
        ? { movieId: p.movieId }
        : p.episodeIds?.length === 1
          ? { episodeId: p.episodeIds[0] }
          : { seriesId: p.seriesId, seasonNumber: p.seasonNumber };
    const rels: ArrRelease[] = await arr.releases(q);
    return rels
      .filter((r) => r.protocol === 'usenet')
      .sort((a, b) => Number(a.rejected) - Number(b.rejected) || (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) || b.size - a.size)
      .slice(0, 50)
      .map((r) => ({
        guid: r.guid,
        indexerId: r.indexerId,
        indexer: r.indexer,
        title: r.title,
        size: r.size,
        ageDays: r.age,
        score: r.customFormatScore ?? 0,
        quality: r.quality?.quality?.name ?? null,
        rejected: r.rejected,
        rejections: (r.rejections ?? []).slice(0, 4),
        sameAsFailed: r.title.replace(/\.nzb$/i, '') === p.release,
      }));
  }

  /** Grab a chosen release through the *arr (so it's tracked), optionally bumping it to the top when it reaches SAB. */
  async grab(id: string, guid: string, indexerId: number, bump: boolean, actor: string): Promise<string> {
    const p = await this.get(id);
    const arr = this.arr(p);
    if (p.tracked && p.queueId) await arr.removeQueueItem(p.queueId, { removeFromClient: true, blocklist: true, skipRedownload: true });
    await arr.grabRelease(guid, indexerId);
    const itemId = p.app === 'radarr' ? p.movieId : p.seriesId;
    if (bump && itemId) {
      const now = Date.now();
      this.stack.db
        .prepare('INSERT INTO pending_bumps (app, item_id, created_at, expires_at, actor) VALUES (?, ?, ?, ?, ?)')
        .run(p.app, itemId, now, now + 6 * 3600_000, actor);
    }
    this.handled(p);
    audit(this.stack.db, actor, 'problem.grab', p.title, `grabbed a release from indexer ${indexerId}${bump ? ', bump on arrival' : ''}`);
    return bump ? 'Grabbed; it will jump to the top of the queue when it reaches SABnzbd' : 'Grabbed';
  }

  /** Ask SAB to try the failed job again (5.1+ re-fetches only missing articles). Untracked jobs only. */
  async retry(id: string, actor: string): Promise<string> {
    const p = await this.get(id);
    if (p.kind !== 'sab-failed' || !p.nzoId || !this.stack.sab) throw new ProblemError('Only a failed SABnzbd job can be retried');
    await this.stack.sab.retry(p.nzoId);
    this.handled(p);
    audit(this.stack.db, actor, 'problem.retry', p.title, p.release);
    return 'Retrying in SABnzbd. If it fails the same way, use Search again or pick a different release.';
  }

  dismiss(id: string, actor: string): void {
    this.hide(id);
    audit(this.stack.db, actor, 'problem.dismiss', id);
  }

  private hide(id: string) {
    const d = getSetting<Record<string, number>>(this.stack.db, DISMISSED, {});
    const cutoff = Date.now() - 30 * 86400_000;
    for (const [k, v] of Object.entries(d)) if (v < cutoff) delete d[k];
    d[id] = Date.now();
    setSetting(this.stack.db, DISMISSED, d);
  }

  /** Acted on: hide it now. A fresh failure of the new download shows up under its own id. */
  private handled(p: Problem) {
    if (this.cache) this.cache.list = this.cache.list.filter((x) => x.id !== p.id);
    if (p.kind === 'sab-failed') this.hide(p.id);
  }
}

export type { Problem };
