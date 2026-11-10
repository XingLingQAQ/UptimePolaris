import type { Env, MonitorTag, Tag } from '../../types';
import { D1Adapter } from '../db/d1';
import { getDB } from '../db/factory';
import { placeholderFor } from '../db/sql/dialect';
import { tagSQL } from '../db/sql/tags';

/**
 * Tags and the monitor/tag join.
 *
 * A tag is many-to-many, so it is `tags` plus `monitor_tags`, with no foreign
 * key. Two invariants are kept by hand: `existingTagIds` refuses a join row
 * naming a missing tag, and `deleteTag` removes join rows in the same batch so
 * a tag cannot vanish while monitors still carry it. Reads inner-join, so a
 * dangling row contributes no chip instead of an `undefined` name.
 * 无外键；写入校验和同批删除维持两条不变量，悬空关联读取时忽略。
 */

/** All tags ordered by unique name. / 全部标签，按唯一名称排序。 */
export async function loadTags(env: Env): Promise<Tag[]> {
  const db = getDB(env);
  return db.query<Tag>(tagSQL[db.type].listAll);
}

/** Every tag id that exists, for validating a submitted `tag_ids` in one read. / 所有存在的标签 ID，用于一次读取验证提交的 `tag_ids`。 */
export async function existingTagIds(env: Env, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;

  const db = getDB(env);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.query<{ id: string }>(tagSQL[db.type].existingIds(placeholders), ids);

  for (const row of rows) out.add(row.id);
  return out;
}

/**
 * Create a tag; duplicate names are left to the UNIQUE index.
 *
 * A check-then-insert passes two concurrent creates and one still fails at the
 * INSERT, as a 500. The route catches the violation and answers `name_taken`.
 * 不做预检查；并发创建时唯一索引才是裁判，冲突映射为 name_taken。
 */
export async function createTag(
  env: Env,
  input: { name: string; color?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  await db.execute(tagSQL[db.type].insert, [id, input.name, input.color ?? '#006FEE', now, now]);
  return id;
}

/** Partial update; returns false when nothing matched. / 部分更新；无匹配返回 false。 */
export async function updateTag(
  env: Env,
  id: string,
  input: Partial<{ name: string; color: string }>,
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
  if (input.color !== undefined) {
    sets.push(`color = ${token()}`);
    values.push(input.color);
  }

  if (sets.length === 0) {
    const row = await db.queryOne<{ one: number }>(tagSQL[db.type].exists, [id]);
    return row !== null;
  }

  sets.push(`updated_at = ${token()}`);
  values.push(Math.floor(Date.now() / 1000));
  const idPlaceholder = placeholderFor(db.type, position);
  values.push(id);

  const r = await db.execute(
    tagSQL[db.type].updateById(sets.join(', '), idPlaceholder),
    values,
  );
  return r.rowsAffected > 0;
}

/**
 * Delete a tag and its join rows in one batch; monitors are untouched.
 * 一次批量删除标签和关联行，不删除监控。
 */
export async function deleteTag(env: Env, id: string): Promise<boolean> {
  const db = getDB(env);

  // One atomic unit on D1 (batch), or a `transaction` scope on a BEGIN/COMMIT
  // backend - same invariant, different plumbing.
  // D1 使用一个原子 batch，BEGIN/COMMIT 后端使用 `transaction` 作用域；
  // 实现方式不同，但不变量相同。
  if (db instanceof D1Adapter) {
    const changes = await db.batchAll([
      { sql: tagSQL.d1.delete, params: [id] },
      { sql: tagSQL.d1.deleteForTag, params: [id] },
    ]);
    return (changes[0] ?? 0) > 0;
  }
  return db.transaction(async (tx) => {
    const r = await tx.execute(tagSQL[db.type].delete, [id]);
    await tx.execute(tagSQL[db.type].deleteForTag, [id]);
    return r.rowsAffected > 0;
  });
}

/** A join row joined to its tag, as SQL returns it. / SQL 返回的关联行及其标签。 */
interface TagJoinRow {
  monitor_id: string;
  num_id: number;
  join_id: number;
  tag_id: string;
  name: string;
  color: string;
}

/**
 * 80 ids per `IN (...)`: D1 caps a statement at 100 bound parameters, and
 * callers add a few more binds. A single oversized IN would fail the whole
 * status page, so ids are chunked and merged.
 * 每个 IN 放 80 个 ID，低于 D1 的 100 绑定上限；超限会让整个状态页失败。
 */
const IDS_PER_QUERY = 80;

/** Tags for many monitors, one query per 80 ids; `id` is the join row, `tag_id` the UUID. / 每 80 个监控一次查询；`id` 是关联行，`tag_id` 是 UUID。 */
export async function loadMonitorTags(
  env: Env,
  monitorIds: string[],
): Promise<Map<string, MonitorTag[]>> {
  const out = new Map<string, MonitorTag[]>();
  if (monitorIds.length === 0) return out;

  const db = getDB(env);
  for (let offset = 0; offset < monitorIds.length; offset += IDS_PER_QUERY) {
    const batch = monitorIds.slice(offset, offset + IDS_PER_QUERY);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.query<TagJoinRow>(
      tagSQL[db.type].monitorTagsForIds(placeholders),
      batch,
    );

    // Merge chunks into one map; shape matches a single query. / 合并分块结果，形状与单次查询一致。
    for (const row of rows) {
      const list = out.get(row.monitor_id) ?? [];
      list.push({
        id: row.join_id,
        monitor_id: row.num_id,
        tag_id: row.tag_id,
        name: row.name,
        color: row.color,
      });
      out.set(row.monitor_id, list);
    }
  }
  return out;
}

/**
 * Replace a monitor's tags wholesale in one batch; caller validates ids.
 *
 * The picker sends the complete set, so merging would make "removed this tag"
 * and "did not mention it" the same request. DELETE and INSERTs share one
 * transaction so a concurrent read never sees the monitor untagged.
 * 整体替换而非合并；删除和插入同事务，避免读到未打标签的中间态。
 */
export async function setMonitorTags(
  env: Env,
  monitorId: string,
  tagIds: string[],
): Promise<void> {
  const unique = [...new Set(tagIds)];
  const db = getDB(env);

  // Single transaction for DELETE plus INSERTs. / DELETE 与 INSERT 在同一事务。
  if (db instanceof D1Adapter) {
    const statements: { sql: string; params: unknown[] }[] = [
      { sql: tagSQL.d1.deleteForMonitor, params: [monitorId] },
    ];
    for (const tagId of unique) {
      statements.push({ sql: tagSQL.d1.insertMonitorTag, params: [monitorId, tagId] });
    }
    await db.batchAll(statements);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.execute(tagSQL[db.type].deleteForMonitor, [monitorId]);
    for (const tagId of unique) {
      await tx.execute(tagSQL[db.type].insertMonitorTag, [monitorId, tagId]);
    }
  });
}
