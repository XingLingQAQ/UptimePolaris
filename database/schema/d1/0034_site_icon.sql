-- An operator-uploaded site icon, stored as bytes.
--
-- Why a table instead of a URL in `app_settings`: the icon people actually want
-- to use is a file on their machine - a logo, a screenshot cropped to a square -
-- not a URL they can host. `site.icon` has always accepted a URL, and that
-- stays: this table is what a URL cannot express.
--
-- Why a table instead of R2: R2 is optional, so a deployment without the
-- binding would lose uploads. The configured database stores the icon; D1 and
-- PostgreSQL each have a migration. One small file (bounded at 256 KB below)
-- does not justify requiring every operator to provision a bucket.
--
-- One row, always. The `singleton` column is a constant 1 with a UNIQUE
-- constraint, so a second upload replaces the first rather than accumulating
-- history nobody asked for. An icon has no version worth keeping: if an
-- operator wants the old one back, they still have the file.
--
-- 将操作人员上传的站点图标按字节存储。选择表而非 app_settings 中的 URL，
-- 是因为用户需要使用本机标志或裁剪截图，不一定有可托管的 URL；site.icon
-- 仍接受 URL，表用于表达 URL 无法表达的文件。选择数据库表而非 R2，是因为 R2
-- 是可选绑定，未配置时上传功能会消失；D1 和 PostgreSQL 均有对应迁移，图标存于
-- 配置的数据库中。图标只是一个最多 256 KB 的小文件，无需要求每个操作人员配置桶。
-- 始终一行：
-- singleton 固定为 1 并受唯一约束，第二次上传替换第一次，不积累无用历史；
-- 若需恢复旧图标，操作人员仍持有原文件。
CREATE TABLE IF NOT EXISTS site_icon (
  singleton     INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  bytes         BLOB NOT NULL,
  content_type  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  -- What the operator's browser reported. Kept for display only; the served
  -- content type comes from `content_type`, which was decided by sniffing the
  -- bytes. A filename is not a security boundary, but it is what makes the
  -- uploads list legible to a human.
  -- 浏览器上报的文件名仅用于显示；实际响应类型取自根据字节嗅探确定的 content_type。
  -- 文件名不是安全边界，但能让上传列表便于阅读。
  filename      TEXT,
  updated_at    INTEGER NOT NULL
);

-- Replacing the icon is an upsert on the singleton key. No index beyond the
-- primary key: there is exactly one row, always read whole.
-- 替换图标按 singleton 主键 upsert；恰好一行且总是整体读取，不需要额外索引。
