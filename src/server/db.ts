import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PORTAL_MIGRATION } from './portal/schema.ts';

export type DB = DatabaseSync;

/** Ordered, append-only. Never edit a shipped migration; add a new one. */
const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'admin',           -- admin | guest (phase 5)
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                           -- sha256 of the cookie token
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX audit_ts ON audit_log(ts DESC);
  CREATE TABLE add_rules (
    id INTEGER PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    media_type TEXT NOT NULL,                      -- movie | tv | any
    conditions TEXT NOT NULL,                      -- JSON RuleConditions
    actions TEXT NOT NULL                          -- JSON RuleActions
  );
  CREATE TABLE samples (
    ts INTEGER PRIMARY KEY,                        -- unix seconds
    sab_total_bytes INTEGER,                       -- server_stats.total (monotonic)
    queue_bytes_left INTEGER,
    queue_count INTEGER,
    speed_bps INTEGER,
    sab_paused INTEGER,
    guard_paused INTEGER,
    pp_waiting INTEGER
  );
  CREATE TABLE pending_bumps (
    id INTEGER PRIMARY KEY,
    app TEXT NOT NULL,                             -- radarr | sonarr
    item_id INTEGER NOT NULL,                      -- movieId / seriesId
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    done_at INTEGER,
    actor TEXT NOT NULL
  );
  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE login_attempts (
    ip TEXT NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX login_attempts_ip ON login_attempts(ip, ts);
  `,
  `
  CREATE TABLE saved_lists (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                            -- imdb | imdb-top250 | letterboxd | mdblist | tmdb | trakt
    ref TEXT NOT NULL,                             -- URL or id
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(kind, ref)
  );
  `,
  `
  -- Phase 4: Saga is the source of truth for Usenet providers and indexers. "Desired" config lives here;
  -- live config is read from SAB / Prowlarr and diffed. Secrets are sealed with SecretBox.
  CREATE TABLE providers (
    id INTEGER PRIMARY KEY,
    sab_name TEXT NOT NULL UNIQUE,                 -- SAB's server key (usually the host)
    display_name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    ssl INTEGER NOT NULL,
    connections INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    retention_days INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    optional INTEGER NOT NULL DEFAULT 0,
    username TEXT,
    password_enc TEXT,
    plan_type TEXT NOT NULL DEFAULT 'unlimited',   -- unlimited | block
    renewal_date TEXT,                             -- YYYY-MM-DD
    price REAL,
    billing_period TEXT,                           -- month | year | once
    block_size_bytes INTEGER,
    block_baseline_bytes INTEGER,                  -- SAB server total when the block was recorded
    block_baseline_at INTEGER,
    data_cap_bytes INTEGER,
    notes TEXT,
    imported_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE indexers (
    id INTEGER PRIMARY KEY,
    prowlarr_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 25,
    api_limit_day INTEGER,
    grab_limit_day INTEGER,
    vip_expiry TEXT,
    renewal_price REAL,
    notes TEXT,
    imported_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- The first build seeded "kids' TV → HD-1080p" rules. HD-1080p is Sonarr's stock profile (no custom formats),
  -- while titles should use a tuned profile, so those rules are removed.
  DELETE FROM add_rules WHERE name IN ('Kids'' TV → 1080p', 'Kids'' ratings → 1080p');
  `,
  `
  -- Phase 4 push: the target app's config is captured (sealed) before every change Saga makes to it.
  CREATE TABLE config_snapshots (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    app TEXT NOT NULL,                             -- sabnzbd | prowlarr
    target TEXT NOT NULL,                          -- server keyword / indexer id
    reason TEXT NOT NULL,
    payload_enc TEXT NOT NULL,
    actor TEXT NOT NULL
  );
  `,
  `
  -- Phase 6 extras (Insights): natural-language discover spend, pool usage history, auto-bump record.
  CREATE TABLE nl_queries (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX nl_queries_ts ON nl_queries(ts);
  CREATE TABLE disk_samples (
    ts INTEGER NOT NULL,
    mount TEXT NOT NULL,
    used INTEGER NOT NULL,
    avail INTEGER NOT NULL,
    PRIMARY KEY (ts, mount)
  );
  CREATE TABLE autobumps (
    download_id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    series_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    episode TEXT NOT NULL
  );
  `,
  // Phase 5: request portal (src/server/portal/schema.ts).
  PORTAL_MIGRATION,
  `
  -- Unlimited guests: no weekly/monthly limits and every request auto-approved (the owner's own account, family).
  ALTER TABLE guests ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Auto-approve everything a guest asks for (their limits still apply).
  ALTER TABLE guests ADD COLUMN auto_approve_all INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'saga.db'));
  return migrate(db);
}

export function openMemoryDb(): DB {
  return migrate(new DatabaseSync(':memory:'));
}

function migrate(db: DB): DB {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < migrations.length) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version]!);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

/** Small TTL cache in SQLite, for TMDB responses and slow lookups that should survive restarts. */
export function cacheGet<T>(db: DB, key: string): T | undefined {
  const row = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key) as
    | { value: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  return JSON.parse(row.value) as T;
}

export function cacheSet(db: DB, key: string, value: unknown, ttlMs: number): void {
  db.prepare(
    'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
  ).run(key, JSON.stringify(value), Date.now() + ttlMs);
}

export function pruneCache(db: DB): void {
  db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM samples WHERE ts < ?').run(Math.floor(Date.now() / 1000) - 30 * 86400);
  db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(Date.now() - 86400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
