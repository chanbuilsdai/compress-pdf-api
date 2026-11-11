-- 0002: per-user limits set by admin + integration limits
ALTER TABLE users ADD COLUMN max_file_mb INTEGER;      -- NULL = default (10)
ALTER TABLE users ADD COLUMN rate_window_s INTEGER;    -- NULL = default (60); 0 = no per-minute limit
ALTER TABLE users ADD COLUMN note TEXT;                -- e.g. zapier-review
CREATE TABLE IF NOT EXISTS settings (
  name TEXT PRIMARY KEY,                               -- e.g. int:zapier
  value TEXT NOT NULL,
  updated_at INTEGER
);
