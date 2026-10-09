import type { Stack } from '../stack.ts';
import type { LibraryService } from '../services/library.ts';
import type { DownloadsService } from '../services/downloads.ts';
import type { StateService } from '../services/state.ts';
import type { DiscoverService } from '../services/discover.ts';
import { toCard } from '../services/discover.ts';
import { QueueControl } from '../services/queueControl.ts';
import { audit } from '../services/audit.ts';
import { cacheGet, cacheSet, getSetting, setSetting } from '../db.ts';
import { requestJson, UpstreamError } from '../http.ts';
import { mbToBytes } from '../connectors/sab.ts';
import type { MediaType, TitleCard } from '../../shared/types.ts';
import { log } from '../log.ts';
import {
  classifyHygiene,
  dailyTotals,
  forecastFill,
  growthPerDay,
  leftoversFromLog,
  leftoversFromFeed,
  normTitle,
  seedWeight,
  selectAutoBumps,
  type BumpCandidateRecord,
  type HygieneItem,
} from './pure.ts';

const MAX_UPGRADE_SEARCHES = 50;

interface ProfileInfo {
  id: number;
  name: string;
  cutoffName: string;
  cutoffFormatScore: number;
  upgradeAllowed: boolean;
}

export interface UpgradeItem {
  key: string; // "radarr:<movieId>" | "sonarr:<seriesId>:<season>"
  app: 'radarr' | 'sonarr';
  id: number; // movieId / seriesId
  seasonNumber?: number;
  tmdbId?: number;
  mediaType: MediaType;
  title: string;
  year?: number;
  episodes?: number;
  quality: string; // current (most common for a season)
  resolution?: number;
  score: number | null; // current custom-format score (min for a season)
  cutoffScore: number;
  cutoffQuality: string;
  reason: 'quality' | 'score';
  sizeBytes: number; // current on disk
  estBytes: number; // estimated download for the upgrade
  profile: string;
}

/** Tautulli API call (the shared connector keeps its command helper private). */
async function tautulli<T>(stack: Stack, cmd: string, params: Record<string, string | number> = {}): Promise<T> {
  const { TAUTULLI_URL, TAUTULLI_API_KEY } = stack.config;
  if (!TAUTULLI_URL || !TAUTULLI_API_KEY) throw new Error('Tautulli is not configured');
  const res = await requestJson<{ response: { result: string; message?: string; data: T } }>('Tautulli', TAUTULLI_URL, '/api/v2', {
    query: { apikey: TAUTULLI_API_KEY, cmd, ...params },
  });
  if (res.response.result !== 'success') throw new UpstreamError('Tautulli', 200, res.response.message ?? 'error');
  return res.response.data;
}

interface HistoryRow {
  user_id: number;
  friendly_name: string;
  media_type: string; // movie | episode
  title: string;
  grandparent_title?: string;
  year?: number;
  date: number;
  rating_key: number;
  grandparent_rating_key?: number | string;
}

export class ExtrasService {
  readonly control: QueueControl;

  constructor(
    private readonly stack: Stack,
    private readonly library: LibraryService,
    private readonly downloads: DownloadsService,
    private readonly state: StateService,
    private readonly discover?: DiscoverService,
  ) {
    this.control = new QueueControl(stack, downloads);
  }

  /** Hygiene and forecast read the joined queues; make sure they've been polled at least once (e.g. right after a restart). */
  private async ensureQueues(): Promise<void> {
    await Promise.all([this.downloads.arrAt ? null : this.downloads.pollArr(), this.downloads.queueAt ? null : this.downloads.pollQueue(), this.downloads.feed || !this.stack.feedHost ? null : this.downloads.pollFeed()]);
  }

  // ============================================================ 1. upgrade finder

