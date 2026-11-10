/**
 * Bootstrap D1 using bundled migrations and atomic per-file batches.
 * Empty PostgreSQL setup is handled separately by setup-postgres.ts.
 * 使用内嵌迁移和逐文件原子批次初始化 D1；空 PostgreSQL 由 setup-postgres.ts 处理。
 */

import type { Env } from '../../types';
import { getDB } from './factory';
import { BOOTSTRAP_FILES, LEDGER_DDL } from './schema-bootstrap';

// Cache per binding, not per isolate alone. / 按数据库绑定缓存，而非仅按 isolate 缓存。
let bootstrapped = new WeakSet<D1Database>();

/** Test hook: forget that this isolate already bootstrapped. / 测试钩子：清除当前 isolate 已初始化的记忆。 */
export function resetSchemaBootstrapCache(): void {
  bootstrapped = new WeakSet<D1Database>();
}

export interface BootstrapResult {
  /** True when this call applied at least one migration. / 本次调用应用了至少一个迁移时为 true。 */
  created: boolean;
  /** Files applied by this call, in order. / 本次调用按顺序应用的文件。 */
  applied: string[];
}

/** Apply missing D1 migrations; PostgreSQL is handled separately. / 应用缺失的 D1 迁移；PostgreSQL 单独处理。 */
export async function bootstrapSchema(env: Env): Promise<BootstrapResult> {
  if ((env.DATABASE_TYPE ?? 'd1') === 'postgres') return { created: false, applied: [] };
  if (bootstrapped.has(env.DB)) return { created: false, applied: [] };

  const db = getDB(env);

  /*
    The ledger first, on its own.

    It cannot be created in the same batch as the migration that follows it: a
    batch is prepared as a unit, and statement 1 of file 0001 is a `CREATE
    TABLE` that is fine either way - but the *claim* row for 0001 must land in a
    table that exists when the batch is prepared. `IF NOT EXISTS` makes this
    idempotent, so a raced second caller is harmless.

    先单独创建账本。它不能与后续迁移放在同一批次：批次作为整体预编译，0001 文件的
    第一条 `CREATE TABLE` 无论如何均可执行，但准备批次时 0001 的领取记录必须写入已存在的表。
    `IF NOT EXISTS` 使该操作幂等，因此竞争的第二个调用方不会造成问题。
  */
  await db.execute(LEDGER_DDL);

  // Existing tables require a recorded migration history.
  // 已存在的表必须有已记录的迁移历史。
  const foreignTable = await db.queryOne<{ name: string }>(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '\\_%' ESCAPE '\\'
        AND name <> 'd1_migrations'
      LIMIT 1`,
  );
  if (foreignTable) {
    const ledger = await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM d1_migrations');
    if ((ledger?.n ?? 0) === 0) {
      throw new Error('Database has tables without a migration ledger; initialize a fresh development database.');
    }
  }

  const applied: string[] = [];
  for (const file of BOOTSTRAP_FILES) {
    /*
      Claim the file and apply it in one batch, so a file can never be recorded
      as applied without its statements having run. The insert is first on
      purpose: a duplicate name aborts the batch before any DDL executes, which
      is what makes the ledger the mutex.

      在同一批次中领取并应用文件，避免文件被记录为已应用而语句尚未执行。
      故意将插入放在第一条：名称重复时，批次在执行任何 DDL 前中止，账本因此充当互斥锁。
    */
    const statements = [
      { sql: 'INSERT INTO d1_migrations (name) VALUES (?)', params: [file.name] },
      ...file.statements.map((sql) => ({ sql })),
    ];
    try {
      await db.commit(statements);
      applied.push(file.name);
    } catch (error) {
      /*
        Either another request claimed this file first, or the schema is in a
        state this code cannot move forward from.

        The two are told apart by asking the ledger, not by reading the error
        text: a duplicate means someone else won the race and this request
        should carry on with the next file, while anything else is a real
        failure that must not be swallowed into a half-built database.

        可能是其他请求先领取了文件，也可能是当前结构处于无法继续的状态。
        通过查询账本而非读取错误文本区分：名称重复表示其他请求胜出，可以继续下一个文件；
        其他情况是真实失败，不能吞掉错误而留下只建了一半的数据库。
      */
      const claimed = await db.queryOne<{ n: number }>(
        'SELECT 1 AS n FROM d1_migrations WHERE name = ?',
        [file.name],
      );
      if (!claimed) throw error;
    }
  }

  bootstrapped.add(env.DB);
  return { created: applied.length > 0, applied };
}
