-- Delivery log: one row per push attempt, kept so the console can answer
-- "did this channel actually work" without reading Worker logs.
-- 投递日志每次推送尝试记录一行，控制台无需读取 Worker 日志即可查看渠道是否正常工作。
--
-- Why a table and not the log stream: an operator looking at the notifications
-- page needs the last N attempts per channel, with latency and the provider's
-- own error text. Logs are not queryable from the Worker, and `pending_notifications`
-- is an outbox - its rows are deleted on success, so it only ever shows what
-- has *not* been delivered. This table is the inverse: it keeps successes and
-- failures, and it is pruned rather than drained.
-- 通知页面需要查询各渠道最近 N 次尝试、延迟和提供商错误；Worker 无法查询日志流。
-- `pending_notifications` 是成功后删除记录的发件箱，只显示未投递内容；此表保留成功和
-- 失败记录，并按时间清理。
--
-- `monitor_name` is denormalised on purpose. A delivery record outlives the
-- monitor it was about (the monitor can be deleted, or renamed), and a log that
-- says "monitor a3f9..." after the row is gone is unreadable. The name is what
-- the operator recognises, so it is copied at write time.
-- `monitor_name` 有意反规范化：投递记录可能比监控存续更久（监控可删除或改名），
-- 仅显示已删除记录的 ID 难以辨认，因此写入时复制管理员熟悉的名称。
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  monitor_id   TEXT,
  monitor_name TEXT,
  -- The transition that was pushed: 0 down, 1 recovered, 2 warning.
  -- 已推送的状态变化：0 故障、1 恢复、2 警告。
  status       INTEGER NOT NULL,
  ok           INTEGER NOT NULL,
  latency_ms   INTEGER NOT NULL,
  -- The provider's own error text when `ok` is 0. Never the channel config.
  -- `ok` 为 0 时提供商返回的错误文本，不包含渠道配置。
  error        TEXT,
  created_at   INTEGER NOT NULL
);

-- The console reads newest-first, and the daily prune scans by age. One index
-- serves both because both start from `created_at`.
-- 控制台按最新时间读取，每日清理按时间扫描；两者均以 `created_at` 开头，共用一个索引。
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
  ON notification_deliveries(created_at DESC);

-- Per-channel statistics filter by channel and time together.
-- 按渠道统计时同时按渠道和时间过滤。
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel
  ON notification_deliveries(channel_id, created_at DESC);
