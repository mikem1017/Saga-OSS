/** Phase 5 tables: guests, invites, requests (one row per title, many requesters), problems, notifications. */
export const PORTAL_MIGRATION = `
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY,
    plex_id INTEGER UNIQUE,
    plex_uuid TEXT,
    username TEXT NOT NULL,
    email TEXT,
    thumb TEXT,
    role TEXT NOT NULL DEFAULT 'guest',            -- guest | kid
    enabled INTEGER NOT NULL DEFAULT 1,
    invite_id INTEGER,
    seerr_user_id INTEGER UNIQUE,
    limit_movies_week INTEGER,                     -- NULL = portal default
    limit_seasons_week INTEGER,
    limit_gb_month INTEGER,
    auto_approve_gb INTEGER,
    rating_cap TEXT,                               -- JSON string[]; NULL = default for the role
    notify_email INTEGER NOT NULL DEFAULT 1,
    watchlist_url TEXT,
    watchlist_synced_at INTEGER,
    watchlist_note TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE INDEX guests_email ON guests(email);
  CREATE TABLE guest_sessions (
    id TEXT PRIMARY KEY,                           -- sha256 of the cookie token
    guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT
  );
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    email TEXT,
    note TEXT,
    role TEXT NOT NULL DEFAULT 'guest',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    redeemed_by INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    redeemed_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE magic_links (
    token_hash TEXT PRIMARY KEY,
    guest_id INTEGER,
    invite_id INTEGER,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    poster_path TEXT,
    seasons TEXT,                                  -- JSON number[] for TV; NULL for movies
    status TEXT NOT NULL,                          -- pending | approved | declined | failed | available
    est_bytes INTEGER NOT NULL DEFAULT 0,
    decline_reason TEXT,
    last_error TEXT,
    source TEXT NOT NULL DEFAULT 'portal',         -- portal | watchlist | seerr
    seerr_request_id INTEGER UNIQUE,
    arr_id INTEGER,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    available_at INTEGER
  );
  CREATE INDEX requests_title ON requests(media_type, tmdb_id);
  CREATE INDEX requests_status ON requests(status);
  CREATE TABLE request_requesters (
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    movies_count INTEGER NOT NULL DEFAULT 0,       -- what this requester is charged against their limits
    seasons_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, guest_id)
  );
  CREATE TABLE problems (
    id INTEGER PRIMARY KEY,
    request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
    guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,                            -- audio | subtitles | video | wrong_file | other
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_note TEXT
  );
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,   -- NULL = the admin
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,   -- NULL = the admin
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_guest ON notifications(guest_id, created_at DESC);
  CREATE TABLE status_posts (
    id INTEGER PRIMARY KEY,
    message TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
`;
