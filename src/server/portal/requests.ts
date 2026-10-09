import type { DB } from '../db.ts';
import type { LibraryState, MediaType } from '../../shared/types.ts';
import type { Notifier } from './notify.ts';
import type { Guest } from './guests.ts';
import { getGuest } from './guests.ts';
import { portalSettings } from './settings.ts';
import { audit } from '../services/audit.ts';

export const GB = 1024 ** 3;

export interface TitleInfo {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  certification?: string;
  genres: string[];
  /** Regular seasons (season 0 = specials is excluded). */
  seasons: { seasonNumber: number; episodeCount: number; airDate?: string | null }[];
}

export interface Coverage {
  /** Title is in Radarr/Sonarr at all. */
  inLibrary: boolean;
  /** Movie has a file. */
  available: boolean;
  /** TV: seasons monitored in Sonarr (they'll arrive without a request). */
  seasonsMonitored: number[];
  /** TV: seasons whose aired episodes are all on disk. */
  seasonsComplete: number[];
}

/** Everything the request logic needs from the rest of Saga, injected so it can be tested without the *arrs. */
export interface RequestDeps {
  db: DB;
  notifier: Notifier;
  titleInfo(type: MediaType, tmdbId: number): Promise<TitleInfo>;
  /** Estimated download size for the title (TV: just these seasons), using the same estimates as admin adds. */
  estimate(type: MediaType, tmdbId: number, seasons: number[] | null): Promise<number>;
  /** Adds to Radarr/Sonarr with the normal add rules. */
  addToArr(type: MediaType, tmdbId: number, seasons: number[] | null, actor: string): Promise<{ ok: boolean; message: string; arrId?: number }>;
  state(type: MediaType, tmdbId: number): LibraryState;
  coverage(type: MediaType, tmdbId: number): Coverage;
}

export type RequestStatus = 'pending' | 'approved' | 'declined' | 'failed' | 'available';

export interface RequestRow {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  seasons: number[] | null;
  status: RequestStatus;
  estBytes: number;
  declineReason: string | null;
  lastError: string | null;
  source: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  availableAt: number | null;
}

export const rowToRequest = (r: any): RequestRow => ({
  id: r.id,
  mediaType: r.media_type,
  tmdbId: r.tmdb_id,
  title: r.title,
  year: r.year,
  posterPath: r.poster_path,
  seasons: r.seasons ? JSON.parse(r.seasons) : null,
  status: r.status,
  estBytes: r.est_bytes,
  declineReason: r.decline_reason,
  lastError: r.last_error,
  source: r.source,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  availableAt: r.available_at,
});

/** What a guest may see of a title's library state: no requester names, no file paths, no quality internals. */
export type GuestState =
  | { kind: 'available' }
  | { kind: 'downloading'; percent: number; etaSec: number | null }
  | { kind: 'queued'; position: number; etaSec: number | null }
  | { kind: 'coming' }
  | { kind: 'requested' }
  | { kind: 'none' };

export function guestState(s: LibraryState): GuestState {
  switch (s.kind) {
    case 'available':
      return { kind: 'available' };
    case 'downloading':
      return { kind: 'downloading', percent: s.percent, etaSec: s.etaSec };
    case 'queued':
      return { kind: 'queued', position: s.position, etaSec: s.etaSec };
    case 'importing':
      return { kind: 'coming' };
    case 'missing':
      return s.monitored ? { kind: 'coming' } : { kind: 'none' };
    case 'requested':
      return { kind: 'requested' };
    default:
      return { kind: 'none' };
  }
}

export type Step = 'requested' | 'declined' | 'approved' | 'searching' | 'queued' | 'downloading' | 'importing' | 'available' | 'problem';

export interface GuestRequestView {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  seasons: number[] | null;
  status: RequestStatus;
  step: Step;
  stepDetail: string;
  percent?: number;
  etaSec?: number | null;
  position?: number;
  declineReason?: string | null;
  createdAt: number;
  availableAt: number | null;
  plexUrl?: string;
}

export function plexSearchUrl(title: string): string {
  return `https://app.plex.tv/desktop/#!/search?pivot=top&query=${encodeURIComponent(title)}`;
}

