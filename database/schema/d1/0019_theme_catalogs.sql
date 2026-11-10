-- Market catalog sources.
--
-- A catalog is a JSON list of installable themes with their download URLs and
-- SHA-256 digests (see `src/lib/theme/catalog.ts`). The default is Komari's own
-- catalog repository, used when this table is empty - so a fresh deployment has
-- a populated market with no configuration, and an operator who wants only
-- their own sources can remove it.
--
-- ## Why a table rather than a settings row
--
-- A catalog is a list of things to trust, and an operator may reasonably want
-- several - their own, plus one they follow. A single JSON blob in a settings
-- row would work and would make "which sources are configured" a thing you read
-- by parsing a string rather than by looking. Ordering matters too (the first
-- catalog to define a `short` wins), and a row with a position expresses that
-- directly.
--
-- `url` is the primary key: adding the same catalog twice is the same as adding
-- it once, which is the behaviour that makes a double-click harmless.
--
-- 主题市场目录来源：目录是包含可安装主题、下载 URL 和 SHA-256 摘要的 JSON 列表。
-- 此表为空时使用 Komari 默认目录，使新部署无需配置即可显示市场；希望只使用自身
-- 来源的操作人员可移除它。目录是需要信任的来源列表，可能有多个；单个设置行 JSON
-- 虽可保存，但查看配置来源必须先解析字符串。顺序也重要：首个定义某 short 的目录
-- 胜出，因此每行保存位置。url 是主键，重复添加等同添加一次，使双击无害。
CREATE TABLE IF NOT EXISTS theme_catalogs (
  url        TEXT PRIMARY KEY,
  -- Optional display name, so a long raw URL need not be the label.
  -- 可选显示名称，避免直接以长 URL 作为标签。
  name       TEXT,
  -- Lower sorts first, and the first catalog to define a short name wins.
  -- 数值较小者排前；最先定义某 short 的目录胜出。
  position   INTEGER NOT NULL DEFAULT 0,
  -- When it was last fetched successfully, and how many themes it returned.
  -- Both NULL until a fetch succeeds, which is what lets the console
  -- distinguish "never fetched" from "fetched and empty".
  -- 上次成功获取时间及返回主题数量；成功获取前均为 NULL，
  -- 让控制台区分“从未获取”和“获取成功但为空”。
  fetched_at INTEGER,
  theme_count INTEGER,
  added_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_theme_catalogs_position
  ON theme_catalogs(position, added_at);
