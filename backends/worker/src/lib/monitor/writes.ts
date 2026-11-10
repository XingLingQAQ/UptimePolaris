import type { Env, Monitor } from '../../types';
import type { DBAdapter } from '../db/adapter';
import { getDB } from '../db/factory';
import { monitorSQL } from '../db/sql/monitors';
import { invalidateConfig, invalidateLive } from './store';
import { visibilityRevisionWrite } from '../public/cache';

const CHECK_FIELDS = ['active', 'name', 'type', 'target', 'method', 'expected_status', 'keyword', 'timeout_ms', 'interval_sec', 'warn_days', 'check_ssl', 'check_domain', 'check_dns', 'options_json', 'group_id', 'agent_id', 'is_public', 'updated_at'] as const;

export class MonitorChanged extends Error {}

export function monitorSnapshotGuard(monitors: Monitor[], now: number): { sql: string; params: unknown[] } {
  const mismatch = CHECK_FIELDS.map((field) => `m.${field} IS NOT json_extract(snapshot.value, '$.${field}')`).join(' OR ');
  return {
    // A failed NOT NULL check rolls back the entire D1 batch, including history and outbox.
    // NOT NULL 检查失败会回滚整个 D1 批次，包括历史记录和待发送通知。
    sql: `INSERT INTO live_state (id, json, updated_at)
      SELECT 'all', CASE WHEN NOT EXISTS (
        SELECT 1 FROM json_each(?) snapshot LEFT JOIN monitors m ON m.id=json_extract(snapshot.value, '$.id')
        WHERE m.id IS NULL OR ${mismatch}
      ) THEN COALESCE((SELECT json FROM live_state WHERE id='all'), '{}') ELSE NULL END, ?
      ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
    params: [JSON.stringify(monitors), now],
  };
}

export async function lockMonitorSnapshots(tx: DBAdapter, monitors: Monitor[]): Promise<void> {
  if (!monitors.length) return;
  // 按固定顺序加锁，降低并发更新多个监控时的死锁风险。
  // Lock in a fixed order to reduce deadlocks when updating multiple monitors concurrently.
  const rows = await tx.query<Monitor>('SELECT * FROM monitors WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [monitors.map((monitor) => monitor.id)]);
  const current = new Map(rows.map((row) => [row.id, row]));
  if (monitors.some((snapshot) => {
    const row = current.get(snapshot.id);
    return !row || CHECK_FIELDS.some((field) => row[field] !== snapshot[field]);
  })) throw new MonitorChanged();
}

/** 提交前核对探测时的监控快照，拒绝将旧配置结果写入已变更的监控。 / Check the probe's monitor snapshot before committing to reject results for a changed configuration. */
export async function commitMonitorWrites(db: DBAdapter, monitor: Monitor, now: number, writes: { sql: string; params: unknown[] }[]): Promise<void> {
  if (db.type === 'postgres') {
    await db.transaction(async (tx) => {
      await lockMonitorSnapshots(tx, [monitor]);
      for (const write of writes) await tx.execute(write.sql, write.params);
    });
    return;
  }
  try {
    await db.commit([monitorSnapshotGuard([monitor], now), ...writes]);
  } catch (error) {
    if (String(error).includes('NOT NULL constraint failed: live_state.json')) throw new MonitorChanged();
    throw error;
  }
}

export async function deleteMonitor(env: Env, id: string): Promise<{ numId: number } | null> {
  const db = getDB(env);
  const monitor = await db.queryOne<{ num_id: number; type: string }>(monitorSQL[db.type].byId, [id]);
  if (!monitor) return null;

  const sql = monitorSQL[db.type];
  const changes = await db.commit([
    { sql: sql.delete, params: [id] },
    visibilityRevisionWrite(Math.floor(Date.now() / 1000), db.type === 'postgres'),
    { sql: sql.deleteUptime, params: [id] },
    { sql: sql.deleteEvents, params: [id] },
    { sql: sql.deleteHeartbeatRing, params: [id] },
    { sql: sql.deletePushHeartbeats, params: [id] },
    { sql: sql.deleteMonitorTags, params: [id] },
    { sql: sql.deleteAgentAvailability, params: [id] },
    { sql: sql.deleteAgentProbeJobs, params: [id] },
    { sql: sql.deletePendingNotifications, params: [id] },
    { sql: sql.removeLiveEntry, params: [db.type === 'postgres' ? id : '$.' + JSON.stringify(id)] },
  ]);
  if (changes[0] === 0) return null;
  invalidateConfig();
  invalidateLive();
  return { numId: monitor.num_id };
}
