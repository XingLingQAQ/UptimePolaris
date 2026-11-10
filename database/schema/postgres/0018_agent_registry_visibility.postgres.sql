-- Independent machines, explicit Agent monitors, and monitor visibility.
-- 独立机器登记、显式 Agent 监控关联，以及监控公开设置。
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  group_id TEXT REFERENCES monitor_groups(id) ON DELETE SET NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
INSERT INTO agents (id,name,token,active,group_id,options_json,created_at,updated_at)
  SELECT id,name,agent_token,active,group_id,
    jsonb_build_object('probe_enabled',COALESCE((options_json::jsonb->>'probe_enabled')::boolean,true))::text,created_at,updated_at
  FROM monitors WHERE type='agent';
ALTER TABLE monitors ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT;
ALTER TABLE monitors ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1));
UPDATE monitors SET agent_id=id, options_json=(options_json::jsonb-'probe_enabled')::text WHERE type='agent';
UPDATE monitors SET agent_id=options_json::jsonb#>>'{check_source,agent_id}' WHERE type IN ('http','tcp') AND options_json::jsonb#>>'{check_source,type}'='agent';
CREATE INDEX idx_monitors_agent_id ON monitors(agent_id);
CREATE INDEX idx_monitors_public_active ON monitors(is_public,active);

ALTER TABLE machine_live RENAME COLUMN monitor_id TO agent_id;
ALTER TABLE machine_live ADD CONSTRAINT machine_live_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE machine_history RENAME COLUMN monitor_id TO agent_id;
ALTER TABLE machine_history ADD CONSTRAINT machine_history_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE agent_runtime_configs DROP CONSTRAINT agent_runtime_configs_monitor_id_fkey;
ALTER TABLE agent_runtime_configs RENAME COLUMN monitor_id TO agent_id;
ALTER TABLE agent_runtime_configs ADD CONSTRAINT agent_runtime_configs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE monitors DROP COLUMN agent_token;
ALTER TABLE agent_probe_jobs ADD COLUMN check_ssl INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_probe_jobs ADD COLUMN check_domain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_probe_jobs ADD COLUMN check_dns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_probe_jobs ADD COLUMN warn_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE agent_probe_jobs ADD COLUMN requested_addons_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_probe_jobs ADD COLUMN addons_json TEXT;
