CREATE TABLE IF NOT EXISTS pending_notifications (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE(event_id, channel_id)
);
ALTER TABLE pending_notifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_notifications ADD COLUMN IF NOT EXISTS next_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_notifications ADD COLUMN IF NOT EXISTS lease_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pending_notifications_due ON pending_notifications(next_attempt, lease_until, created_at);
