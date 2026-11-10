CREATE TABLE IF NOT EXISTS cron_tick_lease (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  owner            TEXT,
  lease_until      BIGINT NOT NULL DEFAULT 0,
  completed_minute BIGINT NOT NULL DEFAULT -1
);
