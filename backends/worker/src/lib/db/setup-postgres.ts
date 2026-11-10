import type { Env } from '../../types';
import type { DBAdapter } from './adapter';
import { getDB } from './factory';
import { probeSchema } from './migrate';
import { POSTGRES_MIGRATIONS } from './postgres-schema';

const objectsQuery = `SELECT EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()
  UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()
  UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = current_schema() AND t.typtype IN ('d', 'e', 'r', 'm')
  UNION ALL SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = current_schema()
) AS present`;

export async function postgresIsEmpty(env: Env): Promise<boolean> {
  const result = await getDB(env).queryOne<{ present: boolean }>(objectsQuery);
  return result?.present === false;
}

/** 空 schema 在事务中初始化；已有迁移记录的 schema 仅检查完整性。 / Initialize an empty schema transactionally; only check completeness when a migration ledger exists. */
export async function initializePostgres(env: Env): Promise<void> {
  const db = getDB(env);
  const created = await db.transaction(async (tx: DBAdapter) => {
    // 将使用此锁的初始化事务串行化；事务结束时自动释放。
    // Serialize setup transactions using this lock; release it when the transaction ends.
    await tx.query('SELECT pg_advisory_xact_lock(722742496, 1481530194)');
    const ledger = await tx.queryOne<{ present: boolean }>("SELECT to_regclass(format('%I.schema_migrations', current_schema())) IS NOT NULL AS present");
    if (ledger?.present) return false;
    const objects = await tx.queryOne<{ present: boolean }>(objectsQuery);
    if (!objects || objects.present) throw new Error('database_initialization_failed');
    for (const migration of POSTGRES_MIGRATIONS) {
      await tx.execute(migration.sql);
      await tx.execute('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [migration.name, Math.floor(Date.now() / 1000)]);
    }
    return true;
  });
  if (!created && !(await probeSchema(env, db)).ok) throw new Error('database_initialization_failed');
}
