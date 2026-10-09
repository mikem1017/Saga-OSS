/**
 * Pure logic for the Insights extras, kept free of I/O so it can be unit-tested:
 * storage forecast maths, hygiene classification, NL filter → browse mapping, auto-bump selection.
 */

// ---------------------------------------------------------------- storage forecast

export interface DiskPoint {
  ts: number; // unix seconds
  used: number;
}

/** Bytes per day from a series of pool "used" readings (least-squares slope, robust to noise). */
export function growthPerDay(points: DiskPoint[]): number | null {
  if (points.length < 2) return null;
  const span = points[points.length - 1]!.ts - points[0]!.ts;
  if (span < 12 * 3600) return null; // need at least half a day to say anything
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.ts, 0) / n;
  const my = points.reduce((a, p) => a + p.used, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.ts - mx) * (p.used - my);
    den += (p.ts - mx) ** 2;
  }
  return den ? (num / den) * 86400 : null;
}

export interface FillForecast {
  /** Days until the pool is full at the given growth rate; null if not growing. */
  daysToFull: number | null;
  fullAt: number | null; // unix ms
  /** Projected used bytes, one point per day, until full or `horizonDays`. */
  projection: { day: number; used: number }[];
}

export function forecastFill(used: number, avail: number, bytesPerDay: number | null, nowMs: number, horizonDays = 365): FillForecast {
  const size = used + avail;
  if (!bytesPerDay || bytesPerDay <= 0) return { daysToFull: null, fullAt: null, projection: [{ day: 0, used }] };
  const daysToFull = avail / bytesPerDay;
  const end = Math.min(horizonDays, Math.ceil(daysToFull));
  const step = Math.max(1, Math.ceil(end / 60));
  const projection: { day: number; used: number }[] = [];
  for (let d = 0; d <= end; d += step) projection.push({ day: d, used: Math.min(size, used + bytesPerDay * d) });
  if (projection[projection.length - 1]!.day !== end) projection.push({ day: end, used: Math.min(size, used + bytesPerDay * end) });
  return { daysToFull, fullAt: nowMs + daysToFull * 86400_000, projection };
}

/** Daily totals (bytes) from dated import events, oldest first, zero-filled. */
export function dailyTotals(events: { date: string; bytes: number }[], days: number, nowMs: number): { day: string; bytes: number }[] {
  const out = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) out.set(new Date(nowMs - i * 86400_000).toISOString().slice(0, 10), 0);
  for (const e of events) {
    const k = e.date.slice(0, 10);
    if (out.has(k)) out.set(k, out.get(k)! + e.bytes);
  }
  return [...out.entries()].map(([day, bytes]) => ({ day, bytes }));
}

// ---------------------------------------------------------------- hygiene

export type HygieneKind = 'missing-stale' | 'unmonitored' | 'duplicate' | 'queue-warning' | 'kept-leftover' | 'unpack-leftover';

export interface HygieneMovie {
  id: number;
  tmdbId: number;
  title: string;
  year?: number;
  monitored: boolean;
  hasFile: boolean;
  added?: string;
  inQueue: boolean;
}

export interface HygieneSeries {
  id: number;
  tmdbId?: number;
  title: string;
  monitored: boolean;
  have: number;
  aired: number;
  added?: string;
  inQueue: boolean;
}

export interface HygieneItem {
  kind: HygieneKind;
  app: 'radarr' | 'sonarr' | 'sab';
  title: string;
  detail: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  ageDays?: number;
}

const ageDays = (iso: string | undefined, nowMs: number) => (iso ? Math.floor((nowMs - new Date(iso).getTime()) / 86400_000) : undefined);

