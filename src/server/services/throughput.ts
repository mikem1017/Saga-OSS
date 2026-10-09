import type { Stack } from '../stack.ts';
import type { ThroughputStats } from '../../shared/types.ts';
import type { DownloadsService } from './downloads.ts';
import { effectiveRate } from './eta.ts';
import { mbToBytes, type SabHistorySlot } from '../connectors/sab.ts';

/**
 * The numbers that used to be worked out by hand: imports per hour (from *arr import history, not SAB,
 * which archives finished jobs), post-processing time per job, failed-NZB rate, per-server bytes and the
 * backlog ETA. Cached for two minutes; history calls are paged and cheap.
 */
export class ThroughputService {
  private cache: { at: number; stats: ThroughputStats } | null = null;
  private inflight: Promise<ThroughputStats> | null = null;

  constructor(
    private readonly stack: Stack,
    private readonly downloads: DownloadsService,
  ) {}

  async get(): Promise<ThroughputStats> {
    if (this.cache && Date.now() - this.cache.at < 120_000) return this.cache.stats;
    if (!this.inflight)
      this.inflight = this.compute()
        .then((stats) => {
          this.cache = { at: Date.now(), stats };
          return stats;
        })
        .finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async compute(): Promise<ThroughputStats> {
    const { radarr, sonarr, sab } = this.stack;
    const now = Date.now();
    const since48 = new Date(now - 48 * 3600_000);
    const since24 = now - 24 * 3600_000;
    const [movieImports, epImports, hist, archive, stats] = await Promise.all([
      radarr ? radarr.importsSince(since48).catch(() => []) : [],
      sonarr ? sonarr.importsSince(since48).catch(() => []) : [],
      sab ? sab.history(300).catch(() => null) : null,
      sab ? sab.history(300, true).catch(() => null) : null,
      sab ? sab.serverStats().catch(() => null) : null,
    ]);

    const hourly = new Map<number, { movies: number; episodes: number }>();
    const bucket = (iso: string) => Math.floor(new Date(iso).getTime() / 3600_000) * 3600;
    for (let h = Math.floor(since48.getTime() / 3600_000) + 1; h <= Math.floor(now / 3600_000); h++) hourly.set(h * 3600, { movies: 0, episodes: 0 });
    let m24 = 0;
    let e24 = 0;
    let bytes24 = 0;
    for (const r of movieImports) {
      const b = hourly.get(bucket(r.date));
      if (b) b.movies++;
      if (new Date(r.date).getTime() >= since24) {
        m24++;
        bytes24 += Number(r.data?.size ?? 0);
      }
    }
    // Sonarr logs one import per episode; a season pack is many.
    for (const r of epImports) {
      const b = hourly.get(bucket(r.date));
      if (b) b.episodes++;
      if (new Date(r.date).getTime() >= since24) {
        e24++;
        bytes24 += Number(r.data?.size ?? 0);
      }
    }

    // Post-processing and failure stats from SAB history + archive, last 24 h, de-duplicated by nzo_id.
    const slots = new Map<string, SabHistorySlot>();
    for (const s of [...(hist?.slots ?? []), ...(archive?.slots ?? [])]) slots.set(s.nzo_id, s);
    const recent = [...slots.values()].filter((s) => s.completed * 1000 >= since24);
    const completed = recent.filter((s) => s.status === 'Completed');
    const failed = recent.filter((s) => s.status === 'Failed');
    // Only jobs big enough to say something about PP (aborted NZBs post-process in 0 s).
    const big = completed.filter((s) => s.bytes > 1024 ** 3);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

    const nowSec = Math.floor(now / 1000);
    const samples = this.downloads.rateSamples(48 * 3600);
    const series = this.stack.db
      .prepare('SELECT ts, sab_total_bytes AS b, sab_paused AS p FROM samples WHERE ts >= ? ORDER BY ts')
      .all(nowSec - 24 * 3600) as { ts: number; b: number | null; p: number | null }[];
    // 10-minute buckets of effective rate for the chart.
    const rateSeries: ThroughputStats['rateSeries'] = [];
    let prev: { ts: number; b: number } | null = null;
    let acc = { bytes: 0, secs: 0, paused: false, start: 0 };
    for (const s of series) {
      if (s.b === null) continue;
      if (prev) {
        const dt = s.ts - prev.ts;
        const db = s.b - prev.b;
        if (dt > 0 && dt < 900 && db >= 0) {
          if (!acc.start) acc.start = Math.floor(s.ts / 600) * 600;
          if (Math.floor(s.ts / 600) * 600 !== acc.start) {
            if (acc.secs) rateSeries.push({ ts: acc.start, bps: Math.round(acc.bytes / acc.secs), paused: acc.paused });
            acc = { bytes: 0, secs: 0, paused: false, start: Math.floor(s.ts / 600) * 600 };
          }
          acc.bytes += db;
          acc.secs += dt;
          acc.paused ||= !!s.p;
        }
      }
      prev = { ts: s.ts, b: s.b };
    }
    if (acc.secs) rateSeries.push({ ts: acc.start, bps: Math.round(acc.bytes / acc.secs), paused: acc.paused });

    const rate1h = effectiveRate(samples, 3600, nowSec);
    const rate6h = effectiveRate(samples, 6 * 3600, nowSec);
    const rate24h = effectiveRate(samples, 24 * 3600, nowSec);
    const backlog = this.downloads.queue ? mbToBytes(this.downloads.queue.mbleft) : 0;
    const etaRate = rate6h ?? rate1h ?? null;

    return {
      updatedAt: now,
      importsLast24h: { movies: m24, episodes: e24, bytes: bytes24 },
      importsPerHour: Math.round(((m24 + e24) / 24) * 10) / 10,
      hourly: [...hourly.entries()].map(([hour, v]) => ({ hour, ...v })),
      ppAvgSec: avg(big.map((s) => s.postproc_time)),
      dlAvgSec: avg(big.map((s) => s.download_time)),
      ppSampleSize: big.length,
      failedLast24h: failed.length,
      completedLast24h: completed.length,
      failedRate: recent.length ? Math.round((failed.length / recent.length) * 1000) / 10 : null,
      servers: stats
        ? Object.entries(stats.servers)
            .map(([name, v]) => ({ name, day: v.day, week: v.week, month: v.month, total: v.total }))
            .sort((a, b) => b.month - a.month)
        : [],
      rate1hBps: rate1h,
      rate6hBps: rate6h,
      rate24hBps: rate24h,
      backlogBytes: backlog,
      backlogEtaSec: etaRate ? Math.round(backlog / etaRate) : null,
      rateSeries,
      storage: this.downloads.feed?.disks ?? [],
    };
  }
}