  private async profiles(app: 'radarr' | 'sonarr'): Promise<Map<number, ProfileInfo>> {
    const client = app === 'radarr' ? this.stack.radarr : this.stack.sonarr;
    if (!client) return new Map();
    const raw = await client.request<any[]>('/qualityprofile');
    return new Map(
      raw.map((p) => {
        const cutoffItem = (p.items ?? []).find((i: any) => (i.id ?? i.quality?.id) === p.cutoff);
        return [
          p.id,
          { id: p.id, name: p.name, cutoffName: cutoffItem?.name ?? cutoffItem?.quality?.name ?? String(p.cutoff), cutoffFormatScore: p.cutoffFormatScore ?? 0, upgradeAllowed: !!p.upgradeAllowed },
        ];
      }),
    );
  }

  async upgrades(refresh = false): Promise<{ items: UpgradeItem[]; totals: { movies: number; seasons: number; episodes: number }; generatedAt: number }> {
    const key = 'extras:upgrades';
    if (!refresh) {
      const hit = cacheGet<{ items: UpgradeItem[]; totals: { movies: number; seasons: number; episodes: number }; generatedAt: number }>(this.stack.db, key);
      if (hit) return hit;
    }
    await this.library.ensureLoaded();
    const items: UpgradeItem[] = [];
    let episodesTotal = 0;
    const { radarr, sonarr } = this.stack;
    if (radarr) {
      const profiles = await this.profiles('radarr');
      const movies: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await radarr.request<{ records: any[]; totalRecords: number }>('/wanted/cutoff', { query: { page, pageSize: 500, monitored: true }, timeoutMs: 60_000 });
        movies.push(...res.records);
        if (movies.length >= res.totalRecords || !res.records.length) break;
      }
      // /wanted/cutoff omits the file; fetch them in batches by file id.
      const files = new Map<number, any>();
      const ids = movies.map((m) => m.movieFileId).filter((x: number) => x > 0);
      for (let i = 0; i < ids.length; i += 100) {
        const qs = ids
          .slice(i, i + 100)
          .map((id: number) => `movieFileIds=${id}`)
          .join('&');
        const batch = await radarr.request<any[]>(`/moviefile?${qs}`, { timeoutMs: 60_000 });
        for (const f of batch) files.set(f.id, f);
      }
      for (const m of movies) {
        const f = files.get(m.movieFileId);
        const p = profiles.get(m.qualityProfileId);
        if (!p?.upgradeAllowed) continue;
        const q = f?.quality?.quality;
        const est = this.library.movieSizeEstimate(m.qualityProfileId);
        items.push({
          key: `radarr:${m.id}`,
          app: 'radarr',
          id: m.id,
          tmdbId: m.tmdbId,
          mediaType: 'movie',
          title: m.title,
          year: m.year,
          quality: q?.name ?? 'unknown',
          resolution: q?.resolution,
          score: f?.customFormatScore ?? null,
          cutoffScore: p.cutoffFormatScore,
          cutoffQuality: p.cutoffName,
          reason: f?.qualityCutoffNotMet ? 'quality' : 'score',
          sizeBytes: f?.size ?? m.sizeOnDisk ?? 0,
          estBytes: est.bytes,
          profile: p.name,
        });
      }
    }
    if (sonarr) {
      const profiles = await this.profiles('sonarr');
      const eps: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await sonarr.request<{ records: any[]; totalRecords: number }>('/wanted/cutoff', {
          query: { page, pageSize: 1000, monitored: true, includeSeries: true, includeEpisodeFile: true },
          timeoutMs: 90_000,
        });
        eps.push(...res.records);
        if (eps.length >= res.totalRecords || !res.records.length) break;
      }
      episodesTotal = eps.length;
      const groups = new Map<string, any[]>();
      for (const e of eps) {
        const k = `${e.seriesId}:${e.seasonNumber}`;
        groups.set(k, [...(groups.get(k) ?? []), e]);
      }
      for (const [k, group] of groups) {
        const s = group[0].series ?? this.library.seriesById.get(group[0].seriesId);
        const profileId = s?.qualityProfileId ?? this.library.seriesById.get(group[0].seriesId)?.qualityProfileId;
        const p = profiles.get(profileId);
        if (!p?.upgradeAllowed) continue;
        const qCount = new Map<string, number>();
        let minScore: number | null = null;
        let size = 0;
        let res: number | undefined;
        let anyQualityBelow = false;
        for (const e of group) {
          const f = e.episodeFile;
          const name = f?.quality?.quality?.name ?? 'unknown';
          qCount.set(name, (qCount.get(name) ?? 0) + 1);
          if (typeof f?.customFormatScore === 'number') minScore = minScore === null ? f.customFormatScore : Math.min(minScore, f.customFormatScore);
          size += f?.size ?? 0;
          res ??= f?.quality?.quality?.resolution;
          if (f?.qualityCutoffNotMet) anyQualityBelow = true;
        }
        const quality = [...qCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        const per = this.library.episodeSizeEstimate(profileId);
        const [seriesId, season] = k.split(':').map(Number) as [number, number];
        items.push({
          key: `sonarr:${seriesId}:${season}`,
          app: 'sonarr',
          id: seriesId,
          seasonNumber: season,
          tmdbId: s?.tmdbId,
          mediaType: 'tv',
          title: `${s?.title ?? `Series ${seriesId}`} · Season ${season}`,
          episodes: group.length,
          quality: qCount.size > 1 ? `${quality} (+${qCount.size - 1} other)` : quality,
          resolution: res,
          score: minScore,
          cutoffScore: p.cutoffFormatScore,
          cutoffQuality: p.cutoffName,
          reason: anyQualityBelow ? 'quality' : 'score',
          sizeBytes: size,
          estBytes: per.bytes * group.length,
          profile: p.name,
        });
      }
    }
    items.sort((a, b) => (a.reason === b.reason ? (a.score ?? -1e9) - (b.score ?? -1e9) : a.reason === 'quality' ? -1 : 1));
    const out = {
      items,
      totals: { movies: items.filter((i) => i.app === 'radarr').length, seasons: items.filter((i) => i.app === 'sonarr').length, episodes: episodesTotal },
      generatedAt: Date.now(),
    };
    cacheSet(this.stack.db, key, out, 15 * 60_000);
    return out;
  }

  /** At most 50 per click: one MoviesSearch command for the films, one SeasonSearch per season (sequential). */
  async searchUpgrades(keys: string[], actor: string): Promise<{ started: number; skipped: number; messages: string[] }> {
    if (keys.length > MAX_UPGRADE_SEARCHES) throw new Error(`At most ${MAX_UPGRADE_SEARCHES} upgrade searches per click`);
    const { items } = await this.upgrades();
    const byKey = new Map(items.map((i) => [i.key, i]));
    const chosen = keys.map((k) => byKey.get(k)).filter((x): x is UpgradeItem => !!x);
    const messages: string[] = [];
    let started = 0;
    const movies = chosen.filter((c) => c.app === 'radarr');
    if (movies.length && this.stack.radarr) {
      await this.stack.radarr.command('MoviesSearch', { movieIds: movies.map((m) => m.id) });
      audit(this.stack.db, actor, 'radarr.upgrade-search', `${movies.length} film(s)`, movies.map((m) => m.title).join(', '));
      started += movies.length;
      messages.push(`Radarr: searching ${movies.length} film(s) for upgrades`);
    }
    const seasons = chosen.filter((c) => c.app === 'sonarr');
    if (seasons.length && this.stack.sonarr) {
      for (const s of seasons) {
        await this.stack.sonarr.command('SeasonSearch', { seriesId: s.id, seasonNumber: s.seasonNumber });
        audit(this.stack.db, actor, 'sonarr.upgrade-search', s.title, `${s.episodes} episode(s) below cutoff`);
        started++;
        await new Promise((r) => setTimeout(r, 250)); // gentle on Sonarr/indexers
      }
      messages.push(`Sonarr: ${seasons.length} season search(es) started`);
    }
    return { started, skipped: keys.length - chosen.length, messages };
  }

  // ============================================================ 2. storage forecast

  /** Hourly: remember pool usage so the forecast can use observed growth rather than import totals. */
  recordDisks(): void {
    const disks = this.downloads.feed?.disks;
    if (!disks?.length) return;
    const ts = Math.floor(Date.now() / 3600_000) * 3600;
    const ins = this.stack.db.prepare('INSERT OR REPLACE INTO disk_samples (ts, mount, used, avail) VALUES (?, ?, ?, ?)');
    for (const d of disks) ins.run(ts, d.mount, d.used, d.avail);
    this.stack.db.prepare('DELETE FROM disk_samples WHERE ts < ?').run(ts - 180 * 86400);
  }

  async forecast() {
    const key = 'extras:forecast';
    const hit = cacheGet<any>(this.stack.db, key);
    if (hit) return hit;
    await this.ensureQueues();
    const now = Date.now();
    const disks = this.downloads.feed?.disks ?? [];
    const { MEDIA_MOUNT, CACHE_MOUNT } = this.stack.config;
    const media = disks.find((d) => d.mount === MEDIA_MOUNT) ?? disks.find((d) => d.mount.startsWith(MEDIA_MOUNT));
    const cache = disks.find((d) => d.mount.startsWith(CACHE_MOUNT));
    const since = new Date(now - 14 * 86400_000);
    const [movieImports, epImports] = await Promise.all([
      this.stack.radarr ? this.stack.radarr.importsSince(since, 20).catch(() => []) : [],
      this.stack.sonarr ? this.stack.sonarr.importsSince(since, 20).catch(() => []) : [],
    ]);
    const events = [...movieImports, ...epImports].map((r) => ({ date: r.date, bytes: Number(r.data?.size ?? 0) }));
    const daily = dailyTotals(events, 14, now);
    const last7 = daily.slice(-7).reduce((a, d) => a + d.bytes, 0) / 7;
    const samples = media
      ? (this.stack.db.prepare('SELECT ts, used FROM disk_samples WHERE mount = ? AND ts >= ? ORDER BY ts').all(media.mount, Math.floor(now / 1000) - 14 * 86400) as { ts: number; used: number }[])
      : [];
    const observed = growthPerDay(samples);
    const growth = observed !== null && observed > 0 ? observed : last7 > 0 ? last7 : null;
    const basis = observed !== null && observed > 0 ? `observed pool growth over ${Math.round((samples[samples.length - 1]!.ts - samples[0]!.ts) / 86400 * 10) / 10} days` : 'imports over the last 7 days (no pool history yet; upgrades that replace files make this an over-estimate)';
    const slots = this.downloads.queue?.slots ?? [];
    const byCat = new Map<string, number>();
    for (const s of slots) byCat.set(s.cat, (byCat.get(s.cat) ?? 0) + mbToBytes(s.mbleft));
    const queueBytes = [...byCat.values()].reduce((a, b) => a + b, 0);
    const fill = media ? forecastFill(media.used, media.avail, growth, now) : null;
    const out = {
      generatedAt: now,
      media: media ? { mount: media.mount, used: media.used, avail: media.avail, size: media.used + media.avail } : null,
      cache: cache
        ? { mount: cache.mount, used: cache.used, avail: cache.avail, size: cache.used + cache.avail, headroomBytes: cache.avail - this.stack.config.SAB_MIN_FREE_GB * 1024 ** 3, sabMinFreeBytes: this.stack.config.SAB_MIN_FREE_GB * 1024 ** 3 }
        : null,
      growthBytesPerDay: growth,
      growthBasis: growth ? basis : 'no growth measured yet',
      importsDaily: daily,
      queue: { totalBytes: queueBytes, byCategory: [...byCat.entries()].map(([category, bytes]) => ({ category, bytes })).sort((a, b) => b.bytes - a.bytes) },
      queueFits: media ? queueBytes <= media.avail : null,
      afterQueueAvail: media ? media.avail - queueBytes : null,
      fill,
      poolSamples: samples.length,
    };
    cacheSet(this.stack.db, key, out, 10 * 60_000);
    return out;
  }

  // ============================================================ 3. hygiene

  async hygiene(staleDays = 30): Promise<{ items: HygieneItem[]; counts: Record<string, number>; feedNote: string; agentJournalHint: string }> {
    await Promise.all([this.library.ensureLoaded(), this.ensureQueues()]);
    const now = Date.now();
    const movies = [...this.library.moviesById.values()].map((m) => ({
      id: m.id,
      tmdbId: m.tmdbId,
      title: m.title,
      year: m.year,
      monitored: m.monitored,
      hasFile: m.hasFile,
      added: m.added,
      inQueue: !!this.downloads.arrByMovie.get(m.id)?.length,
    }));
    const series = [...this.library.seriesById.values()].map((s) => ({
      id: s.id,
      tmdbId: s.tmdbId,
      title: s.title,
      monitored: s.monitored,
      have: s.statistics?.episodeFileCount ?? 0,
      aired: s.statistics?.episodeCount ?? 0,
      added: s.added,
      inQueue: !!this.downloads.arrBySeries.get(s.id)?.length,
    }));
    const items = classifyHygiene({ movies, series, staleDays, nowMs: now });
    for (const a of this.downloads.attention())
      items.push({ kind: 'queue-warning', app: a.app, title: a.title, detail: `${a.release}: ${a.messages.join(' · ') || a.status}`, tmdbId: a.tmdbId, mediaType: a.mediaType });
    const feedLeftovers = this.downloads.feed?.leftovers;
    if (feedLeftovers) items.push(...leftoversFromFeed(feedLeftovers, now));
    else items.push(...leftoversFromLog([...(this.downloads.feed?.cleanup.logTail ?? []), ...(this.downloads.feed?.agentGate.logTail ?? [])]));
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return {
      items,
      counts,
      feedNote: feedLeftovers
        ? `Leftovers: every folder in SAB's complete/ older than 24 h (${feedLeftovers.length} now), refreshed every 15 minutes by the download host's status feed.`
        : 'Leftover detection only sees the cleanup log tail (the host feed has no leftovers list).',
      agentJournalHint: 'If you run a maintenance agent, it may quarantine leftovers itself (quarantine → <pool>/.quarantine/<date>/, purged after 7 days). Check its journal on the Dashboard before acting, so you do not fight it.',
    };
  }

  // ============================================================ 4. because you watched

  private async resolveSeed(kind: 'movie' | 'tv', title: string, year?: number): Promise<number | null> {
    const ckey = `extras:seed:${kind}:${normTitle(title)}:${year ?? ''}`;
    const hit = cacheGet<number | null>(this.stack.db, ckey);
    if (hit !== undefined) return hit;
    let id: number | null = null;
    const n = normTitle(title);
    if (kind === 'movie') {
      for (const m of this.library.movies.values()) if (normTitle(m.title) === n && (!year || Math.abs((m.year ?? 0) - year) <= 1)) id = m.tmdbId;
    } else {
      for (const s of this.library.seriesById.values()) if (s.tmdbId && normTitle(s.title) === n) id = s.tmdbId;
    }
    if (!id && this.discover) {
      const raw = await this.discover
        .tmdbGet<any>(`/search/${kind}`, { query: title.replace(/\(\d{4}\)/, '').trim(), year: kind === 'movie' ? year : undefined, first_air_date_year: kind === 'tv' ? title.match(/\((\d{4})\)/)?.[1] : undefined }, 7 * 86400_000)
        .catch(() => null);
      id = raw?.results?.[0]?.id ?? null;
    }
    cacheSet(this.stack.db, ckey, id, 30 * 86400_000);
    return id;
  }

  async forYou(): Promise<{ users: { userId: number; user: string; seeds: { title: string; mediaType: MediaType; plays: number }[]; items: TitleCard[] }[]; note?: string }> {
    const key = 'extras:foryou';
    const hit = cacheGet<any>(this.stack.db, key);
    if (hit) {
      // Re-decorate so badges stay live while the list itself is cached.
      for (const u of hit.users) u.items = this.state.decorate(u.items.map(({ state: _s, ...c }: TitleCard) => c));
      return hit;
    }
    if (!this.discover) throw new Error('TMDB is not configured');
    await this.library.ensureLoaded();
    const users = (await tautulli<any[]>(this.stack, 'get_users')).filter((u) => u.user_id && u.is_active);
    const after = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const nowSec = Date.now() / 1000;
    const out: { userId: number; user: string; seeds: { title: string; mediaType: MediaType; plays: number }[]; items: TitleCard[] }[] = [];
    for (const u of users) {
      const hist = await tautulli<{ data: HistoryRow[] }>(this.stack, 'get_history', { user_id: u.user_id, after, length: 1000 }).catch(() => ({ data: [] as HistoryRow[] }));
      const seeds = new Map<string, { title: string; mediaType: MediaType; year?: number; plays: number; last: number }>();
      for (const h of hist.data ?? []) {
        const isEp = h.media_type === 'episode';
        if (!isEp && h.media_type !== 'movie') continue;
        const title = isEp ? (h.grandparent_title ?? '') : h.title;
        if (!title) continue;
        const k = `${isEp ? 'tv' : 'movie'}:${normTitle(title)}`;
        const s = seeds.get(k) ?? { title, mediaType: (isEp ? 'tv' : 'movie') as MediaType, year: isEp ? undefined : Number(h.year) || undefined, plays: 0, last: 0 };
        s.plays++;
        s.last = Math.max(s.last, Number(h.date));
        seeds.set(k, s);
      }
      const top = [...seeds.values()].sort((a, b) => seedWeight(b.plays, b.last, nowSec) - seedWeight(a.plays, a.last, nowSec)).slice(0, 8);
      if (!top.length) continue;
      const scores = new Map<string, { card: Omit<TitleCard, 'state'>; score: number; because: Set<string> }>();
      const seedKeys = new Set<string>();
      for (const s of top) {
        const id = await this.resolveSeed(s.mediaType, s.title, s.year);
        if (!id) continue;
        seedKeys.add(`${s.mediaType}:${id}`);
        const w = seedWeight(s.plays, s.last, nowSec);
        const recs = await this.discover.tmdbGet<any>(`/${s.mediaType}/${id}/recommendations`, {}, 7 * 86400_000).catch(() => null);
        (recs?.results ?? []).slice(0, 20).forEach((r: any, rank: number) => {
          const card = toCard(r, s.mediaType);
          if (!card) return;
          const k = `${card.mediaType}:${card.tmdbId}`;
          const e = scores.get(k) ?? { card, score: 0, because: new Set<string>() };
          e.score += w * (1 - rank / 25);
          e.because.add(s.title);
          scores.set(k, e);
        });
      }
      const ranked = [...scores.entries()]
        .filter(([k]) => !seedKeys.has(k))
        .map(([, v]) => v)
        .sort((a, b) => b.score - a.score);
      const items = this.state
        .decorate(ranked.map((r) => ({ ...r.card, role: `Because you watched ${[...r.because].slice(0, 2).join(' & ')}` })))
        .filter((c) => c.state.kind === 'none' || c.state.kind === 'requested')
        .slice(0, 30);
      out.push({ userId: u.user_id, user: u.friendly_name || u.username, seeds: top.map((s) => ({ title: s.title, mediaType: s.mediaType, plays: s.plays })), items });
    }
    const result = { users: out, note: out.length ? undefined : 'No watch history in Tautulli for the last 90 days yet.' };
    cacheSet(this.stack.db, key, result, 6 * 3600_000);
    return result;
  }

  // ============================================================ 6. release-aware auto-bump

  autoBumpEnabled(): boolean {
    return getSetting<boolean>(this.stack.db, 'extras.autobump', true);
  }

  setAutoBump(enabled: boolean, actor: string) {
    setSetting(this.stack.db, 'extras.autobump', enabled);
    audit(this.stack.db, actor, 'extras.autobump', null, enabled ? 'enabled' : 'disabled');
  }

  private watchedCache: { at: number; ids: Set<number>; titles: string[] } | null = null;

  /** Sonarr series someone watched in the last 14 days (Tautulli history, all users). */
  async watchedSeries(): Promise<{ ids: Set<number>; titles: string[] }> {
    if (this.watchedCache && Date.now() - this.watchedCache.at < 30 * 60_000) return this.watchedCache;
    const after = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    const hist = await tautulli<{ data: HistoryRow[] }>(this.stack, 'get_history', { after, length: 2000, media_type: 'episode' });
    const wanted = new Set((hist.data ?? []).map((h) => normTitle(h.grandparent_title ?? '')).filter(Boolean));
    const ids = new Set<number>();
    const titles: string[] = [];
    for (const s of this.library.seriesById.values()) {
      if (wanted.has(normTitle(s.title))) {
        ids.add(s.id);
        titles.push(s.title);
      }
    }
    this.watchedCache = { at: Date.now(), ids, titles };
    return this.watchedCache;
  }

  async runAutoBump(): Promise<number> {
    if (!this.autoBumpEnabled() || !this.stack.tautulli || !this.stack.sab || !this.downloads.queue) return 0;
    const watched = await this.watchedSeries();
    if (!watched.ids.size) return 0;
    const records: BumpCandidateRecord[] = [];
    for (const id of watched.ids)
      for (const r of this.downloads.arrBySeries.get(id) ?? [])
        records.push({ seriesId: id, downloadId: r.downloadId, title: this.library.seriesById.get(id)?.title ?? r.title, episode: (r as any).episode });
    const done = new Set((this.stack.db.prepare('SELECT download_id FROM autobumps').all() as { download_id: string }[]).map((r) => r.download_id));
    const picks = selectAutoBumps({
      watchedSeriesIds: watched.ids,
      records,
      slots: this.downloads.queue.slots.map((s) => ({ nzoId: s.nzo_id, index: s.index, priority: s.priority, status: s.status })),
      alreadyBumped: done,
      nowMs: Date.now(),
    }).slice(0, 10);
    for (const p of picks) {
      try {
        await this.control.bump(p.nzoId, 'auto-bump');
        this.stack.db.prepare('INSERT OR REPLACE INTO autobumps (download_id, ts, series_id, title, episode) VALUES (?, ?, ?, ?, ?)').run(p.nzoId.toLowerCase(), Date.now(), p.seriesId, p.title, p.episode);
        audit(this.stack.db, 'auto-bump', 'extras.autobump', `${p.title} ${p.episode}`, `new episode of a show watched in the last 14 days; was #${p.fromIndex + 1}`);
      } catch (err) {
        log.warn(`auto-bump ${p.title} ${p.episode}: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.stack.db.prepare('DELETE FROM autobumps WHERE ts < ?').run(Date.now() - 30 * 86400_000);
    return picks.length;
  }

  async autoBumpStatus() {
    const watched = this.stack.tautulli ? await this.watchedSeries().catch(() => ({ ids: new Set<number>(), titles: [] as string[] })) : { ids: new Set<number>(), titles: [] };
    return {
      enabled: this.autoBumpEnabled(),
      watchedShows: watched.titles.sort(),
      recent: this.stack.db.prepare('SELECT ts, title, episode FROM autobumps ORDER BY ts DESC LIMIT 25').all(),
    };
  }
}
