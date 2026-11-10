CREATE TABLE IF NOT EXISTS agent_runtime_configs (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  desired_json TEXT,
  desired_revision TEXT,
  reported_json TEXT,
  applied_revision TEXT,
  last_error TEXT,
  updated_at BIGINT NOT NULL
);
