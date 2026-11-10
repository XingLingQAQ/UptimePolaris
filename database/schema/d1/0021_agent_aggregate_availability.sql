ALTER TABLE machine_live ADD COLUMN version TEXT;
ALTER TABLE machine_live ADD COLUMN public_ipv6 TEXT;
ALTER TABLE machine_live ADD COLUMN report_interval_secs INTEGER;
ALTER TABLE machine_history ADD COLUMN sample_count INTEGER;
ALTER TABLE machine_history ADD COLUMN duration_sec INTEGER;
ALTER TABLE machine_history ADD COLUMN quality TEXT;
ALTER TABLE machine_history ADD COLUMN net_up_bytes INTEGER;
ALTER TABLE machine_history ADD COLUMN net_down_bytes INTEGER;
ALTER TABLE machine_history ADD COLUMN network_duration_sec INTEGER;

CREATE TABLE agent_uptime_daily (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  total INTEGER NOT NULL,
  up INTEGER NOT NULL,
  warn INTEGER NOT NULL,
  last_minute_ts INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID;
