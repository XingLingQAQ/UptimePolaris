-- Delivery log - Postgres mirror of 0031.
-- 投递日志：0031 的 Postgres 对应迁移。
--
-- Same columns and same reasoning as the D1 migration; see that file for why
-- this is a table rather than the Worker log stream.
-- 列和设计理由与 D1 迁移相同；为何使用表而不是 Worker 日志流，参见该迁移。
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  monitor_id   TEXT,
  monitor_name TEXT,
  status       INTEGER NOT NULL,
  ok           BOOLEAN NOT NULL,
  latency_ms   INTEGER NOT NULL,
  error        TEXT,
  created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
  ON notification_deliveries(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel
  ON notification_deliveries(channel_id, created_at DESC);
