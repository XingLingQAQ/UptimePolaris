import type { Env } from '../../types';
import type { DBAdapter } from './adapter';
import { getDB } from './factory';

/**
 * Probe PostgreSQL schema compatibility; D1 bootstrap is separate.
 * setup-postgres.ts can initialize an empty PG schema during setup; upgrades of
 * existing PostgreSQL databases use scripts/db/db-migrate-postgres.mjs.
 * 探测 PostgreSQL 结构兼容性；D1 单独初始化。setup-postgres.ts 可在安装时创建空库结构，
 * 已有 PostgreSQL 数据库的升级由 scripts/db/db-migrate-postgres.mjs 完成。
 */

/** Files the PG schema must contain, in application order. / PG 结构必须包含的文件，按应用顺序排列。 */
const EXPECTED_PG_MIGRATIONS = [
  '0001_init.postgres.sql',
  '0002_agent_aggregate_availability.postgres.sql',
  '0003_agent_alerts_outbox.postgres.sql',
  '0005_agent_probe_jobs.postgres.sql',
  '0006_theme_versions.postgres.sql',
  '0007_cron_tick_lease.postgres.sql',
  '0008_auth_setup.postgres.sql',
  '0010_agent_commands.postgres.sql',
  '0011_agent_check_update.postgres.sql',
  '0012_notification_deliveries.postgres.sql',
  '0013_usage_daily.postgres.sql',
  '0015_site_icon.postgres.sql',
  '0016_user_avatars.postgres.sql',
  '0017_agent_runtime_config.postgres.sql',
  '0018_agent_registry_visibility.postgres.sql',
  '0019_agent_inventory.postgres.sql',
  '0020_agent_network_probes.postgres.sql',
  '0021_presentation.postgres.sql',
  '0022_theme_operations.postgres.sql',
  '0023_settings_visibility.postgres.sql',
  '0024_presentation_refinements.postgres.sql',
] as const;

export interface MigrateProbeResult {
  ok: boolean;
  /** Files recorded in `schema_migrations`. / `schema_migrations` 中记录的文件。 */
  applied: string[];
  /** Files the runtime expects but the database has not recorded. / 运行时期望但数据库尚未记录的文件。 */
  missing: string[];
}

export async function probeSchema(
  env: Env,
  db?: Pick<DBAdapter, 'type' | 'query'>,
): Promise<MigrateProbeResult> {
  const adapter = db ?? getDB(env);
  if (adapter.type !== 'postgres') {
    return { ok: true, applied: [], missing: [] };
  }

  let applied: string[] = [];
  try {
    const rows = await adapter.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    applied = rows.map((r) => r.name);
  } catch (e) {
    // The very first boot on a fresh database has no ledger table. That is
    // the "operator has not run the migration script yet" signal and it is
    // reported as missing-baseline rather than as a crash.
    // 新数据库首次启动时没有迁移账本，这是管理员尚未运行迁移脚本的信号；
    // 应报告基线缺失，而非崩溃。
    if (!String(e).includes('does not exist')) throw e;
  }

  const missing: string[] = EXPECTED_PG_MIGRATIONS.filter((f) => !applied.includes(f));
  const schema = await adapter.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()`,
  );
  const columns = new Set(schema.map((row) => `${row.table_name}.${row.column_name}`));
  const required = [
    ...['agent_id', 'desired_json', 'desired_revision', 'reported_json', 'applied_revision', 'last_error', 'updated_at'].map((column) => `agent_runtime_configs.${column}`),
    ...['id', 'name', 'token', 'active', 'is_public', 'group_id', 'options_json', 'created_at', 'updated_at'].map(column => `agents.${column}`),
    ...['agent_id', 'is_public'].map(column => `monitors.${column}`),
    ...['user_id', 'data_url', 'version', 'updated_at'].map((column) => `user_avatars.${column}`),
    ...['monitor_id', 'day', 'total', 'up', 'warn', 'last_minute_ts'].map((column) => `agent_uptime_daily.${column}`),
    ...['id', 'event_id', 'channel_id', 'payload_json', 'created_at', 'attempts', 'next_attempt', 'lease_until'].map((column) => `pending_notifications.${column}`),
    ...['run_id', 'monitor_id', 'agent_id', 'target', 'probe_type', 'method', 'options_json', 'expected_status', 'keyword', 'timeout_ms', 'interval_sec', 'scheduled_at', 'source_version', 'state', 'lease_token', 'lease_until', 'attempts', 'observed_at', 'status', 'status_code', 'latency_ms', 'message', 'completed_at', 'consumed_at', 'check_ssl', 'check_domain', 'check_dns', 'warn_days', 'requested_addons_json', 'addons_json'].map((column) => `agent_probe_jobs.${column}`),
    ...['short', 'id', 'name', 'version', 'manifest_json', 'deleting', 'installed_at', 'updated_at'].map((column) => `themes.${column}`),
    ...['id', 'version', 'digest', 'prefix', 'manifest_json', 'installed_at'].map((column) => `theme_versions.${column}`),
    ...['id', 'token', 'expires_at'].map((column) => `theme_operations.${column}`),
    ...['url', 'position', 'added_at'].map((column) => `theme_catalogs.${column}`),
    ...['id', 'config_json', 'revision', 'updated_at'].map(column => `presentation_state.${column}`),
    ...['id', 'name', 'weight'].map(column => `agent_groups.${column}`),
    ...['id', 'name', 'color'].map(column => `agent_tags.${column}`),
    ...['agent_id', 'tag_id'].map(column => `agent_tag_links.${column}`),
    ...['id', 'owner', 'lease_until', 'completed_minute'].map((column) => `cron_tick_lease.${column}`),
    ...['key_hash', 'attempts', 'window_started', 'locked_until'].map((column) => `auth_login_limits.${column}`),
    ...['agent_id', 'version', 'public_ipv6', 'report_interval_secs', 'probe_capabilities'].map((column) => `machine_live.${column}`),
    ...['agent_id', 'days_json', 'updated_at'].map(column => `agent_history_daily.${column}`),
    ...['agent_id', 'sample_count', 'duration_sec', 'quality', 'net_up_bytes', 'net_down_bytes', 'network_duration_sec'].map((column) => `machine_history.${column}`),
  ];
  const missingColumns = required.filter((column) => !columns.has(column));
  if (missingColumns.length) missing.push(`schema:${missingColumns.join(',')}`);
  const indexes = await adapter.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  const indexNames = new Set(indexes.map((row) => row.indexname));
  const requiredIndexes = [
    'idx_pending_notifications_due',
    'idx_agent_probe_jobs_poll',
    'idx_agent_probe_jobs_latest',
    'idx_themes_id',
    'idx_theme_catalogs_position',
    'idx_theme_versions_latest',
    'idx_agents_public_active',
  ];
  const missingIndexes = requiredIndexes.filter((name) => !indexNames.has(name));
  if (missingIndexes.length) missing.push(`indexes:${missingIndexes.join(',')}`);
  return { ok: missing.length === 0, applied, missing };
}

/** Shared migration guidance for failed schema probes. / 结构探测失败时共用的迁移提示。 */
export function schemaBehindMessage(missing: string[]): string {
  return (
    `Postgres schema is behind: missing ${missing.join(', ')}. ` +
    `Run \`DATABASE_URL=... node scripts/db/db-migrate-postgres.mjs\` first.`
  );
}
