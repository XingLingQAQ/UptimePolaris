// 使用独占 PostgreSQL 数据库验证事务、认证、租约与业务读写。
// Use an owned PostgreSQL database to check transactions, authentication, leases, and business data.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresAdapter } from '../../backends/worker/src/lib/db/postgres.ts';
import { commitTickWrites, TickLeaseLost } from '../../backends/worker/src/lib/jobs/tick-commit.ts';
import { eventsSQL } from '../../backends/worker/src/lib/db/sql/events.ts';
import { liveStateSQL } from '../../backends/worker/src/lib/db/sql/live-state.ts';
import { monitorSQL } from '../../backends/worker/src/lib/db/sql/monitors.ts';
import { commitMonitorWrites, deleteMonitor, MonitorChanged } from '../../backends/worker/src/lib/monitor/writes.ts';
import { storeAgentDaily, loadAgentDaily, pruneAgentDaily } from '../../backends/worker/src/lib/agent/history.ts';
import { deleteAgent } from '../../backends/worker/src/lib/agent/registry.ts';
import { scheduleAgentProbeJobs, pollAgentProbeJobs, submitAgentProbeResult, latestAgentProbeObservation } from '../../backends/worker/src/lib/agent/probes.ts';
import { tickLeaseSQL } from '../../backends/worker/src/lib/db/sql/heartbeat.ts';
import { agentLiveSQL } from '../../backends/worker/src/lib/db/sql/agent.ts';
import { authSQL } from '../../backends/worker/src/lib/db/sql/auth.ts';
import { probeSchema } from '../../backends/worker/src/lib/db/migrate.ts';
import { ensureSchemaReady, resetSchemaGuardCache } from '../../backends/worker/src/lib/db/schema-guard.ts';
import { getDB, withDBScope, withIndependentDBScope } from '../../backends/worker/src/lib/db/factory.ts';
import { countUsers, finishSetup } from '../../backends/worker/src/lib/auth/service.ts';
import { readAvatarImage, readAvatarInfo, removeAvatar, writeAvatar } from '../../backends/worker/src/lib/auth/avatar.ts';
import { Hono } from 'hono';
import { handleGetAgentConfiguration, handleSaveAgentConfiguration, handleAgentConfigurationExchange } from '../../backends/worker/src/lib/agent/runtime-config.ts';
import { testDataMigration } from './data-migration-real.test.mjs';
import { removeTheme } from '../../backends/worker/src/lib/theme/registry.ts';
import { submitCommandResult } from '../../backends/worker/src/lib/agent/commands.ts';
import { commandsSQL } from '../../backends/worker/src/lib/db/sql/commands.ts';

const url = process.env.TEST_DATABASE_URL;
const owner = process.env.UPTIME_PG_OWNER;
const root = process.env.UPTIME_PG_ROOT;
const dataDir = process.env.UPTIME_PG_DATA;
const expectedPort = Number(process.env.UPTIME_PG_PORT);
if (!url || !owner || !root || !dataDir || !expectedPort) throw new Error('run this test through its owned-cluster runner');
assert.equal(readFileSync(`${root}/.uptime-polaris-pg-owner`, 'utf8'), owner);
assert.equal(resolve(dataDir), resolve(root, 'data'));
const parsedUrl = new URL(url);
assert.equal(parsedUrl.hostname, '127.0.0.1');
assert.equal(Number(parsedUrl.port), expectedPort);

const db = new PostgresAdapter(url);
const table = `codex_tx_${crypto.randomUUID().replaceAll('-', '')}`;
let fixtureVerified = false;

