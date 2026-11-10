-- Saved values for a theme's managed configuration.
--
-- One row per theme, holding a JSON object of key -> value. A row per *theme*
-- rather than per field, because the declaration lives in the manifest and the
-- two are always read together: a settings read needs the manifest to know
-- which fields exist and what their types are, so splitting the values across
-- rows would add a join to every read and buy nothing.
--
-- ## Why the values survive a theme update
--
-- The stored document is authoritative and is never pruned against the current
-- declaration. A theme update that removes a field leaves that field's value in
-- place: reinstalling the older version finds its settings still there, which
-- is what makes a downgrade non-destructive. Keys the current declaration does
-- not mention are simply omitted from what the theme reads - see
-- `resolveSettings` in `src/lib/theme/config.ts`.
--
-- The row goes when the theme is uninstalled, and is removed with it.
--
-- 每个主题一行 JSON 键值对象，保存托管配置。声明位于清单中且两者总是一起读取；
-- 设置读取需要清单判断字段及类型，按字段拆行只会增加关联查询而无收益。
-- 存储文档是权威数据，不按当前声明裁剪：主题更新移除字段时保留其值，
-- 降级重装旧版仍可找回设置；当前声明未列出的键不会提供给主题，详见
-- src/lib/theme/config.ts 的 resolveSettings。卸载主题时连同该行删除。
CREATE TABLE IF NOT EXISTS theme_settings (
  short      TEXT PRIMARY KEY,
  -- A JSON object of key -> value. Selector fields hold a JSON *string* of an
  -- array, matching the format's storage rule; the array form exists only at
  -- the output boundary.
  -- JSON 键值对象。选择器字段按格式存储规则保存数组的 JSON 字符串；
  -- 仅在输出边界使用数组形式。
  values_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
