import type { MediaType, Page, TitleCard } from '../../shared/types.ts';
import type { Stack } from '../stack.ts';
import type { DiscoverService } from './discover.ts';
import { cacheGet, cacheSet } from '../db.ts';
import { requestText, requestJson } from '../http.ts';

export interface ResolveResult {
  /** Exact hit for a pasted link or id. */
  match?: { mediaType: MediaType; tmdbId: number };
  source: string;
  results: Page<TitleCard>;
}

const empty: Page<TitleCard> = { page: 1, totalPages: 1, totalResults: 0, results: [] };

/** Pure parser, separated so it can be tested without the network. */
export function parseInput(input: string):
  | { kind: 'imdb'; id: string }
  | { kind: 'tmdb'; mediaType: MediaType; id: number }
  | { kind: 'tvdb-id'; id: number }
  | { kind: 'tvdb-slug'; slug: string }
  | { kind: 'trakt'; mediaType: MediaType; slug: string }
  | { kind: 'letterboxd'; url: string }
  | { kind: 'text'; query: string; year?: number } {
  const s = input.trim();
  const imdb = s.match(/\b(tt\d{6,10})\b/);
  if (imdb) return { kind: 'imdb', id: imdb[1]! };
  const tmdb = s.match(/themoviedb\.org\/(movie|tv)\/(\d+)/) ?? s.match(/^tmdb:(movie|tv):(\d+)$/i);
  if (tmdb) return { kind: 'tmdb', mediaType: tmdb[1] as MediaType, id: Number(tmdb[2]) };
  const tvdbId = s.match(/thetvdb\.com\/.*[?&]id=(\d+)/) ?? s.match(/^tvdb:(\d+)$/i);
  if (tvdbId) return { kind: 'tvdb-id', id: Number(tvdbId[1]) };
  const tvdbSlug = s.match(/thetvdb\.com\/series\/([a-z0-9-]+)/i);
  if (tvdbSlug) return { kind: 'tvdb-slug', slug: tvdbSlug[1]! };
  const trakt = s.match(/trakt\.tv\/(movies|shows)\/([a-z0-9-]+)/i);
  if (trakt) return { kind: 'trakt', mediaType: trakt[1] === 'movies' ? 'movie' : 'tv', slug: trakt[2]! };
  if (/letterboxd\.com\/(?:[^/]+\/)?film\/|boxd\.it\//i.test(s)) return { kind: 'letterboxd', url: s.startsWith('http') ? s : `https://${s}` };
  const yearMatch = s.match(/^(.*?)[\s(]+((?:19|20)\d{2})\)?$/);
  if (yearMatch && yearMatch[1]!.trim()) return { kind: 'text', query: yearMatch[1]!.trim(), year: Number(yearMatch[2]) };
  return { kind: 'text', query: s };
}

export class ResolveService {
  constructor(
    private readonly stack: Stack,
    private readonly discover: DiscoverService,
  ) {}

  async resolve(input: string, page = 1): Promise<ResolveResult> {
    const p = parseInput(input);
    switch (p.kind) {
      case 'imdb':
        return this.fromFind(p.id, 'imdb_id', 'IMDb');
      case 'tmdb':
        return { match: { mediaType: p.mediaType, tmdbId: p.id }, source: 'TMDB', results: empty };
      case 'tvdb-id':
        return this.fromFind(String(p.id), 'tvdb_id', 'TVDB');
      case 'tvdb-slug': {
        const sonarr = this.stack.sonarr;
        if (sonarr) {
          const hits = await sonarr.lookup(p.slug.replace(/-/g, ' '));
          const hit = hits.find((h: any) => h.titleSlug === p.slug) ?? hits[0];
          if (hit?.tvdbId) return this.fromFind(String(hit.tvdbId), 'tvdb_id', 'TVDB');
        }
        return { source: 'TVDB (title search)', results: await this.discover.search(p.slug.replace(/-/g, ' ')) };
      }
      case 'trakt':
        return this.fromTrakt(p.mediaType, p.slug);
      case 'letterboxd': {
        const id = await this.letterboxdFilm(p.url);
        if (id) return { match: id, source: 'Letterboxd', results: empty };
        return { source: 'Letterboxd', results: empty };
      }
      case 'text': {
        const results = await this.discover.search(p.query, page);
        if (p.year) results.results.sort((a, b) => Number(b.year === p.year) - Number(a.year === p.year));
        return { source: 'search', results };
      }
    }
  }

  private async fromFind(id: string, source: 'imdb_id' | 'tvdb_id', label: string): Promise<ResolveResult> {
    const res = await this.discover.find(id, source);
    const movie = res.movie_results?.[0];
    const tv = res.tv_results?.[0];
    if (movie) return { match: { mediaType: 'movie', tmdbId: movie.id }, source: label, results: empty };
    if (tv) return { match: { mediaType: 'tv', tmdbId: tv.id }, source: label, results: empty };
    return { source: `${label} (not found on TMDB)`, results: empty };
  }

  private async fromTrakt(mediaType: MediaType, slug: string): Promise<ResolveResult> {
    const clientId = this.stack.config.TRAKT_CLIENT_ID;
    if (clientId) {
      const res = await requestJson<{ ids: { tmdb?: number } }>('Trakt', 'https://api.trakt.tv', `/${mediaType === 'movie' ? 'movies' : 'shows'}/${slug}`, {
        headers: { 'trakt-api-version': '2', 'trakt-api-key': clientId },
      });
      if (res.ids.tmdb) return { match: { mediaType, tmdbId: res.ids.tmdb }, source: 'Trakt', results: empty };
    }
    // Without a Trakt key, the slug is "title-year".
    const m = slug.match(/^(.*?)-((?:19|20)\d{2})$/);
    const query = (m ? m[1]! : slug).replace(/-/g, ' ');
    const results = await this.discover.search(query);
    results.results = results.results.filter((r) => r.mediaType === mediaType);
    if (m) results.results.sort((a, b) => Number(b.year === Number(m[2])) - Number(a.year === Number(m[2])));
    const top = results.results[0];
    if (top && m && top.year === Number(m[2])) return { match: { mediaType, tmdbId: top.tmdbId }, source: 'Trakt (by title + year)', results };
    return { source: 'Trakt (title search)', results };
  }

  /** Letterboxd film pages carry the TMDB id in the body tag. Cached for a year. */
  async letterboxdFilm(url: string): Promise<{ mediaType: MediaType; tmdbId: number } | undefined> {
    const key = `lb:${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
    const hit = cacheGet<{ mediaType: MediaType; tmdbId: number } | null>(this.stack.db, key);
    if (hit !== undefined) return hit ?? undefined;
    const html = await requestText('Letterboxd', url);
    const id = html.match(/data-tmdb-id="(\d+)"/)?.[1];
    const type = html.match(/data-tmdb-type="(movie|tv)"/)?.[1] as MediaType | undefined;
    const out = id ? { mediaType: type ?? 'movie', tmdbId: Number(id) } : null;
    cacheSet(this.stack.db, key, out, 365 * 86400_000);
    return out ?? undefined;
  }
}
