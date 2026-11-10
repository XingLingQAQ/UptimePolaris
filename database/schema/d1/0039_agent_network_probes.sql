-- Preserve monitor identities, availability and in-flight jobs while adding Agent protocols.
-- 添加 Agent 协议时保留监控标识、可用率和进行中的任务。
CREATE TABLE saved_agent_uptime AS SELECT * FROM agent_uptime_daily;

DROP TABLE agent_uptime_daily;

CREATE TABLE monitors_agent_protocols (
  id              TEXT PRIMARY KEY,
  num_id          INTEGER,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp', 'udp', 'icmp', 'push', 'agent')),
  target          TEXT    NOT NULL,
  method          TEXT    NOT NULL DEFAULT 'GET',
  expected_status TEXT    NOT NULL DEFAULT '200-299',
  keyword         TEXT,
  interval_sec    INTEGER NOT NULL DEFAULT 60,
  timeout_ms      INTEGER NOT NULL DEFAULT 10000,
  warn_days       INTEGER NOT NULL DEFAULT 14,
  check_ssl       INTEGER NOT NULL DEFAULT 0,
  check_domain    INTEGER NOT NULL DEFAULT 0,
  check_dns       INTEGER NOT NULL DEFAULT 0,
  options_json    TEXT    NOT NULL DEFAULT '{}',
  push_token      TEXT,
  group_id        TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
, agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT, is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)));

INSERT INTO monitors_agent_protocols (id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,group_id,active,created_at,updated_at,agent_id,is_public) SELECT id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,group_id,active,created_at,updated_at,agent_id,is_public FROM monitors;

DROP TABLE monitors;

ALTER TABLE monitors_agent_protocols RENAME TO monitors;

CREATE UNIQUE INDEX idx_monitors_num_id ON monitors(num_id);

CREATE INDEX idx_monitors_push_token ON monitors(push_token);

CREATE UNIQUE INDEX idx_monitors_push_token_unique
  ON monitors(push_token) WHERE push_token IS NOT NULL;

CREATE INDEX idx_monitors_agent_id ON monitors(agent_id);

CREATE INDEX idx_monitors_public_active ON monitors(is_public,active);

CREATE TABLE agent_uptime_daily (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  total INTEGER NOT NULL,
  up INTEGER NOT NULL,
  warn INTEGER NOT NULL,
  last_minute_ts INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID;

INSERT INTO agent_uptime_daily (monitor_id,day,total,up,warn,last_minute_ts) SELECT monitor_id,day,total,up,warn,last_minute_ts FROM saved_agent_uptime;

DROP TABLE saved_agent_uptime;

CREATE TABLE agent_probe_jobs_protocols (
  run_id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  target TEXT NOT NULL,
  probe_type TEXT NOT NULL CHECK (probe_type IN ('http', 'tcp', 'udp', 'icmp')),
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
  consumed_at INTEGER, check_ssl INTEGER NOT NULL DEFAULT 0, check_domain INTEGER NOT NULL DEFAULT 0, check_dns INTEGER NOT NULL DEFAULT 0, warn_days INTEGER NOT NULL DEFAULT 14, requested_addons_json TEXT NOT NULL DEFAULT '{}', addons_json TEXT,
  UNIQUE (monitor_id, scheduled_at)
);

INSERT INTO agent_probe_jobs_protocols (run_id,monitor_id,agent_id,target,probe_type,method,options_json,expected_status,keyword,timeout_ms,interval_sec,scheduled_at,source_version,state,lease_token,lease_until,attempts,observed_at,status,status_code,latency_ms,message,completed_at,consumed_at,check_ssl,check_domain,check_dns,warn_days,requested_addons_json,addons_json) SELECT run_id,monitor_id,agent_id,target,probe_type,method,options_json,expected_status,keyword,timeout_ms,interval_sec,scheduled_at,source_version,state,lease_token,lease_until,attempts,observed_at,status,status_code,latency_ms,message,completed_at,consumed_at,check_ssl,check_domain,check_dns,warn_days,requested_addons_json,addons_json FROM agent_probe_jobs;

DROP TABLE agent_probe_jobs;

ALTER TABLE agent_probe_jobs_protocols RENAME TO agent_probe_jobs;

CREATE INDEX idx_agent_probe_jobs_poll
  ON agent_probe_jobs(agent_id, state, scheduled_at);

CREATE INDEX idx_agent_probe_jobs_latest
  ON agent_probe_jobs(monitor_id, state, completed_at DESC);