export function stepFor(r: RequestRow, s: LibraryState): Pick<GuestRequestView, 'step' | 'stepDetail' | 'percent' | 'etaSec' | 'position'> {
  if (r.status === 'available' || (r.status === 'approved' && s.kind === 'available' && r.mediaType === 'movie')) return { step: 'available', stepDetail: 'Ready to watch in Plex' };
  if (r.status === 'pending') return { step: 'requested', stepDetail: 'Waiting for approval' };
  if (r.status === 'declined') return { step: 'declined', stepDetail: r.declineReason ? `Declined: ${r.declineReason}` : 'Declined' };
  if (r.status === 'failed') return { step: 'approved', stepDetail: 'Approved; there was a snag adding it and the admin has been told' };
  switch (s.kind) {
    case 'downloading':
      return { step: 'downloading', stepDetail: `Downloading ${Math.round(s.percent)}%`, percent: s.percent, etaSec: s.etaSec, position: s.position };
    case 'queued':
      return { step: 'queued', stepDetail: `In the download queue at #${s.position}`, etaSec: s.etaSec, position: s.position };
    case 'importing':
      return { step: 'importing', stepDetail: 'Downloaded; being unpacked and added to Plex' };
    case 'missing':
      return { step: 'searching', stepDetail: 'Approved; looking for a good copy' };
    case 'available':
      return { step: 'downloading', stepDetail: 'Some episodes are ready; the rest are on their way' };
    default:
      return { step: 'approved', stepDetail: 'Approved' };
  }
}

export interface Usage {
  moviesWeek: number;
  seasonsWeek: number;
  bytesMonth: number;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code: 'already' | 'quota' | 'rating' | 'invalid' | 'state',
  ) {
    super(message);
  }
}

export type CreateResult = { request: GuestRequestView; outcome: 'created' | 'merged' | 'auto-approved' | 'already-coming' };

const OPEN = "('pending','approved','failed')";

export class RequestService {
  constructor(private readonly d: RequestDeps) {}

  private get db() {
    return this.d.db;
  }

  get(id: number): RequestRow | null {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    return r ? rowToRequest(r) : null;
  }

  private openFor(type: MediaType, tmdbId: number): RequestRow[] {
    return (this.db.prepare(`SELECT * FROM requests WHERE media_type = ? AND tmdb_id = ? AND status IN ${OPEN} ORDER BY id`).all(type, tmdbId) as any[]).map(rowToRequest);
  }

  usage(guestId: number): Usage {
    const now = Date.now();
    const week = this.db
      .prepare(`SELECT COALESCE(SUM(rr.movies_count),0) AS m, COALESCE(SUM(rr.seasons_count),0) AS s FROM request_requesters rr JOIN requests r ON r.id = rr.request_id WHERE rr.guest_id = ? AND rr.created_at > ? AND r.status NOT IN ('declined')`)
      .get(guestId, now - 7 * 86400_000) as { m: number; s: number };
    const month = this.db
      .prepare(`SELECT COALESCE(SUM(rr.bytes),0) AS b FROM request_requesters rr JOIN requests r ON r.id = rr.request_id WHERE rr.guest_id = ? AND rr.created_at > ? AND r.status NOT IN ('declined')`)
      .get(guestId, now - 30 * 86400_000) as { b: number };
    return { moviesWeek: week.m, seasonsWeek: week.s, bytesMonth: month.b };
  }

  /** When the oldest charge in a window expires (for "your next request frees up on …"). */
  private nextFree(guestId: number, windowMs: number, column: 'movies_count' | 'seasons_count' | 'bytes'): number | null {
    const r = this.db
      .prepare(`SELECT MIN(rr.created_at) AS t FROM request_requesters rr JOIN requests r ON r.id = rr.request_id WHERE rr.guest_id = ? AND rr.created_at > ? AND rr.${column} > 0 AND r.status != 'declined'`)
      .get(guestId, Date.now() - windowMs) as { t: number | null };
    return r.t ? r.t + windowMs : null;
  }

