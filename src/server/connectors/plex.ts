import { requestJson, UpstreamError } from '../http.ts';

export class PlexClient {
  readonly app = 'Plex';
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private get<T>(path: string, query: Record<string, string | number> = {}) {
    return requestJson<T>(this.app, this.baseUrl, path, { query, headers: { 'X-Plex-Token': this.token } });
  }

  identity() {
    return this.get<{ MediaContainer: { machineIdentifier: string; version: string } }>('/identity');
  }

  /** Server-side check of the token: /library/sections needs auth even on the LAN allowlist when called with a bad token. */
  async sections() {
    const res = await this.get<{ MediaContainer: { Directory?: { key: string; title: string; type: string }[] } }>('/library/sections');
    return res.MediaContainer.Directory ?? [];
  }

  /** plex.tv validity of the account token (catches the stale-token failure Seerr hit). */
  async accountTokenValid(): Promise<{ valid: boolean; username?: string; detail?: string }> {
    try {
      const res = await requestJson<{ username?: string; title?: string }>('plex.tv', 'https://plex.tv', '/api/v2/user', {
        headers: { 'X-Plex-Token': this.token, 'X-Plex-Client-Identifier': 'saga-media-hub', 'X-Plex-Product': 'Saga' },
        timeoutMs: 10_000,
      });
      return { valid: true, username: res.username ?? res.title };
    } catch (err) {
      if (err instanceof UpstreamError && err.authFailed) return { valid: false, detail: 'plex.tv rejected the token (expired or revoked)' };
      return { valid: true, detail: `plex.tv unreachable, token not verified (${err instanceof Error ? err.message : err})` };
    }
  }

  async recentlyAdded(limit = 30) {
    const res = await this.get<{ MediaContainer: { Metadata?: any[] } }>('/library/recentlyAdded', {
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': limit,
    });
    return res.MediaContainer.Metadata ?? [];
  }

  /** Deep link into Plex Web for a rating key. */
  webUrl(machineId: string, ratingKey: string) {
    return `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
  }

  /** Find a library item by TMDB/TVDB guid. */
  async findByGuid(guid: string): Promise<{ ratingKey: string; title: string } | undefined> {
    for (const type of [1, 2]) {
      const res = await this.get<{ MediaContainer: { Metadata?: { ratingKey: string; title: string }[] } }>('/library/all', { type, guid });
      const hit = res.MediaContainer.Metadata?.[0];
      if (hit) return hit;
    }
    return undefined;
  }
}
