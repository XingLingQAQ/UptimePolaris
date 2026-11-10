import postgres from 'postgres';
import { isPrivateHost } from '../http/private-host';
import { probeSchema } from './migrate';
import type { Env } from '../../types';
import type { DBAdapter } from './adapter';
import { POSTGRES_MIGRATIONS } from './postgres-schema';

type Row = Record<string, unknown>;
type Table = { name: string; columns: string[]; rows: Row[] };
type PgColumn = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string };

const MAX_TABLE_ROWS = 5_000;
const MAX_TOTAL_ROWS = 10_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// 平台元数据和 D1 选库控制记录不属于 PostgreSQL 业务表。
// Platform metadata and D1 database-selection records are not PostgreSQL business tables.
const METADATA_TABLES = new Set(['d1_migrations', '_cf_KV', '_polaris_database']);
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export class MigrationError extends Error {
  constructor(readonly code: string) { super(code); }
}

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new MigrationError('schema_mismatch');
  return `"${value}"`;
}

export function parseTargetUrl(value: unknown, forceVerifyFull = false): string {
  if (typeof value !== 'string' || value.length > 4096) throw new MigrationError('invalid_target');
  let url: URL;
  try { url = new URL(value); } catch { throw new MigrationError('invalid_target'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hostname.includes(':') || !url.username || !url.password ||
      !url.pathname || url.pathname === '/' || url.hash || isPrivateHost(url.hostname)) {
    throw new MigrationError('invalid_target');
  }
  for (const [key, parameter] of url.searchParams) {
    if (key !== 'sslmode' || !['verify-full', 'require'].includes(parameter)) throw new MigrationError('invalid_target');
  }
  url.search = '';
  if (forceVerifyFull) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

async function sourceTables(db: D1Database): Promise<string[]> {
  const result = await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
  return result.results.map((row) => row.name).filter((name) => !METADATA_TABLES.has(name));
}

// 行数与大小检查不能检测所有等量改写；调用方仍须从复制前到切换完成持续停写。
// Row counts and sizes cannot detect every same-size edit; callers must stop writes from before copying through cutover.
async function snapshot(db: D1Database): Promise<Table[]> {
  const names = await sourceTables(db);
  if (!names.length || names.length > 100) throw new MigrationError('schema_mismatch');
  const metadata = await db.batch(names.map((name) => db.prepare(`PRAGMA table_info(${identifier(name)})`)));
  const tableColumns = names.map((name, index) => {
    const columns = (metadata[index].results as { name: string }[]).map((row) => row.name);
    if (name === 'monitor_groups') columns.push('num_id');
    if (name === 'monitor_tags') columns.push('join_id');
    if (!columns.length || new Set(columns).size !== columns.length) throw new MigrationError('schema_mismatch');
    columns.forEach(identifier);
    return columns;
  });
  const sizeExpressions = tableColumns.map((columns, index) => columns.map((column) => {
    const ref = (names[index] === 'monitor_groups' && column === 'num_id') || (names[index] === 'monitor_tags' && column === 'join_id') ? 'rowid' : identifier(column);
    return `(6 * COALESCE(length(CAST(${ref} AS BLOB)), 0) + ${32 + 6 * column.length})`;
  }).join(' + '));
  const stats = await db.batch(names.map((name, index) => db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${sizeExpressions[index]}), 0) AS bytes FROM ${identifier(name)}`)));
  const limits = stats.map((result) => (result.results as { n: number; bytes: number }[])[0]);
  if (limits.some((limit) => !Number.isSafeInteger(limit.n) || !Number.isSafeInteger(limit.bytes) || limit.n > MAX_TABLE_ROWS) ||
      limits.reduce((total, limit) => total + limit.n, 0) > MAX_TOTAL_ROWS ||
      limits.reduce((total, limit) => total + limit.bytes, 0) > MAX_SNAPSHOT_BYTES) throw new MigrationError('source_too_large');
  const statements = [db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")];
  for (const [index, name] of names.entries()) {
    const quoted = identifier(name);
    statements.push(db.prepare(`PRAGMA table_info(${quoted})`));
    const extra = name === 'monitor_groups' ? ', rowid AS num_id' : name === 'monitor_tags' ? ', rowid AS join_id' : '';
    const { n, bytes } = limits[index];
    statements.push(db.prepare(`SELECT *${extra} FROM ${quoted} WHERE (SELECT COUNT(*) FROM ${quoted}) = ${n} AND (SELECT COALESCE(SUM(${sizeExpressions[index]}), 0) FROM ${quoted}) <= ${bytes} LIMIT ${n + 1}`));
    statements.push(db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${sizeExpressions[index]}), 0) AS bytes FROM ${quoted}`));
  }
  const results = await db.batch(statements);
  const currentNames = (results[0].results as { name: string }[]).map((row) => row.name).filter((name) => !METADATA_TABLES.has(name));
  if (JSON.stringify(currentNames) !== JSON.stringify(names)) throw new MigrationError('schema_mismatch');
  let total = 0;
  const tables = names.map((name, i) => {
    const columns = (results[1 + i * 3].results as { name: string }[]).map((row) => row.name);
    if (name === 'monitor_groups') columns.push('num_id');
    if (name === 'monitor_tags') columns.push('join_id');
    if (JSON.stringify(columns) !== JSON.stringify(tableColumns[i])) throw new MigrationError('schema_mismatch');
    columns.forEach(identifier);
    const rows = results[2 + i * 3].results as Row[];
    const final = (results[3 + i * 3].results as { n: number; bytes: number }[])[0];
    if (rows.length !== limits[i].n || final.n !== limits[i].n || final.bytes > limits[i].bytes) throw new MigrationError('source_changed');
    total += rows.length;
    if (rows.length > MAX_TABLE_ROWS || total > MAX_TOTAL_ROWS) throw new MigrationError('source_too_large');
    for (const row of rows) for (const value of Object.values(row)) {
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new MigrationError('unsupported_value');
    }
    return { name, columns, rows };
  });
  if (new TextEncoder().encode(JSON.stringify(tables)).byteLength > MAX_SNAPSHOT_BYTES) throw new MigrationError('source_too_large');
  return tables;
}

