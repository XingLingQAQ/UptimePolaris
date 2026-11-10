/** SQL for the `events` table (transition log) and `pending_notifications` (retry outbox). / `events`（状态变化日志）和 `pending_notifications`（重试发件箱）的 SQL。 */

// Backoff or an active lease on an older transition blocks newer transitions.
// 较早状态变化的退避或活动租约会阻止更新的状态变化。
const d1Head = `NOT EXISTS (
  SELECT 1 FROM pending_notifications older
  WHERE older.channel_id = pending_notifications.channel_id
    AND COALESCE(json_extract(older.payload_json, '$.event.monitorId'), json_extract(older.payload_json, '$.event.monitorName')) =
        COALESCE(json_extract(pending_notifications.payload_json, '$.event.monitorId'), json_extract(pending_notifications.payload_json, '$.event.monitorName'))
    AND older.attempts < 8 AND older.created_at > ?
    AND (json_extract(older.payload_json, '$.event.at'), older.created_at, older.id) <
        (json_extract(pending_notifications.payload_json, '$.event.at'), pending_notifications.created_at, pending_notifications.id)
)`;
const pgHead = `NOT EXISTS (
  SELECT 1 FROM pending_notifications older
  WHERE older.channel_id = pending_notifications.channel_id
    AND COALESCE(older.payload_json::jsonb->'event'->>'monitorId', older.payload_json::jsonb->'event'->>'monitorName') =
        COALESCE(pending_notifications.payload_json::jsonb->'event'->>'monitorId', pending_notifications.payload_json::jsonb->'event'->>'monitorName')
    AND older.attempts < 8 AND older.created_at > $AGE
    AND ((older.payload_json::jsonb->'event'->>'at')::bigint, older.created_at, older.id) <
        ((pending_notifications.payload_json::jsonb->'event'->>'at')::bigint, pending_notifications.created_at, pending_notifications.id)
)`;

const d1 = {
  insert:
    'INSERT INTO events (monitor_id, status, message, created_at) VALUES (?, ?, ?, ?)',
  listRecent: 'SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?',
  listBefore: 'SELECT * FROM events WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?',

  /**
   * Time-based retention for the transition log.
   *
   * Before this, `events` was only ever cleared by deleting the monitor it
   * belonged to (`monitors.ts` → `deleteEvents`). A deployment whose monitors are
   * stable therefore accumulated one row per status flip forever, and the only
   * thing that would eventually stop it was the D1 storage limit - discovered in
   * production, as a write failure.
   *
   * `LIMIT` inside a subquery, the same shape `prunePending` uses: one bounded
   * statement per sync instead of an unbounded delete that could exceed the
   * statement budget on a table that has run for a year.
   * 按时间清理状态变化日志。过去只有删除所属监控时（`monitors.ts` → `deleteEvents`）
   * 才清理其 `events`；监控稳定的部署会为每次状态切换不断累积一行，最终只会因触及 D1
   * 存储上限而停止，并在生产环境表现为写入失败。
   * 与 `prunePending` 一样在子查询中使用 `LIMIT`，每次同步执行有界语句，
   * 避免对已运行一年的表执行无界删除而超出语句预算。
   */
  pruneOld: `DELETE FROM events WHERE id IN (
      SELECT id FROM events WHERE created_at < ? ORDER BY created_at LIMIT 500
    )`,

  /** Outbox: a transition that has not yet been confirmed to a channel. / 发件箱：尚未确认发送到渠道的状态变化。 */
  insertPending:
    'INSERT OR IGNORE INTO pending_notifications (id, event_id, channel_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  deletePending:
    'DELETE FROM pending_notifications WHERE event_id = ? AND channel_id = ?',
  listPending: `SELECT * FROM pending_notifications WHERE next_attempt <= ? AND lease_until <= ? AND attempts < 8 AND created_at > ? AND ${d1Head} ORDER BY created_at, id LIMIT ?`,
  claimPending: `UPDATE pending_notifications SET lease_until = ? WHERE id = ? AND next_attempt <= ? AND lease_until <= ? AND attempts < 8 AND created_at > ? AND ${d1Head}`,
  failPending: 'UPDATE pending_notifications SET attempts = attempts + 1, next_attempt = ?, lease_until = 0 WHERE id = ?',
  prunePending: 'DELETE FROM pending_notifications WHERE id IN (SELECT id FROM pending_notifications WHERE attempts >= 8 OR created_at <= ? ORDER BY created_at LIMIT 100)',
} as const;

type EventsSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

const postgres: EventsSQL = {
  insert:
    'INSERT INTO events (monitor_id, status, message, created_at) VALUES ($1, $2, $3, $4)',
  listRecent: 'SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT $1',
  listBefore: 'SELECT * FROM events WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3',
  pruneOld: `DELETE FROM events WHERE id IN (
      SELECT id FROM events WHERE created_at < $1 ORDER BY created_at LIMIT 500
    )`,

  insertPending:
    'INSERT INTO pending_notifications (id, event_id, channel_id, payload_json, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id, channel_id) DO NOTHING',
  deletePending:
    'DELETE FROM pending_notifications WHERE event_id = $1 AND channel_id = $2',
  listPending: `SELECT * FROM pending_notifications WHERE next_attempt <= $1 AND lease_until <= $2 AND attempts < 8 AND created_at > $3 AND ${pgHead.replace('$AGE', '$4')} ORDER BY created_at, id LIMIT $5`,
  claimPending: `UPDATE pending_notifications SET lease_until = $1 WHERE id = $2 AND next_attempt <= $3 AND lease_until <= $4 AND attempts < 8 AND created_at > $5 AND ${pgHead.replace('$AGE', '$6')}`,
  failPending: 'UPDATE pending_notifications SET attempts = attempts + 1, next_attempt = $1, lease_until = 0 WHERE id = $2',
  prunePending: 'DELETE FROM pending_notifications WHERE id IN (SELECT id FROM pending_notifications WHERE attempts >= 8 OR created_at <= $1 ORDER BY created_at LIMIT 100)',
};

/** 状态事件及通知发件箱的双数据库语句。 / D1 and Postgres statements for status events and the notification outbox. */
export const eventsSQL: Record<'d1' | 'postgres', EventsSQL> = {
  d1,
  postgres,
};
