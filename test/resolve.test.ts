import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/server/services/resolve.ts';
import { detectList, imdbIdsFromHtml, imdbListId } from '../src/server/services/lists.ts';
import { toIcs } from '../src/server/services/calendar.ts';

describe('paste-a-link parsing', () => {
  it.each([
    ['https://www.imdb.com/title/tt0133093/?ref_=nv_sr_1', { kind: 'imdb', id: 'tt0133093' }],
    ['tt0903747', { kind: 'imdb', id: 'tt0903747' }],
    ['https://www.themoviedb.org/movie/603-the-matrix', { kind: 'tmdb', mediaType: 'movie', id: 603 }],
    ['https://www.themoviedb.org/tv/1396-breaking-bad/season/1', { kind: 'tmdb', mediaType: 'tv', id: 1396 }],
    ['tvdb:81189', { kind: 'tvdb-id', id: 81189 }],
    ['https://thetvdb.com/series/breaking-bad', { kind: 'tvdb-slug', slug: 'breaking-bad' }],
    ['https://trakt.tv/movies/the-matrix-1999', { kind: 'trakt', mediaType: 'movie', slug: 'the-matrix-1999' }],
    ['https://trakt.tv/shows/severance', { kind: 'trakt', mediaType: 'tv', slug: 'severance' }],
    ['https://letterboxd.com/film/heat-1995/', { kind: 'letterboxd', url: 'https://letterboxd.com/film/heat-1995/' }],
    ['https://boxd.it/2bfI', { kind: 'letterboxd', url: 'https://boxd.it/2bfI' }],
    ['Heat (1995)', { kind: 'text', query: 'Heat', year: 1995 }],
    ['90s heist films', { kind: 'text', query: '90s heist films' }],
  ])('%s', (input, expected) => {
    expect(parseInput(input)).toEqual(expected);
  });
});

describe('list detection', () => {
  it('recognises list URLs', () => {
    expect(detectList('https://www.imdb.com/list/ls055592025/?sort=list_order')).toEqual({ kind: 'imdb', ref: 'https://www.imdb.com/list/ls055592025/' });
    expect(detectList('https://letterboxd.com/dave/list/official-top-250-narrative-feature-films')?.kind).toBe('letterboxd');
    expect(detectList('https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week/')).toEqual({
      kind: 'mdblist',
      ref: 'https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week',
    });
    expect(detectList('https://www.themoviedb.org/list/8136')).toEqual({ kind: 'tmdb', ref: '8136' });
    expect(detectList('https://www.imdb.com/title/tt0133093/')).toBeNull();
  });

  it('pulls IMDb ids in page order without duplicates', () => {
    expect(imdbIdsFromHtml('<a href="/title/tt0111161/">x</a><a href="/title/tt0068646/"><a href="/title/tt0111161/?ref">')).toEqual(['tt0111161', 'tt0068646']);
  });
});

describe('iCal', () => {
  it('writes all-day movie releases and timed episodes with CRLF', () => {
    const ics = toIcs([
      { id: 'm1-digital', date: '2026-10-20', allDay: true, mediaType: 'movie', kind: 'digital', title: 'Film, The', subtitle: 'Digital release', hasFile: false },
      { id: 'e2', date: '2026-10-21T02:00:00Z', allDay: false, mediaType: 'tv', kind: 'episode', title: 'Show', subtitle: 'S01E02', hasFile: true },
    ]);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261021');
    expect(ics).toContain('DTSTART:20261021T020000Z');
    expect(ics).toContain('SUMMARY:Film\\, The — Digital release');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});

describe('IMDb list ids', () => {
  it('maps charts and lists to the Radarr list service ids', () => {
    expect(imdbListId('https://www.imdb.com/chart/top/')).toBe('top250');
    expect(imdbListId('https://www.imdb.com/chart/moviemeter/')).toBe('popular');
    expect(imdbListId('https://www.imdb.com/list/ls055592025/')).toBe('ls055592025');
    expect(imdbListId('https://www.imdb.com/user/ur12345678/watchlist')).toBe('ur12345678');
  });
});
