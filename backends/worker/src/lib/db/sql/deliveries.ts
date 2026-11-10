/** SQL for `notification_deliveries`; written after a send, never inside a tick batch. / `notification_deliveries` 的 SQL；发送后写入，不进入 tick 批处理。 */

const d1 = {
  insert: `INSERT INTO notification_deliveries
      (id, channel_id, monitor_id, monitor_name, status, ok, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  /** Newest first, for the console's delivery log. / 最新优先，供控制台投递日志使用。 */
  listRecent: `SELECT * FROM notification_deliveries
    ORDER BY created_at DESC LIMIT ?`,

  /**
   * Per-channel aggregate over a time window.
   *
   * One query for every channel, not one per channel: the page renders all of
   * them, and twelve channels would otherwise be twelve round trips. `hour` is
   * computed in SQL to keep UTC and let the `(channel_id, created_at)` index
   * drive the range scan.
   * 一次查询所有渠道；hour 在 SQL 中计算以保持 UTC 并使用索引。
   */
  stats: `SELECT
      channel_id,
      COUNT(*)                                 AS sent,
      SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)  AS failed,
      AVG(latency_ms)                          AS avg_latency,
      MAX(created_at)                          AS last_sent_at,
      CAST(created_at / 3600 AS INTEGER)       AS hour
    FROM notification_deliveries
    WHERE created_at >= ?
    GROUP BY channel_id, CAST(created_at / 3600 AS INTEGER)`,

  /** Bounded retention prune, same shape as the event prune. / 有上限的保留清理，与事件清理同形。 */
  pruneOld: `DELETE FROM notification_deliveries WHERE id IN (
      SELECT id FROM notification_deliveries WHERE created_at < ? ORDER BY created_at LIMIT 500
    )`,

  /** A channel being deleted takes its delivery history with it. / 删除渠道时同时删除其投递历史。 */
  deleteForChannel: 'DELETE FROM notification_deliveries WHERE channel_id = ?',
} as const;

type DeliveriesSQL = { [K in keyof typeof d1]: string };

const postgres: DeliveriesSQL = {
  insert: `INSERT INTO notification_deliveries
      (id, channel_id, monitor_id, monitor_name, status, ok, latency_ms, error, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,

  listRecent: `SELECT * FROM notification_deliveries
    ORDER BY created_at DESC LIMIT $1`,

  stats: `SELECT
      channel_id,
      COUNT(*)                                 AS sent,
      SUM(CASE WHEN ok = FALSE THEN 1 ELSE 0 END) AS failed,
      AVG(latency_ms)                          AS avg_latency,
      MAX(created_at)                          AS last_sent_at,
      FLOOR(created_at / 3600)                 AS hour
    FROM notification_deliveries
    WHERE created_at >= $1
    GROUP BY channel_id, FLOOR(created_at / 3600)`,

  pruneOld: `DELETE FROM notification_deliveries WHERE id IN (
      SELECT id FROM notification_deliveries WHERE created_at < $1 ORDER BY created_at LIMIT 500
    )`,

  deleteForChannel: 'DELETE FROM notification_deliveries WHERE channel_id = $1',
};

export const deliveriesSQL: Record<'d1' | 'postgres', DeliveriesSQL> = {
  d1,
  postgres,
};

/** One row of the per-channel statistics query. / 按渠道统计查询的一行结果。 */
export interface DeliveryStatRow {
  channel_id: string;
  sent: number | string;
  failed: number | string;
  avg_latency: number | string | null;
  last_sent_at: number | string | null;
  hour: number | string;
}
