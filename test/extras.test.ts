import { describe, expect, it } from 'vitest';
import {
  classifyHygiene,
  costUsd,
  dailyTotals,
  filtersToBrowse,
  forecastFill,
  growthPerDay,
  leftoversFromLog,
  libraryMatch,
  normTitle,
  seedWeight,
  selectAutoBumps,
  type NlFilters,
} from '../src/server/extras/pure.ts';
import { NlDiscover } from '../src/server/extras/nl.ts';
import { openMemoryDb } from '../src/server/db.ts';

const TB = 1024 ** 4;
const DAY = 86400;

describe('storage forecast', () => {
  it('fits a slope through noisy pool readings', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ ts: i * DAY, used: 100 * TB + i * 0.5 * TB + (i % 2 ? 0.05 : -0.05) * TB }));
    expect(growthPerDay(pts)! / TB).toBeCloseTo(0.5, 1);
  });
  it('needs at least half a day of history', () => {
    expect(growthPerDay([{ ts: 0, used: 1 }, { ts: 3600, used: 2 }])).toBeNull();
  });
  it('projects the fill date', () => {
    const f = forecastFill(100 * TB, 50 * TB, 0.5 * TB, 0);
    expect(f.daysToFull).toBeCloseTo(100);
    expect(f.fullAt).toBe(100 * DAY * 1000);
    expect(f.projection.at(-1)).toEqual({ day: 100, used: 150 * TB });
  });
  it('no growth means no fill date', () => {
    expect(forecastFill(1, 1, 0, 0).daysToFull).toBeNull();
    expect(forecastFill(1, 1, null, 0).daysToFull).toBeNull();
  });
  it('totals imports per day, zero-filled', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const d = dailyTotals([{ date: '2026-10-08T01:00:00Z', bytes: 5 }, { date: '2026-10-08T02:00:00Z', bytes: 7 }, { date: '2026-10-06T02:00:00Z', bytes: 1 }, { date: '2025-01-01', bytes: 99 }], 3, now);
    expect(d).toEqual([
      { day: '2026-10-06', bytes: 1 },
      { day: '2026-10-07', bytes: 0 },
      { day: '2026-10-08', bytes: 12 },
    ]);
  });
});

describe('hygiene', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  it('classifies stale missing, unmonitored and duplicates; ignores queued and recent', () => {
    const items = classifyHygiene({
      staleDays: 30,
      nowMs: now,
      movies: [
        { id: 1, tmdbId: 10, title: 'Old Missing', year: 1999, monitored: true, hasFile: false, added: '2026-07-01', inQueue: false },
        { id: 2, tmdbId: 11, title: 'Queued', monitored: true, hasFile: false, added: '2026-07-01', inQueue: true },
        { id: 3, tmdbId: 12, title: 'New', monitored: true, hasFile: false, added: '2026-10-01', inQueue: false },
        { id: 4, tmdbId: 13, title: 'Unmon', monitored: false, hasFile: true, added: '2026-01-01', inQueue: false },
        { id: 5, tmdbId: 14, title: 'Dup', monitored: true, hasFile: true, inQueue: false },
        { id: 6, tmdbId: 14, title: 'Dup', monitored: true, hasFile: true, inQueue: false },
      ],
      series: [
        { id: 1, tmdbId: 100, title: 'Gaps', monitored: true, have: 3, aired: 10, added: '2026-06-01', inQueue: false },
        { id: 2, tmdbId: 101, title: 'Complete', monitored: true, have: 10, aired: 10, added: '2026-06-01', inQueue: false },
      ],
    });
    const kinds = items.map((i) => `${i.kind}:${i.title}`).sort();
    expect(kinds).toEqual(['duplicate:Dup', 'missing-stale:Gaps', 'missing-stale:Old Missing (1999)', 'unmonitored:Unmon']);
  });
  it('pulls kept and _UNPACK_ lines from the cleanup log, once each', () => {
    const items = leftoversFromLog([
      '2026-10-08 03:00 Some.Movie.2001.1080p.BluRay-GRP kept (only an older import 2025-11-02)',
      '2026-10-08 04:00 Some.Movie.2001.1080p.BluRay-GRP kept (only an older import 2025-11-02)',
      '2026-10-08 04:00 skipping _UNPACK_Other.Movie.2010.2160p (no import)',
      '2026-10-08 04:00 deleted Imported.Thing.2020',
    ]);
    expect(items.map((i) => i.kind)).toEqual(['kept-leftover', 'unpack-leftover']);
    expect(items[1]!.title).toBe('_UNPACK_Other.Movie.2010.2160p');
  });
});

