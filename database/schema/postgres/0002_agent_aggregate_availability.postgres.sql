ALTER TABLE machine_live ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE machine_live ADD COLUMN IF NOT EXISTS public_ipv6 TEXT;
ALTER TABLE machine_live ADD COLUMN IF NOT EXISTS report_interval_secs INTEGER;
ALTER TABLE machine_history ADD COLUMN IF NOT EXISTS sample_count INTEGER;
ALTER TABLE machine_history ADD COLUMN IF NOT EXISTS duration_sec INTEGER;
ALTER TABLE machine_history ADD COLUMN IF NOT EXISTS quality TEXT;
ALTER TABLE machine_history ADD COLUMN IF NOT EXISTS net_up_bytes BIGINT;
ALTER TABLE machine_history ADD COLUMN IF NOT EXISTS net_down_bytes BIGINT;
ALTER TABLE machine_history ADD COLUMN IF NOT EXISTS network_duration_sec INTEGER;

CREATE TABLE IF NOT EXISTS agent_uptime_daily (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  total INTEGER NOT NULL,
  up INTEGER NOT NULL,
  warn INTEGER NOT NULL,
  last_minute_ts INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, day)
);