  checkQuota(guest: Guest, charge: { movies: number; seasons: number; bytes: number }): void {
    if (guest.unlimited) return;
    const u = this.usage(guest.id);
    const when = (t: number | null) => (t ? ` It frees up ${new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}.` : '');
    if (charge.movies && u.moviesWeek + charge.movies > guest.limits.moviesPerWeek)
      throw new RequestError(`You've used your ${guest.limits.moviesPerWeek} film requests for this week.${when(this.nextFree(guest.id, 7 * 86400_000, 'movies_count'))}`, 'quota');
    if (charge.seasons && u.seasonsWeek + charge.seasons > guest.limits.seasonsPerWeek)
      throw new RequestError(
        `That's ${charge.seasons} season(s); you have ${Math.max(0, guest.limits.seasonsPerWeek - u.seasonsWeek)} of ${guest.limits.seasonsPerWeek} left this week. Try fewer seasons.${when(this.nextFree(guest.id, 7 * 86400_000, 'seasons_count'))}`,
        'quota',
      );
    if (charge.bytes && u.bytesMonth + charge.bytes > guest.limits.gbPerMonth * GB)
      throw new RequestError(
        `That's about ${Math.round(charge.bytes / GB)} GB and you have ${Math.max(0, Math.round(guest.limits.gbPerMonth - u.bytesMonth / GB))} GB of your ${guest.limits.gbPerMonth} GB left this month.${when(this.nextFree(guest.id, 30 * 86400_000, 'bytes'))}`,
        'quota',
      );
  }

  private addRequester(requestId: number, guestId: number, charge: { movies: number; seasons: number; bytes: number }) {
    this.db
      .prepare(
        `INSERT INTO request_requesters (request_id, guest_id, created_at, movies_count, seasons_count, bytes) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id, guest_id) DO UPDATE SET movies_count = movies_count + excluded.movies_count, seasons_count = seasons_count + excluded.seasons_count, bytes = bytes + excluded.bytes`,
      )
      .run(requestId, guestId, Date.now(), charge.movies, charge.seasons, charge.bytes);
  }