/** Classify library rows into report items. Report only: nothing here leads to a delete. */
export function classifyHygiene(input: { movies: HygieneMovie[]; series: HygieneSeries[]; staleDays: number; nowMs: number }): HygieneItem[] {
  const out: HygieneItem[] = [];
  const { staleDays, nowMs } = input;
  for (const m of input.movies) {
    const age = ageDays(m.added, nowMs);
    if (!m.monitored) {
      out.push({ kind: 'unmonitored', app: 'radarr', title: label(m), detail: m.hasFile ? 'Unmonitored (has a file, will not upgrade)' : 'Unmonitored and missing', tmdbId: m.tmdbId, mediaType: 'movie', ageDays: age });
    } else if (!m.hasFile && !m.inQueue && age !== undefined && age >= staleDays) {
      out.push({ kind: 'missing-stale', app: 'radarr', title: label(m), detail: `Monitored, no file, not in the queue for ${age} days since added`, tmdbId: m.tmdbId, mediaType: 'movie', ageDays: age });
    }
  }
  const byTmdb = new Map<number, HygieneMovie[]>();
  for (const m of input.movies) byTmdb.set(m.tmdbId, [...(byTmdb.get(m.tmdbId) ?? []), m]);
  for (const [tmdbId, group] of byTmdb)
    if (group.length > 1) out.push({ kind: 'duplicate', app: 'radarr', title: label(group[0]!), detail: `${group.length} Radarr entries share TMDB ${tmdbId} (ids ${group.map((g) => g.id).join(', ')})`, tmdbId, mediaType: 'movie' });

  for (const s of input.series) {
    const age = ageDays(s.added, nowMs);
    if (!s.monitored) {
      out.push({ kind: 'unmonitored', app: 'sonarr', title: s.title, detail: `Unmonitored (${s.have}/${s.aired} episodes on disk)`, tmdbId: s.tmdbId, mediaType: 'tv', ageDays: age });
    } else if (s.have < s.aired && !s.inQueue && age !== undefined && age >= staleDays) {
      out.push({ kind: 'missing-stale', app: 'sonarr', title: s.title, detail: `${s.aired - s.have} aired episode(s) missing, nothing in the queue (added ${age} days ago)`, tmdbId: s.tmdbId, mediaType: 'tv', ageDays: age });
    }
  }
  const seriesByTmdb = new Map<number, HygieneSeries[]>();
  for (const s of input.series) if (s.tmdbId) seriesByTmdb.set(s.tmdbId, [...(seriesByTmdb.get(s.tmdbId) ?? []), s]);
  for (const [tmdbId, group] of seriesByTmdb)
    if (group.length > 1) out.push({ kind: 'duplicate', app: 'sonarr', title: group[0]!.title, detail: `${group.length} Sonarr entries share TMDB ${tmdbId}`, tmdbId, mediaType: 'tv' });
  return out;
}

/** Folders sitting in SAB's complete/ for over a day: an interrupted unpack, or a download nothing imported. */
export function leftoversFromFeed(list: { name: string; category: string; size: number; mtime: number }[], nowMs: number): HygieneItem[] {
  return list.map((l) => {
    const days = Math.floor((nowMs - l.mtime * 1000) / 86400_000);
    const gb = (l.size / 1024 ** 3).toFixed(1);
    const unpack = l.name.startsWith('_UNPACK_');
    return {
      kind: unpack ? 'unpack-leftover' : 'kept-leftover',
      app: 'sab' as const,
      title: l.name,
      detail: unpack
        ? `complete/${l.category}: interrupted unpack, ${gb} GB, ${days} day(s) old. Check whether the title is in the library before removing it.`
        : `complete/${l.category}: finished ${days} day(s) ago, ${gb} GB, never cleaned up. Usually a download the *arr didn't import (check its queue/history).`,
      ageDays: days,
    };
  });
}

