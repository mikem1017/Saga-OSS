import type { DB } from '../db.ts';
import type { SeerrRequest, SeerrUser } from '../connectors/seerr.ts';
import type { MediaType } from '../../shared/types.ts';
import type { RequestStatus, TitleInfo } from './requests.ts';
import { audit } from '../services/audit.ts';

/** Seerr permission bit for ADMIN (owner and admins aren't imported as guests). */
const SEERR_ADMIN = 2;

export interface MappedRequest {
  seerrRequestId: number;
  mediaType: MediaType;
  tmdbId: number;
  seasons: number[] | null;
  status: RequestStatus;
  seerrUserId: number;
  createdAt: number;
}

/**
 * Seerr request → Saga request. Media status 5 (available) wins; otherwise the request status:
 * 1 pending, 2 approved, 3 declined, 4 failed, 5 completed.
 */
export function mapSeerrRequest(r: SeerrRequest): MappedRequest | null {
  if (!r.media?.tmdbId) return null;
  const mediaType: MediaType = r.type === 'tv' ? 'tv' : 'movie';
  let status: RequestStatus;
  if (r.media.status === 5 || r.status === 5) status = 'available';
  else if (r.status === 3) status = 'declined';
  else if (r.status === 2) status = 'approved';
  else if (r.status === 4) status = 'failed';
  else status = 'pending';
  const seasons = mediaType === 'tv' ? [...new Set((r.seasons ?? []).map((s) => s.seasonNumber).filter((n) => n > 0))].sort((a, b) => a - b) : null;
  return {
    seerrRequestId: r.id,
    mediaType,
    tmdbId: r.media.tmdbId,
    seasons: mediaType === 'tv' ? (seasons!.length ? seasons : null) : null,
    status,
    seerrUserId: r.requestedBy?.id,
    createdAt: Date.parse(r.createdAt) || Date.now(),
  };
}

export function isSeerrAdmin(u: SeerrUser): boolean {
  return u.id === 1 || ((u.permissions ?? 0) & SEERR_ADMIN) === SEERR_ADMIN;
}

export interface SeerrImportReport {
  dryRun: boolean;
  users: { total: number; admins: number; new: number; existing: number };
  requests: { total: number; new: number; existing: number; skipped: number; byStatus: Record<string, number> };
  sample: { title: string; status: string; requester: string | null }[];
}

/**
 * Idempotent: guests are keyed by Seerr user id (and matched to a Plex sign-in later by Plex id/username/email),
 * requests by Seerr request id. Re-running only adds what's new. Requests made by Seerr admins (the owner) are
 * imported without a guest requester.
 */
export async function importFromSeerr(
  db: DB,
  data: { users: SeerrUser[]; requests: SeerrRequest[] },
  titleInfo: (type: MediaType, id: number) => Promise<Pick<TitleInfo, 'title' | 'year' | 'posterPath'>>,
  opts: { dryRun: boolean; actor: string },
): Promise<SeerrImportReport> {
  const report: SeerrImportReport = {
    dryRun: opts.dryRun,
    users: { total: data.users.length, admins: 0, new: 0, existing: 0 },
    requests: { total: data.requests.length, new: 0, existing: 0, skipped: 0, byStatus: {} },
    sample: [],
  };
  const guestBySeerr = new Map<number, number | null>(); // seerr user id → guest id (null in dry run)
  const usernames = new Map<number, string>();
  for (const u of data.users) {
    const name = u.plexUsername || u.username || u.displayName || u.email?.split('@')[0] || `seerr-${u.id}`;
    usernames.set(u.id, name);
    if (isSeerrAdmin(u)) {
      report.users.admins++;
      continue;
    }
    const existing = db.prepare('SELECT id FROM guests WHERE seerr_user_id = ? OR (plex_id IS NOT NULL AND plex_id = ?)').get(u.id, u.plexId ?? -1) as { id: number } | undefined;
    if (existing) {
      report.users.existing++;
      guestBySeerr.set(u.id, existing.id);
      if (!opts.dryRun) db.prepare('UPDATE guests SET seerr_user_id = COALESCE(seerr_user_id, ?) WHERE id = ?').run(u.id, existing.id);
      continue;
    }
    report.users.new++;
    if (opts.dryRun) {
      guestBySeerr.set(u.id, null);
      continue;
    }
    const res = db
      .prepare('INSERT INTO guests (plex_id, username, email, thumb, seerr_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u.plexId ?? null, name, u.email?.toLowerCase() ?? null, u.avatar ?? null, u.id, Date.now());
    guestBySeerr.set(u.id, Number(res.lastInsertRowid));
  }

  for (const raw of data.requests) {
    const m = mapSeerrRequest(raw);
    if (!m) {
      report.requests.skipped++;
      continue;
    }
    report.requests.byStatus[m.status] = (report.requests.byStatus[m.status] ?? 0) + 1;
    const exists = db.prepare('SELECT id FROM requests WHERE seerr_request_id = ?').get(m.seerrRequestId) as { id: number } | undefined;
    if (exists) {
      report.requests.existing++;
      continue;
    }
    report.requests.new++;
    const requester = guestBySeerr.has(m.seerrUserId) ? (usernames.get(m.seerrUserId) ?? null) : null;
    let info: Pick<TitleInfo, 'title' | 'year' | 'posterPath'>;
    try {
      info = await titleInfo(m.mediaType, m.tmdbId);
    } catch {
      info = { title: `${m.mediaType} ${m.tmdbId}` };
    }
    if (report.sample.length < 12) report.sample.push({ title: info.title, status: m.status, requester });
    if (opts.dryRun) continue;
    const res = db
      .prepare(
        'INSERT INTO requests (media_type, tmdb_id, title, year, poster_path, seasons, status, est_bytes, source, seerr_request_id, created_at, decided_at, decided_by, available_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        m.mediaType,
        m.tmdbId,
        info.title,
        info.year ?? null,
        info.posterPath ?? null,
        m.seasons ? JSON.stringify(m.seasons) : null,
        m.status,
        'seerr',
        m.seerrRequestId,
        m.createdAt,
        m.status === 'pending' ? null : m.createdAt,
        m.status === 'pending' ? null : 'seerr',
        m.status === 'available' ? m.createdAt : null,
      );
    const gid = guestBySeerr.get(m.seerrUserId);
    // Imported history doesn't count against anyone's weekly limits (charges are 0).
    if (gid) db.prepare('INSERT OR IGNORE INTO request_requesters (request_id, guest_id, created_at) VALUES (?, ?, ?)').run(Number(res.lastInsertRowid), gid, m.createdAt);
  }
  if (!opts.dryRun) audit(db, opts.actor, 'seerr.import', null, `${report.users.new} guest(s), ${report.requests.new} request(s)`);
  return report;
}
