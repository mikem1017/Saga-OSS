import { requestJson } from '../http.ts';

export interface SeerrRequest {
  id: number;
  status: number; // 1 pending, 2 approved, 3 declined, 4 failed, 5 completed
  createdAt: string;
  type: 'movie' | 'tv';
  is4k: boolean;
  media: { tmdbId: number; tvdbId?: number; status: number; mediaType: 'movie' | 'tv' };
  requestedBy: { id: number; displayName?: string; email?: string; plexUsername?: string; username?: string };
  seasons?: { seasonNumber: number }[];
}

export interface SeerrUser {
  id: number;
  email?: string;
  plexUsername?: string;
  username?: string;
  displayName?: string;
  plexId?: number;
  avatar?: string;
  permissions?: number;
  userType?: number;
}

/** Read-only Seerr client. Used for the "requested" badge now and for migration in phase 5. */
export class SeerrClient {
  readonly app = 'Seerr';
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private get<T>(path: string, query: Record<string, string | number> = {}) {
    return requestJson<T>(this.app, this.baseUrl, `/api/v1${path}`, { query, headers: { 'X-Api-Key': this.apiKey } });
  }

  status() {
    return this.get<{ version: string }>('/status');
  }

  async users(): Promise<SeerrUser[]> {
    const out: SeerrUser[] = [];
    for (let skip = 0; skip < 5000; skip += 100) {
      const res = await this.get<{ results: SeerrUser[] }>('/user', { take: 100, skip });
      out.push(...res.results);
      if (res.results.length < 100) break;
    }
    return out;
  }

  async allRequests(): Promise<SeerrRequest[]> {
    const out: SeerrRequest[] = [];
    for (let skip = 0; skip < 5000; skip += 100) {
      const res = await this.get<{ pageInfo: { results: number }; results: SeerrRequest[] }>('/request', { take: 100, skip, filter: 'all', sort: 'added' });
      out.push(...res.results);
      if (res.results.length < 100) break;
    }
    return out;
  }
}
