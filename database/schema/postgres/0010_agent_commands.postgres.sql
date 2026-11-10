CREATE TABLE IF NOT EXISTS agent_commands (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('upgrade', 'restart', 're_report')),
  queued_at      BIGINT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),
  lease_token    TEXT,
  lease_until    BIGINT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  ok             SMALLINT,
  message        TEXT,
  completed_at   BIGINT,
  issued_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_commands_poll
  ON agent_commands(agent_id, state, queued_at);

CREATE INDEX IF NOT EXISTS idx_agent_commands_recent
  ON agent_commands(agent_id, queued_at DESC);
