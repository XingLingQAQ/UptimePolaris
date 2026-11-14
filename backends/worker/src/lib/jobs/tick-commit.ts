import type { Monitor } from '../../types';
import type { DBAdapter } from '../db/adapter';
import { lockMonitorSnapshots, MonitorChanged, guardMonitorWrites } from '../monitor/writes';

export class TickLeaseLost extends Error {}

export async function commitTickWrites(
  db: DBAdapter,
  owner: string,
  now: number,
  writes: { sql: string; params: unknown[] }[],
  monitors: Monitor[] = [],
): Promise<void> {
  if (db.type === 'd1') {
    try {
      // 租约失效时触发非空约束，使整个 D1 批次回滚。
      // An expired lease violates the non-null constraint and rolls back the entire D1 batch.
      await db.commit([
        {
          sql: `INSERT INTO cron_tick_lease (id, owner, lease_until, completed_minute)
                VALUES (1, ?, (SELECT lease_until FROM cron_tick_lease WHERE id = 1 AND owner = ? AND lease_until > ?), -1)
                ON CONFLICT(id) DO UPDATE SET lease_until = CASE
                  WHEN cron_tick_lease.owner = ? AND cron_tick_lease.lease_until > ?
                  THEN cron_tick_lease.lease_until ELSE NULL END`,
          params: [owner, owner, now, owner, now],
        },
        ...guardMonitorWrites(monitors, now, writes),
      ]);
    } catch (error) {
      if (String(error).includes('cron_tick_lease.lease_until')) throw new TickLeaseLost();
      if (String(error).includes('NOT NULL constraint failed: live_state.json')) throw new MonitorChanged();
      throw error;
    }
    return;
  }
  await db.transaction(async (tx) => {
    // 持锁校验租约和监控快照，避免旧任务提交探测结果。
    // Validate the lease and monitor snapshot under lock to reject stale results.
    const lease = await tx.queryOne<{ owner: string | null; lease_until: number }>(
      'SELECT owner, lease_until FROM cron_tick_lease WHERE id = 1 FOR UPDATE',
    );
    if (lease?.owner !== owner || Number(lease.lease_until) <= now) throw new TickLeaseLost();
    await lockMonitorSnapshots(tx, monitors);
    for (const write of writes) await tx.execute(write.sql, write.params);
  });
}