  private insertRequest(info: TitleInfo, seasons: number[] | null, status: RequestStatus, estBytes: number, source: string, decidedBy: string | null): number {
    const res = this.db
      .prepare(
        'INSERT INTO requests (media_type, tmdb_id, title, year, poster_path, seasons, status, est_bytes, source, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(info.mediaType, info.tmdbId, info.title, info.year ?? null, info.posterPath ?? null, seasons ? JSON.stringify(seasons) : null, status, estBytes, source, Date.now(), decidedBy ? Date.now() : null, decidedBy);
    return Number(res.lastInsertRowid);
  }

  ratingAllowed(guest: Guest, info: TitleInfo): boolean {
    if (!guest.ratingCap) return true;
    return !!info.certification && guest.ratingCap.includes(info.certification);
  }

  /**
   * A guest asks for a title. Already in Plex → refused. Already coming (monitored in the *arr, or another open
   * request) → the guest is attached at no cost and told when it lands. Otherwise limits are checked server-side,
   * the request is created, and it's approved automatically when it's under the guest's auto-approve size.
   */
  async create(guest: Guest, input: { mediaType: MediaType; tmdbId: number; seasons?: number[] | null }, source = 'portal'): Promise<CreateResult> {
    if (!guest.enabled) throw new RequestError('Your access is turned off.', 'state');
    const info = await this.d.titleInfo(input.mediaType, input.tmdbId);
    if (!this.ratingAllowed(guest, info)) throw new RequestError(`That title is rated ${info.certification ?? 'unrated'}, which isn't available on this profile.`, 'rating');
    const cov = this.d.coverage(input.mediaType, input.tmdbId);
    const open = this.openFor(input.mediaType, input.tmdbId);
    const free = { movies: 0, seasons: 0, bytes: 0 };

    if (input.mediaType === 'movie') {
      if (cov.available) throw new RequestError(`${info.title} is already in Plex.`, 'already');
      if (open[0]) {
        this.addRequester(open[0].id, guest.id, free);
        return { request: this.viewFor(open[0].id), outcome: 'merged' };
      }
      if (cov.inLibrary) {
        const id = this.insertRequest(info, null, 'approved', 0, source, 'library');
        this.addRequester(id, guest.id, free);
        return { request: this.viewFor(id), outcome: 'already-coming' };
      }
      const est = await this.d.estimate('movie', info.tmdbId, null);
      const charge = { movies: 1, seasons: 0, bytes: est };
      this.checkQuota(guest, charge);
      const id = this.insertRequest(info, null, 'pending', est, source, null);
      this.addRequester(id, guest.id, charge);
      return this.afterCreate(guest, id, est);
    }

    // TV: work in seasons.
    const regular = info.seasons.filter((s) => s.seasonNumber > 0 && s.episodeCount > 0).map((s) => s.seasonNumber);
    const wanted = [...new Set((input.seasons?.length ? input.seasons : regular).filter((n) => regular.includes(n)))].sort((a, b) => a - b);
    if (!wanted.length) throw new RequestError('Pick at least one season that has episodes.', 'invalid');
    if (wanted.every((n) => cov.seasonsComplete.includes(n))) throw new RequestError(`${info.title} (those seasons) is already in Plex.`, 'already');
    const coveredByOpen = new Set(open.flatMap((r) => r.seasons ?? []));
    const covered = new Set([...coveredByOpen, ...cov.seasonsMonitored, ...cov.seasonsComplete]);
    const extra = wanted.filter((n) => !covered.has(n));
    if (!extra.length) {
      const overlapping = open.filter((r) => (r.seasons ?? []).some((n) => wanted.includes(n)));
      for (const r of overlapping) this.addRequester(r.id, guest.id, free);
      if (overlapping.length) return { request: this.viewFor(overlapping[0]!.id), outcome: 'merged' };
      const id = this.insertRequest(info, wanted, 'approved', 0, source, 'library');
      this.addRequester(id, guest.id, free);
      return { request: this.viewFor(id), outcome: 'already-coming' };
    }
    const est = await this.d.estimate('tv', info.tmdbId, extra);
    const charge = { movies: 0, seasons: extra.length, bytes: est };
    this.checkQuota(guest, charge);
    const pending = open.find((r) => r.status === 'pending');
    if (pending) {
      const seasons = [...new Set([...(pending.seasons ?? []), ...extra])].sort((a, b) => a - b);
      this.db.prepare('UPDATE requests SET seasons = ?, est_bytes = est_bytes + ? WHERE id = ?').run(JSON.stringify(seasons), est, pending.id);
      this.addRequester(pending.id, guest.id, charge);
      return { request: this.viewFor(pending.id), outcome: 'merged' };
    }
    const id = this.insertRequest(info, extra, 'pending', est, source, null);
    this.addRequester(id, guest.id, charge);
    return this.afterCreate(guest, id, est);
  }

  private async afterCreate(guest: Guest, id: number, est: number): Promise<CreateResult> {
    const r = this.get(id)!;
    audit(this.db, `guest:${guest.username}`, 'request.create', `${r.title}${r.year ? ` (${r.year})` : ''}`, `${r.mediaType}${r.seasons ? ` seasons ${r.seasons.join(',')}` : ''}; ~${Math.round(est / GB)} GB`);
    if (guest.unlimited || guest.autoApproveAll || (guest.limits.autoApproveGb > 0 && est <= guest.limits.autoApproveGb * GB)) {
      await this.approve(id, guest.unlimited ? 'auto (unlimited guest)' : guest.autoApproveAll ? 'auto (guest set to auto-approve)' : `auto (under ${guest.limits.autoApproveGb} GB)`);
      return { request: this.viewFor(id), outcome: 'auto-approved' };
    }
    await this.d.notifier.toAdmin({ kind: 'request.new', title: `New request: ${r.title}`, body: `${guest.username} asked for ${r.title}${r.seasons ? ` (S${r.seasons.join(', S')})` : ''}, about ${Math.round(est / GB)} GB.`, url: '/requests' });
    return { request: this.viewFor(id), outcome: 'created' };
  }

  requesterIds(requestId: number): number[] {
    return (this.db.prepare('SELECT guest_id FROM request_requesters WHERE request_id = ?').all(requestId) as { guest_id: number }[]).map((r) => r.guest_id);
  }

  private async notifyRequesters(requestId: number, m: { kind: string; title: string; body?: string }) {
    for (const g of this.requesterIds(requestId)) await this.d.notifier.toGuest(g, { ...m, url: '/requests' });
  }

  /**
   * Approve requests still waiting from guests who are Unlimited or set to auto-approve (e.g. requests made
   * before the switch was turned on). Runs when a guest is edited and once at startup.
   */
  async approvePendingForTrusted(guestId?: number): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.id, g.unlimited FROM requests r
           JOIN request_requesters rr ON rr.request_id = r.id
           JOIN guests g ON g.id = rr.guest_id
          WHERE r.status = 'pending' AND g.enabled = 1 AND (g.unlimited = 1 OR g.auto_approve_all = 1)${guestId ? ' AND g.id = ?' : ''}`,
      )
      .all(...(guestId ? [guestId] : [])) as { id: number; unlimited: number }[];
    let n = 0;
    for (const row of rows) {
      try {
        await this.approve(row.id, row.unlimited ? 'auto (unlimited guest)' : 'auto (guest set to auto-approve)');
        n++;
      } catch {
        /* already decided, or the add failed (recorded on the request) */
      }
    }
    return n;
  }

  async approve(id: number, actor: string): Promise<RequestRow> {
    const r = this.get(id);
    if (!r) throw new RequestError('No such request', 'invalid');
    if (r.status !== 'pending' && r.status !== 'failed') throw new RequestError(`Request is already ${r.status}`, 'state');
    const res = await this.d.addToArr(r.mediaType, r.tmdbId, r.seasons, `requests:${actor}`);
    if (!res.ok) {
      this.db.prepare("UPDATE requests SET status = 'failed', last_error = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(res.message, Date.now(), actor, id);
      audit(this.db, actor, 'request.approve', r.title, `failed: ${res.message}`, false);
      throw new RequestError(`Couldn't add it: ${res.message}`, 'state');
    }
    this.db.prepare("UPDATE requests SET status = 'approved', arr_id = ?, last_error = NULL, decided_at = ?, decided_by = ? WHERE id = ?").run(res.arrId ?? null, Date.now(), actor, id);
    audit(this.db, actor, 'request.approve', r.title, res.message);
    await this.notifyRequesters(id, { kind: 'request.approved', title: `Approved: ${r.title}`, body: "It's been added. You'll get another message when it's ready to watch." });
    return this.get(id)!;
  }

  async decline(id: number, reason: string | null, actor: string): Promise<RequestRow> {
    const r = this.get(id);
    if (!r) throw new RequestError('No such request', 'invalid');
    if (r.status !== 'pending' && r.status !== 'failed') throw new RequestError(`Request is already ${r.status}`, 'state');
    this.db.prepare("UPDATE requests SET status = 'declined', decline_reason = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(reason, Date.now(), actor, id);
    audit(this.db, actor, 'request.decline', r.title, reason);
    await this.notifyRequesters(id, { kind: 'request.declined', title: `Not this time: ${r.title}`, body: reason ? `Reason: ${reason}` : undefined });
    return this.get(id)!;
  }

  /** Approved requests whose files have all landed become available, and their requesters hear about it. */
  async checkAvailability(): Promise<number> {
    const rows = (this.db.prepare("SELECT * FROM requests WHERE status = 'approved'").all() as any[]).map(rowToRequest);
    let n = 0;
    for (const r of rows) {
      const cov = this.d.coverage(r.mediaType, r.tmdbId);
      const done = r.mediaType === 'movie' ? cov.available : !!r.seasons?.length && r.seasons.every((s) => cov.seasonsComplete.includes(s));
      if (!done) continue;
      this.db.prepare("UPDATE requests SET status = 'available', available_at = ? WHERE id = ?").run(Date.now(), r.id);
      n++;
      await this.notifyRequesters(r.id, { kind: 'request.available', title: `Ready to watch: ${r.title}`, body: `${r.title}${r.seasons ? ` (season ${r.seasons.join(', ')})` : ''} is in Plex now.` });
    }
    return n;
  }

  viewFor(id: number): GuestRequestView {
    const r = this.get(id)!;
    return this.view(r);
  }

  view(r: RequestRow): GuestRequestView {
    const s = this.d.state(r.mediaType, r.tmdbId);
    const step = stepFor(r, s);
    return {
      id: r.id,
      mediaType: r.mediaType,
      tmdbId: r.tmdbId,
      title: r.title,
      year: r.year,
      posterPath: r.posterPath,
      seasons: r.seasons,
      status: r.status,
      ...step,
      declineReason: r.status === 'declined' ? r.declineReason : undefined,
      createdAt: r.createdAt,
      availableAt: r.availableAt,
      plexUrl: step.step === 'available' ? plexSearchUrl(r.title) : undefined,
    };
  }

  /** A guest's own requests only. */
  forGuest(guestId: number): GuestRequestView[] {
    const rows = (
      this.db
        .prepare('SELECT r.* FROM requests r JOIN request_requesters rr ON rr.request_id = r.id WHERE rr.guest_id = ? ORDER BY r.created_at DESC LIMIT 300')
        .all(guestId) as any[]
    ).map(rowToRequest);
    return rows.map((r) => this.view(r));
  }

  /** The guest's request for a title, if any (title pages show it). */
  guestRequestFor(guestId: number, type: MediaType, tmdbId: number): GuestRequestView | null {
    const r = this.db
      .prepare('SELECT r.* FROM requests r JOIN request_requesters rr ON rr.request_id = r.id WHERE rr.guest_id = ? AND r.media_type = ? AND r.tmdb_id = ? ORDER BY r.id DESC LIMIT 1')
      .get(guestId, type, tmdbId);
    return r ? this.view(rowToRequest(r)) : null;
  }

  /**
   * Admin listing, with requester names. `by` filters to one guest's requests (a merged request matches any
   * of its requesters), or 'none' for requests with no guest attached (Seerr imports, the owner's own).
   */
  adminList(status?: string, by?: number | 'none', limit = 300) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (status) {
      where.push('r.status = ?');
      args.push(status);
    }
    if (by === 'none') where.push('NOT EXISTS (SELECT 1 FROM request_requesters rr WHERE rr.request_id = r.id)');
    else if (by !== undefined) {
      where.push('EXISTS (SELECT 1 FROM request_requesters rr WHERE rr.request_id = r.id AND rr.guest_id = ?)');
      args.push(by);
    }
    const rows = this.db
      .prepare(`SELECT r.* FROM requests r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT ?`)
      .all(...args, limit) as any[];
    return rows.map((raw) => {
      const r = rowToRequest(raw);
      const requesters = this.db
        .prepare('SELECT g.id, g.username FROM request_requesters rr JOIN guests g ON g.id = rr.guest_id WHERE rr.request_id = ? ORDER BY rr.created_at')
        .all(r.id) as { id: number; username: string }[];
      return { ...r, requesters, state: this.d.state(r.mediaType, r.tmdbId) };
    });
  }

  /** Everyone who has requested something, with per-status counts, for the admin "Requested by" filter. */
  requesterSummary() {
    const guests = this.db
      .prepare(
        `SELECT g.id, g.username,
                COUNT(*) AS total,
                SUM(r.status = 'pending') AS pending,
                SUM(r.status = 'approved') AS approved,
                SUM(r.status = 'available') AS available
           FROM request_requesters rr
           JOIN guests g ON g.id = rr.guest_id
           JOIN requests r ON r.id = rr.request_id
          GROUP BY g.id
          ORDER BY g.username COLLATE NOCASE`,
      )
      .all() as { id: number; username: string; total: number; pending: number; approved: number; available: number }[];
    const none = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM requests r WHERE NOT EXISTS (SELECT 1 FROM request_requesters rr WHERE rr.request_id = r.id)')
        .get() as { n: number }
    ).n;
    return { guests, none };
  }

  counts() {
    const c = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      pending: c("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'"),
      failed: c("SELECT COUNT(*) AS n FROM requests WHERE status = 'failed'"),
      problems: c("SELECT COUNT(*) AS n FROM problems WHERE status = 'open'"),
    };
  }

  // ---------- problems ----------

  async reportProblem(guest: Guest, input: { mediaType: MediaType; tmdbId: number; kind: string; note?: string }) {
    const r = this.guestRequestFor(guest.id, input.mediaType, input.tmdbId);
    const s = this.d.state(input.mediaType, input.tmdbId);
    if (!r && s.kind !== 'available') throw new RequestError('You can report problems with titles that are in Plex.', 'invalid');
    const info = r ? { title: r.title } : await this.d.titleInfo(input.mediaType, input.tmdbId);
    const res = this.db
      .prepare('INSERT INTO problems (request_id, guest_id, media_type, tmdb_id, title, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r?.id ?? null, guest.id, input.mediaType, input.tmdbId, info.title, input.kind, input.note?.slice(0, 1000) ?? null, Date.now());
    audit(this.db, `guest:${guest.username}`, 'problem.report', info.title, `${input.kind}${input.note ? `: ${input.note.slice(0, 200)}` : ''}`);
    await this.d.notifier.toAdmin({ kind: 'problem.new', title: `Problem reported: ${info.title}`, body: `${guest.username}: ${input.kind}${input.note ? ` — ${input.note.slice(0, 200)}` : ''}`, url: '/requests?tab=problems' });
    return { id: Number(res.lastInsertRowid) };
  }

  guestProblems(guestId: number) {
    return this.db.prepare('SELECT id, media_type AS mediaType, tmdb_id AS tmdbId, title, kind, note, status, created_at AS createdAt, resolved_at AS resolvedAt, resolution_note AS resolutionNote FROM problems WHERE guest_id = ? ORDER BY created_at DESC').all(guestId);
  }

  adminProblems(status?: string) {
    const sql = `SELECT p.id, p.request_id AS requestId, p.media_type AS mediaType, p.tmdb_id AS tmdbId, p.title, p.kind, p.note, p.status, p.created_at AS createdAt, p.resolved_at AS resolvedAt, p.resolution_note AS resolutionNote, g.username FROM problems p JOIN guests g ON g.id = p.guest_id ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.created_at DESC LIMIT 300`;
    return status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all();
  }

  async resolveProblem(id: number, note: string | null, actor: string) {
    const p = this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as any;
    if (!p) throw new RequestError('No such problem', 'invalid');
    this.db.prepare("UPDATE problems SET status = 'resolved', resolved_at = ?, resolution_note = ? WHERE id = ?").run(Date.now(), note, id);
    audit(this.db, actor, 'problem.resolve', p.title, note);
    await this.d.notifier.toGuest(p.guest_id, { kind: 'problem.resolved', title: `Fixed: ${p.title}`, body: note ?? 'The problem you reported has been sorted out.', url: '/requests' });
  }

  // ---------- watchlist sync ----------

  /**
   * Turn a guest's linked watchlist into requests, never beyond their limits: titles already in Plex or already
   * requested are skipped, and the run stops at the first limit it hits.
   */
  async syncWatchlist(guestId: number, items: { mediaType: MediaType; tmdbId: number; state: LibraryState }[]): Promise<{ added: number; note: string }> {
    const guest = getGuest(this.db, guestId);
    if (!guest || !guest.enabled) return { added: 0, note: 'guest disabled' };
    const max = portalSettings(this.db).watchlistMaxPerRun;
    let added = 0;
    let note = 'up to date';
    for (const it of items) {
      if (added >= max) {
        note = `added ${max} this run; more next time`;
        break;
      }
      if (it.state.kind !== 'none') continue;
      if (this.guestRequestFor(guestId, it.mediaType, it.tmdbId)) continue;
      try {
        const res = await this.create(guest, { mediaType: it.mediaType, tmdbId: it.tmdbId }, 'watchlist');
        if (res.outcome !== 'merged') added++;
      } catch (err) {
        if (err instanceof RequestError && err.code === 'quota') {
          note = `stopped at your limit: ${err.message}`;
          break;
        }
        if (err instanceof RequestError) continue; // rating, already, invalid: skip that title
        throw err;
      }
    }
    if (added && note === 'up to date') note = `added ${added}`;
    this.db.prepare('UPDATE guests SET watchlist_synced_at = ?, watchlist_note = ? WHERE id = ?').run(Date.now(), note, guestId);
    return { added, note };
  }
}
