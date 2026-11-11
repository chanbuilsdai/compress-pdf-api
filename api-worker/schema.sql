-- editpdf.tools API: separate database (Cloudflare D1). Has nothing to do with the site's Supabase.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | active | blocked
  monthly_quota INTEGER,                           -- NULL = use DEFAULT_MONTHLY_QUOTA
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  last_call_at INTEGER NOT NULL DEFAULT 0          -- for the per-minute limit
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,                       -- SHA-256 of the key; the key itself is never stored
  user_id TEXT NOT NULL,
  prefix TEXT NOT NULL,                            -- first characters, for display only
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS tokens (                -- one-time email login links
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (                 -- per user per month (YYYY-MM, UTC)
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS counters (              -- global safety counters
  name TEXT PRIMARY KEY,                           -- e.g. files:2026-11, bytes:2026-11, emails:2026-11-10, ip:<hash>:<hour>
  value INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
