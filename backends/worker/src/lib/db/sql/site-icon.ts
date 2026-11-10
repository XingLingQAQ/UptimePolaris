/**
 * SQL for `site_icon`, the operator's uploaded site icon.
 *
 * One row, always. `singleton` is a constant 1 with a UNIQUE constraint, so the
 * upsert below replaces the current icon instead of accumulating revisions -
 * an icon has no history worth keeping, and "which row is current" should never
 * be a question a reader has to answer.
 *
 * The bytes column differs by dialect: D1 stores a `BLOB`, Postgres a `BYTEA`.
 * The adapter passes a `Uint8Array` through in both cases, so the difference
 * stays inside these strings.
 * 管理员上传的网站图标 `site_icon` 的 SQL。表始终只有一行：`singleton` 恒为 1
 * 且有 UNIQUE 约束，upsert 替换当前图标，不累计无需保留的版本，也无需判断哪行是当前值。
 * 字节列的方言不同：D1 用 `BLOB`，Postgres 用 `BYTEA`；适配器均传入 `Uint8Array`，
 * 差异限定在这些 SQL 字符串中。
 */

const d1 = {
  /** The current icon, or no row at all. Absence is not an error - it means "none uploaded". / 当前图标或无记录；无记录表示未上传，并非错误。 */
  read: 'SELECT bytes, content_type, byte_size, filename, updated_at FROM site_icon WHERE singleton = 1',

  /** Store or replace. There is only ever one row. / 存储或替换；始终最多一行。 */
  upsert: `INSERT INTO site_icon (singleton, bytes, content_type, byte_size, filename, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       bytes = excluded.bytes,
       content_type = excluded.content_type,
       byte_size = excluded.byte_size,
       filename = excluded.filename,
       updated_at = excluded.updated_at`,

  /** Remove the uploaded icon so the generated mark comes back. / 删除上传的图标，恢复生成的图标。 */
  remove: 'DELETE FROM site_icon WHERE singleton = 1',
} as const;

type SiteIconSQL = {
  [K in keyof typeof d1]: string;
};

const postgres: SiteIconSQL = {
  read: 'SELECT bytes, content_type, byte_size, filename, updated_at FROM site_icon WHERE singleton = 1',
  upsert: `INSERT INTO site_icon (singleton, bytes, content_type, byte_size, filename, updated_at)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT(singleton) DO UPDATE SET
       bytes = EXCLUDED.bytes,
       content_type = EXCLUDED.content_type,
       byte_size = EXCLUDED.byte_size,
       filename = EXCLUDED.filename,
       updated_at = EXCLUDED.updated_at`,
  remove: 'DELETE FROM site_icon WHERE singleton = 1',
};

export const siteIconSQL: Record<'d1' | 'postgres', SiteIconSQL> = {
  d1,
  postgres,
};
