CREATE TABLE IF NOT EXISTS themes (
  short TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  source_url TEXT,
  manifest_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  installed_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_one_active
  ON themes(is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS theme_catalogs (
  url TEXT PRIMARY KEY,
  name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  fetched_at BIGINT,
  theme_count INTEGER,
  added_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_theme_catalogs_position
  ON theme_catalogs(position, added_at);

CREATE TABLE IF NOT EXISTS theme_settings (
  short TEXT PRIMARY KEY,
  values_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

ALTER TABLE themes ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE themes ADD COLUMN IF NOT EXISTS active_version TEXT;
ALTER TABLE themes ADD COLUMN IF NOT EXISTS previous_active_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_id ON themes(id);

CREATE TABLE IF NOT EXISTS theme_versions (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  prefix TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  installed_at BIGINT NOT NULL,
  PRIMARY KEY (id, version, digest)
);
CREATE INDEX IF NOT EXISTS idx_theme_versions_latest ON theme_versions(id, installed_at DESC);
