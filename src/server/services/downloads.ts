import type { Stack } from '../stack.ts';
import type { SabQueue, SabHistorySlot, SabQueueSlot } from '../connectors/sab.ts';
import { mbToBytes, PP_STATES } from '../connectors/sab.ts';
import type { ArrQueueRecord } from '../connectors/arr.ts';
import type { HostFeed } from '../connectors/feeds.ts';
import type { DownloadsSnapshot, GuardState, LibraryState, QueueJob } from '../../shared/types.ts';
import { effectiveRate, queueEtas, type RateSample } from './eta.ts';
import type { LibraryService } from './library.ts';
import { audit } from './audit.ts';
import { log } from '../log.ts';

interface ArrLink {
  app: 'radarr' | 'sonarr';
  record: ArrQueueRecord;
}

const GUARD_STALE_SEC = 10 * 60; // a guard heartbeat older than this counts as dead

/**
 * The feed reports df for each NFS mount. On ZFS each dataset reports its own "used" but the pool's shared
 * "avail", so /mnt/media alone looks empty while /mnt/media/movies holds most of the data. Mounts that share an avail
 * figure are one pool: report them once under the shortest path, with used summed.
 */
export function mergePoolDisks(disks: HostFeed['disks']): HostFeed['disks'] {
  const groups = new Map<number, HostFeed['disks']>();
  for (const d of disks) groups.set(d.avail, [...(groups.get(d.avail) ?? []), d]);
  return [...groups.values()].map((g) => {
    const mount = g.map((d) => d.mount).sort((a, b) => a.length - b.length)[0]!;
    const used = g.reduce((a, d) => a + d.used, 0);
    return { mount, used, avail: g[0]!.avail, size: used + g[0]!.avail };
  });
}

/**
 * Polls SAB and the *arr queues, joins them on downloadId (= SAB nzo_id), and records throughput samples.
 * Polling is deliberately gentle: a SAB queue can hold thousands of jobs, and SAB's memory may be tight.
 */
export class DownloadsService {
  queue: SabQueue | null = null;
  queueAt = 0;
  queueError: string | null = null;
  history: SabHistorySlot[] = [];
  ppslots = 0;
  arrByDownloadId = new Map<string, ArrLink>();
  arrByMovie = new Map<number, ArrQueueRecord[]>();
  arrBySeries = new Map<number, ArrQueueRecord[]>();
  arrAt = 0;
  feed: HostFeed | null = null;
  feedAt = 0;
  feedError: string | null = null;
  private etaCache: { at: number; rate: number | null; byNzo: Map<string, { etaSec: number | null; startsInSec: number | null }> } | null = null;

  constructor(
    private readonly stack: Stack,
    private readonly library: LibraryService,
  ) {}

  async pollQueue(): Promise<void> {
    const { sab } = this.stack;
    if (!sab) return;
    try {
      const [queue, hist] = await Promise.all([sab.queue(0, 0), sab.history(60)]);
      this.queue = queue;
      this.history = hist.slots;
      this.ppslots = hist.ppslots ?? hist.slots.filter((h) => PP_STATES.has(h.status)).length;
      this.queueAt = Date.now();
      this.queueError = null;
      this.etaCache = null;
    } catch (err) {
      this.queueError = err instanceof Error ? err.message : String(err);
    }
  }

  async pollArr(): Promise<void> {
    const { radarr, sonarr } = this.stack;
    const byDl = new Map<string, ArrLink>();
    const byMovie = new Map<number, ArrQueueRecord[]>();
    const bySeries = new Map<number, ArrQueueRecord[]>();
    const tasks: Promise<void>[] = [];
    if (radarr)
      tasks.push(
        radarr.queueAll({ includeMovie: false }).then((recs) => {
          for (const r of recs) {
            if (r.downloadId) byDl.set(r.downloadId.toLowerCase(), { app: 'radarr', record: r });
            if (r.movieId) byMovie.set(r.movieId, [...(byMovie.get(r.movieId) ?? []), r]);
          }
        }),
      );
    if (sonarr)
      tasks.push(
        sonarr.queueAll({ includeSeries: false, includeEpisode: true }).then((recs) => {
          for (const r of recs) {
            if (r.downloadId) {
              // A season pack is one download shared by many episode records; keep the first.
              const k = r.downloadId.toLowerCase();
              if (!byDl.has(k)) byDl.set(k, { app: 'sonarr', record: r });
            }
            if (r.seriesId) bySeries.set(r.seriesId, [...(bySeries.get(r.seriesId) ?? []), r]);
          }
        }),
      );
    const results = await Promise.allSettled(tasks);
    if (results.every((r) => r.status === 'rejected')) return; // keep the previous view
    this.arrByDownloadId = byDl;
    this.arrByMovie = byMovie;
    this.arrBySeries = bySeries;
    this.arrAt = Date.now();
    await this.processPendingBumps().catch((e) => log.error('pending bumps', e));
  }

