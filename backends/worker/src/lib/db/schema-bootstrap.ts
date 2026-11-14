/**
 * GENERATED FILE - do not edit by hand.
 *
 * The D1 schema, as statements, embedded for `backends/worker/src/lib/db/bootstrap.ts` to apply
 * on the first request against an empty database. Written by
 * `scripts/db/build-schema-bootstrap.mjs` from `database/schema/d1/*.sql`, which remain
 * the source of truth; `test/db/schema-bootstrap.test.mjs` fails if this copy and
 * those files disagree.
 *
 * Regenerate with `npm run schema:build`.
 *
 * 自动生成的 D1 迁移语句，供 backends/worker/src/lib/db/bootstrap.ts 在空库首次请求时执行。
 * scripts/db/build-schema-bootstrap.mjs 从作为真实来源的 database/schema/d1/*.sql 生成本文件；
 * test/db/schema-bootstrap.test.mjs 会检查两者是否一致。使用 npm run schema:build 重新生成。
 */

export interface BootstrapFile {
  /** The migration's filename, as the ledger records it. / 迁移记录表中的文件名。 */
  name: string;
  statements: readonly string[];
}

/**
 * The migration ledger, matching the one `wrangler d1 migrations apply` writes.
 *
 * Same table and columns on purpose: an operator who runs `npm run db:init`
 * afterwards must find this ledger already correct rather than a second,
 * parallel record of what has been applied.
 * 迁移记录表与 wrangler d1 migrations apply 的表及列一致；操作员后续运行 npm run db:init
 * 时会找到正确的现有记录，而非另一份并行记录。
 */
export const LEDGER_DDL = "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

