/** SQL for `monitor_groups`. / `monitor_groups` 的 SQL。 */

const d1 = {
  /** Includes `rowid` for the UI's integer key. / 包含 `rowid`，供界面作为整数键。 */
  listWithNumId: 'SELECT rowid AS num_id, * FROM monitor_groups ORDER BY weight, name',
  exists: 'SELECT 1 AS one FROM monitor_groups WHERE id = ?',
  insert: `INSERT INTO monitor_groups (id, name, weight, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  updateById: (sets: string, idPlaceholder = '?') =>
    `UPDATE monitor_groups SET ${sets} WHERE id = ${idPlaceholder}`,
  delete: 'DELETE FROM monitor_groups WHERE id = ?',
  /** Cascade: a group being deleted NULLs the column on every monitor in it. / 级联处理：删除分组时，将其所有监控的分组列设为 NULL。 */
  clearGroupFromMonitors: 'UPDATE monitors SET group_id = NULL WHERE group_id = ?',
  /** Cascade: a group's channel scopes go with it. / 级联处理：同时删除该分组的渠道范围。 */
  deleteScopesForGroup: 'DELETE FROM notification_groups WHERE group_id = ?',
} as const;

type GroupSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

/**
 * Postgres dialect notes:
 *
 *   - `rowid` does not exist. The D1 statement exposes it as `num_id` so the
 *     UI gets an integer per group; on PG the schema adds a real
 *     `num_id INTEGER GENERATED ALWAYS AS IDENTITY` column (see
 *     `database/schema/postgres/0001_init.postgres.sql`), which the SELECT below reads
 *     under the same name. Callers see the same shape either way.
 *   - `updateById` is caller-rendered. The call site in `lib/groups.ts`
 *     builds the `SET a = ?, b = ?` clause with the dialect's own positional
 *     tokens (`?` on D1, `$1, $2, ...` on PG) and passes the trailer's
 *     placeholder along with it, so this layer only concatenates.
 * Postgres 方言说明：PG 没有 `rowid`。D1 将其作为 `num_id` 返回给界面；PG 结构
 * 使用真正的 `num_id INTEGER GENERATED ALWAYS AS IDENTITY` 列（见
 * `database/schema/postgres/0001_init.postgres.sql`），查询以相同名称返回，使调用方结构一致。
 * `updateById` 的 `SET a = ?, b = ?` 子句由 `lib/groups.ts` 使用方言的位置占位符
 * （D1 的 `?` 或 PG 的 `$1, $2, ...`）构建，并传入尾部占位符；此层只负责拼接。
 */
const postgres: GroupSQL = {
  listWithNumId: 'SELECT num_id, * FROM monitor_groups ORDER BY weight, name',
  exists: 'SELECT 1 AS one FROM monitor_groups WHERE id = $1',
  insert: `INSERT INTO monitor_groups (id, name, weight, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
  updateById: (sets: string, idPlaceholder = '$1') =>
    `UPDATE monitor_groups SET ${sets} WHERE id = ${idPlaceholder}`,
  delete: 'DELETE FROM monitor_groups WHERE id = $1',
  clearGroupFromMonitors: 'UPDATE monitors SET group_id = NULL WHERE group_id = $1',
  deleteScopesForGroup: 'DELETE FROM notification_groups WHERE group_id = $1',
};

export const groupSQL: Record<'d1' | 'postgres', GroupSQL> = {
  d1,
  postgres,
};
