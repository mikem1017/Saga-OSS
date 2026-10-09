import type { MediaType, TitleCard } from '../../shared/types.ts';
import type { Stack } from '../stack.ts';
import type { DiscoverService } from './discover.ts';
import { toCard } from './discover.ts';
import type { ResolveService } from './resolve.ts';
import type { StateService } from './state.ts';
import { cacheGet, cacheSet } from '../db.ts';
import { requestJson, requestText } from '../http.ts';

export type ListKind = 'imdb' | 'letterboxd' | 'mdblist' | 'tmdb' | 'trakt';

export interface ListRef {
  kind: ListKind;
  ref: string;
}

export interface ResolvedList {
  kind: ListKind;
  ref: string;
  name: string;
  total: number;
  have: number;
  unresolved: number;
  items: TitleCard[];
}

export const BUILTIN_LISTS: { kind: ListKind; ref: string; name: string }[] = [
  { kind: 'imdb', ref: 'https://www.imdb.com/chart/top/', name: 'IMDb Top 250 Movies' },
  { kind: 'imdb', ref: 'https://www.imdb.com/chart/moviemeter/', name: 'IMDb Most Popular Movies' },
];

/**
 * IMDb blocks scrapers (AWS WAF challenge, HTTP 202 with an empty body), so IMDb lists go through the same
 * service Radarr's IMDb import lists use. It returns TMDB ids directly, but covers films only.
 */
export function imdbListId(url: string): string | null {
  if (/chart\/top\b/.test(url)) return 'top250';
  if (/chart\/moviemeter/.test(url)) return 'popular';
  return url.match(/\b(ls\d+|ur\d+)\b/)?.[1] ?? null;
}

export function detectList(url: string): ListRef | null {
  const u = url.trim();
  if (/imdb\.com\/(list\/ls\d+|chart\/\w+|user\/ur\d+\/watchlist)/.test(u)) return { kind: 'imdb', ref: u.split('?')[0]! };
  if (/letterboxd\.com\/[^/]+\/(list\/[^/]+|watchlist)/.test(u)) return { kind: 'letterboxd', ref: u.split('?')[0]!.replace(/\/?$/, '/') };
  if (/mdblist\.com\/lists\/[^/]+\/[^/]+/.test(u)) return { kind: 'mdblist', ref: u.split('?')[0]!.replace(/\/$/, '') };
  if (/themoviedb\.org\/list\/\d+/.test(u)) return { kind: 'tmdb', ref: u.match(/list\/(\d+)/)![1]! };
  if (/trakt\.tv\/users\/[^/]+\/(lists\/[^/]+|watchlist)/.test(u)) return { kind: 'trakt', ref: u.split('?')[0]! };
  return null;
}

/** Every /title/ttNNN link in page order (for IMDb HTML pasted or fetched some other way). */
export function imdbIdsFromHtml(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/\/title\/(tt\d{6,10})/g)) {
    if (!seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push(m[1]!);
    }
  }
  return out;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

export class ListService {
  constructor(
    private readonly stack: Stack,
    private readonly discover: DiscoverService,
    private readonly resolver: ResolveService,
    private readonly state: StateService,
  ) {}

  async resolve(ref: ListRef): Promise<ResolvedList> {
    const key = `list:${ref.kind}:${ref.ref}`;
    let base = cacheGet<{ name: string; ids: { mediaType: MediaType; tmdbId: number }[]; unresolved: number }>(this.stack.db, key);
    if (!base) {
      base = await this.fetch(ref);
      cacheSet(this.stack.db, key, base, 3600_000);
    }
    const cards = await pool(base.ids, 8, async (id) => {
      const raw = await this.discover.tmdbGet<any>(`/${id.mediaType}/${id.tmdbId}`, {}, 30 * 86400_000).catch(() => null);
      return raw ? toCard(raw, id.mediaType) : null;
    });
    const items = this.state.decorate(cards.filter(Boolean) as Omit<TitleCard, 'state'>[]);
    const have = items.filter((i) => i.state.kind !== 'none' && i.state.kind !== 'requested').length;
    return { kind: ref.kind, ref: ref.ref, name: base.name, total: items.length, have, unresolved: base.unresolved, items };
  }

  private async fromImdbIds(ids: string[]): Promise<{ ids: { mediaType: MediaType; tmdbId: number }[]; unresolved: number }> {
    const found = await pool(ids.slice(0, 500), 8, async (id) => {
      const res = await this.discover.find(id, 'imdb_id').catch(() => null);
      if (res?.movie_results?.[0]) return { mediaType: 'movie' as const, tmdbId: res.movie_results[0].id as number };
      if (res?.tv_results?.[0]) return { mediaType: 'tv' as const, tmdbId: res.tv_results[0].id as number };
      return null;
    });
    const ok = found.filter(Boolean) as { mediaType: MediaType; tmdbId: number }[];
    return { ids: ok, unresolved: found.length - ok.length };
  }