  async pollFeed(): Promise<void> {
    const feed = this.stack.feedHost;
    if (!feed) return;
    try {
      const f = await feed.fetch<HostFeed>();
      f.disks = mergePoolDisks(f.disks);
      this.feed = f;
      this.feedAt = Date.now();
      this.feedError = null;
    } catch (err) {
      this.feedError = err instanceof Error ? err.message : String(err);
    }
  }

  /** One throughput sample a minute: SAB's monotonic byte counter plus queue shape. */
  async sample(): Promise<void> {
    const { sab, db } = this.stack;
    if (!sab) return;
    try {
      const stats = await sab.serverStats();
      const q = this.queue;
      db.prepare(
        'INSERT OR REPLACE INTO samples (ts, sab_total_bytes, queue_bytes_left, queue_count, speed_bps, sab_paused, guard_paused, pp_waiting) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        Math.floor(Date.now() / 1000),
        stats.total,
        q ? mbToBytes(q.mbleft) : null,
        q ? q.noofslots_total : null,
        q ? Math.round(Number(q.kbpersec) * 1024) : null,
        q ? (q.paused ? 1 : 0) : null,
        this.feed?.guard.paused ? 1 : 0,
        this.ppslots,
      );
    } catch (err) {
      log.warn(`sample failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  rateSamples(windowSec: number): RateSample[] {
    const since = Math.floor(Date.now() / 1000) - windowSec;
    return (this.stack.db.prepare('SELECT ts, sab_total_bytes AS totalBytes FROM samples WHERE ts >= ? ORDER BY ts').all(since) as unknown as RateSample[]);
  }

  /** Effective rate for ETAs: 1 h window, falling back to 6 h, then to the live speed. */
  rate(): { bps: number | null; windowMin: number } {
    const now = Math.floor(Date.now() / 1000);
    const samples = this.rateSamples(6 * 3600);
    const r1 = effectiveRate(samples, 3600, now);
    if (r1 !== null && r1 > 0) return { bps: r1, windowMin: 60 };
    const r6 = effectiveRate(samples, 6 * 3600, now);
    if (r6 !== null && r6 > 0) return { bps: r6, windowMin: 360 };
    const live = this.queue ? Number(this.queue.kbpersec) * 1024 : 0;
    return { bps: live > 0 ? live : null, windowMin: 0 };
  }

  private etas() {
    if (this.etaCache && this.etaCache.at === this.queueAt) return this.etaCache;
    const rate = this.rate().bps;
    const slots = this.queue?.slots ?? [];
    const etas = queueEtas(
      slots.map((s) => ({ leftBytes: mbToBytes(s.mbleft), status: s.status })),
      rate,
    );
    const byNzo = new Map<string, { etaSec: number | null; startsInSec: number | null }>();
    slots.forEach((s, i) => byNzo.set(s.nzo_id, etas[i]!));
    this.etaCache = { at: this.queueAt, rate, byNzo };
    return this.etaCache;
  }

  guardState(): GuardState {
    const f = this.feed;
    if (!f) return { available: false, paused: false, pausedSince: null, heartbeatAgeSec: null, fresh: false, logTail: [] };
    const nowSec = Date.now() / 1000;
    const age = f.guard.heartbeat ? Math.round(nowSec - f.guard.heartbeat) : null;
    return {
      available: true,
      paused: f.guard.paused,
      pausedSince: f.guard.pausedSince,
      heartbeatAgeSec: age,
      fresh: age !== null && age < GUARD_STALE_SEC,
      logTail: f.guard.logTail.slice(-10),
    };
  }

  pauseReason(): string | null {
    const q = this.queue;
    if (!q || !q.paused) return null;
    const g = this.guardState();
    if (g.paused) return `PP guard: ${this.ppslots} job(s) waiting for post-processing. It resumes on its own.`;
    if (q.pause_int && q.pause_int !== '0') return `Timed pause (${q.pause_int} left)`;
    const freeGb = Number(q.diskspace1);
    if (Number.isFinite(freeGb) && freeGb < 520) return `Low disk space (${freeGb.toFixed(0)} GB free; SAB needs 500 GB)`;
    return 'Paused manually';
  }

  linkFor(nzoId: string): QueueJob['arr'] {
    const link = this.arrByDownloadId.get(nzoId.toLowerCase());
    if (!link) return undefined;
    const r = link.record;
    if (link.app === 'radarr') {
      const m = r.movieId ? this.library.moviesById.get(r.movieId) : undefined;
      return { app: 'radarr', itemId: r.movieId!, title: m ? `${m.title} (${m.year})` : r.title, tmdbId: m?.tmdbId, mediaType: 'movie', queueId: r.id };
    }
    const s = r.seriesId ? this.library.seriesById.get(r.seriesId) : undefined;
    const ep = (r as any).episode;
    return {
      app: 'sonarr',
      itemId: r.seriesId!,
      title: s ? s.title : r.title,
      tmdbId: s?.tmdbId,
      mediaType: 'tv',
      queueId: r.id,
      episode: ep ? `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} ${ep.title ?? ''}`.trim() : undefined,
    };
  }

  snapshot(opts: { offset?: number; limit?: number; search?: string; category?: string } = {}): DownloadsSnapshot {
    const q = this.queue;
    const { bps, windowMin } = this.rate();
    const etas = this.etas();
    const slots = q?.slots ?? [];
    const cats = new Map<string, { jobs: number; leftBytes: number }>();
    for (const s of slots) {
      const c = cats.get(s.cat) ?? { jobs: 0, leftBytes: 0 };
      c.jobs++;
      c.leftBytes += mbToBytes(s.mbleft);
      cats.set(s.cat, c);
    }
    const needle = opts.search?.toLowerCase().trim();
    let matched = slots;
    if (opts.category) matched = matched.filter((s) => s.cat === opts.category);
    if (needle) matched = matched.filter((s) => s.filename.toLowerCase().includes(needle) || (this.linkFor(s.nzo_id)?.title.toLowerCase().includes(needle) ?? false));
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 50, 500);
    const totalLeft = q ? mbToBytes(q.mbleft) : 0;
    return {
      updatedAt: this.queueAt,
      sabPaused: q?.paused ?? false,
      pauseReason: this.pauseReason(),
      speedBps: q ? Math.round(Number(q.kbpersec) * 1024) : 0,
      speedLimitBps: q && Number(q.speedlimit_abs) > 0 ? Number(q.speedlimit_abs) : null,
      rateBps: bps,
      rateWindowMin: windowMin,
      totalJobs: q?.noofslots_total ?? 0,
      totalLeftBytes: totalLeft,
      backlogEtaSec: bps ? Math.round(totalLeft / bps) : null,
      categories: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.leftBytes - a.leftBytes),
      guard: this.guardState(),
      postProcessing: this.history
        .filter((h) => PP_STATES.has(h.status))
        .map((h) => ({ nzoId: h.nzo_id, name: h.name, category: h.category, status: h.status, actionLine: h.action_line, completed: h.completed })),
      jobs: matched.slice(offset, offset + limit).map((s) => {
        const size = mbToBytes(s.mb);
        const left = mbToBytes(s.mbleft);
        const e = etas.byNzo.get(s.nzo_id);
        return {
          nzoId: s.nzo_id,
          index: s.index,
          name: s.filename,
          category: s.cat,
          priority: s.priority,
          status: s.status,
          sizeBytes: size,
          leftBytes: left,
          percent: Number(s.percentage),
          etaSec: e?.etaSec ?? null,
          startsInSec: e?.startsInSec ?? null,
          arr: this.linkFor(s.nzo_id),
        };
      }),
      jobsTotalMatched: matched.length,
    };
  }

  /** *arr queue items stuck in warning/error (import blocked, unknown title, missing files) with the app's own reason. */
  attention() {
    const out: { app: 'radarr' | 'sonarr'; queueId: number; title: string; release: string; state?: string; status?: string; messages: string[]; tmdbId?: number; mediaType: 'movie' | 'tv'; added?: string }[] = [];
    const seen = new Set<string>();
    for (const [app, map] of [['radarr', this.arrByMovie], ['sonarr', this.arrBySeries]] as const) {
      for (const recs of map.values())
        for (const r of recs) {
          if (r.trackedDownloadStatus !== 'warning' && r.trackedDownloadStatus !== 'error') continue;
          const key = `${app}:${r.downloadId ?? r.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const m = app === 'radarr' && r.movieId ? this.library.moviesById.get(r.movieId) : undefined;
          const s = app === 'sonarr' && r.seriesId ? this.library.seriesById.get(r.seriesId) : undefined;
          out.push({
            app,
            queueId: r.id,
            title: m ? `${m.title} (${m.year})` : s ? s.title : r.title,
            release: r.title,
            state: r.trackedDownloadState,
            status: r.trackedDownloadStatus,
            messages: [...(r.statusMessages ?? []).flatMap((x) => x.messages), ...(r.errorMessage ? [r.errorMessage] : [])].slice(0, 6),
            tmdbId: m?.tmdbId ?? s?.tmdbId,
            mediaType: app === 'radarr' ? 'movie' : 'tv',
            added: r.added,
          });
        }
    }
    return out.sort((a, b) => (a.added ?? '').localeCompare(b.added ?? ''));
  }

