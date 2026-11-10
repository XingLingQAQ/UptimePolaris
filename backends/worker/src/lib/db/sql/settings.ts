/**
 * SQL for `app_settings`, the runtime configuration store.
 *
 * Key/value with JSON values: adding a setting is a code-only change with a
 * default, so no migration per setting and nothing seeded wrongly. A wide row
 * would need a migration for every new setting. `upsert` is the only writer;
 * `load` reads the whole table in one scan (tens of rows).
 * 键值表避免每项迁移；默认值写在代码里，未写入即读默认。
 */

const d1 = {
  /** Every stored override. Absent keys are not errors - they mean "default". / 所有已存储的覆盖值；键缺失表示使用默认值，并非错误。 */
  load: 'SELECT key, value_json FROM app_settings',

  /** Upsert one setting with the caller's timestamp. / 用调用方时间戳写入一项设置。 */
  upsert: `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,

  /** Drop an override so the key falls back to its declared default. / 删除覆盖值，使键回退到声明的默认值。 */
  remove: 'DELETE FROM app_settings WHERE key = ?',
} as const;

type SettingsSQL = {
  [K in keyof typeof d1]: string;
};

const postgres: SettingsSQL = {
  load: 'SELECT key, value_json FROM app_settings',
  upsert: `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value_json = EXCLUDED.value_json,
       updated_at = EXCLUDED.updated_at`,
  remove: 'DELETE FROM app_settings WHERE key = $1',
};

export const settingsSQL: Record<'d1' | 'postgres', SettingsSQL> = {
  d1,
  postgres,
};
