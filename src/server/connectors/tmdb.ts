import { cacheGet, cacheSet, type DB } from '../db.ts';
import { requestJson } from '../http.ts';

export const TMDB_IMG = 'https://image.tmdb.org/t/p';

/** TMDB v3 client with an SQLite-backed response cache (TMDB data changes slowly; trending is cached shortest). */
export class TmdbClient {
  readonly app = 'TMDB';
  constructor(
    private readonly apiKey: string,
    private readonly db: DB,
  ) {}

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, ttlMs = 6 * 3600_000): Promise<T> {
    const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''));
    const key = `tmdb:${path}?${new URLSearchParams(clean as Record<string, string>).toString()}`;
    const hit = cacheGet<T>(this.db, key);
    if (hit) return hit;
    // v4 read tokens are JWTs; v3 keys are 32 hex chars.
    const auth = this.apiKey.length > 40 ? { headers: { Authorization: `Bearer ${this.apiKey}` } } : { query: { api_key: this.apiKey } };
    const data = await requestJson<T>(this.app, 'https://api.themoviedb.org/3', path, {
      ...auth,
      query: { language: 'en-US', ...clean, ...('query' in auth ? auth.query : {}) },
      timeoutMs: 15_000,
    });
    cacheSet(this.db, key, data, ttlMs);
    return data;
  }

  configurationCheck() {
    return this.get<{ images: unknown }>('/configuration', {}, 60_000);
  }
}