describe('natural-language filters', () => {
  const base: NlFilters = {
    mediaType: 'movie',
    titleSearch: null,
    genres: ['Crime', 'heist'],
    yearFrom: 1990,
    yearTo: 1999,
    keywords: ['heist', 'unknown-thing'],
    people: ['Michael Mann'],
    language: null,
    country: null,
    sort: 'rating',
    minRating: null,
    library: 'missing',
    haveQuality: null,
    summary: '90s heist films not in the library',
  };
  const lookups = {
    genreIds: new Map([['crime', 80], ['thriller', 53]]),
    keywordIds: new Map<string, number | undefined>([['heist', 10051], ['unknown-thing', undefined]]),
    personIds: new Map<string, number | undefined>([['michael mann', 638]]),
  };
  it('maps model output to a TMDB discover query', () => {
    const { query, dropped } = filtersToBrowse(base, lookups);
    expect(query).toEqual({ type: 'movie', sort: 'vote_average.desc', genre: '80', yearFrom: 1990, yearTo: 1999, language: undefined, country: undefined, keyword: '10051', person: '638', minRating: undefined, minVotes: 150 });
    expect(dropped).toEqual(['keyword "unknown-thing"']);
  });
  it('drops people for TV (TMDB limitation) and uses first_air_date sorts', () => {
    const { query, dropped } = filtersToBrowse({ ...base, mediaType: 'tv', genres: [], keywords: [], sort: 'newest' }, lookups);
    expect(query.person).toBeUndefined();
    expect(query.sort).toBe('first_air_date.desc');
    expect(dropped).toContain('people filter (TMDB only supports it for films)');
  });
  it('filters by library state and quality', () => {
    expect(libraryMatch({ kind: 'none' }, { library: 'missing', haveQuality: null })).toBe(true);
    expect(libraryMatch({ kind: 'queued' }, { library: 'missing', haveQuality: null })).toBe(false);
    expect(libraryMatch({ kind: 'available', resolution: 2160 }, { library: 'have', haveQuality: '4k' })).toBe(true);
    expect(libraryMatch({ kind: 'available', resolution: 1080 }, { library: 'have', haveQuality: '4k' })).toBe(false);
  });
  it('prices calls per model', () => {
    expect(costUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(6);
    expect(costUsd('unknown-model', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(4.2);
  });
  it('runs end to end with a mocked model response', async () => {
    const db = openMemoryDb();
    const card = (id: number, kind: string) => ({ mediaType: 'movie' as const, tmdbId: id, title: `T${id}`, state: { kind } as any });
    const calls: any[] = [];
    const discover = {
      genres: async () => [{ id: 80, name: 'Crime' }],
      searchKeywords: async () => [{ id: 10051, name: 'heist' }],
      searchPeople: async () => [{ id: 638, name: 'Michael Mann' }],
      browse: async (q: any) => {
        calls.push(q);
        return { page: q.page, totalPages: 1, totalResults: 3, results: [card(1, 'none'), card(2, 'available'), card(3, 'requested')] };
      },
      search: async () => ({ page: 1, totalPages: 1, totalResults: 0, results: [] }),
    };
    const nl = new NlDiscover({ db, config: {} } as any, discover as any);
    const out = await nl.run('90s heist films I do not have', 'tester', async () => base);
    expect(calls[0]).toMatchObject({ type: 'movie', genre: '80', keyword: '10051', person: '638', page: 1 });
    expect(out.results.map((r) => r.tmdbId)).toEqual([1, 3]);
  });
  it('refuses without a key', async () => {
    const nl = new NlDiscover({ db: openMemoryDb(), config: {} } as any, {} as any);
    if (!process.env.ANTHROPIC_API_KEY) await expect(nl.interpret('x', 't')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('auto-bump selection', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const slots = [
    { nzoId: 'A', index: 0, priority: 'High', status: 'Downloading' },
    { nzoId: 'B', index: 40, priority: 'High', status: 'Queued' },
    { nzoId: 'C', index: 900, priority: 'Normal', status: 'Queued' },
    { nzoId: 'D', index: 950, priority: 'Normal', status: 'Queued' },
    { nzoId: 'E', index: 1, priority: 'High', status: 'Queued' },
  ];
  const ep = (days: number) => ({ seasonNumber: 2, episodeNumber: 3, airDateUtc: new Date(now - days * 86400_000).toISOString(), title: 'Ep' });
  it('bumps new episodes of watched shows that are still queued, once', () => {
    const picks = selectAutoBumps({
      watchedSeriesIds: new Set([1]),
      records: [
        { seriesId: 1, downloadId: 'a', title: 'Show', episode: ep(1) }, // downloading already
        { seriesId: 1, downloadId: 'b', title: 'Show', episode: ep(2) }, // pick
        { seriesId: 1, downloadId: 'b', title: 'Show', episode: ep(2) }, // season pack duplicate
        { seriesId: 1, downloadId: 'c', title: 'Show', episode: ep(40) }, // too old
        { seriesId: 2, downloadId: 'd', title: 'Other', episode: ep(1) }, // not watched
        { seriesId: 1, downloadId: 'e', title: 'Show', episode: ep(1) }, // already near the top
        { seriesId: 1, downloadId: 'x', title: 'Show', episode: ep(1) }, // not in SAB
      ],
      slots,
      alreadyBumped: new Set(),
      nowMs: now,
    });
    expect(picks.map((p) => p.nzoId)).toEqual(['B']);
    expect(picks[0]!.episode).toBe('S02E03 Ep');
  });
  it('skips downloads bumped before', () => {
    const picks = selectAutoBumps({ watchedSeriesIds: new Set([1]), records: [{ seriesId: 1, downloadId: 'B', title: 'Show', episode: ep(1) }], slots, alreadyBumped: new Set(['b']), nowMs: now });
    expect(picks).toEqual([]);
  });
  it('matches titles across Plex/Sonarr spellings', () => {
    expect(normTitle('Doctor Who (2005)')).toBe(normTitle('Doctor Who'));
    expect(normTitle('Law & Order: SVU')).toBe('law and order svu');
  });
  it('weights recent, repeated plays higher', () => {
    const now = 100 * DAY;
    expect(seedWeight(1, now, now)).toBeGreaterThan(seedWeight(1, now - 60 * DAY, now));
    expect(seedWeight(4, now, now)).toBeGreaterThan(seedWeight(1, now, now));
  });
});

import { leftoversFromFeed } from '../src/server/extras/pure.ts';
describe('leftovers from the download host feed', () => {
  it('classifies _UNPACK_ folders and plain leftovers with age and size', () => {
    const now = Date.UTC(2026, 9, 8);
    const items = leftoversFromFeed(
      [
        { name: '_UNPACK_Some.Movie.2020.2160p', category: 'movies', size: 50 * 1024 ** 3, mtime: now / 1000 - 3 * 86400 },
        { name: 'Show.S01E01.1080p', category: 'tv', size: 2 * 1024 ** 3, mtime: now / 1000 - 2 * 86400 },
      ],
      now,
    );
    expect(items.map((i) => [i.kind, i.ageDays])).toEqual([['unpack-leftover', 3], ['kept-leftover', 2]]);
    expect(items[0]!.detail).toContain('50.0 GB');
  });
});