  /** Where a set of *arr queue records sits in SAB, for the library badge. */
  private stateForRecords(records: ArrQueueRecord[] | undefined): LibraryState | null {
    if (!records?.length) return null;
    const etas = this.etas();
    const slotsById = new Map((this.queue?.slots ?? []).map((s) => [s.nzo_id.toLowerCase(), s]));
    let best: { slot: SabQueueSlot } | null = null;
    let importing = 0;
    const jobs = new Set<string>();
    for (const r of records) {
      const id = r.downloadId?.toLowerCase();
      if (!id) continue;
      jobs.add(id);
      const slot = slotsById.get(id);
      if (!slot) {
        if (r.trackedDownloadState === 'importPending' || r.trackedDownloadState === 'importing' || r.status === 'completed') importing++;
        continue;
      }
      if (!best || slot.index < best.slot.index) best = { slot };
    }
    if (best) {
      const s = best.slot;
      const e = etas.byNzo.get(s.nzo_id);
      const pct = Number(s.percentage);
      if (s.status === 'Downloading' && (pct > 0 || s.index === 0))
        return { kind: 'downloading', percent: pct, etaSec: e?.etaSec ?? null, position: s.index + 1, jobs: jobs.size };
      return { kind: 'queued', position: s.index + 1, etaSec: e?.etaSec ?? null, startsInSec: e?.startsInSec ?? null, jobs: jobs.size };
    }
    if (importing) return { kind: 'importing', detail: 'Downloaded, waiting for post-processing or import' };
    // Queue record without a SAB slot: post-processing in SAB history, or a warning state.
    const warn = records.find((r) => r.trackedDownloadStatus === 'warning' || r.trackedDownloadStatus === 'error');
    if (warn) return { kind: 'importing', detail: warn.statusMessages?.[0]?.messages?.[0] ?? warn.errorMessage ?? 'Needs attention in the *arr' };
    return { kind: 'importing' };
  }

