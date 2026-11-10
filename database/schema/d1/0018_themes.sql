-- Installed themes, and which one is active.
--
-- A theme is a whole compiled front end (see `src/lib/theme/router.ts`), so
-- this table is the *registry*: which themes exist, and which one `/` should
-- serve. The files themselves live elsewhere - object storage, or an external
-- URL - because a Worker cannot write to its own asset store.
--
-- ## Why one row holds the active flag
--
-- `is_active` is a column rather than a row in a settings table, and a partial
-- unique index enforces at most one active theme. The alternative - a
-- `active_theme` string in a settings row - makes "the active theme" and "the
-- themes that exist" two sources that can disagree: activating a theme that was
-- uninstalled a moment earlier would leave the site rendering a 404 on `/`,
-- which is the one page that must never break.
--
-- With the flag on the row, a foreign key from the site to the theme is
-- implicit: deleting the active row clears the flag by deletion, and the router
-- falls back to the built-in UI. That is the behaviour worth having.
--
-- ## `short` is the URL segment
--
-- `/theme/<short>/...` is how a theme's own bundles are addressed, so `short`
-- must be URL-safe and unique. It is the primary key rather than a surrogate id
-- because it is what every caller already has - the router, the installer, the
-- manifest - and an id would just be a second name for the same thing.
--
-- The slug rule is enforced in code (`validateShort`) rather than by a CHECK
-- constraint: SQLite and Postgres disagree on regex support, and this file has
-- to apply cleanly to both.
--
-- 已安装主题及当前启用项。主题是完整编译的前端，本表只登记有哪些主题和 `/`
-- 应提供哪一个；文件位于对象存储或外部 URL，因为 Worker 无法写自身资源存储。
-- is_active 存在主题行上，并以部分唯一索引保证最多一个启用；若另在设置表保存
-- active_theme 字符串，主题存在性和活动主题可能不一致，刚卸载的主题被激活会使
-- 关键首页返回 404。标志随行删除，删除活动主题后路由回退到内置界面。
-- short 是 `/theme/<short>/...` 的 URL 安全唯一段，路由、安装器和清单已持有它，
-- 故直接作主键，不再增加同义代理 ID。slug 规则由 validateShort 而非 CHECK 校验，
-- 因为 SQLite 和 PostgreSQL 的正则支持不同，而此文件需要两者均可执行。
CREATE TABLE IF NOT EXISTS themes (
  -- URL segment, e.g. "classic". Lowercase alphanumerics and dashes.
  -- URL 段，如 classic；仅小写字母、数字和连字符。
  short        TEXT PRIMARY KEY,
  -- Display name from the manifest, already resolved to one string.
  -- 清单中的显示名称，已解析为单个字符串。
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  description  TEXT,
  author       TEXT,
  -- Where the package came from, for "check for updates". NULL for a theme
  -- installed from an uploaded file with no upstream.
  -- 包来源，用于检查更新；从无上游的上传文件安装时为 NULL。
  source_url   TEXT,
  -- The manifest exactly as it arrived, so a field this version does not
  -- understand survives a reinstall without being silently dropped.
  -- 按收到时原样保存清单，使当前版本不认识的字段重装后仍保留。
  manifest_json TEXT NOT NULL,
  -- 1 for the theme `/` serves. A partial unique index below keeps it single.
  -- `/` 提供的主题为 1；下方部分唯一索引保证最多一个。
  is_active    INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- At most one active theme.
--
-- A partial index rather than a plain unique one: the latter would allow only
-- one *inactive* row too, since NULLs are distinct in some engines and not in
-- others. `WHERE is_active = 1` states the rule that is actually meant.
--
-- 最多一个活动主题。使用部分索引而非普通唯一索引：普通索引也只允许一条
-- 非活动行，且不同数据库对 NULL 唯一性的处理不同；`WHERE is_active = 1`
-- 精确表达实际规则。
CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_one_active
  ON themes(is_active) WHERE is_active = 1;
