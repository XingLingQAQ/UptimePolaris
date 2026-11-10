/** Shared D1/Postgres operations. SQL maps supply dialect-specific placeholders; D1 uses commit() for atomic write sets. / D1/Postgres 共用操作。SQL 映射提供对应方言的占位符；D1 使用 commit() 原子提交写入集合。 */

export type DBType = 'd1' | 'postgres';

export interface ExecuteResult {
  /** Rows the statement changed. D1's `meta.changes`. / 语句修改的行数，对应 D1 的 `meta.changes`。 */
  rowsAffected: number;
  /** Rowid of the last inserted row, where the backend reports one. / 后端提供时，返回最后插入行的 rowid。 */
  lastInsertId?: number | string;
}

export interface DBUsage {
  binding_requests: number;
  statements: number;
  rows_read: number;
  rows_written: number;
  duration_ms: number;
}

/** 统一读写接口；调用方仍需选择对应数据库方言的 SQL。 / Shared read/write interface; callers must still select SQL for the database dialect. */
export interface DBAdapter {
  readonly type: DBType;

  /** Run a statement expected to return rows. Never null. / 执行预期返回多行的语句；结果不为 null。 */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Run a statement expected to return 0 or 1 rows. / 执行预期返回零行或一行的语句。 */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;

  /** Run a statement expected to write. / 执行预期写入数据的语句。 */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /** Run a transaction callback where supported; D1 rejects this method, so use commit() for a fixed write set. / 在支持时执行事务回调；D1 不支持此方法，固定写入集合应使用 commit()。 */
  transaction<T>(fn: (tx: DBAdapter) => Promise<T>): Promise<T>;

  /** Commit a known write set atomically and return each statement's row count. / 原子提交已知写入集合，返回各语句的行数。 */
  commit(statements: { sql: string; params?: unknown[] }[]): Promise<number[]>;

  /** Free the underlying connection, where the backend has one. Optional. / 后端存在底层连接时释放它；此方法可选。 */
  close?(): Promise<void>;

  getUsage?(): DBUsage;
}
