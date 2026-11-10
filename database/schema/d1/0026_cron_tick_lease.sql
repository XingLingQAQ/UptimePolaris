CREATE TABLE IF NOT EXISTS cron_tick_lease (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  owner            TEXT,
  lease_until      INTEGER NOT NULL DEFAULT 0,
  completed_minute INTEGER NOT NULL DEFAULT -1
);
