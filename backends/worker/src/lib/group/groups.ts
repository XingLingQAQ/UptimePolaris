import type { Env, MonitorGroup } from '../../types';
import { D1Adapter } from '../db/d1';
import { getDB } from '../db/factory';
import { placeholderFor } from '../db/sql/dialect';
import { groupSQL } from '../db/sql/groups';

/**
 * Monitor groups.
 *
 * `monitors.group_id` is nullable and NULL means ungrouped; there is no
 * sentinel "Ungrouped" row. SQLite cannot add a constrained column, so no
 * foreign key backs it: `groupExists` guards writes, and `deleteGroup` nulls
 * references in the same batch, so a group cannot vanish while monitors point
 * at it. Readers treat a dangling id as ungrouped.
 * 无外键；写入校验、删除同批置空，悬空 ID 按未分组处理。
 */

/** A group as the database row holds it. / 数据库行中的分组。 */
type StoredGroup = MonitorGroup & { num_id: number };

/**
 * Groups ordered by weight then name, with the integer rowid.
 *
 * One ORDER BY shared by the status page and the picker, so they cannot
 * disagree; `name` is the tie-break that keeps the order total. `rowid` is the
 * stable integer the UI keys on, while the primary key is a UUID.
 * 排序只有一处，避免状态页和选择器顺序不一致；rowid 是 UI 使用的整数键。
 */
async function loadGroupsWithNumId(env: Env): Promise<StoredGroup[]> {
  const db = getDB(env);
  return db.query<StoredGroup>(groupSQL[db.type].listWithNumId);
}

/** Same list with integer ids for the public payload. / 公开载荷使用的整数 ID 列表。 */
export async function loadGroupsForUi(env: Env): Promise<StoredGroup[]> {
  return loadGroupsWithNumId(env);
}

export async function loadGroups(env: Env): Promise<MonitorGroup[]> {
  // Map fields explicitly so new columns do not leak into the response. / 逐字段映射，避免新列意外进入响应。
  return (await loadGroupsWithNumId(env)).map((g) => ({
    id: g.id,
    name: g.name,
    weight: g.weight,
    created_at: g.created_at,
    updated_at: g.updated_at,
  }));
}

/** Existence check; one primary-key lookup. / 存在性检查，一次主键查询。 */
export async function groupExists(env: Env, id: string): Promise<boolean> {
  const db = getDB(env);
  const row = await db.queryOne<{ one: number }>(groupSQL[db.type].exists, [id]);
  return row !== null;
}

/** Create a group; duplicate names throw from the UNIQUE index. / 创建分组；重名由唯一索引抛错。 */
export async function createGroup(
  env: Env,
  input: { name: string; weight?: number },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  await db.execute(groupSQL[db.type].insert, [id, input.name, input.weight ?? 0, now, now]);
  return id;
}

/** Partial update; returns false when nothing matched. / 部分更新；无匹配返回 false。 */
export async function updateGroup(
  env: Env,
  id: string,
  input: Partial<{ name: string; weight: number }>,
): Promise<boolean> {
  const db = getDB(env);
  const sets: string[] = [];
  const values: unknown[] = [];
  let position = 1;
  const token = () => placeholderFor(db.type, position++);

  if (input.name !== undefined) {
    sets.push(`name = ${token()}`);
    values.push(input.name);
  }
  // undefined check, because 0 is a valid weight. / 用 undefined 判断，因为 0 是有效权重。
  if (input.weight !== undefined) {
    sets.push(`weight = ${token()}`);
    values.push(input.weight);
  }

  if (sets.length === 0) return groupExists(env, id);

  sets.push(`updated_at = ${token()}`);
  values.push(Math.floor(Date.now() / 1000));
  const idPlaceholder = placeholderFor(db.type, position);
  values.push(id);

  const r = await db.execute(
    groupSQL[db.type].updateById(sets.join(', '), idPlaceholder),
    values,
  );
  return r.rowsAffected > 0;
}

/**
 * Delete a group, ungroup its monitors and drop channel scopes in one batch.
 *
 * Monitors are never deleted — a group is a label. The third statement removes
 * `notification_groups` rows: without it a channel would keep a scope entry
 * naming a group that no longer exists, invisible in the console and matched
 * by no monitor, so alerts would silently stop. Dropping them leaves the
 * channel unscoped, which receives everything — the safe direction.
 * 删除分组不删监控；同批清理渠道范围，避免通知静默失效。
 */
export async function deleteGroup(env: Env, id: string): Promise<boolean> {
  const db = getDB(env);

  // Single transaction; the group delete's changes is the 404 signal. / 单事务；删除分组的变更数决定 404。
  if (db instanceof D1Adapter) {
    const changes = await db.batchAll([
      { sql: groupSQL.d1.delete, params: [id] },
      { sql: groupSQL.d1.clearGroupFromMonitors, params: [id] },
      { sql: groupSQL.d1.deleteScopesForGroup, params: [id] },
    ]);
    return (changes[0] ?? 0) > 0;
  }
  return db.transaction(async (tx) => {
    const r = await tx.execute(groupSQL[db.type].delete, [id]);
    await tx.execute(groupSQL[db.type].clearGroupFromMonitors, [id]);
    await tx.execute(groupSQL[db.type].deleteScopesForGroup, [id]);
    return r.rowsAffected > 0;
  });
}
