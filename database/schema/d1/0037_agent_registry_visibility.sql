-- Independent machines, explicit Agent monitors, and monitor visibility.
-- 独立机器登记、显式 Agent 监控关联，以及监控公开设置。
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  group_id TEXT REFERENCES monitor_groups(id) ON DELETE SET NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO agents (id,name,token,active,group_id,options_json,created_at,updated_at)
  SELECT id,name,agent_token,active,group_id,
    json_object('probe_enabled',json(CASE WHEN json_extract(options_json,'$.probe_enabled')=0 THEN 'false' ELSE 'true' END)),created_at,updated_at
  FROM monitors WHERE type='agent';
ALTER TABLE monitors ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT;
ALTER TABLE monitors ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1));
UPDATE monitors SET agent_id=id, options_json=json_remove(options_json,'$.probe_enabled') WHERE type='agent';
UPDATE monitors SET agent_id=json_extract(options_json,'$.check_source.agent_id') WHERE type IN ('http','tcp') AND json_extract(options_json,'$.check_source.type')='agent';
CREATE INDEX idx_monitors_agent_id ON monitors(agent_id);
CREATE INDEX idx_monitors_public_active ON monitors(is_public,active);

CREATE TABLE machine_live_separated (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,

  os TEXT,
  arch TEXT,
  kernel TEXT,
  cpu_model TEXT,
  cpu_cores INTEGER,

  cpu_usage REAL,
  mem_used INTEGER,
  mem_total INTEGER,
  swap_used INTEGER,
  swap_total INTEGER,
  load_1 REAL,
  load_5 REAL,
  load_15 REAL,
  disk_used INTEGER,
  disk_total INTEGER,
  net_up_rate INTEGER,
  net_down_rate INTEGER,
  net_up_total INTEGER,
  net_down_total INTEGER,
  connections_tcp INTEGER,
  connections_udp INTEGER,
  process_count INTEGER,
  uptime INTEGER,
  message TEXT,

  reported_at INTEGER,
  updated_at INTEGER NOT NULL
, public_ip     TEXT, isp           TEXT, region        TEXT, virtualization TEXT, interfaces_json TEXT, mounts_json      TEXT, transport TEXT, version TEXT, public_ipv6 TEXT, report_interval_secs INTEGER, probe_capabilities TEXT);
INSERT INTO machine_live_separated (agent_id,os,arch,kernel,cpu_model,cpu_cores,cpu_usage,mem_used,mem_total,swap_used,swap_total,load_1,load_5,load_15,disk_used,disk_total,net_up_rate,net_down_rate,net_up_total,net_down_total,connections_tcp,connections_udp,process_count,uptime,message,reported_at,updated_at,public_ip,isp,region,virtualization,interfaces_json,mounts_json,transport,version,public_ipv6,report_interval_secs,probe_capabilities) SELECT monitor_id,os,arch,kernel,cpu_model,cpu_cores,cpu_usage,mem_used,mem_total,swap_used,swap_total,load_1,load_5,load_15,disk_used,disk_total,net_up_rate,net_down_rate,net_up_total,net_down_total,connections_tcp,connections_udp,process_count,uptime,message,reported_at,updated_at,public_ip,isp,region,virtualization,interfaces_json,mounts_json,transport,version,public_ipv6,report_interval_secs,probe_capabilities FROM machine_live;
DROP TABLE machine_live;
ALTER TABLE machine_live_separated RENAME TO machine_live;

CREATE TABLE machine_history_separated (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  bucket_ts INTEGER NOT NULL,

  cpu_avg REAL,
  cpu_max REAL,
  mem_pct_avg REAL,
  mem_pct_max REAL,
  load_1_avg REAL,
  load_5_avg REAL, sample_count INTEGER, duration_sec INTEGER, quality TEXT, net_up_bytes INTEGER, net_down_bytes INTEGER, network_duration_sec INTEGER,

  PRIMARY KEY (agent_id, bucket_ts)
) WITHOUT ROWID;
INSERT INTO machine_history_separated (agent_id,bucket_ts,cpu_avg,cpu_max,mem_pct_avg,mem_pct_max,load_1_avg,load_5_avg,sample_count,duration_sec,quality,net_up_bytes,net_down_bytes,network_duration_sec) SELECT monitor_id,bucket_ts,cpu_avg,cpu_max,mem_pct_avg,mem_pct_max,load_1_avg,load_5_avg,sample_count,duration_sec,quality,net_up_bytes,net_down_bytes,network_duration_sec FROM machine_history;
DROP TABLE machine_history;
ALTER TABLE machine_history_separated RENAME TO machine_history;

CREATE TABLE agent_runtime_configs_separated (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  desired_json TEXT,
  desired_revision TEXT,
  reported_json TEXT,
  applied_revision TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO agent_runtime_configs_separated (agent_id,desired_json,desired_revision,reported_json,applied_revision,last_error,updated_at) SELECT monitor_id,desired_json,desired_revision,reported_json,applied_revision,last_error,updated_at FROM agent_runtime_configs;
DROP TABLE agent_runtime_configs;
ALTER TABLE agent_runtime_configs_separated RENAME TO agent_runtime_configs;

DROP INDEX idx_monitors_agent_token;
ALTER TABLE monitors DROP COLUMN agent_token;
ALTER TABLE agent_probe_jobs ADD COLUMN check_ssl INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_probe_jobs ADD COLUMN check_domain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_probe_jobs ADD COLUMN check_dns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_probe_jobs ADD COLUMN warn_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE agent_probe_jobs ADD COLUMN requested_addons_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_probe_jobs ADD COLUMN addons_json TEXT;
