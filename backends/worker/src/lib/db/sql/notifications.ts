
import { pgPlaceholders } from './dialect';

const d1 = {
  listActive: 'SELECT * FROM notifications WHERE active = 1 ORDER BY created_at',
  listAll: 'SELECT * FROM notifications ORDER BY created_at',
  insert: `INSERT INTO notifications (id, name, type, config_json, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  /** `sets` is the `SET a = ?, b = ?` clause built by the caller. / `sets` 是调用方构建的 `SET a = ?, b = ?` 子句。 */
  updateById: (sets: string, idPlaceholder = '?') =>
    `UPDATE notifications SET ${sets} WHERE id = ${idPlaceholder}`,
  delete: 'DELETE FROM notifications WHERE id = ?',

  /** Scopes for a list of channels, grouped by the caller. / 一组渠道的范围，由调用方分组。 */
  scopesForChannels: (placeholders: string) =>
    `SELECT notification_id, group_id FROM notification_groups
        WHERE notification_id IN (${placeholders})
        ORDER BY group_id`,
  deleteScopeForChannel: 'DELETE FROM notification_groups WHERE notification_id = ?',
  insertScope: 'INSERT INTO notification_groups (notification_id, group_id) VALUES (?, ?)',
  deleteScopesForGroup: 'DELETE FROM notification_groups WHERE group_id = ?',
} as const;

type NotificationSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

const postgres: NotificationSQL = {
  listActive: 'SELECT * FROM notifications WHERE active = 1 ORDER BY created_at',
  listAll: 'SELECT * FROM notifications ORDER BY created_at',
  insert: `INSERT INTO notifications (id, name, type, config_json, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  updateById: (sets: string, idPlaceholder = '$1') =>
    `UPDATE notifications SET ${sets} WHERE id = ${idPlaceholder}`,
  delete: 'DELETE FROM notifications WHERE id = $1',

  scopesForChannels: (placeholders: string) =>
    `SELECT notification_id, group_id FROM notification_groups
        WHERE notification_id IN (${pgPlaceholders(placeholders)})
        ORDER BY group_id`,
  deleteScopeForChannel: 'DELETE FROM notification_groups WHERE notification_id = $1',
  insertScope: 'INSERT INTO notification_groups (notification_id, group_id) VALUES ($1, $2)',
  deleteScopesForGroup: 'DELETE FROM notification_groups WHERE group_id = $1',
};

export const notificationSQL: Record<'d1' | 'postgres', NotificationSQL> = {
  d1,
  postgres,
};
