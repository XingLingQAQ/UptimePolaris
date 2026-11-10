// 验证机器登记迁移保留凭据、关联和历史。
// Check that registry migration preserves credentials, associations, and history.

import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { migrationPlan } from '../../scripts/db/build-schema-bootstrap.mjs';

const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
  compatibilityDate: '2025-01-01', d1Databases: { DB: 'migration-fixture' } });
try {
  const db = await mf.getD1Database('DB');
  const plan = migrationPlan();
  const registryIndex = plan.findIndex(file => file.name === '0037_agent_registry_visibility.sql');
  assert.ok(registryIndex > 0);
  for (const file of plan.slice(0, registryIndex)) await db.batch(file.statements.map(sql => db.prepare(sql)));
  const id = '12345678-1234-4234-8234-123456789abc';
  await db.prepare("INSERT INTO monitors(id,num_id,name,type,target,agent_token,options_json,created_at,updated_at) VALUES(?,1,'Existing machine','agent','','saved-token',?,1,1)")
    .bind(id, JSON.stringify({ probe_enabled: false, alerts: { cpu: { enabled: true, threshold: 90, duration_sec: 60, recovery_pct: 80 } } })).run();
  await db.prepare("INSERT INTO machine_live(monitor_id,cpu_usage,reported_at,updated_at) VALUES(?,42,100,100)").bind(id).run();
  await db.prepare("INSERT INTO machine_history(monitor_id,bucket_ts,cpu_avg,quality) VALUES(?,60,32,'finalized')").bind(id).run();
  await db.prepare("INSERT INTO agent_runtime_configs(monitor_id,reported_json,updated_at) VALUES(?,'{}',100)").bind(id).run();
  await db.prepare("INSERT INTO agent_uptime_daily(monitor_id,day,total,up,warn,last_minute_ts) VALUES(?,'2026-01-01',1,1,0,60)").bind(id).run();
  await db.prepare("INSERT INTO monitors(id,num_id,name,type,target,options_json,created_at,updated_at) VALUES('web',2,'Web','http','https://example.com',?,1,1)")
    .bind(JSON.stringify({ check_source: { type: 'agent', agent_id: id } })).run();
  for (const file of plan.slice(registryIndex)) await db.batch(file.statements.map(sql => db.prepare(sql)));
  const machine = await db.prepare('SELECT * FROM agents WHERE id=?').bind(id).first();
  assert.equal(machine.token, 'saved-token');
  assert.equal(machine.group_id, null, 'machine groups remain independent of monitor groups');
  const agentForeignKeys = (await db.prepare('PRAGMA foreign_key_list(agents)').all()).results;
  assert.ok(agentForeignKeys.some(key => key.from === 'group_id' && key.table === 'agent_groups' && key.on_delete === 'SET NULL'));
  assert.equal(JSON.parse(machine.options_json).probe_enabled, false);
  const monitor = await db.prepare('SELECT * FROM monitors WHERE id=?').bind(id).first();
  assert.equal(monitor.agent_id, id);
  assert.equal(monitor.is_public, 1);
  assert.equal('agent_token' in monitor, false);
  assert.equal('probe_enabled' in JSON.parse(monitor.options_json), false);
  assert.ok(JSON.parse(monitor.options_json).alerts.cpu);
  assert.equal((await db.prepare("SELECT agent_id FROM monitors WHERE id='web'").first()).agent_id, id);
  assert.equal((await db.prepare('SELECT cpu_usage FROM machine_live WHERE agent_id=?').bind(id).first()).cpu_usage, 42);
  assert.equal((await db.prepare('SELECT cpu_avg FROM machine_history WHERE agent_id=?').bind(id).first()).cpu_avg, 32);
  assert.ok(await db.prepare('SELECT agent_id FROM agent_runtime_configs WHERE agent_id=?').bind(id).first());
  assert.equal((await db.prepare('SELECT total FROM agent_uptime_daily WHERE monitor_id=?').bind(id).first()).total,1);
  await db.prepare('DELETE FROM monitors WHERE id=?').bind(id).run();
  assert.ok(await db.prepare('SELECT agent_id FROM machine_live WHERE agent_id=?').bind(id).first(), 'even equal machine and monitor IDs have independent lifetimes');
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  console.log('PASS D1 registry migration retains credentials, associations, policies, runtime configuration and machine history');
} finally { await mf.dispose(); }
