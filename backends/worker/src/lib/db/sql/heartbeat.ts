/**
 * SQL for heartbeat storage and cron tick leases.
 *
 * `heartbeat_ring` is keyed by `id` rather than `monitor_id` (a historical
 * quirk the cascade in `monitors.deleteHeartbeatRing` accounts for). Both
 * tables are read/written here.
 * 心跳存储和定时任务租约的 SQL。`heartbeat_ring` 以 `id` 而非 `monitor_id`
 * 为键（历史遗留差异由 `monitors.deleteHeartbeatRing` 的级联处理）；此处读写两张表。
 */

import { pgPlaceholders } from './dialect';

const d1 = {
  ringForIds: (placeholders: string) =>
    `SELECT id, json FROM heartbeat_ring WHERE id IN (${placeholders})`,
  ringUpsert: `INSERT INTO heartbeat_ring (id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,

  /** All push monitors' last heartbeat. Missing table is tolerated by the caller. / 所有 Push 监控的最新心跳；调用方容忍表缺失。 */
  pushAll: 'SELECT monitor_id, ts, status, msg, ping FROM push_heartbeats',
  pushUpsert: `INSERT INTO push_heartbeats (monitor_id, ts, status, msg, ping) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       ts = excluded.ts, status = excluded.status,
       msg = excluded.msg, ping = excluded.ping`,
} as const;

type HeartbeatSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

const postgres: HeartbeatSQL = {
  ringForIds: (placeholders: string) =>
    `SELECT id, json FROM heartbeat_ring WHERE id IN (${pgPlaceholders(placeholders)})`,
  ringUpsert: `INSERT INTO heartbeat_ring (id, json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(id) DO UPDATE SET json = EXCLUDED.json, updated_at = EXCLUDED.updated_at`,

  pushAll: 'SELECT monitor_id, ts, status, msg, ping FROM push_heartbeats',
  pushUpsert: `INSERT INTO push_heartbeats (monitor_id, ts, status, msg, ping) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(monitor_id) DO UPDATE SET
       ts = EXCLUDED.ts, status = EXCLUDED.status,
       msg = EXCLUDED.msg, ping = EXCLUDED.ping`,
};

/** 心跳历史写入和读取的双数据库语句。 / D1 and Postgres statements for reading and writing heartbeat history. */
export const heartbeatSQL: Record<'d1' | 'postgres', HeartbeatSQL> = {
  d1,
  postgres,
};

const tickLeaseD1 = {
  claimTick: `INSERT INTO cron_tick_lease (id, owner, lease_until, completed_minute)
     VALUES (1, ?, ?, -1)
     ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until
     WHERE cron_tick_lease.lease_until <= ? AND cron_tick_lease.completed_minute < ?`,
  renewTick: `UPDATE cron_tick_lease SET lease_until = ?
     WHERE id = 1 AND owner = ? AND lease_until > ?`,
  releaseTick: `UPDATE cron_tick_lease
     SET owner = NULL, lease_until = 0, completed_minute = CASE WHEN ? = 1 THEN ? ELSE completed_minute END
     WHERE id = 1 AND owner = ? AND (? = 0 OR lease_until > ?)`,
} as const;

const tickLeasePostgres = {
  claimTick: `INSERT INTO cron_tick_lease (id, owner, lease_until, completed_minute)
     VALUES (1, $1, $2, -1)
     ON CONFLICT(id) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until
     WHERE cron_tick_lease.lease_until <= $3 AND cron_tick_lease.completed_minute < $4`,
  renewTick: `UPDATE cron_tick_lease SET lease_until = $1
     WHERE id = 1 AND owner = $2 AND lease_until > $3`,
  releaseTick: `UPDATE cron_tick_lease
     SET owner = NULL, lease_until = 0, completed_minute = CASE WHEN $1 = 1 THEN $2 ELSE completed_minute END
     WHERE id = 1 AND owner = $3 AND ($4 = 0 OR lease_until > $5)`,
} as const;

/** 周期任务的领取、续租和释放语句。 / Statements for claiming, renewing, and releasing scheduled-job leases. */
export const tickLeaseSQL = {
  d1: tickLeaseD1,
  postgres: tickLeasePostgres,
} as const;
