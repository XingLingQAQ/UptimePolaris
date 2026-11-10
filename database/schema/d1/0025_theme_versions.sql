ALTER TABLE themes ADD COLUMN id TEXT;
ALTER TABLE themes ADD COLUMN active_version TEXT;
ALTER TABLE themes ADD COLUMN previous_active_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_id ON themes(id);

CREATE TABLE IF NOT EXISTS theme_versions (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  prefix TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (id, version, digest)
);
CREATE INDEX IF NOT EXISTS idx_theme_versions_latest ON theme_versions(id, installed_at DESC);