  private async fetch(ref: ListRef): Promise<{ name: string; ids: { mediaType: MediaType; tmdbId: number }[]; unresolved: number }> {
    switch (ref.kind) {
      case 'imdb': {
        const id = imdbListId(ref.ref);
        if (!id) throw new Error('Unrecognised IMDb list URL');
        const rows = await requestJson<{ TmdbId?: number; ImdbId?: string; Title: string }[]>('IMDb list (via Radarr list service)', 'https://api.radarr.video', `/v1/list/imdb/${id}`, {
          timeoutMs: 30_000,
        });
        const ids = rows.filter((r) => r.TmdbId).map((r) => ({ mediaType: 'movie' as const, tmdbId: r.TmdbId! }));
        const extra = await this.fromImdbIds(rows.filter((r) => !r.TmdbId && r.ImdbId).map((r) => r.ImdbId!));
        const name = BUILTIN_LISTS.find((l) => l.ref === ref.ref)?.name ?? `IMDb list ${id}`;
        return { name, ids: [...ids, ...extra.ids], unresolved: extra.unresolved };
      }
      case 'mdblist': {
        const rows = await requestJson<{ id?: number; imdb_id?: string; mediatype: string; title: string }[]>('MDBList', ref.ref, '/json');
        const ids: { mediaType: MediaType; tmdbId: number }[] = [];
        const imdbOnly: string[] = [];
        for (const r of rows) {
          const mediaType: MediaType = r.mediatype === 'show' ? 'tv' : 'movie';
          if (r.id) ids.push({ mediaType, tmdbId: r.id });
          else if (r.imdb_id) imdbOnly.push(r.imdb_id);
        }
        const extra = await this.fromImdbIds(imdbOnly);
        return { name: ref.ref.split('/').pop()!.replace(/-/g, ' '), ids: [...ids, ...extra.ids], unresolved: extra.unresolved };
      }
      case 'tmdb': {
        const raw = await this.discover.tmdbGet<any>(`/list/${ref.ref}`, {}, 3600_000);
        const ids = (raw.items ?? []).filter((i: any) => i.media_type === 'movie' || i.media_type === 'tv').map((i: any) => ({ mediaType: i.media_type, tmdbId: i.id }));
        return { name: raw.name, ids, unresolved: 0 };
      }
      case 'letterboxd': {
        const slugs: string[] = [];
        let name = 'Letterboxd list';
        for (let page = 1; page <= 10; page++) {
          const html = await requestText('Letterboxd', page === 1 ? ref.ref : `${ref.ref}page/${page}/`);
          if (page === 1) name = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? name;
          const found = [...html.matchAll(/data-(?:film-slug|target-link)="\/?(?:film\/)?([a-z0-9-]+)\/?"/g)].map((m) => m[1]!);
          const fresh = found.filter((s) => !slugs.includes(s));
          slugs.push(...fresh);
          if (!fresh.length || !html.includes('class="next"')) break;
        }
        const resolved = await pool(slugs.slice(0, 400), 6, (slug) => this.resolver.letterboxdFilm(`https://letterboxd.com/film/${slug}/`).catch(() => undefined));
        const ids = resolved.filter(Boolean) as { mediaType: MediaType; tmdbId: number }[];
        return { name, ids, unresolved: slugs.length - ids.length };
      }
      case 'trakt': {
        const clientId = this.stack.config.TRAKT_CLIENT_ID;
        if (!clientId) throw new Error('Trakt lists need a Trakt API client id (TRAKT_CLIENT_ID in .env)');
        const m = ref.ref.match(/users\/([^/]+)\/(?:lists\/([^/]+)|watchlist)/)!;
        const path = m[2] ? `/users/${m[1]}/lists/${m[2]}/items` : `/users/${m[1]}/watchlist`;
        const rows = await requestJson<any[]>('Trakt', 'https://api.trakt.tv', path, { headers: { 'trakt-api-version': '2', 'trakt-api-key': clientId } });
        const ids = rows
          .map((r) => (r.movie?.ids?.tmdb ? { mediaType: 'movie' as const, tmdbId: r.movie.ids.tmdb } : r.show?.ids?.tmdb ? { mediaType: 'tv' as const, tmdbId: r.show.ids.tmdb } : null))
          .filter(Boolean) as { mediaType: MediaType; tmdbId: number }[];
        return { name: m[2]?.replace(/-/g, ' ') ?? `${m[1]}'s watchlist`, ids, unresolved: rows.length - ids.length };
      }
    }
  }

  saved() {
    const rows = this.stack.db.prepare('SELECT id, kind, ref, name FROM saved_lists ORDER BY created_at').all() as { id: number; kind: ListKind; ref: string; name: string }[];
    return [...BUILTIN_LISTS.map((l, i) => ({ id: -1 - i, builtin: true, ...l })), ...rows.map((r) => ({ ...r, builtin: false }))];
  }

  save(ref: ListRef, name: string) {
    this.stack.db.prepare('INSERT OR IGNORE INTO saved_lists (kind, ref, name, created_at) VALUES (?, ?, ?, ?)').run(ref.kind, ref.ref, name, Date.now());
  }

  remove(id: number) {
    this.stack.db.prepare('DELETE FROM saved_lists WHERE id = ?').run(id);
  }
}
