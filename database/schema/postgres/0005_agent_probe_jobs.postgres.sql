ALTER TABLE machine_live ADD COLUMN IF NOT EXISTS probe_capabilities TEXT;

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
  scheduled_at BIGINT NOT NULL,
  source_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),
  lease_token TEXT,
  lease_until BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  observed_at BIGINT,
  status INTEGER,
  status_code INTEGER,
  latency_ms DOUBLE PRECISION,
  message TEXT,
  completed_at BIGINT,
  consumed_at BIGINT,
  UNIQUE (monitor_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_agent_probe_jobs_poll
  ON agent_probe_jobs(agent_id, state, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_agent_probe_jobs_latest
  ON agent_probe_jobs(monitor_id, state, completed_at DESC);