try {
  const runtime = await db.queryOne(`SELECT current_setting('data_directory') AS data_directory,
                                      inet_server_addr()::text AS address,
                                      inet_server_port() AS port`);
  assert.equal(resolve(runtime.data_directory), resolve(dataDir));
  assert.equal(runtime.address.split('/')[0], '127.0.0.1');
  assert.equal(Number(runtime.port), expectedPort);
  assert.equal(readFileSync(`${root}/.uptime-polaris-pg-owner`, 'utf8'), owner);
  fixtureVerified = true;

  await testDataMigration(url);

  for (const migration of readdirSync('database/schema/postgres').filter((file) => file.endsWith('.postgres.sql')).sort()) {
    await db.execute(readFileSync(`database/schema/postgres/${migration}`, 'utf8'));
    await db.execute('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [migration, Math.floor(Date.now() / 1000)]);
  }
  const schemaProbe = await probeSchema({ DATABASE_TYPE: 'postgres', DATABASE_URL: url }, db);
  assert.equal(schemaProbe.ok, true, `full schema probe: ${schemaProbe.missing.join(', ')}`);

  const historyEnv = { DATABASE_TYPE: 'postgres', DATABASE_URL: url };
  const archiveDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const earlierDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const expiredDay = new Date(Date.now() - 401 * 86400000).toISOString().slice(0, 10);
  const dayPoint = { d: archiveDay, sample_count: 3, duration_sec: 60, cpu_samples: 0, mem_samples: 3,
    cpu_avg: null, cpu_max: null, mem_pct_avg: 50, mem_pct_max: 60, load_1_avg: null, load_5_avg: null,
    net_up_bytes: null, net_down_bytes: null, network_duration_sec: 0, sampled: false };
  await db.execute("INSERT INTO agents(id,name,token,created_at,updated_at) VALUES('history-agent','History','history-token',1,1)");
  const archive = (day, point = dayPoint) => withDBScope(historyEnv, env => storeAgentDaily(env, day, new Map([['history-agent', point]]), 400));
  await Promise.all([archive(earlierDay), archive(archiveDay)]);
  let days = await withDBScope(historyEnv, env => loadAgentDaily(env, 'history-agent'));
  assert.deepEqual(days.map(day => day.d), [earlierDay, archiveDay]);
  await db.execute("UPDATE agent_history_daily SET updated_at=1 WHERE agent_id='history-agent'");
  await archive(archiveDay);
  assert.equal((await db.queryOne("SELECT updated_at FROM agent_history_daily WHERE agent_id='history-agent'")).updated_at, '1');
  await archive(archiveDay, { ...dayPoint, mem_pct_avg: 55 });
  days = await withDBScope(historyEnv, env => loadAgentDaily(env, 'history-agent'));
  assert.equal(days.find(day => day.d === archiveDay).mem_pct_avg, 55);
  days.unshift({ ...dayPoint, d: expiredDay });
  await db.execute("UPDATE agent_history_daily SET days_json=$1 WHERE agent_id='history-agent'", [JSON.stringify(days)]);
  await withDBScope(historyEnv, env => pruneAgentDaily(env, 400));
  assert.deepEqual((await withDBScope(historyEnv, env => loadAgentDaily(env, 'history-agent'))).map(day => day.d), [earlierDay, archiveDay]);
  await db.execute("DELETE FROM agents WHERE id='history-agent'");
  assert.equal((await db.queryOne("SELECT count(*)::int AS n FROM agent_history_daily WHERE agent_id='history-agent'")).n, 0);

  /* 每次在独立数据库作用域内验证已迁移结构。
   * Validate the migrated schema inside a separate database scope for each call. */
  const guardEnv = { DATABASE_TYPE: 'postgres', DATABASE_URL: url };
  const guard = () => withDBScope(guardEnv, (requestEnv) => ensureSchemaReady(requestEnv));
  resetSchemaGuardCache();
  assert.deepEqual(await guard(), { ok: true }, 'a migrated schema must pass the guard');

  /* 移除迁移记录，验证即使表仍存在也会拒绝结构检查。
   * Remove a migration record to check rejection even when its tables still exist. */
  await db.execute('DELETE FROM schema_migrations WHERE name = $1', ['0013_usage_daily.postgres.sql']);
  resetSchemaGuardCache();
  const behind = await guard();
  assert.equal(behind.ok, false, 'a ledger missing a migration must fail the guard');
  assert.equal(behind.error, 'schema_behind');
  assert.ok(
    behind.missing.some((entry) => entry.includes('0013_usage_daily')),
    `the missing migration must be named: ${behind.missing.join(', ')}`,
  );
  assert.match(behind.message, /db-migrate-postgres\.mjs/, 'the message must name the command that fixes it');

  /**
   * The probe is cached, so restoring the ledger is not visible until the TTL
   * expires. Asserted rather than assumed: a guard with no cache would re-query
   * three catalog tables on every request, and one whose cache never expired
   * would keep a fixed database failing forever. 30s is the failure TTL, so
   * moving the clock past it is how the test avoids sleeping.
   *
   * 探测带缓存，恢复迁移记录要等 TTL 到期才可见。显式断言此行为：没有缓存会使每次请求查询
   * 三张系统目录表；永不过期则会让已修复的数据库永远失败。失败 TTL 为 30 秒，测试通过移动时钟避免实际等待。
   */
  await db.execute('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', ['0013_usage_daily.postgres.sql', Math.floor(Date.now() / 1000)]);
  assert.equal((await guard()).ok, false, 'the failing result is cached for its short TTL');

  const realNow = Date.now;
  try {
    // 30s is the failure TTL, so moving the clock past it is how this avoids a
    // real sleep. A cached verdict that never expired would keep a fixed
    // database failing forever; this is the assertion that it does not.
    // 失败 TTL 为 30 秒，移动时钟避免实际等待；此断言确保缓存会过期，不会让已修复数据库持续失败。
    Date.now = () => realNow() + 31_000;
    assert.equal((await guard()).ok, true, 'past the failure TTL the probe re-runs and passes');
  } finally {
    Date.now = realNow;
    resetSchemaGuardCache();
  }

  /**
   * The guard is a no-op on D1, which is what makes it safe to run in front of
   * every request rather than only the PG branch. Asserted with no `DB` binding
   * at all: touching the database here would throw, so a passing answer proves
   * the D1 path returns before any query.
   *
   * D1 上守卫为空操作，因此可安全放在所有请求前而不只放在 PG 分支。测试完全不提供 DB 绑定，
   * 若访问数据库就会抛错；通过表示 D1 路径在查询前返回。
   */
  assert.deepEqual(await ensureSchemaReady({ DB: {} }), { ok: true }, 'the guard must be a no-op on D1');

  /* 这里只核对入口调用关系；运行时结构行为由上方断言验证。
   * This assertion checks entry-point wiring; the preceding assertions exercise schema behavior. */
  const entry = readFileSync('backends/worker/src/index.ts', 'utf8');
  assert.match(
    entry,
    /ensureSchemaReady\s*\(/,
    'backends/worker/src/index.ts must call ensureSchemaReady from its fetch entry',
  );
  assert.match(
    readFileSync('backends/worker/src/lib/db/schema-guard.ts', 'utf8'),
    /probeSchema/,
    'the guard must be the thing that calls probeSchema',
  );
  console.log('PASS Postgres schema guard: passes a migrated schema, fails a stale ledger, caches the verdict, wired into fetch');
  await db.execute('INSERT INTO monitors (id, name, type, target, active, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $5)', ['utc-agent', 'Fixture agent', 'agent', 'fixture', Math.floor(Date.now() / 1000)]);
  const utcMinute = Date.UTC(2026, 0, 1, 20) / 1000;
  await db.execute(agentLiveSQL.postgres.recordAvailability, ['utc-agent', utcMinute, 1, 'utc-agent']);
  const utcDay = await db.queryOne(agentLiveSQL.postgres.dailyAvailability, ['utc-agent', utcMinute]);
  assert.equal(utcDay.d, '2026-01-01');
  assert.equal(String(utcDay.t), '1');

  // Statement-level contracts: each SQL constant is executed once with exactly
  // the parameters its production caller passes. These are what the
  // dialect-shape checks cannot see - a wrong column count or a reused $n is
  // valid-looking text and only PG rejects it.
  // 语句级契约：每个 SQL 常量用生产调用方传入的参数执行一次。列数错误或重复使用 $n
  // 在文本上可能看似合法，方言形状检查无法发现，只有 Postgres 会拒绝。
  const createdAt = 1_800_000_100;
  const updatedAt = 1_800_000_105;
  await db.execute(monitorSQL.postgres.insert, [
    'pg-insert-fixture', 'Insert fixture', 'http', 'https://fixture.invalid', 'GET', '200-299',
    null, 60, 10000, 14, 0, 0, 0, '{}', null, null, 1, 'pg-insert-group', createdAt, updatedAt,
  ]);
  const insertedMonitor = await db.queryOne(
    'SELECT num_id, group_id, active, created_at, updated_at FROM monitors WHERE id = $1',
    ['pg-insert-fixture'],
  );
  assert.notEqual(insertedMonitor.num_id, null, 'monitors.insert must allocate num_id');
  assert.equal(insertedMonitor.group_id, 'pg-insert-group');
  assert.equal(Number(insertedMonitor.active), 1);
  assert.equal(Number(insertedMonitor.created_at), createdAt);
  assert.equal(Number(insertedMonitor.updated_at), updatedAt);
  console.log('PASS Postgres monitors.insert: 20 params land on the right columns');

  const summaryTs = 1_800_000_120;
  await db.execute("INSERT INTO agents(id,name,token,created_at,updated_at) VALUES('pg-insert-fixture','History machine','pg-history-token',1,1)");
  const commandNow = 1_800_000_000;
  await db.execute(commandsSQL.postgres.insert, ['pg-lease-fixture', 'pg-insert-fixture', 're_report', commandNow, null]);
  await db.execute("UPDATE agent_commands SET state='leased', lease_token='lease', lease_until=$1 WHERE id='pg-lease-fixture'", [commandNow - 5]);
  const expiredCommand = await withDBScope({ DATABASE_TYPE: 'postgres', DATABASE_URL: url }, env => submitCommandResult(env, { id: 'pg-insert-fixture' }, { id: 'pg-lease-fixture', lease_token: 'lease', ok: true }, commandNow));
  assert.equal(expiredCommand, 'stale');
  assert.equal((await db.execute(commandsSQL.postgres.complete, [1, 'late', commandNow, 'pg-lease-fixture', 'lease', commandNow])).rowsAffected, 0);
  await db.execute("UPDATE agent_commands SET lease_until=$1 WHERE id='pg-lease-fixture'", [commandNow + 120]);
  const validCommand = await withDBScope({ DATABASE_TYPE: 'postgres', DATABASE_URL: url }, env => submitCommandResult(env, { id: 'pg-insert-fixture' }, { id: 'pg-lease-fixture', lease_token: 'lease', ok: true, message: 'done' }, commandNow));
  assert.equal(validCommand, 'recorded');
  assert.equal((await db.queryOne("SELECT state FROM agent_commands WHERE id='pg-lease-fixture'")).state, 'completed');
  console.log('PASS Postgres command lease expiry and atomic completion');
  await db.execute(agentLiveSQL.postgres.upsertFinalized, [
    'pg-insert-fixture', summaryTs, 11.5, 22.5, 33.5, 44.5, 1.25, 2.25, 12, 60, 100, 200, 60, 'pg-insert-fixture',
  ]);
  const snapshot = await db.queryOne(
    `SELECT cpu_avg, cpu_max, mem_pct_avg, mem_pct_max, sample_count, duration_sec, quality,
            net_up_bytes, net_down_bytes
       FROM machine_history WHERE agent_id = $1 AND bucket_ts = $2`,
    ['pg-insert-fixture', summaryTs],
  );
  assert.equal(snapshot.cpu_avg, 11.5);
  assert.equal(snapshot.cpu_max, 22.5);
  assert.equal(snapshot.mem_pct_avg, 33.5);
  assert.equal(snapshot.mem_pct_max, 44.5);
  assert.equal(Number(snapshot.sample_count), 12);
  assert.equal(Number(snapshot.duration_sec), 60);
  assert.equal(snapshot.quality, 'aggregate');
  assert.equal(Number(snapshot.net_up_bytes), 100);
  assert.equal(Number(snapshot.net_down_bytes), 200);
  console.log('PASS Postgres agent.upsertFinalized: 14 params land on the right columns');

  const dayStart = Date.UTC(2026, 0, 2, 0) / 1000;
  const availability = (minuteOffset, status) => [
    'pg-insert-fixture', dayStart + minuteOffset * 60, status, 'pg-insert-fixture',
  ];
  await db.execute(agentLiveSQL.postgres.recordAvailability, availability(0, 1));
  await db.execute(agentLiveSQL.postgres.recordAvailability, availability(1, 1));
  await db.execute(agentLiveSQL.postgres.recordAvailability, availability(2, 2));
  const daily = await db.queryOne(
    'SELECT total, up, warn, last_minute_ts FROM agent_uptime_daily WHERE monitor_id = $1 AND day = $2',
    ['pg-insert-fixture', '2026-01-02'],
  );
  assert.equal(Number(daily.total), 3);
  assert.equal(Number(daily.up), 2, 'up must accumulate only for status=1');
  assert.equal(Number(daily.warn), 1, 'warn must accumulate only for status=2');
  assert.equal(Number(daily.last_minute_ts), dayStart + 2 * 60);
  await db.execute(agentLiveSQL.postgres.recordAvailability, availability(2, 2));
  const replayed = await db.queryOne(
    'SELECT total, up, warn FROM agent_uptime_daily WHERE monitor_id = $1 AND day = $2',
    ['pg-insert-fixture', '2026-01-02'],
  );
  assert.deepEqual(
    { total: Number(replayed.total), up: Number(replayed.up), warn: Number(replayed.warn) },
    { total: 3, up: 2, warn: 1 },
    're-recording the same minute must not double count',
  );
  console.log('PASS Postgres agent.recordAvailability: up/warn split by status, same-minute replay ignored');

  await db.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, owner TEXT, lease_until BIGINT NOT NULL, value TEXT)`);
  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO ${table} (id, lease_until, value) VALUES ($1, $2, $3)`, [1, 0, 'rollback']);
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  assert.equal(await db.queryOne(`SELECT id FROM ${table} WHERE id = $1`, [1]), null);

  await db.execute(`INSERT INTO themes (short, id, name, version, manifest_json, installed_at, updated_at)
    VALUES ('removal-fixture', 'removal-fixture', 'Removal fixture', '1.0.0', '{}', 0, 0)`);
  await db.execute(`INSERT INTO theme_versions (id, version, digest, prefix, manifest_json, installed_at)
    VALUES ('removal-fixture', '1.0.0', 'digest', 'unused-fixture-prefix', '{}', 0)`);
  const removalPresentation = { agentEnabled: false, workerService: 'uptime-polaris', domains: [], pages: {
    monitor: { theme: { short: 'removal-fixture', version: '1.0.0', theme: 'main' }, themeOptions: { headline: 'saved' } },
    agent: { theme: null, themeOptions: {} },
  } };
  await db.execute("INSERT INTO presentation_state(id, config_json, revision, updated_at) VALUES ('main', $1, 'removal-fixture', 0)", [JSON.stringify(removalPresentation)]);
  const removed = await withDBScope({ DATABASE_TYPE: 'postgres', DATABASE_URL: url, THEMES: {
    async list({ prefix }) { assert.equal(prefix, 'themes/removal-fixture/'); return { objects: [], truncated: false }; },
  } }, removeEnv => removeTheme(removeEnv, 'removal-fixture'));
  assert.deepEqual(removed, { ok: true });
  for (const [themeTable, column] of [['themes', 'short'], ['theme_versions', 'id']]) {
    assert.equal(await db.queryOne(`SELECT ${column} FROM ${themeTable} WHERE ${column} = $1`, ['removal-fixture']), null);
  }
  const removedPresentation = JSON.parse((await db.queryOne("SELECT config_json FROM presentation_state WHERE id = 'main'")).config_json);
  assert.equal(removedPresentation.pages.monitor.theme, null);
  assert.deepEqual(removedPresentation.pages.monitor.themeOptions, {});
  console.log('PASS Postgres theme removal deletes registry, versions and page references');

  const writes = await db.commit([
    { sql: `INSERT INTO ${table} (id, owner, lease_until, value) VALUES ($1, $2, $3, $4)`, params: [1, 'seed', '9007199254740993', 'committed'] },
    { sql: `UPDATE ${table} SET value = $1 WHERE id = $2`, params: ['updated', 1] },
  ]);
  assert.deepEqual(writes, [1, 1]);
  const big = await db.queryOne(`SELECT owner, lease_until, value FROM ${table} WHERE id = $1`, [1]);
  assert.equal(big.owner, 'seed');
  assert.equal(String(big.lease_until), '9007199254740993');
  assert.equal(big.value, 'updated');

  const now = 1_800_000_000;
  const leaseClaims = (owner) => db.execute(tickLeaseSQL.postgres.claimTick, [owner, now + 60, now, now]);
  const claims = await Promise.all([leaseClaims('worker-a'), leaseClaims('worker-b')]);
  assert.equal(claims.filter((claim) => claim.rowsAffected === 1).length, 1);
  const lease = await db.queryOne('SELECT owner, lease_until FROM cron_tick_lease WHERE id = 1');
  assert(['worker-a', 'worker-b'].includes(lease.owner));
  assert.equal(String(lease.lease_until), String(now + 60));

  const tickWrites = [
    { sql: liveStateSQL.postgres.upsert, params: ['all', JSON.stringify({ monitor: { st: 2, resource_alerts: { cpu: { active: true, since: now } } } }), now] },
    { sql: eventsSQL.postgres.insert, params: ['monitor', 2, 'cpu 95 exceeded 80', now] },
    { sql: eventsSQL.postgres.insertPending, params: [
      'outbox', 'monitor:resource:cpu:entry@1', 'channel',
      JSON.stringify({ event: { monitorType: 'agent', eventKey: 'resource:cpu:entry', status: 2 }, channelId: 'channel' }), now,
    ] },
  ];
  await assert.rejects(commitTickWrites(db, lease.owner, now, [
    ...tickWrites,
    { sql: 'INSERT INTO missing_tick_fixture (id) VALUES ($1)', params: [1] },
  ]));
  assert.equal(await db.queryOne('SELECT id FROM live_state WHERE id = $1', ['all']), null);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS count FROM events')).count, '0');
  assert.equal((await db.queryOne('SELECT COUNT(*) AS count FROM pending_notifications')).count, '0');

  await commitTickWrites(db, lease.owner, now, tickWrites);
  const committedState = JSON.parse((await db.queryOne('SELECT json FROM live_state WHERE id=$1', ['all'])).json);
  assert.equal(committedState.monitor.resource_alerts.cpu.active, true);
  assert.equal((await db.queryOne('SELECT status FROM events WHERE monitor_id=$1', ['monitor'])).status, 2);
  const committedOutbox = await db.queryOne('SELECT payload_json FROM pending_notifications WHERE id=$1', ['outbox']);
  assert.equal(JSON.parse(committedOutbox.payload_json).event.eventKey, 'resource:cpu:entry');
  assert.equal((await db.queryOne('SELECT COUNT(*) AS count FROM pending_notifications')).count, '1');
  await assert.rejects(commitTickWrites(db, 'stale-owner', now, [
    { sql: liveStateSQL.postgres.upsert, params: ['all', '{}', now + 1] },
  ]), TickLeaseLost);
  assert.equal(JSON.parse((await db.queryOne('SELECT json FROM live_state WHERE id=$1', ['all'])).json).monitor.resource_alerts.cpu.active, true);

  await Promise.all([
    db.execute(liveStateSQL.postgres.merge, ['all', JSON.stringify({ 'parallel-a': { st: 0, v: null } }), now + 1]),
    db.execute(liveStateSQL.postgres.merge, ['all', JSON.stringify({ 'parallel-b': { st: 0, v: 15 } }), now + 1]),
  ]);
  await db.execute(liveStateSQL.postgres.merge, ['all', JSON.stringify({ 'parallel-a': { st: 1 } }), now + 2]);
  const merged = JSON.parse((await db.queryOne('SELECT json FROM live_state WHERE id=$1', ['all'])).json);
  assert.deepEqual(merged['parallel-a'], { st: 1 });
  assert.deepEqual(merged['parallel-b'], { st: 0, v: 15 });
  assert.equal(merged.monitor.resource_alerts.cpu.active, true);

  const scopedEnv = { DATABASE_TYPE: 'postgres', DATABASE_URL: url };
  const waitUntil = [];
  const requestAdapters = new Set();
  let requestConstructCount = 0;
  let requestAdapter;
  let requestCloseCount = 0;
  let requestEnvForFrame;
  const requestDB = (env) => {
    const adapter = getDB(env);
    if (!requestAdapters.has(adapter)) {
      requestAdapters.add(adapter);
      requestConstructCount++;
      const close = adapter.close.bind(adapter);
      adapter.close = async () => { requestCloseCount++; await close(); };
    }
    return adapter;
  };
  let releaseWaitUntil;
  const waitGate = new Promise((resolve) => { releaseWaitUntil = resolve; });
  await withDBScope(scopedEnv, async (requestEnv, ctx) => {
    requestEnvForFrame = requestEnv;
    requestAdapter = requestDB(requestEnv);
    assert.equal(getDB(requestEnv), requestAdapter);
    ctx.waitUntil(waitGate.then(() => requestDB(requestEnv).query('SELECT 1')));
  }, { waitUntil: (promise) => waitUntil.push(promise) });
  assert.equal(requestConstructCount, 1);
  assert.equal(requestCloseCount, 0);
  releaseWaitUntil();
  await Promise.all(waitUntil);
  assert.equal(requestCloseCount, 1);

  let closedFrameAdapter;
  let frameConstructCount = 0;
  let closedFrameCloseCount = 0;
  const frameAdapter = await withIndependentDBScope(requestEnvForFrame, async (frameEnv) => {
    const adapter = getDB(frameEnv);
    frameConstructCount++;
    const close = adapter.close.bind(adapter);
    adapter.close = async () => { closedFrameCloseCount++; await close(); };
    await adapter.query('SELECT 1');
    return adapter;
  });
  closedFrameAdapter = frameAdapter;
  assert.notEqual(closedFrameAdapter, requestAdapter);
  assert.equal(frameConstructCount, 1);
  assert.equal(closedFrameCloseCount, 1);

  const concurrentCloseCounts = [0, 0];
  const concurrentConstructCounts = [0, 0];
  const concurrentAdapters = await Promise.all([0, 1].map((index) => withDBScope(scopedEnv, async (requestEnv) => {
    let adapter;
    const requestGetDB = () => {
      const current = getDB(requestEnv);
      if (!adapter) {
        adapter = current;
        concurrentConstructCounts[index]++;
        const close = current.close.bind(current);
        current.close = async () => { concurrentCloseCounts[index]++; await close(); };
      }
      return current;
    };
    adapter = requestGetDB();
    assert.equal(requestGetDB(), adapter);
    await adapter.query('SELECT 1');
    return adapter;
  })));
  assert.notEqual(concurrentAdapters[0], concurrentAdapters[1]);
  assert.deepEqual(concurrentConstructCounts, [1, 1]);
  assert.deepEqual(concurrentCloseCounts, [1, 1]);

  let failedConstructCount = 0;
  let failedCloseCount = 0;
  await assert.rejects(withDBScope(scopedEnv, async (requestEnv) => {
    const adapter = getDB(requestEnv);
    failedConstructCount++;
    const close = adapter.close.bind(adapter);
    adapter.close = async () => { failedCloseCount++; await close(); };
    await adapter.query('SELECT 1');
    throw new Error('failed request fixture');
  }), /failed request fixture/);
  assert.equal(failedConstructCount, 1);
  assert.equal(failedCloseCount, 1);

  const authEnv = { DATABASE_TYPE: 'postgres', DATABASE_URL: url };
  const setupResults = await Promise.all([
    withDBScope(authEnv, (requestEnv) => finishSetup(requestEnv, 'owner-a', 'fixture password A')),
    withDBScope(authEnv, (requestEnv) => finishSetup(requestEnv, 'owner-b', 'fixture password B')),
  ]);
  assert.equal(setupResults.filter(Boolean).length, 1);
  assert.equal(await withDBScope(authEnv, (requestEnv) => countUsers(requestEnv)), 1);
  const winner = await db.queryOne('SELECT id, username FROM users');
  assert.equal(setupResults.includes(winner.id), true);
  assert(['owner-a', 'owner-b'].includes(winner.username));
  assert.equal((await db.queryOne('SELECT completed, claim_id FROM auth_setup_state WHERE id = 1')).completed, 1);
  assert.equal((await db.queryOne('SELECT completed, claim_id FROM auth_setup_state WHERE id = 1')).claim_id, null);
  console.log('PASS Postgres setup race: one winner, one user, completed claim');

  await db.execute('DELETE FROM users');
  await db.execute('UPDATE auth_setup_state SET completed = 0, claim_id = NULL WHERE id = 1');
  const chosenId = crypto.randomUUID();
  const authNow = Math.floor(Date.now() / 1000);
  await db.execute(`INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until)
    VALUES ($1, 'chosen-owner', 'fixture-hash', $2, $2, 0, 0)`, [chosenId, authNow]);
  assert.equal(await withDBScope(authEnv, (requestEnv) => finishSetup(requestEnv, 'third-owner', 'ignored password')), null);
  assert.deepEqual(Array.from(await db.query('SELECT id, username FROM users')), [{ id: chosenId, username: 'chosen-owner' }]);
  console.log('PASS Postgres setup preserves an existing chosen account');

  await db.execute('DELETE FROM users');
  await db.execute('UPDATE auth_setup_state SET completed = 0, claim_id = NULL WHERE id = 1');
  await db.execute(`CREATE FUNCTION reject_setup_complete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture setup completion failure'; END $$`);
  await db.execute(`CREATE TRIGGER reject_setup_complete BEFORE UPDATE OF completed ON auth_setup_state
    FOR EACH ROW WHEN (NEW.completed = 1) EXECUTE FUNCTION reject_setup_complete()`);
  await assert.rejects(withDBScope(authEnv, (requestEnv) =>
    finishSetup(requestEnv, 'rollback-owner', 'fixture password')), /fixture setup completion failure/);
  assert.equal(await db.query('SELECT id FROM users').then((rows) => rows.length), 0);
  const rolledBackClaim = await db.queryOne('SELECT completed, claim_id FROM auth_setup_state WHERE id = 1');
  assert.equal(rolledBackClaim.completed, 0);
  assert.equal(rolledBackClaim.claim_id, null);
  console.log('PASS Postgres setup failure rolls back user insert and claim');

  /* 对同一条旧记录改变限流窗口，验证参数绑定后的锁定与重置行为。
   * Vary the rate-limit window for the same stale row to check locking and reset after parameter binding. */
  const throttleNow = Math.floor(Date.now() / 1000);
  const throttleKey = `account:pg-throttle-${crypto.randomUUID()}`;
  const seedThrottle = () => db.execute(
    `INSERT INTO auth_login_limits (key_hash, attempts, window_started, locked_until)
     VALUES ($1, 7, $2, 0)
     ON CONFLICT (key_hash) DO UPDATE SET attempts = 7, window_started = $2, locked_until = 0`,
    [throttleKey, throttleNow - 120],
  );
  const throttleArgs = (windowSec, maxAttempts) => [
    throttleKey,
    throttleNow,
    throttleNow, windowSec,
    throttleNow, windowSec, throttleNow,
    throttleNow,
    throttleNow, windowSec,
    maxAttempts,
    throttleNow + windowSec,
  ];

  await seedThrottle();
  const outside = await db.queryOne(authSQL.postgres.reserveLoginAttempt, throttleArgs(60, 8));
  const afterOutside = await db.queryOne(
    'SELECT attempts, window_started, locked_until FROM auth_login_limits WHERE key_hash = $1',
    [throttleKey],
  );
  assert.equal(Number(afterOutside.attempts), 1, 'a row older than the window must reset');
  assert.equal(Number(afterOutside.locked_until), 0);
  assert.equal(Number(outside.locked_until), 0);

  await seedThrottle();
  const inside = await db.queryOne(authSQL.postgres.reserveLoginAttempt, throttleArgs(300, 8));
  const afterInside = await db.queryOne(
    'SELECT attempts, locked_until FROM auth_login_limits WHERE key_hash = $1',
    [throttleKey],
  );
  assert.equal(Number(afterInside.attempts), 8, 'a row inside the window must reach the ceiling');
  assert(Number(inside.locked_until) > throttleNow, 'and the returned lock must be in the future');

  // A lower ceiling locks earlier, so $11 is the ceiling and not the window.
  // 更低的上限使锁定更早发生，因此 $11 是上限而非窗口。
  await seedThrottle();
  await db.execute('UPDATE auth_login_limits SET attempts = 2 WHERE key_hash = $1', [throttleKey]);
  const lockedAtThree = await db.queryOne(authSQL.postgres.reserveLoginAttempt, throttleArgs(300, 3));
  assert(Number(lockedAtThree.locked_until) > throttleNow, 'ceiling 3 must lock the third attempt');

  await db.execute('DELETE FROM auth_login_limits WHERE key_hash = $1', [throttleKey]);
  console.log('PASS Postgres auth.reserveLoginAttempt: window ($4/$6/$10) and ceiling ($11) bind by position');

  /**
   * `recordFailure` is the per-account half of the same rule, and it had its own
   * literal (`failed_count + 1 >= 8`). Exercised against the `users` row left
   * above so the two halves are proven to move together.
   *
   * recordFailure 是同一规则的按账号部分，也曾写死 failed_count + 1 >= 8。
   * 使用上方留下的 users 行测试，确保两部分一起随设置变化。
   */
  // The setup cases above leave the table empty, so the row this needs is
  // created here rather than assumed to exist.
  // 上方初始化测试结束后表为空，因此在此创建所需行，而不是假定其存在。
  const throttleUserId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until)
     VALUES ($1, 'pg-throttle-user', 'pbkdf2$1$x$y', $2, $2, 0, 0)`,
    [throttleUserId, throttleNow],
  );
  const throttleUser = { id: throttleUserId };
  for (let i = 0; i < 2; i++) {
    await db.execute(authSQL.postgres.recordFailure, [3, throttleNow + 300, throttleUser.id]);
  }
  const beforeCeiling = await db.queryOne('SELECT failed_count, locked_until FROM users WHERE id = $1', [throttleUser.id]);
  assert.equal(Number(beforeCeiling.failed_count), 2);
  assert.equal(Number(beforeCeiling.locked_until), 0, 'two failures must not lock a ceiling of three');

  await db.execute(authSQL.postgres.recordFailure, [3, throttleNow + 300, throttleUser.id]);
  const atCeiling = await db.queryOne('SELECT failed_count, locked_until FROM users WHERE id = $1', [throttleUser.id]);
  assert.equal(Number(atCeiling.failed_count), 3);
  assert.equal(Number(atCeiling.locked_until), throttleNow + 300, 'the third failure locks');
  await db.execute('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = $1', [throttleUser.id]);
  console.log('PASS Postgres auth.recordFailure: the ceiling is the bound value, not a literal 8');
  // 设置存放在 KV；此夹具只需要命令通道开关。 / Settings live in KV; this fixture only needs the command-channel toggle.
  const settingsStore = new Map([['settings', JSON.stringify({ 'security.allowAgentCommands': true })]]);
  const managementEnv = {
    DATABASE_TYPE: 'postgres', DATABASE_URL: url,
    CONFIG: {
      async get(key, type) {
        const raw = settingsStore.get(key);
        return raw === undefined ? null : type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { settingsStore.set(key, String(value)); },
      async delete(key) { settingsStore.delete(key); },
    },
  };
  for (const id of ['management-a', 'management-b']) {
    await db.execute('INSERT INTO agents(id,name,token,created_at,updated_at) VALUES($1,$1,$1,$2,$2)', [id, now]);
    await db.execute("INSERT INTO monitors(id,num_id,name,type,target,created_at,updated_at) VALUES($1,(SELECT COALESCE(MAX(num_id),0)+1 FROM monitors),$1,'agent','',$2,$2)", [id, now]);
    await db.execute('INSERT INTO heartbeat_ring(id,json,updated_at) VALUES($1,$2,$3)', [id, '[]', now]);
    await db.execute('INSERT INTO pending_notifications(id,event_id,channel_id,payload_json,created_at) VALUES($1,$1,$2,$3,$4)', [id, 'channel', JSON.stringify({ event: { monitorId: id } }), now]);
  }
  for (const id of ['management-a', 'management-b']) await db.execute(monitorSQL.postgres.setGroup, [null, now, id]);
  await withDBScope(managementEnv, (env) => deleteMonitor(env, 'management-a', 'agent'));
  assert.equal(await db.queryOne('SELECT id FROM monitors WHERE id=$1', ['management-a']), null);
  assert.equal(await db.queryOne('SELECT id FROM heartbeat_ring WHERE id=$1', ['management-a']), null);
  assert.equal(await db.queryOne('SELECT id FROM pending_notifications WHERE id=$1', ['management-a']), null);
  assert.notEqual(await db.queryOne('SELECT id FROM monitors WHERE id=$1', ['management-b']), null);
  const checkSnapshot = await db.queryOne('SELECT * FROM monitors WHERE id=$1', ['management-b']);
  await commitMonitorWrites(db, checkSnapshot, now, [{ sql: 'INSERT INTO events(monitor_id,status,message,created_at) VALUES($1,1,$2,$3)', params: [checkSnapshot.id, 'snapshot valid', now] }]);
  await db.execute('UPDATE monitors SET target=$1 WHERE id=$2', ['changed', checkSnapshot.id]);
  await assert.rejects(commitMonitorWrites(db, checkSnapshot, now, [{ sql: 'INSERT INTO events(monitor_id,status,message,created_at) VALUES($1,1,$2,$3)', params: [checkSnapshot.id, 'stale result', now] }]), MonitorChanged);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM events WHERE message=$1', ['stale result'])).n, '0');

  await db.execute('DELETE FROM pending_notifications');
  for (const [id, status, at] of [['ordered-down', 0, now], ['ordered-up', 1, now + 10]]) {
    await db.execute(eventsSQL.postgres.insertPending, [id, id, 'ordered-channel', JSON.stringify({ event: { monitorId: 'ordered-monitor', status, at } }), at]);
  }
  await db.execute('UPDATE pending_notifications SET next_attempt=$1 WHERE id=$2', [now + 30, 'ordered-down']);
  assert.equal((await db.query(eventsSQL.postgres.listPending, [now + 10, now + 10, now - 86400, now - 86400, 20])).length, 0);
  assert.equal((await db.execute(eventsSQL.postgres.claimPending, [now + 100, 'ordered-up', now + 10, now + 10, now - 86400, now - 86400])).rowsAffected, 0);
  const firstPending = await db.query(eventsSQL.postgres.listPending, [now + 31, now + 31, now - 86400, now - 86400, 20]);
  assert.equal(firstPending.length, 1);
  assert.equal(firstPending[0].id, 'ordered-down');
  await db.execute(eventsSQL.postgres.deletePending, ['ordered-down', 'ordered-channel']);
  const nextPending = await db.query(eventsSQL.postgres.listPending, [now + 31, now + 31, now - 86400, now - 86400, 20]);
  assert.equal(nextPending.length, 1);
  assert.equal(nextPending[0].id, 'ordered-up');
  console.log('PASS Postgres monitor snapshots and per-monitor notification ordering');
  console.log('PASS Postgres management: grouping and shared deletion clean up only the selected agent');
  const avatarBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGNgYGD4z8Dwn4GBAQAAAAD//wMAAP8A//8AAoAAAf+amj8cAAAAAElFTkSuQmCC', 'base64'));
  await withDBScope(managementEnv, async (env) => {
    assert.deepEqual(await readAvatarInfo(env, throttleUser.id), { uploaded: false, url: null });
    const saved = await writeAvatar(env, throttleUser.id, avatarBytes);
    assert.deepEqual(await readAvatarInfo(env, throttleUser.id), saved);
    assert.deepEqual(await readAvatarImage(env, throttleUser.id), avatarBytes);
    assert.notEqual((await writeAvatar(env, throttleUser.id, avatarBytes)).url, saved.url);
    await removeAvatar(env, throttleUser.id);
    assert.deepEqual(await readAvatarInfo(env, throttleUser.id), { uploaded: false, url: null });
    assert.equal(await readAvatarImage(env, throttleUser.id), null);
  });
  console.log('PASS Postgres account avatars: upload, byte preservation, replacement and removal');
  await db.execute("INSERT INTO agents(id,name,active,token,created_at,updated_at) VALUES('runtime-config-pg','Runtime PG',1,'runtime-config-pg-token',1,1)");
  const runtimeApp = new Hono();
  runtimeApp.get('/admin/:id', handleGetAgentConfiguration);
  runtimeApp.put('/admin/:id', handleSaveAgentConfiguration);
  runtimeApp.post('/exchange/:token', handleAgentConfigurationExchange);
  const runtimeRequest = (path, method = 'GET', body) => withDBScope(managementEnv, (env) => runtimeApp.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env));
  const runtimeInitial = { sample_interval_secs: 5, report_interval_secs: 60, include_nics: [], exclude_nics: [], include_mounts: [], exclude_mounts: [], auto_update: false };
  const runtimeInstallation = { service_tier: 'manual', config_path: '/fixture/config.json', executable_path: '/fixture/probe', auto_update_supported: false };
  assert.equal((await runtimeRequest('/exchange/runtime-config-pg-token', 'POST', { config: runtimeInitial, revision: null, installation: runtimeInstallation })).status, 200);
  const runtimeNext = { ...runtimeInitial, sample_interval_secs: 10, report_interval_secs: 120 };
  const runtimeSave = await runtimeRequest('/admin/runtime-config-pg', 'PUT', { config: runtimeNext, expected_revision: null });
  assert.equal(runtimeSave.status, 200, await runtimeSave.clone().text());
  const runtimeRevision = (await runtimeSave.json()).revision;
  assert.equal((await runtimeRequest('/admin/runtime-config-pg', 'PUT', { config: runtimeNext, expected_revision: null })).status, 409);
  const runtimeDelivery = await (await runtimeRequest('/exchange/runtime-config-pg-token', 'POST', { config: runtimeInitial, revision: null, installation: runtimeInstallation })).json();
  assert.deepEqual(runtimeDelivery.runtime_config, { config: runtimeNext, revision: runtimeRevision });
  assert.equal((await runtimeRequest('/exchange/runtime-config-pg-token', 'POST', { config: runtimeNext, revision: runtimeRevision, installation: runtimeInstallation })).status, 200);
  const runtimeApplied = await (await runtimeRequest('/admin/runtime-config-pg')).json();
  assert.equal(runtimeApplied.status, 'synced');
  assert.deepEqual(runtimeApplied.current, runtimeNext);
  await withDBScope(managementEnv, (env) => deleteAgent(env, 'runtime-config-pg'));
  assert.equal((await db.queryOne("SELECT COUNT(*)::int AS n FROM agent_runtime_configs WHERE agent_id='runtime-config-pg'")).n, 0);
  console.log('PASS Postgres Agent runtime configuration: report, guarded save/conflict, desired delivery, ACK and cascade deletion');
  await withDBScope(managementEnv, async env => {
    const machine = { id: '12345678-1234-4234-8234-123456789abc', name: 'Probe PG', token: 'probe-pg-token', active: 1, options_json: '{}', created_at: now, updated_at: now };
    await db.execute('INSERT INTO agents(id,name,token,active,created_at,updated_at) VALUES($1,$2,$3,1,$4,$4)', [machine.id, machine.name, machine.token, now]);
    await db.execute('INSERT INTO machine_live(agent_id,version,probe_capabilities,report_interval_secs,reported_at,updated_at) VALUES($1,$2,$3,60,$4,$4)',
      [machine.id, '0.5.4', JSON.stringify(['probe_http', 'probe_ssl', 'probe_domain', 'probe_dns']), now]);
    await db.execute("INSERT INTO monitors(id,name,type,target,agent_id,check_ssl,check_domain,check_dns,options_json,created_at,updated_at) VALUES('pg-native-check','Probe monitor','http','https://example.com',$1,1,1,1,$2,$3,$3)",
      [machine.id, JSON.stringify({ check_source: { type: 'agent', agent_id: machine.id }, dns: { recordType: 'A' } }), now]);
    const monitor = await db.queryOne("SELECT * FROM monitors WHERE id='pg-native-check'");
    await scheduleAgentProbeJobs(env, [monitor], now);
    const [job] = await pollAgentProbeJobs(env, machine, now);
    assert.ok(job.addons.ssl && job.addons.domain && job.addons.dns);
    const input = { run_id: job.run_id, lease_token: job.lease_token, observed_at: now, status: 1, status_code: 200, latency_ms: 12, message: '', addons: {
      ssl: { status: 1, days_left: 100, tls_valid: true, observed_at: now, message: 'SSL valid' },
      domain: { status: 1, days_left: 100, observed_at: now, message: 'Domain valid' },
      dns: { status: 1, observed_at: now, message: 'DNS valid', records: ['192.0.2.1'], rcode: 'NOERROR' },
    } };
    assert.equal(await submitAgentProbeResult(env, machine, { ...input, addons: {} }, now), 'invalid');
    assert.equal(await submitAgentProbeResult(env, machine, input, now), 'accepted');
    assert.equal(await submitAgentProbeResult(env, machine, input, now), 'duplicate');
    const observation = await latestAgentProbeObservation(env, monitor, 0, now);
    assert.equal(observation.latencyMs, 12);
    assert.equal(observation.addons.ssl.days, 100);
    assert.deepEqual(observation.addons.dns.records, ['192.0.2.1']);
  });
  console.log('PASS Postgres Agent probes: capability dispatch, lease claims, addon validation, result CAS and persisted readings');
  console.log('PASS isolated Postgres: full migrations/auth schema, DB scope lifetimes, rollback, atomic tick/outbox, BIGINT string, and lease fencing');
} finally {
  try {
    if (fixtureVerified) {
      for (const name of ['agent_runtime_configs', 'pending_notifications', 'events', 'live_state', 'cron_tick_lease', 'agent_uptime_daily', 'agent_probe_jobs', 'monitors', 'machine_history', 'machine_live', 'agents']) await db.execute(`DROP TABLE IF EXISTS ${name} CASCADE`);
      await db.execute(`DROP TABLE IF EXISTS ${table}`);
    }
  } finally { await db.close(); }
}
