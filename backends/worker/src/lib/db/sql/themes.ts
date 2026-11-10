const d1 = {
  list: 'SELECT * FROM themes ORDER BY installed_at DESC',
  byShort: 'SELECT * FROM themes WHERE short = ?',
  version: 'SELECT * FROM theme_versions WHERE id = ? AND version = ? ORDER BY installed_at DESC LIMIT 1',
  versionsById: 'SELECT * FROM theme_versions WHERE id = ? ORDER BY installed_at DESC',
  insertVersion: `INSERT INTO theme_versions (id, version, digest, prefix, manifest_json, installed_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM themes WHERE (short = ? AND id <> ?) OR (id = ? AND short <> ?)) AND NOT EXISTS (SELECT 1 FROM themes WHERE id = ? AND deleting = 1) AND EXISTS (SELECT 1 FROM theme_operations WHERE id=? AND token=? AND expires_at>=?)
    ON CONFLICT(id, version, digest) DO NOTHING`,
  upsert: `INSERT INTO themes (short, id, name, version, description, author, source_url, manifest_json, installed_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM theme_operations WHERE id=? AND token=? AND expires_at>=?)
    ON CONFLICT(short) DO UPDATE SET id=excluded.id, name=excluded.name, version=excluded.version,
      description=excluded.description, author=excluded.author, source_url=excluded.source_url,
      manifest_json=excluded.manifest_json, updated_at=excluded.updated_at WHERE themes.id=excluded.id AND themes.deleting=0`,
  remove: 'DELETE FROM themes WHERE short = ?',
  removeVersions: 'DELETE FROM theme_versions WHERE id = ?',
};

type ThemeSQL = { [K in keyof typeof d1]: (typeof d1)[K] };
const postgres: ThemeSQL = {
  list: d1.list,
  byShort: 'SELECT * FROM themes WHERE short = $1',
  version: 'SELECT * FROM theme_versions WHERE id = $1 AND version = $2 ORDER BY installed_at DESC LIMIT 1',
  versionsById: 'SELECT * FROM theme_versions WHERE id = $1 ORDER BY installed_at DESC',
  insertVersion: `INSERT INTO theme_versions (id, version, digest, prefix, manifest_json, installed_at)
    SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM themes WHERE (short = $7 AND id <> $8) OR (id = $9 AND short <> $10)) AND NOT EXISTS (SELECT 1 FROM themes WHERE id = $11 AND deleting = 1) AND EXISTS (SELECT 1 FROM theme_operations WHERE id=$12 AND token=$13 AND expires_at>=$14)
    ON CONFLICT(id, version, digest) DO NOTHING`,
  upsert: `INSERT INTO themes (short, id, name, version, description, author, source_url, manifest_json, installed_at, updated_at)
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 WHERE EXISTS (SELECT 1 FROM theme_operations WHERE id=$11 AND token=$12 AND expires_at>=$13)
    ON CONFLICT(short) DO UPDATE SET id=EXCLUDED.id, name=EXCLUDED.name, version=EXCLUDED.version,
      description=EXCLUDED.description, author=EXCLUDED.author, source_url=EXCLUDED.source_url,
      manifest_json=EXCLUDED.manifest_json, updated_at=EXCLUDED.updated_at WHERE themes.id=EXCLUDED.id AND themes.deleting=0`,
  remove: 'DELETE FROM themes WHERE short = $1',
  removeVersions: 'DELETE FROM theme_versions WHERE id = $1',
};

export const themeSQL: Record<'d1' | 'postgres', ThemeSQL> = { d1, postgres };
