// 使用实际 PostgreSQL 验证 D1 复制和非空目标拒绝。
// Use PostgreSQL to check D1 copying and rejection of populated targets.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import postgres from 'postgres';
import { migrateDataWithConnection, parseTargetUrl } from '../../backends/worker/src/lib/db/data-migration.ts';
import { postgresMigrationPlan, renderPostgres } from '../../scripts/db/build-schema-bootstrap.mjs';

export async function testDataMigration(url) {
  assert.equal(readFileSync('backends/worker/src/lib/db/postgres-schema.ts', 'utf8'), renderPostgres(postgresMigrationPlan()));
  for (const value of ['postgres://u:p@127.0.0.1/db', 'postgres://u:p@localhost/db', 'postgres://u:p@example.com/db?host=127.0.0.1', 'https://example.com/']) {
    assert.throws(() => parseTargetUrl(value));
  }
  assert.equal(parseTargetUrl('postgres://u:p@example.com/db?sslmode=require'), 'postgres://u:p@example.com/db');
  const local = new DatabaseSync(':memory:');
  for (const file of readdirSync('database/schema/d1').filter((entry) => entry.endsWith('.sql')).sort()) {
    local.exec(readFileSync(`database/schema/d1/${file}`, 'utf8'));
  }
  local.exec("INSERT INTO site_icon (singleton, bytes, content_type, byte_size, updated_at) VALUES (1, x'010203', 'image/png', 3, 100)");
  local.exec("INSERT INTO agents(id,name,token,created_at,updated_at) VALUES('machine','Machine','machine-token',100,100)");
  local.exec("INSERT INTO monitors(id,num_id,name,type,target,agent_id,is_public,created_at,updated_at) VALUES('private',1,'Private monitor','agent','','machine',0,100,100)");
  local.exec("INSERT INTO machine_live(agent_id,cpu_usage,updated_at) VALUES('machine',42,100)");
  const d1 = {
    prepare(query) {
      return { all: async () => ({ results: local.prepare(query).all() }), query };
    },
    batch: async (statements) => statements.map(({ query }) => ({ results: local.prepare(query).all() })),
  };
  const admin = postgres(url, { max: 1 });
  const schema = `migration_fixture_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const target = postgres(url, { max: 1, connection: { search_path: schema } });
  try {
    await target`CREATE TABLE unrelated_data (id int)`;
    await assert.rejects(() => migrateDataWithConnection(d1, target, false), (error) => error.code === 'schema_mismatch');
    await target`DROP TABLE unrelated_data`;
    const freshPreview = await migrateDataWithConnection(d1, target, false);
    assert.equal(freshPreview.targetNeedsInitialization, true);
    assert.equal((await target`SELECT to_regclass('schema_migrations') AS name`)[0].name, null);
    local.exec('UPDATE site_icon SET byte_size = 2147483648 WHERE singleton = 1');
    await assert.rejects(() => migrateDataWithConnection(d1, target, true));
    assert.equal((await target`SELECT to_regclass('schema_migrations') AS name`)[0].name, null);
    local.exec('UPDATE site_icon SET byte_size = 3 WHERE singleton = 1');
    const initial = await migrateDataWithConnection(d1, target, true);
    assert.equal(initial.targetNeedsInitialization, true);
    assert.equal((await target`SELECT token FROM agents WHERE id='machine'`)[0].token, 'machine-token');
    assert.equal((await target`SELECT name FROM monitors WHERE id='private'`)[0].name, 'Private monitor');
    assert.equal((await target`SELECT is_public FROM monitors WHERE id='private'`)[0].is_public, 0);
    assert.equal((await target`SELECT cpu_usage FROM machine_live WHERE agent_id='machine'`)[0].cpu_usage, 42);
    await target`DELETE FROM monitors`;
    await target`DELETE FROM agents`;
    await target`DELETE FROM site_icon`;
    await target`DELETE FROM schema_migrations WHERE name = '0017_agent_runtime_config.postgres.sql'`;
    await assert.rejects(() => migrateDataWithConnection(d1, target, false), (error) => error.code === 'schema_mismatch');
    await target`INSERT INTO schema_migrations (name, applied_at) VALUES ('0017_agent_runtime_config.postgres.sql', 1)`;
    await target`DROP INDEX idx_pending_notifications_due`;
    await assert.rejects(() => migrateDataWithConnection(d1, target, false), (error) => error.code === 'schema_mismatch');
    await target`CREATE INDEX idx_pending_notifications_due ON pending_notifications(next_attempt, lease_until, created_at)`;
    const preview = await migrateDataWithConnection(d1, target, false);
    assert.equal(preview.targetNeedsInitialization, false);
    assert.equal(preview.tables.find((table) => table.name === 'site_icon').rows, 1);
    local.exec('UPDATE site_icon SET byte_size = 2147483648 WHERE singleton = 1');
    await assert.rejects(() => migrateDataWithConnection(d1, target, true));
    assert.equal((await target`SELECT COUNT(*)::int AS n FROM monitors`)[0].n, 0);
    assert.equal((await target`SELECT COUNT(*)::int AS n FROM auth_setup_state`)[0].n, 1);
    local.exec('UPDATE site_icon SET byte_size = 3 WHERE singleton = 1');
    const copied = await migrateDataWithConnection(d1, target, true);
    assert.equal(copied.copied, true);
    assert.equal((await target`SELECT COUNT(*)::int AS n FROM monitors`)[0].n, 1);
    assert.deepEqual([...((await target`SELECT bytes FROM site_icon`)[0].bytes)], [1, 2, 3]);
    await assert.rejects(() => migrateDataWithConnection(d1, target, true), (error) => error.code === 'target_not_empty');
    console.log('PASS D1 to PostgreSQL migration: preflight, complete copy, binary data and populated target rejection');
  } finally {
    await target.end();
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    local.close();
  }
}
