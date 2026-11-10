/**
 * SQL for `agent_commands`, separate from `agent_probe_jobs`.
 *
 * A probe is a read; a command changes the host, with different permission,
 * expiry and audit rules. Sharing one table would make every probe query carry
 * a `kind` filter, and a missed filter could turn a probe row into a command.
 * 命令会改变主机，权限、过期和审计规则不同；合表时漏掉 kind 过滤会把探测行变成命令。
 */

const d1 = {
  /** Queue one command; `INSERT OR IGNORE` makes retries idempotent. / 入队命令；`INSERT OR IGNORE` 保证重试幂等。 */
  insert: `INSERT OR IGNORE INTO agent_commands
       (id, agent_id, action, queued_at, state, issued_by)
     VALUES (?, ?, ?, ?, 'pending', ?)`,

  /** Claimable commands: not expired, under the attempt cap, unclaimed or lease lapsed. / 可领取命令：未过期、未超尝试次数、未领取或租约已失效。 */
  pollable: `SELECT id, action, queued_at
       FROM agent_commands
      WHERE agent_id = ? AND attempts < ? AND queued_at + ? >= ?
        AND (state = 'pending' OR (state = 'leased' AND lease_until <= ?))
      ORDER BY queued_at LIMIT ?`,

  /** Take the lease atomically; `rowsAffected = 0` means another isolate won. / 原子领取租约；`rowsAffected = 0` 表示被其他 isolate 抢走。 */
  claim: `UPDATE agent_commands
       SET state = 'leased', lease_token = ?, lease_until = ?, attempts = attempts + 1
     WHERE id = ? AND attempts < ? AND (state = 'pending' OR (state = 'leased' AND lease_until <= ?))`,

  /** Expire stale commands on each poll so old work cannot fire days later. / 每次轮询清理过期命令，避免旧任务数天后执行。 */
  expireStale: `UPDATE agent_commands SET state = 'expired'
     WHERE agent_id = ? AND state IN ('pending', 'leased') AND queued_at + ? < ?`,

  /** Record an outcome guarded by the lease token, so stale results cannot overwrite. / 按租约令牌记录结果，避免过期结果覆盖。 */
  complete: `UPDATE agent_commands
       SET state = 'completed', ok = ?, message = ?, completed_at = ?, lease_token = NULL, lease_until = NULL
     WHERE id = ? AND lease_token = ? AND state = 'leased' AND lease_until >= ?`,

  /** One command, for building the result response and the console's list. / 单条命令，用于构建结果响应及控制台列表。 */
  get: 'SELECT * FROM agent_commands WHERE id = ?',

  /** Recent commands for one agent; the caller bounds the limit. / 某台机器的最近指令；调用方限制条数。 */
  listForAgent: 'SELECT * FROM agent_commands WHERE agent_id = ? ORDER BY queued_at DESC LIMIT ?',

  /** Oldest first for the console's fleet-wide view. / 按最早优先排序，供控制台集群视图使用。 */
  listRecent: 'SELECT c.*, m.name AS agent_name FROM agent_commands c LEFT JOIN monitors m ON m.id = c.agent_id ORDER BY c.queued_at DESC LIMIT ?',

  /** Retention sweep; only terminal rows are removed. / 保留清理；只删除已结束的记录。 */
  pruneOld: `DELETE FROM agent_commands WHERE id IN (
      SELECT id FROM agent_commands WHERE state IN ('completed', 'expired') AND queued_at < ? ORDER BY queued_at LIMIT 200
    )`,
} as const;

type CommandsSQL = {
  [K in keyof typeof d1]: string;
};

const postgres: CommandsSQL = {
  insert: `INSERT INTO agent_commands
       (id, agent_id, action, queued_at, state, issued_by)
     VALUES ($1, $2, $3, $4, 'pending', $5) ON CONFLICT (id) DO NOTHING`,
  pollable: `SELECT id, action, queued_at
       FROM agent_commands
      WHERE agent_id = $1 AND attempts < $2 AND queued_at + $3 >= $4
        AND (state = 'pending' OR (state = 'leased' AND lease_until <= $5))
      ORDER BY queued_at LIMIT $6`,
  claim: `UPDATE agent_commands
       SET state = 'leased', lease_token = $1, lease_until = $2, attempts = attempts + 1
     WHERE id = $3 AND attempts < $4 AND (state = 'pending' OR (state = 'leased' AND lease_until <= $5))`,
  expireStale: `UPDATE agent_commands SET state = 'expired'
     WHERE agent_id = $1 AND state IN ('pending', 'leased') AND queued_at + $2 < $3`,
  complete: `UPDATE agent_commands
       SET state = 'completed', ok = $1, message = $2, completed_at = $3, lease_token = NULL, lease_until = NULL
     WHERE id = $4 AND lease_token = $5 AND state = 'leased' AND lease_until >= $6`,
  get: 'SELECT * FROM agent_commands WHERE id = $1',
  listForAgent: 'SELECT * FROM agent_commands WHERE agent_id = $1 ORDER BY queued_at DESC LIMIT $2',
  listRecent: 'SELECT c.*, m.name AS agent_name FROM agent_commands c LEFT JOIN monitors m ON m.id = c.agent_id ORDER BY c.queued_at DESC LIMIT $1',
  pruneOld: `DELETE FROM agent_commands WHERE id IN (
      SELECT id FROM agent_commands WHERE state IN ('completed', 'expired') AND queued_at < $1 ORDER BY queued_at LIMIT 200
    )`,
};

/** Agent 命令入队、租约与结果处理的双数据库语句。 / D1 and Postgres statements for Agent command enqueueing, leases, and results. */
export const commandsSQL: Record<'d1' | 'postgres', CommandsSQL> = {
  d1,
  postgres,
};
