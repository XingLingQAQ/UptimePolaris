/** SQL for `tags` and their `monitor_tags` join. / `tags` 及其 `monitor_tags` 关联的 SQL。 */

import { pgPlaceholders } from './dialect';

const d1 = {
  listAll: 'SELECT * FROM tags ORDER BY name',
  existingIds: (placeholders: string) =>
    `SELECT id FROM tags WHERE id IN (${placeholders})`,
  exists: 'SELECT 1 AS one FROM tags WHERE id = ?',
  insert: `INSERT INTO tags (id, name, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  updateById: (sets: string, idPlaceholder = '?') =>
    `UPDATE tags SET ${sets} WHERE id = ${idPlaceholder}`,
  delete: 'DELETE FROM tags WHERE id = ?',

  /** All join rows for a list of monitor ids, joined to their tag names. / 获取一组监控 ID 的所有关联行及标签名称。 */
  monitorTagsForIds: (placeholders: string) =>
    `SELECT mt.monitor_id AS monitor_id, m.num_id AS num_id,
              mt.rowid AS join_id, t.id AS tag_id, t.name AS name, t.color AS color
         FROM monitor_tags mt
         JOIN tags t     ON t.id = mt.tag_id
         JOIN monitors m ON m.id = mt.monitor_id
        WHERE mt.monitor_id IN (${placeholders})
        ORDER BY t.name`,
  deleteForMonitor: 'DELETE FROM monitor_tags WHERE monitor_id = ?',
  insertMonitorTag: 'INSERT INTO monitor_tags (monitor_id, tag_id) VALUES (?, ?)',
  deleteForTag: 'DELETE FROM monitor_tags WHERE tag_id = ?',
} as const;

type TagSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

/**
 * Postgres dialect notes:
 *
 *   - `mt.rowid AS join_id` has no analogue. The PG schema gives
 *     `monitor_tags` a `join_id BIGINT GENERATED ALWAYS AS IDENTITY`
 *     surrogate (see `database/schema/postgres/0001_init.postgres.sql`) so the join
 *     row keeps the same "stable integer id" the UI displays in its
 *     chip-with-x rendering.
 * Postgres 方言说明：`mt.rowid AS join_id` 没有直接对应项。PG 结构为
 * `monitor_tags` 提供 `join_id BIGINT GENERATED ALWAYS AS IDENTITY` 代理键
 * （见 `database/schema/postgres/0001_init.postgres.sql`），使界面的可删除标签仍有稳定整数 ID。
 */
const postgres: TagSQL = {
  listAll: 'SELECT * FROM tags ORDER BY name',
  existingIds: (placeholders: string) =>
    `SELECT id FROM tags WHERE id IN (${pgPlaceholders(placeholders)})`,
  exists: 'SELECT 1 AS one FROM tags WHERE id = $1',
  insert: `INSERT INTO tags (id, name, color, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
  updateById: (sets: string, idPlaceholder = '$1') =>
    `UPDATE tags SET ${sets} WHERE id = ${idPlaceholder}`,
  delete: 'DELETE FROM tags WHERE id = $1',

  monitorTagsForIds: (placeholders: string) =>
    `SELECT mt.monitor_id AS monitor_id, m.num_id AS num_id,
              mt.join_id AS join_id, t.id AS tag_id, t.name AS name, t.color AS color
         FROM monitor_tags mt
         JOIN tags t     ON t.id = mt.tag_id
         JOIN monitors m ON m.id = mt.monitor_id
        WHERE mt.monitor_id IN (${pgPlaceholders(placeholders)})
        ORDER BY t.name`,
  deleteForMonitor: 'DELETE FROM monitor_tags WHERE monitor_id = $1',
  insertMonitorTag: 'INSERT INTO monitor_tags (monitor_id, tag_id) VALUES ($1, $2)',
  deleteForTag: 'DELETE FROM monitor_tags WHERE tag_id = $1',
};

export const tagSQL: Record<'d1' | 'postgres', TagSQL> = {
  d1,
  postgres,
};
