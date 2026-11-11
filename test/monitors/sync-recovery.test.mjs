// 验证历史回填恢复、游标与投递记录保留。
// Check history backfill recovery, cursors, and delivery retention.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const fixtureNow = Date.now();
const latest = new Date(fixtureNow - 86_400_000).toISOString().slice(0, 10);
const failedDay = new Date(Date.parse(`${latest}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
const worker = await build({
  stdin: {
    contents: `
      import { runSync } from './backends/worker/src/lib/jobs/daily-sync.ts';
      import { resetSettingsCache } from './backends/worker/src/lib/settings/store.ts';
      Date.now = () => ${fixtureNow};
      let failed = false;
      const queried = [];
      globalThis.fetch = async (_input, init) => {
        const sql = String(init?.body);
        const day = sql.match(/toDateTime\\('(\\d{4}-\\d{2}-\\d{2}) 00:00:00'/)?.[1];
        queried.push(day);
        if (day === ${JSON.stringify(failedDay)} && !failed) {
          failed = true;
          return Response.json({ success: false, errors: ['fixture failure'] });
        }
        const data = day === ${JSON.stringify(failedDay)}
          ? [
              { idx: 'paused-exact-fixture', total: 200, up: 0, warn: 0, avg: 123 },
              { idx: 'paused-race-fixture', total: 200, up: 0, warn: 0, avg: 123 },
            ]
          : [];
        return Response.json({ success: true, data });
      };
      export default { async fetch(request, env) {
        resetSettingsCache();
        const scoped = new URL(request.url).pathname === '/disabled'
          ? { ...env, CF_API_TOKEN: '' }
          : env;
        const start = queried.length;
        const result = await runSync(scoped);
        return Response.json({ ...result, queried: queried.slice(start) });
      } };
    `,
    resolveDir: process.cwd(),
    sourcefile: 'sync-recovery-fixture.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  external: ['cloudflare:sockets'],
  logLevel: 'error',
  plugins: [{
    name: 'stub-postgres',
    setup(builder) {
      builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
      builder.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
        contents: `export default function postgres() { throw new Error('postgres is unused in this D1 fixture'); }`,
      }));
    },
  }],
});

const mf = new Miniflare({
  modules: true,
  script: worker.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  d1Databases: { DB: 'sync-recovery-fixture' },
  analyticsEngineDatasets: { UPTIME: { dataset: 'uptime_heartbeats' } },
  bindings: { CF_ACCOUNT_ID: 'fixture-account', CF_API_TOKEN: 'fixture-token' },
});

let db;
let startupTimer;
try {
  console.log('sync recovery fixture: waiting for isolated D1 binding');
  db = await Promise.race([
    mf.getD1Database('DB'),
    new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error('D1 fixture startup timed out after 20s')), 20_000);
    }),
  ]);
} catch (error) {
  await mf.dispose();
  throw error;
} finally {
  clearTimeout(startupTimer);
}

try {
  await applyD1Migrations(db);

  const pausedId = 'paused-exact-fixture';
  const now = Math.floor(fixtureNow / 1000);
  await db.prepare('INSERT INTO monitors (id,name,type,target,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(pausedId, 'Paused exact fixture', 'http', 'https://example.invalid', 0, now, now).run();
  const priorSample = { d: failedDay, t: 60, u: 60, w: 0, avg: 12 };
  await db.prepare('INSERT INTO monitor_uptime (monitor_id,days_json,updated_at) VALUES (?,?,?)')
    .bind(pausedId, JSON.stringify([priorSample]), now).run();
  await db.prepare('INSERT INTO live_state (id,json,updated_at) VALUES (?,?,?)')
    .bind('all', JSON.stringify({ [pausedId]: { availability: { endMinute: 0, minutes: [], daily: [failedDay, 1, 1, 0] } } }), now).run();

  const raceId = 'paused-race-fixture';
  await db.prepare('INSERT INTO monitors (id,name,type,target,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(raceId, 'Paused race fixture', 'http', 'https://example.invalid', 0, now, now).run();
  const committedRace = { d: failedDay, t: 60, u: 59, w: 1, avg: 12, exact: true };
  await db.prepare('INSERT INTO monitor_uptime (monitor_id,days_json,updated_at) VALUES (?,?,?)')
    .bind(raceId, JSON.stringify([committedRace]), now).run();
  await db.prepare('UPDATE live_state SET json=? WHERE id=\'all\'')
    .bind(JSON.stringify({
      [pausedId]: { availability: { endMinute: 0, minutes: [], daily: [failedDay, 1, 1, 0] } },
      [raceId]: { availability: { endMinute: 0, minutes: [], daily: [failedDay, 60, 60, 0] } },
    })).run();

  const request = (path) => mf.dispatchFetch(`http://localhost${path}`);
  const first = await (await request('/sync')).json();
  assert.equal(first.status, 'partial');
  assert.equal(first.attempted, 3);
  assert.equal(first.failed, 1);
  assert.equal(await db.prepare("SELECT json FROM live_state WHERE id='sync'").first(), null);

  const recovered = await (await request('/sync')).json();
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.attempted, 3);
  assert.deepEqual(await db.prepare("SELECT json FROM live_state WHERE id='sync'").first(), {
    json: JSON.stringify({ cursor: failedDay }),
  });
  const exactDay = JSON.parse((await db.prepare('SELECT days_json FROM monitor_uptime WHERE monitor_id=?').bind(pausedId).first()).days_json)[0];
  assert.deepEqual(exactDay, { d: failedDay, t: 1, u: 1, w: 0, avg: 12, exact: true });
  assert.ok(exactDay.u + exactDay.w <= exactDay.t);
  const raceDay = JSON.parse((await db.prepare('SELECT days_json FROM monitor_uptime WHERE monitor_id=?').bind(raceId).first()).days_json)[0];
  assert.deepEqual(raceDay, committedRace);
  assert.ok(raceDay.u + raceDay.w <= raceDay.t);
  assert.equal((await (await request('/sync')).json()).status, 'complete');
  assert.equal((await (await request('/sync')).json()).status, 'complete');
  assert.deepEqual(await db.prepare("SELECT json FROM live_state WHERE id='sync'").first(), {
    json: JSON.stringify({ cursor: latest }),
  });
  const steady = await (await request('/sync')).json();
  assert.equal(steady.days, 2);
  assert.equal(steady.attempted, 2);

  const staleCursor = new Date(Date.parse(`${latest}T00:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10);
  await db.prepare("UPDATE live_state SET json=? WHERE id='sync'").bind(JSON.stringify({ cursor: staleCursor })).run();
  const bounded = await (await request('/sync')).json();
  assert.equal(bounded.days, 3);
  assert.equal(bounded.queried[0], new Date(Date.parse(`${latest}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10));

  const monitorId = 'sync-retention-fixture';
  await db.prepare('INSERT INTO monitors (id,name,type,target,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind(monitorId, 'Retention fixture', 'http', 'https://example.invalid', now, now).run();
  const oldDay = new Date((now - 401 * 86_400) * 1000).toISOString().slice(0, 10);
  const retainedDay = new Date((now - 399 * 86_400) * 1000).toISOString().slice(0, 10);
  await db.prepare('INSERT INTO monitor_uptime (monitor_id,days_json,updated_at) VALUES (?,?,?)')
    .bind(monitorId, JSON.stringify([
      { d: oldDay, t: 60, u: 60, w: 0, avg: null },
      { d: retainedDay, t: 60, u: 60, w: 0, avg: null },
    ]), now).run();
  await db.prepare("INSERT OR IGNORE INTO agents(id,name,token,created_at,updated_at) VALUES(?,'History fixture','fixture-token',1,1)").bind(monitorId).run();
  await db.prepare('INSERT INTO machine_history (agent_id,bucket_ts) VALUES (?,?)')
    .bind(monitorId, now - 91 * 86_400).run();
  await db.prepare('INSERT INTO machine_history (agent_id,bucket_ts) VALUES (?,?)')
    .bind(monitorId, now - 89 * 86_400).run();
  await db.prepare('INSERT INTO agent_uptime_daily (monitor_id,day,total,up,warn,last_minute_ts) VALUES (?,?,?,?,?,?)')
    .bind(monitorId, oldDay, 1440, 1440, 0, now - 401 * 86_400).run();
  await db.prepare('INSERT INTO agent_uptime_daily (monitor_id,day,total,up,warn,last_minute_ts) VALUES (?,?,?,?,?,?)')
    .bind(monitorId, retainedDay, 1440, 1440, 0, now - 399 * 86_400).run();

  /* 同时断言旧投递记录删除与近期记录保留。
   * Assert both deletion of old delivery records and retention of recent ones. */
  const deliveryNow = Math.floor(fixtureNow / 1000);
  const oldDelivery = 'delivery-old-fixture';
  const freshDelivery = 'delivery-fresh-fixture';
  const insertDelivery = (id, createdAt) => db.prepare(
    'INSERT INTO notification_deliveries (id, channel_id, monitor_id, monitor_name, status, ok, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(id, 'channel-fixture', monitorId, 'Retention fixture', 0, 1, 12, null, createdAt).run();
  await insertDelivery(oldDelivery, deliveryNow - 120 * 86_400);
  await insertDelivery(freshDelivery, deliveryNow - 86_400);

  const disabled = await (await request('/disabled')).json();
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.days, 0);
  assert.equal(disabled.attempted, 0);
  const retainedHistory = JSON.parse((await db.prepare('SELECT days_json FROM monitor_uptime WHERE monitor_id=?').bind(monitorId).first()).days_json);
  assert.deepEqual(retainedHistory.map((entry) => entry.d), [retainedDay]);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM machine_history WHERE agent_id=?').bind(monitorId).first().then((row) => row.n), 1);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM agent_uptime_daily WHERE monitor_id=?').bind(monitorId).first().then((row) => row.n), 1);
  assert.equal(
    await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE id=?').bind(oldDelivery).first().then((row) => row.n),
    0,
    'a delivery older than retention.eventDays must be pruned by housekeeping',
  );
  assert.equal(
    await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE id=?').bind(freshDelivery).first().then((row) => row.n),
    1,
    'a delivery inside the window must survive',
  );
  // 保留配置不可读或清理表故障时必须失败，不能静默采用默认值。
  // Fail when retention configuration or cleanup tables are unavailable.
  for (const table of ['app_settings', 'agent_commands', 'machine_history', 'events']) {
    await db.prepare(`ALTER TABLE ${table} RENAME TO fixture_unavailable`).run();
    const unavailable = await mf.dispatchFetch('http://localhost/disabled');
    assert.equal(unavailable.status, 500, table);
    await unavailable.text();
    await db.prepare(`ALTER TABLE fixture_unavailable RENAME TO ${table}`).run();
  }
  console.log('PASS Miniflare D1 cursor retry, bounded recovery, disabled AE status, and delivery retention');
} finally {
  await mf.dispose();
}
