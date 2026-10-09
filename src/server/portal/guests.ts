import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db.ts';
import { portalSettings } from './settings.ts';
import type { PlexAccount } from './plex.ts';

export interface Guest {
  id: number;
  plexId: number | null;
  username: string;
  email: string | null;
  thumb: string | null;
  role: 'guest' | 'kid';
  enabled: boolean;
  seerrUserId: number | null;
  limits: { moviesPerWeek: number; seasonsPerWeek: number; gbPerMonth: number; autoApproveGb: number };
  /** No limits at all, and every request is approved straight away. */
  unlimited: boolean;
  /** Every request within their limits is approved straight away (no admin queue). */
  autoApproveAll: boolean;
  /** Overrides as stored (null = portal default), for the admin editor. */
  overrides: { moviesPerWeek: number | null; seasonsPerWeek: number | null; gbPerMonth: number | null; autoApproveGb: number | null; ratingCap: string[] | null };
  ratingCap: string[] | null; // effective; null = no cap
  notifyEmail: boolean;
  watchlistUrl: string | null;
  watchlistSyncedAt: number | null;
  watchlistNote: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 60;

export function rowToGuest(db: DB, r: any): Guest {
  const s = portalSettings(db);
  const cap = r.rating_cap ? (JSON.parse(r.rating_cap) as string[]) : null;
  return {
    id: r.id,
    plexId: r.plex_id,
    username: r.username,
    email: r.email,
    thumb: r.thumb,
    role: r.role === 'kid' ? 'kid' : 'guest',
    enabled: !!r.enabled,
    seerrUserId: r.seerr_user_id,
    limits: {
      moviesPerWeek: r.limit_movies_week ?? s.defaults.moviesPerWeek,
      seasonsPerWeek: r.limit_seasons_week ?? s.defaults.seasonsPerWeek,
      gbPerMonth: r.limit_gb_month ?? s.defaults.gbPerMonth,
      autoApproveGb: r.auto_approve_gb ?? s.defaults.autoApproveGb,
    },
    unlimited: !!r.unlimited,
    autoApproveAll: !!r.auto_approve_all,
    overrides: { moviesPerWeek: r.limit_movies_week, seasonsPerWeek: r.limit_seasons_week, gbPerMonth: r.limit_gb_month, autoApproveGb: r.auto_approve_gb, ratingCap: cap },
    ratingCap: cap ?? (r.role === 'kid' ? s.kidRatings : null),
    notifyEmail: !!r.notify_email,
    watchlistUrl: r.watchlist_url,
    watchlistSyncedAt: r.watchlist_synced_at,
    watchlistNote: r.watchlist_note,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

export function getGuest(db: DB, id: number): Guest | null {
  const r = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  return r ? rowToGuest(db, r) : null;
}

export function listGuests(db: DB): Guest[] {
  return (db.prepare('SELECT * FROM guests ORDER BY lower(username)').all() as any[]).map((r) => rowToGuest(db, r));
}

// ---------- sessions ----------

export function createGuestSession(db: DB, guestId: number, ip: string): { token: string; csrf: string } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO guest_sessions (id, guest_id, csrf, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)').run(sha256(token), guestId, csrf, now, now + SESSION_DAYS * 86400_000, ip);
  db.prepare('UPDATE guests SET last_seen_at = ? WHERE id = ?').run(now, guestId);
  return { token, csrf };
}

export function lookupGuestSession(db: DB, token: string | undefined): { guest: Guest; csrf: string; sessionId: string } | null {
  if (!token) return null;
  const id = sha256(token);
  const s = db.prepare('SELECT guest_id, csrf, expires_at FROM guest_sessions WHERE id = ?').get(id) as { guest_id: number; csrf: string; expires_at: number } | undefined;
  if (!s || s.expires_at < Date.now()) return null;
  const guest = getGuest(db, s.guest_id);
  if (!guest || !guest.enabled) return null;
  if (!guest.lastSeenAt || Date.now() - guest.lastSeenAt > 3600_000) db.prepare('UPDATE guests SET last_seen_at = ? WHERE id = ?').run(Date.now(), guest.id);
  return { guest, csrf: s.csrf, sessionId: id };
}

export function destroyGuestSession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM guest_sessions WHERE id = ?').run(sha256(token));
}

// ---------- invites ----------

export interface Invite {
  id: number;
  code: string;
  email: string | null;
  note: string | null;
  role: 'guest' | 'kid';
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  redeemedBy: number | null;
  redeemedAt: number | null;
  revokedAt: number | null;
}

const rowToInvite = (r: any): Invite => ({
  id: r.id,
  code: r.code,
  email: r.email,
  note: r.note,
  role: r.role === 'kid' ? 'kid' : 'guest',
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  redeemedBy: r.redeemed_by,
  redeemedAt: r.redeemed_at,
  revokedAt: r.revoked_at,
});

export function createInvite(db: DB, opts: { email?: string | null; note?: string | null; role?: 'guest' | 'kid'; expiresDays?: number | null; createdBy: string }): Invite {
  // Readable, unguessable: 12 chars from a 32-letter alphabet (60 bits).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const code = Array.from(bytes, (b) => alphabet[b % 32]).join('').replace(/(.{4})(?=.)/g, '$1-');
  const now = Date.now();
  const res = db
    .prepare('INSERT INTO invites (code, email, note, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(code, opts.email?.trim().toLowerCase() || null, opts.note || null, opts.role ?? 'guest', opts.createdBy, now, opts.expiresDays ? now + opts.expiresDays * 86400_000 : null);
  return rowToInvite(db.prepare('SELECT * FROM invites WHERE id = ?').get(Number(res.lastInsertRowid)));
}

export function listInvites(db: DB): Invite[] {
  return (db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as any[]).map(rowToInvite);
}

/** An invite that can still be used, by code. Codes are compared without dashes/case. */
export function usableInvite(db: DB, code: string | undefined | null): Invite | null {
  if (!code) return null;
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const r = db.prepare("SELECT * FROM invites WHERE replace(code, '-', '') = ?").get(norm);
  if (!r) return null;
  const inv = rowToInvite(r);
  if (inv.revokedAt || inv.redeemedAt || (inv.expiresAt && inv.expiresAt < Date.now())) return null;
  return inv;
}

export function revokeInvite(db: DB, id: number): void {
  db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND redeemed_at IS NULL').run(Date.now(), id);
}

function redeem(db: DB, inviteId: number, guestId: number) {
  db.prepare('UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE id = ?').run(guestId, Date.now(), inviteId);
}

// ---------- sign-in decisions ----------

export type SignInResult = { ok: true; guest: Guest; created: boolean } | { ok: false; reason: string };

/**
 * Decide whether a Plex account may sign in. In order: an existing enabled guest (by Plex id, or a Seerr-imported
 * record matched by Plex id / username / email); a usable invite; or, if allowed, being the owner's Plex friend.
 * There is no open sign-up.
 */
export function signInWithPlex(db: DB, acct: PlexAccount, opts: { inviteCode?: string | null; isFriend: boolean; isOwner?: boolean }): SignInResult {
  const now = Date.now();
  const byPlex = db.prepare('SELECT * FROM guests WHERE plex_id = ?').get(acct.id) as any;
  if (byPlex) {
    if (!byPlex.enabled) return { ok: false, reason: 'Your access has been turned off. Ask the person who invited you if you think that is a mistake.' };
    if (opts.isOwner) db.prepare('UPDATE guests SET unlimited = 1 WHERE id = ?').run(byPlex.id);
    db.prepare('UPDATE guests SET username = ?, email = COALESCE(?, email), thumb = ?, plex_uuid = ? WHERE id = ?').run(acct.username || acct.title || byPlex.username, acct.email ?? null, acct.thumb ?? null, acct.uuid, byPlex.id);
    return { ok: true, guest: getGuest(db, byPlex.id)!, created: false };
  }
  // A guest imported from Seerr (or invited by email) that hasn't linked Plex yet.
  const unlinked = db
    .prepare('SELECT * FROM guests WHERE plex_id IS NULL AND (lower(username) = lower(?) OR (email IS NOT NULL AND lower(email) = lower(?)))')
    .get(acct.username ?? '', acct.email ?? '') as any;
  if (unlinked) {
    if (!unlinked.enabled) return { ok: false, reason: 'Your access has been turned off. Ask the person who invited you if you think that is a mistake.' };
    db.prepare('UPDATE guests SET plex_id = ?, plex_uuid = ?, username = ?, email = COALESCE(email, ?), thumb = ? WHERE id = ?').run(acct.id, acct.uuid, acct.username || unlinked.username, acct.email ?? null, acct.thumb ?? null, unlinked.id);
    return { ok: true, guest: getGuest(db, unlinked.id)!, created: false };
  }
  const invite = usableInvite(db, opts.inviteCode);
  // The server owner can always sign in (to see what guests see), whatever the friends setting says.
  if (!invite && !opts.isOwner && !(opts.isFriend && portalSettings(db).allowPlexFriends)) {
    return { ok: false, reason: opts.inviteCode ? 'That invite code is not valid any more.' : 'Saga Requests is invite-only. Ask the person who runs this server for an invite link.' };
  }
  const res = db
    .prepare('INSERT INTO guests (plex_id, plex_uuid, username, email, thumb, role, invite_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(acct.id, acct.uuid, acct.username || acct.title || `plex-${acct.id}`, acct.email?.toLowerCase() ?? null, acct.thumb ?? null, invite?.role ?? 'guest', invite?.id ?? null, now, now);
  const id = Number(res.lastInsertRowid);
  if (invite) redeem(db, invite.id, id);
  // The server owner's own account has no limits.
  if (opts.isOwner) db.prepare('UPDATE guests SET unlimited = 1 WHERE id = ?').run(id);
  return { ok: true, guest: getGuest(db, id)!, created: true };
}

// ---------- magic links (email fallback for invited people) ----------

/** Returns a token to email, or null when the address isn't invited (callers answer the same way either way). */
export function createMagicLink(db: DB, email: string): string | null {
  const e = email.trim().toLowerCase();
  const guest = db.prepare('SELECT id, enabled FROM guests WHERE lower(email) = ?').get(e) as { id: number; enabled: number } | undefined;
  let inviteId: number | null = null;
  if (guest && !guest.enabled) return null;
  if (!guest) {
    const inv = db.prepare('SELECT * FROM invites WHERE lower(email) = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(e, Date.now()) as any;
    if (!inv) return null;
    inviteId = inv.id;
  }
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO magic_links (token_hash, guest_id, invite_id, email, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(token), guest?.id ?? null, inviteId, e, Date.now() + 20 * 60_000);
  return token;
}

export function redeemMagicLink(db: DB, token: string): SignInResult {
  const row = db.prepare('SELECT * FROM magic_links WHERE token_hash = ?').get(sha256(token)) as any;
  if (!row || row.used_at || row.expires_at < Date.now()) return { ok: false, reason: 'That sign-in link has expired. Ask for a new one.' };
  db.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
  if (row.guest_id) {
    const g = getGuest(db, row.guest_id);
    if (!g || !g.enabled) return { ok: false, reason: 'Your access has been turned off.' };
    return { ok: true, guest: g, created: false };
  }
  const inv = db.prepare('SELECT * FROM invites WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL').get(row.invite_id) as any;
  if (!inv) return { ok: false, reason: 'That invite has already been used or revoked.' };
  const now = Date.now();
  const res = db.prepare('INSERT INTO guests (username, email, role, invite_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(row.email.split('@')[0], row.email, inv.role, inv.id, now, now);
  const id = Number(res.lastInsertRowid);
  redeem(db, inv.id, id);
  return { ok: true, guest: getGuest(db, id)!, created: true };
}

// ---------- throttling ----------

/** Sign-in throttle for the portal, keyed by client IP (cf-connecting-ip through the tunnel). */
export function portalAuthAllowed(db: DB, ip: string): boolean {
  const since = Date.now() - 15 * 60_000;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND ts > ?').get(`portal:${ip}`, since) as { n: number }).n;
  return n < 10;
}

export function recordPortalAuth(db: DB, ip: string, ok: boolean): void {
  db.prepare('INSERT INTO login_attempts (ip, ts, ok) VALUES (?, ?, ?)').run(`portal:${ip}`, Date.now(), ok ? 1 : 0);
}