/** Every D1 migration, in application order. / 按执行顺序排列的全部 D1 迁移。 */
export const BOOTSTRAP_FILES: readonly BootstrapFile[] = [
  {
    name: "0001_init.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS monitors (\n  id              TEXT PRIMARY KEY,\n  name            TEXT    NOT NULL,\n  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp')),\n  target          TEXT    NOT NULL,\n  method          TEXT    NOT NULL DEFAULT 'GET',\n  expected_status TEXT    NOT NULL DEFAULT '200-299',\n  keyword         TEXT,\n  interval_sec    INTEGER NOT NULL DEFAULT 60,\n  timeout_ms      INTEGER NOT NULL DEFAULT 10000,\n  warn_days       INTEGER NOT NULL DEFAULT 14,\n  active          INTEGER NOT NULL DEFAULT 1,\n  created_at      INTEGER NOT NULL,\n  updated_at      INTEGER NOT NULL\n)",
      "CREATE TABLE IF NOT EXISTS live_state (\n  id         TEXT PRIMARY KEY,\n  json       TEXT    NOT NULL,\n  updated_at INTEGER NOT NULL\n) WITHOUT ROWID",
      "CREATE TABLE IF NOT EXISTS monitor_uptime (\n  monitor_id TEXT PRIMARY KEY,\n  days_json  TEXT    NOT NULL,\n  updated_at INTEGER NOT NULL\n) WITHOUT ROWID",
      "CREATE TABLE IF NOT EXISTS events (\n  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n  monitor_id TEXT    NOT NULL,\n  status     INTEGER NOT NULL,\n  message    TEXT,\n  created_at INTEGER NOT NULL\n)",
      "CREATE INDEX IF NOT EXISTS idx_events_monitor ON events(monitor_id, created_at DESC)",
    ],
  },
  {
    name: "0002_ui_support.sql",
    statements: [
      "ALTER TABLE monitors ADD COLUMN num_id INTEGER",
      "UPDATE monitors SET num_id = rowid WHERE num_id IS NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_num_id ON monitors(num_id)",
      "CREATE TABLE IF NOT EXISTS heartbeat_ring (\n  id         TEXT PRIMARY KEY,\n  json       TEXT    NOT NULL,\n  updated_at INTEGER NOT NULL\n) WITHOUT ROWID",
    ],
  },
  {
    name: "0003_auth.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS users (\n  id            TEXT PRIMARY KEY,\n  username      TEXT    NOT NULL,\n  password_hash TEXT    NOT NULL,\n  created_at    INTEGER NOT NULL,\n  updated_at    INTEGER NOT NULL,\n  failed_count  INTEGER NOT NULL DEFAULT 0,\n  locked_until  INTEGER NOT NULL DEFAULT 0\n)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)",
      "CREATE TABLE IF NOT EXISTS sessions (\n  token_hash TEXT PRIMARY KEY,\n  user_id    TEXT    NOT NULL,\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  user_agent TEXT\n) WITHOUT ROWID",
      "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
    ],
  },
  {
    name: "0005_monitor_addons.sql",
    statements: [
      "ALTER TABLE monitors ADD COLUMN check_ssl    INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE monitors ADD COLUMN check_domain INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    name: "0006_notifications.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS notifications (\n  id          TEXT PRIMARY KEY,\n  name        TEXT NOT NULL,\n  type        TEXT NOT NULL CHECK (type IN ('telegram','feishu')),\n  config_json TEXT NOT NULL,\n  active      INTEGER NOT NULL DEFAULT 1,\n  created_at  INTEGER NOT NULL,\n  updated_at  INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0007_notification_providers.sql",
    statements: [
      "CREATE TABLE notifications_new (\n  id          TEXT PRIMARY KEY,\n  name        TEXT NOT NULL,\n  type        TEXT NOT NULL CHECK (type IN (\n                'telegram','feishu','slack','discord','webhook','apprise','serverchan'\n              )),\n  config_json TEXT NOT NULL,\n  active      INTEGER NOT NULL DEFAULT 1,\n  created_at  INTEGER NOT NULL,\n  updated_at  INTEGER NOT NULL\n)",
      "INSERT INTO notifications_new\n  SELECT id, name, type, config_json, active, created_at, updated_at FROM notifications",
      "DROP TABLE notifications",
      "ALTER TABLE notifications_new RENAME TO notifications",
    ],
  },
  {
    name: "0008_monitor_types.sql",
    statements: [
      "ALTER TABLE monitors ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE monitors ADD COLUMN push_token TEXT",
      "CREATE TABLE monitors_new (\n  id              TEXT PRIMARY KEY,\n  num_id          INTEGER,\n  name            TEXT    NOT NULL,\n  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp', 'push')),\n  target          TEXT    NOT NULL,\n  method          TEXT    NOT NULL DEFAULT 'GET',\n  expected_status TEXT    NOT NULL DEFAULT '200-299',\n  keyword         TEXT,\n  interval_sec    INTEGER NOT NULL DEFAULT 60,\n  timeout_ms      INTEGER NOT NULL DEFAULT 10000,\n  warn_days       INTEGER NOT NULL DEFAULT 14,\n  check_ssl       INTEGER NOT NULL DEFAULT 0,\n  check_domain    INTEGER NOT NULL DEFAULT 0,\n  options_json    TEXT    NOT NULL DEFAULT '{}',\n  push_token      TEXT,\n  active          INTEGER NOT NULL DEFAULT 1,\n  created_at      INTEGER NOT NULL,\n  updated_at      INTEGER NOT NULL\n)",
      "INSERT INTO monitors_new\n  (id, num_id, name, type, target, method, expected_status, keyword,\n   interval_sec, timeout_ms, warn_days, check_ssl, check_domain,\n   options_json, push_token, active, created_at, updated_at)\n  SELECT\n   id, num_id, name, type, target, method, expected_status, keyword,\n   interval_sec, timeout_ms, warn_days, check_ssl, check_domain,\n   options_json, push_token, active, created_at, updated_at\n  FROM monitors",
      "DROP TABLE monitors",
      "ALTER TABLE monitors_new RENAME TO monitors",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_num_id ON monitors(num_id)",
      "CREATE TABLE IF NOT EXISTS push_heartbeats (\n  monitor_id TEXT PRIMARY KEY,\n  ts         INTEGER NOT NULL,\n  status     INTEGER NOT NULL,\n  msg        TEXT NOT NULL DEFAULT '',\n  ping       INTEGER NOT NULL DEFAULT 0\n)",
      "CREATE INDEX IF NOT EXISTS idx_monitors_push_token ON monitors(push_token)",
    ],
  },
  {
    name: "0009_groups_tags.sql",
    statements: [
      "ALTER TABLE monitors ADD COLUMN group_id TEXT",
      "CREATE TABLE IF NOT EXISTS monitor_groups (\n  id         TEXT PRIMARY KEY,\n  name       TEXT NOT NULL,\n  weight     INTEGER NOT NULL DEFAULT 0,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_groups_name ON monitor_groups(name)",
      "CREATE TABLE IF NOT EXISTS tags (\n  id         TEXT PRIMARY KEY,\n  name       TEXT NOT NULL,\n  color      TEXT NOT NULL DEFAULT '#006FEE',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name)",
      "CREATE TABLE IF NOT EXISTS monitor_tags (\n  monitor_id TEXT NOT NULL,\n  tag_id     TEXT NOT NULL,\n  PRIMARY KEY (monitor_id, tag_id)\n)",
      "CREATE INDEX IF NOT EXISTS idx_monitor_tags_tag ON monitor_tags(tag_id)",
      "CREATE INDEX IF NOT EXISTS idx_monitors_group ON monitors(group_id)",
    ],
  },
  {
    name: "0010_notification_groups.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS notification_groups (\n  notification_id TEXT NOT NULL,\n  group_id        TEXT NOT NULL,\n  PRIMARY KEY (notification_id, group_id)\n)",
      "CREATE INDEX IF NOT EXISTS idx_notification_groups_group ON notification_groups(group_id)",
    ],
  },
  {
    name: "0011_dns_as_addon.sql",
    statements: [
      "ALTER TABLE monitors ADD COLUMN check_dns INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    name: "0012_agent_monitors.sql",
    statements: [
      "ALTER TABLE monitors ADD COLUMN agent_token TEXT",
      "CREATE TABLE monitors_new (\n  id              TEXT PRIMARY KEY,\n  num_id          INTEGER,\n  name            TEXT    NOT NULL,\n  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp', 'push', 'agent')),\n  target          TEXT    NOT NULL,\n  method          TEXT    NOT NULL DEFAULT 'GET',\n  expected_status TEXT    NOT NULL DEFAULT '200-299',\n  keyword         TEXT,\n  interval_sec    INTEGER NOT NULL DEFAULT 60,\n  timeout_ms      INTEGER NOT NULL DEFAULT 10000,\n  warn_days       INTEGER NOT NULL DEFAULT 14,\n  check_ssl       INTEGER NOT NULL DEFAULT 0,\n  check_domain    INTEGER NOT NULL DEFAULT 0,\n  check_dns       INTEGER NOT NULL DEFAULT 0,\n  options_json    TEXT    NOT NULL DEFAULT '{}',\n  push_token      TEXT,\n  agent_token     TEXT,\n  group_id        TEXT,\n  active          INTEGER NOT NULL DEFAULT 1,\n  created_at      INTEGER NOT NULL,\n  updated_at      INTEGER NOT NULL\n)",
      "INSERT INTO monitors_new\n  (id, num_id, name, type, target, method, expected_status, keyword,\n   interval_sec, timeout_ms, warn_days, check_ssl, check_domain, check_dns,\n   options_json, push_token, agent_token, group_id, active, created_at, updated_at)\n  SELECT\n   id, num_id, name, type, target, method, expected_status, keyword,\n   interval_sec, timeout_ms, warn_days, check_ssl, check_domain, check_dns,\n   options_json, push_token, agent_token, group_id, active, created_at, updated_at\n  FROM monitors",
      "DROP TABLE monitors",
      "ALTER TABLE monitors_new RENAME TO monitors",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_num_id ON monitors(num_id)",
      "CREATE INDEX IF NOT EXISTS idx_monitors_push_token ON monitors(push_token)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_agent_token\n  ON monitors(agent_token) WHERE agent_token IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_push_token_unique\n  ON monitors(push_token) WHERE push_token IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS machine_live (\n  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,\n\n  os TEXT,\n  arch TEXT,\n  kernel TEXT,\n  cpu_model TEXT,\n  cpu_cores INTEGER,\n\n  cpu_usage REAL,\n  mem_used INTEGER,\n  mem_total INTEGER,\n  swap_used INTEGER,\n  swap_total INTEGER,\n  load_1 REAL,\n  load_5 REAL,\n  load_15 REAL,\n  disk_used INTEGER,\n  disk_total INTEGER,\n  net_up_rate INTEGER,\n  net_down_rate INTEGER,\n  net_up_total INTEGER,\n  net_down_total INTEGER,\n  connections_tcp INTEGER,\n  connections_udp INTEGER,\n  process_count INTEGER,\n  uptime INTEGER,\n  message TEXT,\n\n  reported_at INTEGER,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE TABLE IF NOT EXISTS machine_history (\n  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,\n  bucket_ts INTEGER NOT NULL,\n\n  cpu_avg REAL,\n  cpu_max REAL,\n  mem_pct_avg REAL,\n  mem_pct_max REAL,\n  load_1_avg REAL,\n  load_5_avg REAL,\n\n  PRIMARY KEY (monitor_id, bucket_ts)\n) WITHOUT ROWID",
    ],
  },
  {
    name: "0014_agent_extras.sql",
    statements: [
      "ALTER TABLE machine_live ADD COLUMN public_ip     TEXT",
      "ALTER TABLE machine_live ADD COLUMN isp           TEXT",
      "ALTER TABLE machine_live ADD COLUMN region        TEXT",
      "ALTER TABLE machine_live ADD COLUMN virtualization TEXT",
    ],
  },
  {
    name: "0015_agent_nics_mounts.sql",
    statements: [
      "ALTER TABLE machine_live ADD COLUMN interfaces_json TEXT",
      "ALTER TABLE machine_live ADD COLUMN mounts_json      TEXT",
    ],
  },
  {
    name: "0016_housekeeping.sql",
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)",
      "CREATE TABLE IF NOT EXISTS pending_notifications (\n  id           TEXT PRIMARY KEY,\n  event_id     TEXT NOT NULL,\n  channel_id   TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at   INTEGER NOT NULL,\n  UNIQUE(event_id, channel_id)\n)",
    ],
  },
  {
    name: "0017_agent_transport.sql",
    statements: [
      "ALTER TABLE machine_live ADD COLUMN transport TEXT",
    ],
  },
  {
    name: "0018_themes.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS themes (\n  short        TEXT PRIMARY KEY,\n  name         TEXT NOT NULL,\n  version      TEXT NOT NULL,\n  description  TEXT,\n  author       TEXT,\n  source_url   TEXT,\n  manifest_json TEXT NOT NULL,\n  is_active    INTEGER NOT NULL DEFAULT 0,\n  installed_at INTEGER NOT NULL,\n  updated_at   INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_one_active\n  ON themes(is_active) WHERE is_active = 1",
    ],
  },
  {
    name: "0019_theme_catalogs.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS theme_catalogs (\n  url        TEXT PRIMARY KEY,\n  name       TEXT,\n  position   INTEGER NOT NULL DEFAULT 0,\n  fetched_at INTEGER,\n  theme_count INTEGER,\n  added_at   INTEGER NOT NULL\n)",
      "CREATE INDEX IF NOT EXISTS idx_theme_catalogs_position\n  ON theme_catalogs(position, added_at)",
    ],
  },
  {
    name: "0020_theme_settings.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS theme_settings (\n  short      TEXT PRIMARY KEY,\n  values_json TEXT NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0021_agent_aggregate_availability.sql",
    statements: [
      "ALTER TABLE machine_live ADD COLUMN version TEXT",
      "ALTER TABLE machine_live ADD COLUMN public_ipv6 TEXT",
      "ALTER TABLE machine_live ADD COLUMN report_interval_secs INTEGER",
      "ALTER TABLE machine_history ADD COLUMN sample_count INTEGER",
      "ALTER TABLE machine_history ADD COLUMN duration_sec INTEGER",
      "ALTER TABLE machine_history ADD COLUMN quality TEXT",
      "ALTER TABLE machine_history ADD COLUMN net_up_bytes INTEGER",
      "ALTER TABLE machine_history ADD COLUMN net_down_bytes INTEGER",
      "ALTER TABLE machine_history ADD COLUMN network_duration_sec INTEGER",
      "CREATE TABLE agent_uptime_daily (\n  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,\n  day TEXT NOT NULL,\n  total INTEGER NOT NULL,\n  up INTEGER NOT NULL,\n  warn INTEGER NOT NULL,\n  last_minute_ts INTEGER NOT NULL,\n  PRIMARY KEY (monitor_id, day)\n) WITHOUT ROWID",
    ],
  },
  {
    name: "0022_agent_alerts_outbox.sql",
    statements: [
      "ALTER TABLE pending_notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pending_notifications ADD COLUMN next_attempt INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pending_notifications ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS idx_pending_notifications_due ON pending_notifications(next_attempt, lease_until, created_at)",
    ],
  },
  {
    name: "0024_agent_probe_jobs.sql",
    statements: [
      "ALTER TABLE machine_live ADD COLUMN probe_capabilities TEXT",
      "CREATE TABLE IF NOT EXISTS agent_probe_jobs (\n  run_id TEXT PRIMARY KEY,\n  monitor_id TEXT NOT NULL,\n  agent_id TEXT NOT NULL,\n  target TEXT NOT NULL,\n  probe_type TEXT NOT NULL CHECK (probe_type IN ('http', 'tcp')),\n  method TEXT NOT NULL,\n  options_json TEXT NOT NULL,\n  expected_status TEXT NOT NULL,\n  keyword TEXT,\n  timeout_ms INTEGER NOT NULL,\n  interval_sec INTEGER NOT NULL,\n  scheduled_at INTEGER NOT NULL,\n  source_version TEXT NOT NULL,\n  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),\n  lease_token TEXT,\n  lease_until INTEGER,\n  attempts INTEGER NOT NULL DEFAULT 0,\n  observed_at INTEGER,\n  status INTEGER,\n  status_code INTEGER,\n  latency_ms REAL,\n  message TEXT,\n  completed_at INTEGER,\n  consumed_at INTEGER,\n  UNIQUE (monitor_id, scheduled_at)\n)",
      "CREATE INDEX IF NOT EXISTS idx_agent_probe_jobs_poll\n  ON agent_probe_jobs(agent_id, state, scheduled_at)",
      "CREATE INDEX IF NOT EXISTS idx_agent_probe_jobs_latest\n  ON agent_probe_jobs(monitor_id, state, completed_at DESC)",
    ],
  },
  {
    name: "0025_theme_versions.sql",
    statements: [
      "ALTER TABLE themes ADD COLUMN id TEXT",
      "ALTER TABLE themes ADD COLUMN active_version TEXT",
      "ALTER TABLE themes ADD COLUMN previous_active_version TEXT",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_id ON themes(id)",
      "CREATE TABLE IF NOT EXISTS theme_versions (\n  id TEXT NOT NULL,\n  version TEXT NOT NULL,\n  digest TEXT NOT NULL,\n  prefix TEXT NOT NULL,\n  manifest_json TEXT NOT NULL,\n  installed_at INTEGER NOT NULL,\n  PRIMARY KEY (id, version, digest)\n)",
      "CREATE INDEX IF NOT EXISTS idx_theme_versions_latest ON theme_versions(id, installed_at DESC)",
    ],
  },
  {
    name: "0026_cron_tick_lease.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS cron_tick_lease (\n  id               INTEGER PRIMARY KEY CHECK (id = 1),\n  owner            TEXT,\n  lease_until      INTEGER NOT NULL DEFAULT 0,\n  completed_minute INTEGER NOT NULL DEFAULT -1\n)",
    ],
  },
  {
    name: "0027_auth_setup.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS auth_login_limits (\n  key_hash TEXT PRIMARY KEY,\n  attempts INTEGER NOT NULL,\n  window_started INTEGER NOT NULL,\n  locked_until INTEGER NOT NULL DEFAULT 0\n)",
      "CREATE INDEX IF NOT EXISTS idx_auth_login_limits_window_started\n  ON auth_login_limits(window_started)",
      "CREATE TABLE IF NOT EXISTS auth_setup_state (\n  id INTEGER PRIMARY KEY CHECK (id = 1),\n  completed INTEGER NOT NULL DEFAULT 0,\n  claim_id TEXT\n)",
      "INSERT INTO auth_setup_state (id, completed, claim_id)\nSELECT 1,\n  CASE WHEN EXISTS (\n    SELECT 1 FROM users\n  ) THEN 1 ELSE 0 END,\n  NULL\nWHERE NOT EXISTS (SELECT 1 FROM auth_setup_state WHERE id = 1)",
    ],
  },
  {
    name: "0029_agent_commands.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS agent_commands (\r\n  id             TEXT PRIMARY KEY,\r\n  agent_id       TEXT NOT NULL,\r\n  action         TEXT NOT NULL CHECK (action IN ('upgrade', 'restart', 're_report')),\r\n  queued_at      INTEGER NOT NULL,\r\n  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),\r\n  lease_token    TEXT,\r\n  lease_until    INTEGER,\r\n  attempts       INTEGER NOT NULL DEFAULT 0,\r\n  ok             INTEGER,\r\n  message        TEXT,\r\n  completed_at   INTEGER,\r\n  issued_by      TEXT\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_agent_commands_poll\r\n  ON agent_commands(agent_id, state, queued_at)",
      "CREATE INDEX IF NOT EXISTS idx_agent_commands_recent\r\n  ON agent_commands(agent_id, queued_at DESC)",
    ],
  },
  {
    name: "0030_agent_check_update.sql",
    statements: [
      "CREATE TABLE agent_commands_new (\r\n  id             TEXT PRIMARY KEY,\r\n  agent_id       TEXT NOT NULL,\r\n  action         TEXT NOT NULL CHECK (action IN ('upgrade', 'restart', 're_report', 'check_update')),\r\n  queued_at      INTEGER NOT NULL,\r\n  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),\r\n  lease_token    TEXT,\r\n  lease_until    INTEGER,\r\n  attempts       INTEGER NOT NULL DEFAULT 0,\r\n  ok             INTEGER,\r\n  message        TEXT,\r\n  completed_at   INTEGER,\r\n  issued_by      TEXT\r\n)",
      "INSERT INTO agent_commands_new\r\n  (id, agent_id, action, queued_at, state, lease_token, lease_until, attempts, ok, message, completed_at, issued_by)\r\n  SELECT\r\n   id, agent_id, action, queued_at, state, lease_token, lease_until, attempts, ok, message, completed_at, issued_by\r\n  FROM agent_commands",
      "DROP TABLE agent_commands",
      "ALTER TABLE agent_commands_new RENAME TO agent_commands",
      "CREATE INDEX IF NOT EXISTS idx_agent_commands_poll\r\n  ON agent_commands(agent_id, state, queued_at)",
      "CREATE INDEX IF NOT EXISTS idx_agent_commands_recent\r\n  ON agent_commands(agent_id, queued_at DESC)",
    ],
  },
  {
    name: "0031_notification_deliveries.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS notification_deliveries (\n  id           TEXT PRIMARY KEY,\n  channel_id   TEXT NOT NULL,\n  monitor_id   TEXT,\n  monitor_name TEXT,\n  status       INTEGER NOT NULL,\n  ok           INTEGER NOT NULL,\n  latency_ms   INTEGER NOT NULL,\n  error        TEXT,\n  created_at   INTEGER NOT NULL\n)",
      "CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created\n  ON notification_deliveries(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel\n  ON notification_deliveries(channel_id, created_at DESC)",
    ],
  },
  {
    name: "0032_usage_daily.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS usage_daily (\n  day               TEXT PRIMARY KEY,\n  rows_read         INTEGER NOT NULL DEFAULT 0,\n  rows_written      INTEGER NOT NULL DEFAULT 0,\n  statements        INTEGER NOT NULL DEFAULT 0,\n  ticks             INTEGER NOT NULL DEFAULT 0,\n  peak_subrequests  INTEGER NOT NULL DEFAULT 0,\n  updated_at        INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0034_site_icon.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS site_icon (\n  singleton     INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),\n  bytes         BLOB NOT NULL,\n  content_type  TEXT NOT NULL,\n  byte_size     INTEGER NOT NULL,\n  filename      TEXT,\n  updated_at    INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0035_user_avatars.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS user_avatars (\n  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,\n  data_url TEXT NOT NULL,\n  version TEXT NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0036_agent_runtime_config.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS agent_runtime_configs (\n  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,\n  desired_json TEXT,\n  desired_revision TEXT,\n  reported_json TEXT,\n  applied_revision TEXT,\n  last_error TEXT,\n  updated_at INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0037_agent_registry_visibility.sql",
    statements: [
      "CREATE TABLE agents (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  token TEXT NOT NULL UNIQUE,\n  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),\n  group_id TEXT REFERENCES monitor_groups(id) ON DELETE SET NULL,\n  options_json TEXT NOT NULL DEFAULT '{}',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "INSERT INTO agents (id,name,token,active,group_id,options_json,created_at,updated_at)\n  SELECT id,name,agent_token,active,group_id,\n    json_object('probe_enabled',json(CASE WHEN json_extract(options_json,'$.probe_enabled')=0 THEN 'false' ELSE 'true' END)),created_at,updated_at\n  FROM monitors WHERE type='agent'",
      "ALTER TABLE monitors ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT",
      "ALTER TABLE monitors ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1))",
      "UPDATE monitors SET agent_id=id, options_json=json_remove(options_json,'$.probe_enabled') WHERE type='agent'",
      "UPDATE monitors SET agent_id=json_extract(options_json,'$.check_source.agent_id') WHERE type IN ('http','tcp') AND json_extract(options_json,'$.check_source.type')='agent'",
      "CREATE INDEX idx_monitors_agent_id ON monitors(agent_id)",
      "CREATE INDEX idx_monitors_public_active ON monitors(is_public,active)",
      "CREATE TABLE machine_live_separated (\n  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,\n\n  os TEXT,\n  arch TEXT,\n  kernel TEXT,\n  cpu_model TEXT,\n  cpu_cores INTEGER,\n\n  cpu_usage REAL,\n  mem_used INTEGER,\n  mem_total INTEGER,\n  swap_used INTEGER,\n  swap_total INTEGER,\n  load_1 REAL,\n  load_5 REAL,\n  load_15 REAL,\n  disk_used INTEGER,\n  disk_total INTEGER,\n  net_up_rate INTEGER,\n  net_down_rate INTEGER,\n  net_up_total INTEGER,\n  net_down_total INTEGER,\n  connections_tcp INTEGER,\n  connections_udp INTEGER,\n  process_count INTEGER,\n  uptime INTEGER,\n  message TEXT,\n\n  reported_at INTEGER,\n  updated_at INTEGER NOT NULL\n, public_ip     TEXT, isp           TEXT, region        TEXT, virtualization TEXT, interfaces_json TEXT, mounts_json      TEXT, transport TEXT, version TEXT, public_ipv6 TEXT, report_interval_secs INTEGER, probe_capabilities TEXT)",
      "INSERT INTO machine_live_separated (agent_id,os,arch,kernel,cpu_model,cpu_cores,cpu_usage,mem_used,mem_total,swap_used,swap_total,load_1,load_5,load_15,disk_used,disk_total,net_up_rate,net_down_rate,net_up_total,net_down_total,connections_tcp,connections_udp,process_count,uptime,message,reported_at,updated_at,public_ip,isp,region,virtualization,interfaces_json,mounts_json,transport,version,public_ipv6,report_interval_secs,probe_capabilities) SELECT monitor_id,os,arch,kernel,cpu_model,cpu_cores,cpu_usage,mem_used,mem_total,swap_used,swap_total,load_1,load_5,load_15,disk_used,disk_total,net_up_rate,net_down_rate,net_up_total,net_down_total,connections_tcp,connections_udp,process_count,uptime,message,reported_at,updated_at,public_ip,isp,region,virtualization,interfaces_json,mounts_json,transport,version,public_ipv6,report_interval_secs,probe_capabilities FROM machine_live",
      "DROP TABLE machine_live",
      "ALTER TABLE machine_live_separated RENAME TO machine_live",
      "CREATE TABLE machine_history_separated (\n  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,\n  bucket_ts INTEGER NOT NULL,\n\n  cpu_avg REAL,\n  cpu_max REAL,\n  mem_pct_avg REAL,\n  mem_pct_max REAL,\n  load_1_avg REAL,\n  load_5_avg REAL, sample_count INTEGER, duration_sec INTEGER, quality TEXT, net_up_bytes INTEGER, net_down_bytes INTEGER, network_duration_sec INTEGER,\n\n  PRIMARY KEY (agent_id, bucket_ts)\n) WITHOUT ROWID",
      "INSERT INTO machine_history_separated (agent_id,bucket_ts,cpu_avg,cpu_max,mem_pct_avg,mem_pct_max,load_1_avg,load_5_avg,sample_count,duration_sec,quality,net_up_bytes,net_down_bytes,network_duration_sec) SELECT monitor_id,bucket_ts,cpu_avg,cpu_max,mem_pct_avg,mem_pct_max,load_1_avg,load_5_avg,sample_count,duration_sec,quality,net_up_bytes,net_down_bytes,network_duration_sec FROM machine_history",
      "DROP TABLE machine_history",
      "ALTER TABLE machine_history_separated RENAME TO machine_history",
      "CREATE TABLE agent_runtime_configs_separated (\n  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,\n  desired_json TEXT,\n  desired_revision TEXT,\n  reported_json TEXT,\n  applied_revision TEXT,\n  last_error TEXT,\n  updated_at INTEGER NOT NULL\n)",
      "INSERT INTO agent_runtime_configs_separated (agent_id,desired_json,desired_revision,reported_json,applied_revision,last_error,updated_at) SELECT monitor_id,desired_json,desired_revision,reported_json,applied_revision,last_error,updated_at FROM agent_runtime_configs",
      "DROP TABLE agent_runtime_configs",
      "ALTER TABLE agent_runtime_configs_separated RENAME TO agent_runtime_configs",
      "DROP INDEX idx_monitors_agent_token",
      "ALTER TABLE monitors DROP COLUMN agent_token",
      "ALTER TABLE agent_probe_jobs ADD COLUMN check_ssl INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE agent_probe_jobs ADD COLUMN check_domain INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE agent_probe_jobs ADD COLUMN check_dns INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE agent_probe_jobs ADD COLUMN warn_days INTEGER NOT NULL DEFAULT 14",
      "ALTER TABLE agent_probe_jobs ADD COLUMN requested_addons_json TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE agent_probe_jobs ADD COLUMN addons_json TEXT",
    ],
  },
  {
    name: "0038_agent_inventory.sql",
    statements: [
      "ALTER TABLE agents DROP COLUMN group_id",
    ],
  },
  {
    name: "0039_agent_network_probes.sql",
    statements: [
      "CREATE TABLE saved_agent_uptime AS SELECT * FROM agent_uptime_daily",
      "DROP TABLE agent_uptime_daily",
      "CREATE TABLE monitors_agent_protocols (\n  id              TEXT PRIMARY KEY,\n  num_id          INTEGER,\n  name            TEXT    NOT NULL,\n  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp', 'udp', 'icmp', 'push', 'agent')),\n  target          TEXT    NOT NULL,\n  method          TEXT    NOT NULL DEFAULT 'GET',\n  expected_status TEXT    NOT NULL DEFAULT '200-299',\n  keyword         TEXT,\n  interval_sec    INTEGER NOT NULL DEFAULT 60,\n  timeout_ms      INTEGER NOT NULL DEFAULT 10000,\n  warn_days       INTEGER NOT NULL DEFAULT 14,\n  check_ssl       INTEGER NOT NULL DEFAULT 0,\n  check_domain    INTEGER NOT NULL DEFAULT 0,\n  check_dns       INTEGER NOT NULL DEFAULT 0,\n  options_json    TEXT    NOT NULL DEFAULT '{}',\n  push_token      TEXT,\n  group_id        TEXT,\n  active          INTEGER NOT NULL DEFAULT 1,\n  created_at      INTEGER NOT NULL,\n  updated_at      INTEGER NOT NULL\n, agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT, is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)))",
      "INSERT INTO monitors_agent_protocols (id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,group_id,active,created_at,updated_at,agent_id,is_public) SELECT id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,group_id,active,created_at,updated_at,agent_id,is_public FROM monitors",
      "DROP TABLE monitors",
      "ALTER TABLE monitors_agent_protocols RENAME TO monitors",
      "CREATE UNIQUE INDEX idx_monitors_num_id ON monitors(num_id)",
      "CREATE INDEX idx_monitors_push_token ON monitors(push_token)",
      "CREATE UNIQUE INDEX idx_monitors_push_token_unique\n  ON monitors(push_token) WHERE push_token IS NOT NULL",
      "CREATE INDEX idx_monitors_agent_id ON monitors(agent_id)",
      "CREATE INDEX idx_monitors_public_active ON monitors(is_public,active)",
      "CREATE TABLE agent_uptime_daily (\n  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,\n  day TEXT NOT NULL,\n  total INTEGER NOT NULL,\n  up INTEGER NOT NULL,\n  warn INTEGER NOT NULL,\n  last_minute_ts INTEGER NOT NULL,\n  PRIMARY KEY (monitor_id, day)\n) WITHOUT ROWID",
      "INSERT INTO agent_uptime_daily (monitor_id,day,total,up,warn,last_minute_ts) SELECT monitor_id,day,total,up,warn,last_minute_ts FROM saved_agent_uptime",
      "DROP TABLE saved_agent_uptime",
      "CREATE TABLE agent_probe_jobs_protocols (\n  run_id TEXT PRIMARY KEY,\n  monitor_id TEXT NOT NULL,\n  agent_id TEXT NOT NULL,\n  target TEXT NOT NULL,\n  probe_type TEXT NOT NULL CHECK (probe_type IN ('http', 'tcp', 'udp', 'icmp')),\n  method TEXT NOT NULL,\n  options_json TEXT NOT NULL,\n  expected_status TEXT NOT NULL,\n  keyword TEXT,\n  timeout_ms INTEGER NOT NULL,\n  interval_sec INTEGER NOT NULL,\n  scheduled_at INTEGER NOT NULL,\n  source_version TEXT NOT NULL,\n  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),\n  lease_token TEXT,\n  lease_until INTEGER,\n  attempts INTEGER NOT NULL DEFAULT 0,\n  observed_at INTEGER,\n  status INTEGER,\n  status_code INTEGER,\n  latency_ms REAL,\n  message TEXT,\n  completed_at INTEGER,\n  consumed_at INTEGER, check_ssl INTEGER NOT NULL DEFAULT 0, check_domain INTEGER NOT NULL DEFAULT 0, check_dns INTEGER NOT NULL DEFAULT 0, warn_days INTEGER NOT NULL DEFAULT 14, requested_addons_json TEXT NOT NULL DEFAULT '{}', addons_json TEXT,\n  UNIQUE (monitor_id, scheduled_at)\n)",
      "INSERT INTO agent_probe_jobs_protocols (run_id,monitor_id,agent_id,target,probe_type,method,options_json,expected_status,keyword,timeout_ms,interval_sec,scheduled_at,source_version,state,lease_token,lease_until,attempts,observed_at,status,status_code,latency_ms,message,completed_at,consumed_at,check_ssl,check_domain,check_dns,warn_days,requested_addons_json,addons_json) SELECT run_id,monitor_id,agent_id,target,probe_type,method,options_json,expected_status,keyword,timeout_ms,interval_sec,scheduled_at,source_version,state,lease_token,lease_until,attempts,observed_at,status,status_code,latency_ms,message,completed_at,consumed_at,check_ssl,check_domain,check_dns,warn_days,requested_addons_json,addons_json FROM agent_probe_jobs",
      "DROP TABLE agent_probe_jobs",
      "ALTER TABLE agent_probe_jobs_protocols RENAME TO agent_probe_jobs",
      "CREATE INDEX idx_agent_probe_jobs_poll\n  ON agent_probe_jobs(agent_id, state, scheduled_at)",
      "CREATE INDEX idx_agent_probe_jobs_latest\n  ON agent_probe_jobs(monitor_id, state, completed_at DESC)",
    ],
  },
  {
    name: "0040_presentation.sql",
    statements: [
      "CREATE TABLE presentation_state (id TEXT PRIMARY KEY, published_json TEXT NOT NULL, draft_json TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE agent_groups (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,weight INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
      "CREATE TABLE agent_tags (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
      "ALTER TABLE agents ADD COLUMN group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL",
      "CREATE TABLE agent_tag_links (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES agent_tags(id) ON DELETE CASCADE,PRIMARY KEY(agent_id,tag_id))",
      "CREATE INDEX idx_agents_group ON agents(group_id)",
      "CREATE INDEX idx_agent_tags_lookup ON agent_tag_links(tag_id)",
      "DROP INDEX idx_themes_one_active",
      "ALTER TABLE themes DROP COLUMN previous_active_version",
      "ALTER TABLE themes DROP COLUMN active_version",
      "ALTER TABLE themes DROP COLUMN is_active",
      "DROP TABLE theme_settings",
    ],
  },
  {
    name: "0041_theme_operations.sql",
    statements: [
      "ALTER TABLE themes ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0",
      "CREATE TABLE theme_operations (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    ],
  },
  {
    name: "0042_settings_visibility.sql",
    statements: [
      "ALTER TABLE agents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1))",
      "UPDATE agents SET is_public=1 WHERE EXISTS (\n  SELECT 1 FROM presentation_state p WHERE p.id='main' AND (\n    (json_extract(p.published_json,'$.pages.agent.selection')='selected' AND agents.id IN (SELECT value FROM json_each(p.published_json,'$.pages.agent.ids'))) OR\n    (json_extract(p.published_json,'$.pages.agent.selection')='groups' AND agents.group_id IN (SELECT value FROM json_each(p.published_json,'$.pages.agent.groupIds'))) OR\n    (json_extract(p.published_json,'$.pages.agent.selection')='tags' AND EXISTS (SELECT 1 FROM agent_tag_links l WHERE l.agent_id=agents.id AND l.tag_id IN (SELECT value FROM json_each(p.published_json,'$.pages.agent.tagIds'))))\n  )\n)",
      "CREATE INDEX idx_agents_public_active ON agents(is_public,active)",
      "UPDATE presentation_state SET published_json=json_object(\n  'agentEnabled',json(CASE WHEN json_extract(published_json,'$.agentEnabled')=1 THEN 'true' ELSE 'false' END),\n  'workerService',json_extract(published_json,'$.workerService'),\n  'domains',json_extract(published_json,'$.domains'),\n  'pages',json_object(\n    'monitor',json_object('theme',json_extract(published_json,'$.pages.monitor.theme'),'themeOptions',json_extract(published_json,'$.pages.monitor.themeOptions')),\n    'agent',json_object('theme',json_extract(published_json,'$.pages.agent.theme'),'themeOptions',json_extract(published_json,'$.pages.agent.themeOptions'))\n  )),revision='settings-v2-'||updated_at",
      "ALTER TABLE presentation_state DROP COLUMN draft_json",
      "ALTER TABLE presentation_state RENAME COLUMN published_json TO config_json",
    ],
  },
  {
    name: "0043_presentation_refinements.sql",
    statements: [
      "UPDATE presentation_state SET config_json=json_set(config_json,'$.domains',json((\n  SELECT json_group_array(json_object('hostname',json_extract(value,'$.hostname'),'page',json_extract(value,'$.page')))\n  FROM json_each(presentation_state.config_json,'$.domains')\n))),revision='refinements-'||revision",
    ],
  },
  {
    name: "0044_agent_history_daily.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS agent_history_daily (\r\n  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,\r\n  days_json TEXT NOT NULL,\r\n  updated_at INTEGER NOT NULL\r\n) WITHOUT ROWID",
    ],
  },
];
