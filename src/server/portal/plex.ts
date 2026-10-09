import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { getSetting, setSetting } from '../db.ts';
import { requestJson } from '../http.ts';
import { log } from '../log.ts';

/** plex.tv sign-in (PIN flow) and the owner's friends list. The guest's Plex token is used once and never stored. */

export interface PlexAccount {
  id: number;
  uuid: string;
  username: string;
  email?: string;
  thumb?: string;
  title?: string;
}

export function plexClientId(db: DB): string {
  let id = getSetting<string | null>(db, 'portal.plexClientId', null);
  if (!id) {
    id = `saga-requests-${randomUUID()}`;
    setSetting(db, 'portal.plexClientId', id);
  }
  return id;
}

const headers = (clientId: string, token?: string): Record<string, string> => ({
  'X-Plex-Client-Identifier': clientId,
  'X-Plex-Product': 'Saga Requests',
  'X-Plex-Device-Name': 'Saga Requests',
  ...(token ? { 'X-Plex-Token': token } : {}),
});

export class PlexTv {
  constructor(
    private readonly clientId: string,
    /** The server owner's token (PLEX_TOKEN). Only used to read the friends list. */
    private readonly ownerToken?: string,
  ) {}

  async createPin(): Promise<{ id: number; code: string }> {
    return requestJson('plex.tv', 'https://plex.tv', '/api/v2/pins', { method: 'POST', query: { strong: 'true' }, headers: headers(this.clientId), timeoutMs: 10_000 });
  }

  authUrl(code: string, forwardUrl: string): string {
    const p = new URLSearchParams({ clientID: this.clientId, code, forwardUrl, 'context[device][product]': 'Saga Requests' });
    return `https://app.plex.tv/auth#?${p.toString()}`;
  }

  async pinToken(id: number): Promise<string | null> {
    const pin = await requestJson<{ authToken: string | null }>('plex.tv', 'https://plex.tv', `/api/v2/pins/${id}`, { headers: headers(this.clientId), timeoutMs: 10_000 });
    return pin.authToken || null;
  }

  account(token: string): Promise<PlexAccount> {
    return requestJson('plex.tv', 'https://plex.tv', '/api/v2/user', { headers: headers(this.clientId, token), timeoutMs: 10_000 });
  }

  private ownerCache: { at: number; id: number | null } | null = null;
  private friendsCache: { at: number; ids: Set<number> } | null = null;

  /** The server owner's Plex account id (from PLEX_TOKEN). Cached for an hour. */
  private async ownerId(): Promise<number | null> {
    if (!this.ownerToken) return null;
    if (!this.ownerCache || Date.now() - this.ownerCache.at > 3600_000) {
      const owner = await this.account(this.ownerToken).catch(() => null);
      if (owner) this.ownerCache = { at: Date.now(), id: owner.id };
      else return this.ownerCache?.id ?? null;
    }
    return this.ownerCache.id;
  }

  /**
   * Plex account ids of the owner's friends / shared users and Plex Home members. plex.tv retired /api/v2/friends
   * (HTTP 410, Oct 2026), so this reads the legacy XML /api/users plus /api/v2/home/users. Cached for 10 minutes.
   */
  private async friendIds(): Promise<Set<number>> {
    if (!this.ownerToken) return new Set();
    if (this.friendsCache && Date.now() - this.friendsCache.at < 10 * 60_000) return this.friendsCache.ids;
    const ids = new Set<number>();
    const h = headers(this.clientId, this.ownerToken);
    const [xml, home] = await Promise.all([
      fetch('https://plex.tv/api/users', { headers: { ...h, accept: 'application/xml' }, signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`plex.tv /api/users HTTP ${r.status}`))))
        .catch((e) => {
          log.warn(`plex friends list: ${e instanceof Error ? e.message : e}`);
          return '';
        }),
      requestJson<{ users?: { id: number }[] }>('plex.tv', 'https://plex.tv', '/api/v2/home/users', { headers: h, timeoutMs: 10_000 }).catch(() => ({ users: [] })),
    ]);
    for (const m of xml.matchAll(/<User\s[^>]*?\bid="(\d+)"/g)) ids.add(Number(m[1]));
    for (const u of home.users ?? []) ids.add(u.id);
    if (xml) this.friendsCache = { at: Date.now(), ids };
    return ids;
  }

  /** How this Plex account relates to the server owner. Each check fails closed on its own. */
  async relation(acct: PlexAccount): Promise<{ owner: boolean; friend: boolean }> {
    const [ownerId, friends] = await Promise.all([this.ownerId(), this.friendIds()]);
    return { owner: ownerId !== null && ownerId === acct.id, friend: friends.has(acct.id) };
  }

  async isFriendOrOwner(acct: PlexAccount): Promise<boolean> {
    const r = await this.relation(acct);
    return r.owner || r.friend;
  }
}
