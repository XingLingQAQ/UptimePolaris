/**
 * Apply the Postgres schema, in order, against `DATABASE_URL`.
 *
 *   DATABASE_URL=postgres://user:pass@host/db node scripts/db/db-migrate-postgres.mjs
 *
 * Reads `database/schema/postgres/*.postgres.sql` in lexicographic order, tracks applied
 * files in the `schema_migrations` table the 0001 file creates, and refuses
 * to re-apply an already-recorded file (so a second run is a no-op rather
 * than a "duplicate column name" crash).
 *
 * Explicit upgrades for Worker PostgreSQL; fresh setup can initialize an empty database.
 *
 * 按文件名字典序向 DATABASE_URL 应用 Postgres 迁移；0001 创建的
 * schema_migrations 表记录已执行文件，因此重复运行会跳过它们。
 * 跳过已记录的文件，使第二次运行成为空操作，避免“列名重复”错误。
 * 用于 Worker PostgreSQL 的显式升级；首次初始化可以直接为所选空数据库建表。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:migrate:postgres] DATABASE_URL is not set');
  process.exit(1);
}

const dir = 'database/schema/postgres';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.postgres.sql'))
  .sort();

if (files.length === 0) {
  console.error(`[db:migrate:postgres] no migrations found in ${dir}/`);
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  // The ledger itself is created by 0001; on a fresh DB the table does not
  // exist yet, so the first ledger read is wrapped to tolerate that.
  // 迁移记录表由 0001 创建；新库首次读取时允许该表尚不存在。
  let applied;
  try {
    applied = new Set(
      (await sql`SELECT name FROM schema_migrations`).map((r) => r.name),
    );
  } catch (e) {
    if (!String(e).includes('does not exist')) throw e;
    applied = new Set();
  }

  if (applied.size === 0) {
    const existing = await sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'`;
    if (existing.length) {
      throw new Error('Postgres has tables but no recorded migration baseline; refusing to guess. Verify every migration effect and establish the ledger before retrying.');
    }
  }

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[db:migrate:postgres] skip  ${file} (already applied)`);
      continue;
    }
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    console.log(`[db:migrate:postgres] apply ${file}`);
    // `unsafe` because the file is a sequence of statements; the driver's
    // template-literal API does not accept raw multi-statement SQL. Each
    // file is wrapped in a transaction so a crash mid-file does not leave
    // half a table built.
    // unsafe 接受多条原始 SQL；每个文件使用事务，避免中途失败留下不完整的表。
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx.unsafe(
        'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)',
        [file, Math.floor(Date.now() / 1000)],
      );
    });
    ran++;
  }

  console.log(`[db:migrate:postgres] done: applied ${ran} of ${files.length}`);
} finally {
  await sql.end();
}
