-- Housekeeping indexes and notification outbox.
--
-- Two things land here:
--
--   1. An index on `events.created_at` for the console's event page. The
--      existing composite `idx_events_monitor (monitor_id, created_at DESC)`
--      cannot serve the global "recent events" listing, which has no
--      `WHERE monitor_id`, so a large events table turns that page into a
--      scan + sort.
--   2. `pending_notifications`, the outbox for notification retries. A
--      transition writes here *within the same D1 batch as the events row and
--      live_state*, so a dispatch failure no longer loses the alert. The row
--      is deleted on success; until the next tick attempts a re-send.
-- 清理索引和通知发件箱包含两项内容：
-- 1. `events.created_at` 索引用于控制台全局近期事件列表。现有复合索引
--    `idx_events_monitor (monitor_id, created_at DESC)` 无法服务没有
--    `WHERE monitor_id` 的查询，事件表较大时会导致扫描和排序。
-- 2. `pending_notifications` 保存待重试通知。状态变化在同一个 D1 批次中写入
--    发件箱、事件行和 live_state，避免投递失败丢失告警；成功后删除，失败则等待下次 tick 重发。

-- 1. events.listRecent can use this index for a global most-recent listing.
-- 1. events.listRecent 使用此索引获取全局近期事件。
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

-- 2. Outbox for notification retries.
-- 2. 用于通知重试的发件箱。
--
-- Row-per-event-per-channel because a single transition can hit multiple
-- scoped channels, each of which can succeed or fail independently.
-- 每个事件和渠道各占一行：同一次状态变化可发送到多个限定范围的渠道，且各自独立成功或失败。
CREATE TABLE IF NOT EXISTS pending_notifications (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(event_id, channel_id)
);