/** Cleanup-log lines worth a human look: folders kept because only an older import matched, and _UNPACK_ leftovers. */
export function leftoversFromLog(lines: string[]): HygieneItem[] {
  const out: HygieneItem[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const kept = /kept \(only an older import/i.test(line);
    const unpack = /_UNPACK_/.test(line);
    if (!kept && !unpack) continue;
    // The release name: the _UNPACK_ token if any, else the longest dotted token with letters in it.
    const tokens = line.split(/\s+/).map((t) => t.replace(/[:,;]$/, ''));
    const name =
      tokens.find((t) => t.includes('_UNPACK_')) ??
      tokens.filter((t) => /[A-Za-z]/.test(t) && t.includes('.')).sort((a, b) => b.length - a.length)[0] ??
      line.slice(0, 80);
    const key = `${kept ? 'k' : 'u'}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kept ? 'kept-leftover' : 'unpack-leftover', app: 'sab', title: name, detail: line.trim().slice(0, 300) });
  }
  return out;
}

function label(m: { title: string; year?: number }) {
  return m.year ? `${m.title} (${m.year})` : m.title;
}

// ---------------------------------------------------------------- natural-language discover

export interface NlFilters {
  mediaType: 'movie' | 'tv';
  /** Plain-text title search, used only when the request names a specific title. */
  titleSearch: string | null;
  genres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  keywords: string[];
  people: string[];
  language: string | null;
  country: string | null;
  sort: 'popularity' | 'rating' | 'newest' | 'oldest' | 'revenue';
  minRating: number | null;
  library: 'missing' | 'have' | 'any';
  haveQuality: '4k' | '1080p' | null;
  summary: string;
}

export interface NlLookups {
  genreIds: Map<string, number>; // lowercased name → id
  keywordIds: Map<string, number | undefined>;
  personIds: Map<string, number | undefined>;
}

export interface BrowseQuery {
  type: 'movie' | 'tv';
  sort: string;
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  language?: string;
  country?: string;
  keyword?: string;
  person?: string;
  minRating?: number;
  minVotes?: number;
}

const GENRE_ALIASES: Record<string, string> = { 'sci-fi': 'science fiction', scifi: 'science fiction', 'rom-com': 'romance', heist: 'crime', superhero: 'action', kids: 'family', cartoon: 'animation', anime: 'animation', thriller: 'thriller' };

/** Model filters → a DiscoverService.browse query. Unknown genres/keywords/people are dropped (and reported). */
export function filtersToBrowse(f: NlFilters, l: NlLookups): { query: BrowseQuery; dropped: string[] } {
  const dropped: string[] = [];
  const genreIds: number[] = [];
  for (const g of f.genres) {
    const name = g.toLowerCase().trim();
    const id = l.genreIds.get(name) ?? l.genreIds.get(GENRE_ALIASES[name] ?? '');
    if (id) genreIds.push(id);
    else dropped.push(`genre "${g}"`);
  }
  const kw = [...new Set(f.keywords.map((k) => l.keywordIds.get(k.toLowerCase())).filter((x): x is number => !!x))];
  for (const k of f.keywords) if (!l.keywordIds.get(k.toLowerCase())) dropped.push(`keyword "${k}"`);
  const ppl = [...new Set(f.people.map((p) => l.personIds.get(p.toLowerCase())).filter((x): x is number => !!x))];
  for (const p of f.people) if (!l.personIds.get(p.toLowerCase())) dropped.push(`person "${p}"`);
  const isMovie = f.mediaType === 'movie';
  const dateKey = isMovie ? 'primary_release_date' : 'first_air_date';
  const sort = { popularity: 'popularity.desc', rating: 'vote_average.desc', newest: `${dateKey}.desc`, oldest: `${dateKey}.asc`, revenue: isMovie ? 'revenue.desc' : 'popularity.desc' }[f.sort];
  const query: BrowseQuery = {
    type: f.mediaType,
    sort,
    genre: genreIds.length ? [...new Set(genreIds)].join(',') : undefined,
    yearFrom: f.yearFrom ?? undefined,
    yearTo: f.yearTo ?? undefined,
    language: f.language ?? undefined,
    country: f.country ?? undefined,
    // TMDB: comma = AND, pipe = OR. Keywords are alternatives ("heist|robbery"), people must all appear.
    keyword: kw.length ? kw.join('|') : undefined,
    person: isMovie && ppl.length ? ppl.join(',') : undefined,
    minRating: f.minRating ?? undefined,
    minVotes: f.sort === 'rating' || f.minRating ? 150 : 20,
  };
  if (!isMovie && ppl.length) dropped.push('people filter (TMDB only supports it for films)');
  return { query, dropped };
}

/** Post-filter on live library state. */
export function libraryMatch(state: { kind: string; resolution?: number }, f: Pick<NlFilters, 'library' | 'haveQuality'>): boolean {
  const inLib = state.kind !== 'none' && state.kind !== 'requested';
  if (f.library === 'missing') return !inLib;
  if (f.library === 'have') {
    if (state.kind !== 'available') return false;
    if (f.haveQuality === '4k') return (state.resolution ?? 0) >= 2160;
    if (f.haveQuality === '1080p') return (state.resolution ?? 0) >= 1080 && (state.resolution ?? 0) < 2160;
    return true;
  }
  return true;
}

/** Dollar cost of one call. Per-MTok prices; unknown models are priced like Opus 5.5. */
export const MODEL_PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function costUsd(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-opus-5-5']!;
  return (u.input_tokens * p.in + u.output_tokens * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6;
}

// ---------------------------------------------------------------- auto-bump

export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface BumpCandidateRecord {
  seriesId: number;
  downloadId?: string;
  title: string;
  episode?: { seasonNumber: number; episodeNumber: number; airDateUtc?: string; title?: string };
}

export interface BumpSlot {
  nzoId: string;
  index: number;
  priority: string;
  status: string;
}

export interface AutoBump {
  nzoId: string;
  seriesId: number;
  title: string;
  episode: string;
  fromIndex: number;
}

/**
 * New episodes (aired within `newWithinDays`) of shows someone watched recently, still queued in SAB, not
 * already near the top of the High band, and not bumped before. One bump per download.
 */
export function selectAutoBumps(input: {
  watchedSeriesIds: Set<number>;
  records: BumpCandidateRecord[];
  slots: BumpSlot[];
  alreadyBumped: Set<string>;
  nowMs: number;
  newWithinDays?: number;
}): AutoBump[] {
  const within = (input.newWithinDays ?? 14) * 86400_000;
  const slotById = new Map(input.slots.map((s) => [s.nzoId.toLowerCase(), s]));
  const out = new Map<string, AutoBump>();
  for (const r of input.records) {
    if (!input.watchedSeriesIds.has(r.seriesId) || !r.downloadId) continue;
    const id = r.downloadId.toLowerCase();
    if (input.alreadyBumped.has(id) || out.has(id)) continue;
    const air = r.episode?.airDateUtc ? new Date(r.episode.airDateUtc).getTime() : NaN;
    if (!Number.isFinite(air) || air > input.nowMs + 86400_000 || input.nowMs - air > within) continue;
    const slot = slotById.get(id);
    if (!slot || slot.status === 'Paused' || slot.status === 'Downloading') continue;
    if (slot.priority === 'Force' || (slot.priority === 'High' && slot.index < 3)) continue;
    const ep = r.episode!;
    out.set(id, {
      nzoId: slot.nzoId,
      seriesId: r.seriesId,
      title: r.title,
      episode: `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}${ep.title ? ` ${ep.title}` : ''}`,
      fromIndex: slot.index,
    });
  }
  return [...out.values()];
}

/** Recency-weighted seed scores for "because you watched": half-life 30 days, extra plays add less. */
export function seedWeight(plays: number, lastPlayedSec: number, nowSec: number): number {
  const ageDays = Math.max(0, (nowSec - lastPlayedSec) / 86400);
  return Math.pow(0.5, ageDays / 30) * (1 + Math.log2(Math.max(1, plays)));
}