  stateForMovie(movieId: number) {
    return this.stateForRecords(this.arrByMovie.get(movieId));
  }

  stateForSeries(seriesId: number) {
    return this.stateForRecords(this.arrBySeries.get(seriesId));
  }

  /** After an add with "bump on grab", move the grabbed job to the top of the High band once it shows up. */
  private async processPendingBumps(): Promise<void> {
    const { db, sab } = this.stack;
    if (!sab) return;
    const now = Date.now();
    const pending = db.prepare('SELECT id, app, item_id, actor FROM pending_bumps WHERE done_at IS NULL AND expires_at > ?').all(now) as {
      id: number;
      app: string;
      item_id: number;
      actor: string;
    }[];
    for (const p of pending) {
      const recs = p.app === 'radarr' ? this.arrByMovie.get(p.item_id) : this.arrBySeries.get(p.item_id);
      const ids = [...new Set((recs ?? []).map((r) => r.downloadId?.toLowerCase()).filter(Boolean))] as string[];
      const inSab = ids.filter((id) => this.queue?.slots.some((s) => s.nzo_id.toLowerCase() === id));
      if (!inSab.length) continue;
      for (const id of inSab) {
        const slot = this.queue!.slots.find((s) => s.nzo_id.toLowerCase() === id)!;
        try {
          await sab.setPriority(slot.nzo_id, 1);
          await sab.switchPosition(slot.nzo_id, 0);
          audit(db, p.actor, 'queue.bump', slot.filename, 'bumped on grab (requested at add time)');
        } catch (err) {
          audit(db, p.actor, 'queue.bump', slot.filename, String(err), false);
        }
      }
      db.prepare('UPDATE pending_bumps SET done_at = ? WHERE id = ?').run(now, p.id);
    }
  }
}
