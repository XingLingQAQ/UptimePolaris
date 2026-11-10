ALTER TABLE machine_live ADD COLUMN probe_capabilities TEXT;

CREATE TABLE IF NOT EXISTS agent_probe_jobs (
  run_id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  target TEXT NOT NULL,
  probe_type TEXT NOT NULL CHECK (probe_type IN ('http', 'tcp')),
  method TEXT NOT NULL,
  options_json TEXT NOT NULL,
  expected_status TEXT NOT NULL,
  keyword TEXT,
  timeout_ms INTEGER NOT NULL,
  interval_sec INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER,
  status INTEGER,
  status_code INTEGER,
  latency_ms REAL,
  message TEXT,
  completed_at INTEGER,
  consumed_at INTEGER,
  UNIQUE (monitor_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_agent_probe_jobs_poll
  ON agent_probe_jobs(agent_id, state, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_agent_probe_jobs_latest
  ON agent_probe_jobs(monitor_id, state, completed_at DESC);
