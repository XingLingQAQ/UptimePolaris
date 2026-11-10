ALTER TABLE pending_notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_notifications ADD COLUMN next_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_notifications ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pending_notifications_due ON pending_notifications(next_attempt, lease_until, created_at);