function orderTables(names: string[], edges: { child: string; parent: string }[]): string[] {
  const pending = new Set(names);
  const ordered: string[] = [];
  while (pending.size) {
    const next = [...pending].find((name) => !edges.some((edge) => edge.child === name && edge.parent !== name && pending.has(edge.parent)));
    if (!next) throw new MigrationError('schema_mismatch');
    ordered.push(next);
    pending.delete(next);
  }
  return ordered;
}

export async function migrateData(db: D1Database, target: string, execute: boolean) {
  const sql = postgres(target, { max: 1, ssl: 'verify-full', connect_timeout: 10, idle_timeout: 5, prepare: false, onnotice: () => {} });
  try {
    return await migrateDataWithConnection(db, sql, execute);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** 预览不写目标库；执行时在目标事务中建表和复制，不切换活动数据库。 / Preview leaves the target unchanged; execution initializes and copies in one target transaction without switching the active database. */
export async function migrateDataWithConnection(db: D1Database, sql: ReturnType<typeof postgres>, execute: boolean) {
  const tables = await snapshot(db);
  return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '30s'");
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      if (execute) await tx.unsafe('SELECT pg_advisory_xact_lock(722742496, 1481530194)');
      const ledgerExists = await tx.unsafe<{ present: boolean }[]>("SELECT to_regclass(format('%I.schema_migrations', current_schema())) IS NOT NULL AS present");
      const targetNeedsInitialization = !ledgerExists[0]?.present;
      if (targetNeedsInitialization) {
        const existingObjects = await tx.unsafe<{ present: boolean }[]>(`SELECT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()
          UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()
          UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = current_schema() AND t.typtype IN ('d', 'e', 'r', 'm')
          UNION ALL SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = current_schema()
        ) AS present`);
        if (existingObjects[0].present) throw new MigrationError('schema_mismatch');
        const permission = await tx.unsafe<{ allowed: boolean }[]>("SELECT has_schema_privilege(current_schema(), 'CREATE') AS allowed");
        if (!permission[0].allowed) throw new MigrationError('schema_mismatch');
        if (!execute) {
          return { ok: true as const, tables: tables.map(({ name, rows }) => ({ name, rows: rows.length })), totalRows: tables.reduce((sum, table) => sum + table.rows.length, 0), targetNeedsInitialization };
        }
        for (const migration of POSTGRES_MIGRATIONS) {
          await tx.unsafe(migration.sql);
          await tx.unsafe('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [migration.name, Math.floor(Date.now() / 1000)]);
        }
      }
      const probeAdapter: Pick<DBAdapter, 'type' | 'query'> = {
        type: 'postgres',
        async query<T>(query: string, params: unknown[] = []) {
          return await tx.unsafe(query, params as never[]) as unknown as T[];
        },
      };
      if (!(await probeSchema({} as Env, probeAdapter)).ok) throw new MigrationError('schema_mismatch');
      const pgTables = await tx.unsafe<{ table_name: string }[]>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name");
      const targetNames = pgTables.map((row) => row.table_name);
      if (JSON.stringify(targetNames) !== JSON.stringify(tables.map((table) => table.name))) throw new MigrationError('schema_mismatch');
      const columns = await tx.unsafe<PgColumn[]>("SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_schema = current_schema()");
      for (const table of tables) {
        const targetColumns = columns.filter((column) => column.table_name === table.name);
        if (table.columns.some((column) => !targetColumns.some((entry) => entry.column_name === column)) ||
            targetColumns.some((column) => !table.columns.includes(column.column_name) && column.is_nullable === 'NO' && !column.column_default && column.is_identity !== 'YES')) {
          throw new MigrationError('schema_mismatch');
        }
      }
      if (execute) await tx.unsafe(`LOCK TABLE ${targetNames.map(identifier).join(', ')} IN ACCESS EXCLUSIVE MODE`);
      for (const name of targetNames) {
        const condition = name === 'auth_setup_state' ? ' WHERE NOT (id = 1 AND completed = 0 AND claim_id IS NULL)' : '';
        const existing = await tx.unsafe<{ populated: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM ${identifier(name)}${condition}) AS populated`);
        if (existing[0].populated) throw new MigrationError('target_not_empty');
      }
      const edges = await tx.unsafe<{ child: string; parent: string }[]>(`SELECT child.relname AS child, parent.relname AS parent FROM pg_constraint c JOIN pg_class child ON child.oid = c.conrelid JOIN pg_class parent ON parent.oid = c.confrelid JOIN pg_namespace n ON n.oid = child.relnamespace WHERE c.contype = 'f' AND n.nspname = current_schema()`);
      const order = orderTables(targetNames, edges);
      if (execute) {
        await tx.unsafe('DELETE FROM auth_setup_state WHERE id = 1 AND completed = 0 AND claim_id IS NULL');
        for (const name of order) {
          const table = tables.find((entry) => entry.name === name)!;
          const types = columns.filter((column) => column.table_name === name);
          for (let offset = 0; offset < table.rows.length; offset += 50) {
            const rows = table.rows.slice(offset, offset + 50);
            const values: unknown[] = [];
            const groups = rows.map((row) => `(${table.columns.map((column) => {
              let value = row[column] ?? null;
              const type = types.find((entry) => entry.column_name === column)?.data_type;
              if (type === 'boolean' && (value === 0 || value === 1)) value = value === 1;
              if (type === 'bytea' && Array.isArray(value)) value = new Uint8Array(value as number[]);
              values.push(value);
              return `$${values.length}`;
            }).join(',')})`);
            await tx.unsafe(`INSERT INTO ${identifier(name)} (${table.columns.map(identifier).join(',')}) VALUES ${groups.join(',')}`, values as never[]);
          }
        }
        for (const column of columns.filter((entry) => entry.is_identity === 'YES')) {
          if (!targetNames.includes(column.table_name)) continue;
          const sequence = await tx.unsafe<{ seq: string | null }[]>('SELECT pg_get_serial_sequence(format(\'%I.%I\', current_schema(), $1::text), $2::text) AS seq', [column.table_name, column.column_name]);
          if (!sequence[0]?.seq) throw new MigrationError('schema_mismatch');
          const max = await tx.unsafe<{ value: string }[]>(`SELECT COALESCE(MAX(${identifier(column.column_name)}), 0)::text AS value FROM ${identifier(column.table_name)}`);
          const next = BigInt(max[0].value) + 1n;
          if (next < 1n) throw new MigrationError('unsupported_value');
          const seqName = sequence[0].seq.split('.');
          if (seqName.length !== 2) throw new MigrationError('schema_mismatch');
          await tx.unsafe(`ALTER SEQUENCE ${seqName.map(identifier).join('.')} RESTART WITH ${next}`);
        }
      }
      return { ok: true as const, tables: tables.map(({ name, rows }) => ({ name, rows: rows.length })), totalRows: tables.reduce((sum, table) => sum + table.rows.length, 0), targetNeedsInitialization, ...(execute ? { copied: true } : {}) };
    });
}
