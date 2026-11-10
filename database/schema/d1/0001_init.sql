-- Config. Written rarely, read often. Kept small so it is cheap to scan.
-- 配置：写入少、读取频繁；保持精简以降低扫描成本。
CREATE TABLE IF NOT EXISTS monitors (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp')),
  target          TEXT    NOT NULL,
  method          TEXT    NOT NULL DEFAULT 'GET',
  expected_status TEXT    NOT NULL DEFAULT '200-299',
  keyword         TEXT,
  interval_sec    INTEGER NOT NULL DEFAULT 60,
  timeout_ms      INTEGER NOT NULL DEFAULT 10000,
  warn_days       INTEGER NOT NULL DEFAULT 14,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Live status for every monitor, packed into ONE row.
-- Writing N per-monitor rows every minute would cost 50 * 1440 = 72k rows
-- written/day against a 100k budget. One JSON blob costs ~1.4k/day instead.
-- 所有监控的实时状态打包为一行。若每分钟分别写入 50 行，每天需写入
-- 50 * 1440 = 72k 行，而预算为 100k；单个 JSON 数据块每天约需 1.4k 次写入。
CREATE TABLE IF NOT EXISTS live_state (
  id         TEXT PRIMARY KEY,
  json       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per monitor holding the entire daily availability history as JSON.
-- A status page showing 50 monitors reads 50 rows, not 50 * days.
-- 每个监控用一行 JSON 保存完整的每日可用性历史；显示 50 个监控只需读取 50 行，
-- 而不是 50 * 天数行。
CREATE TABLE IF NOT EXISTS monitor_uptime (
  monitor_id TEXT PRIMARY KEY,
  days_json  TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- State transitions only. A steady monitor writes nothing.
-- 仅记录状态变化；稳定的监控不产生写入。
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT    NOT NULL,
  status     INTEGER NOT NULL,
  message    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_monitor ON events(monitor_id, created_at DESC);
