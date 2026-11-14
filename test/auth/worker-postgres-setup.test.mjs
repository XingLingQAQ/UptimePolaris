// Check setup and sessions with a D1 control record and with PostgreSQL alone.
// 验证带 D1 控制记录及纯 PostgreSQL 的初始化与会话。

import assert from 'node:assert/strict';
import postgres from 'postgres';
import { Miniflare } from 'miniflare';
import app from '../../backends/worker/src/index.ts';

const port = Number(process.env.UPTIME_FIXTURE_PORT);
assert.ok(Number.isInteger(port) && port > 0);
const workerOptions = {
  modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
  compatibilityDate: '2025-01-01', bindings: { ADMIN_TOKEN: 'fixture-setup-credential' },
  kvNamespaces: { CONFIG: crypto.randomUUID(), D1_CONFIG: crypto.randomUUID(), PG_CONFIG: crypto.randomUUID() },
  d1Databases: { DB: crypto.randomUUID() },
};
const mf = new Miniflare(workerOptions);
const db = await mf.getD1Database('DB');
const admin = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
const ctx = { waitUntil() {} };
const config = name => ({ DATABASE_TYPE: 'postgres', DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/${name}?sslmode=disable`,
  ADMIN_TOKEN: 'fixture-setup-credential', PBKDF2_ITERATIONS: '3000', UPTIME: { writeDataPoint() {} } });
async function request(env, path, body, cookie) {
  const headers = new Headers();
  if (body) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  const response = await app.fetch(new Request('https://fixture.test' + path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) }), env, ctx);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}
async function scenario(name, withD1) {
  // KV 是必需的部署项；每个场景独占命名空间，避免保存的选库记录互相影响。
  // KV is a required deployment item; each scenario owns its namespace so saved selections do not leak.
  const env = { ...config(name), CONFIG: await mf.getKVNamespace(withD1 ? 'D1_CONFIG' : 'PG_CONFIG'), ...(withD1 ? { DB: db } : {}) };
  if (!withD1) {
    const before = await request({ ...env, DATABASE_URL: undefined }, '/api/auth/session');
    assert.equal(before.response.status, 200);
    assert.ok(before.body.setupRequirements.every(item => !item.required || item.ok));
    assert.deepEqual(before.body.setupDatabase, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: false, postgresUrlEditable: true });
    const after = await request(env, '/api/auth/session');
    assert.deepEqual(after.body.setupDatabase, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: true, postgresUrlEditable: true });
  }
  for (const path of ['/', '/admin', '/unknown']) {
    const response = await app.fetch(new Request('https://fixture.test' + path), env, ctx);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), '/setup');
  }
  const blocked = await app.fetch(new Request('https://fixture.test/api/monitors', {
    headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
  }), env, ctx);
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, 'setup_required');
  assert.equal((await request(env, '/api/auth/session')).body.needsSetup, true);
  const setup = await request(env, '/api/auth/setup', { credential: 'fixture-setup-credential', username: 'owner', password: 'fixture-password', database: { type: 'postgres' } });
  assert.equal(setup.response.status, 200, JSON.stringify(setup.body));
  const cookie = setup.response.headers.get('set-cookie').split(';')[0];
  const session = await request({ ...env }, '/api/auth/session', undefined, cookie);
  assert.equal(session.response.status, 200);
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.username, 'owner');
  assert.equal(session.body.needsSetup, false);
  assert.equal(session.body.setupDatabase, null);
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  try {
    const [user] = await sql`SELECT count(*)::int AS n FROM users`;
    const [sessions] = await sql`SELECT count(*)::int AS n FROM sessions`;
    const [migrations] = await sql`SELECT count(*)::int AS n FROM schema_migrations`;
    assert.equal(user.n, 1); assert.equal(sessions.n, 1); assert.ok(migrations.n > 0);
  } finally { await sql.end(); }
  if (withD1) {
    const sql = postgres(env.DATABASE_URL, { max: 1 });
    const [row] = await sql`SELECT phase, type FROM _polaris_database WHERE id = 1`;
    await sql.end();
    const saved = await env.CONFIG.get('database', 'json');
    assert.equal(row.phase, 'active'); assert.equal(row.type, 'postgres');
    assert.ok(saved.encrypted_url.startsWith('v1.'));
    assert.equal(saved.encrypted_url.includes('127.0.0.1'), false);
    const coldEnv = { ...env, DATABASE_TYPE: 'd1', DATABASE_URL: undefined };
    const cold = await request(coldEnv, '/api/auth/session', undefined, cookie);
    assert.equal(cold.response.status, 200, JSON.stringify(cold.body));
    assert.equal(cold.body.authenticated, true);
    assert.equal(cold.body.user.username, 'owner');
  }
  console.log(`PASS real PostgreSQL setup ${withD1 ? 'with KV configuration, optional D1 and fresh scope' : 'without D1 binding'}`);
}
async function pageConfiguration() {
  await admin`CREATE DATABASE polaris_setup_page`;
  await admin`CREATE DATABASE polaris_setup_reselected`;
  const store = await mf.getKVNamespace('CONFIG');
  let writes = 0;
  const kv = { get: (...args) => store.get(...args), put: async (...args) => { writes++; return store.put(...args); } };
  const env = { ADMIN_TOKEN: 'fixture-setup-credential', PBKDF2_ITERATIONS: '3000', UPTIME: { writeDataPoint() {} }, CONFIG: kv };
  const credential = env.ADMIN_TOKEN;
  const target = name => ({ type: 'postgres', url: `postgresql://fixture:private-password@db.fixture.test/${name}?sslmode=require` });
  const session = await request(env, '/api/auth/session');
  assert.deepEqual(session.body.setupDatabase, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: false, postgresUrlEditable: true });
  const rejected = await request(env, '/api/auth/setup/database', { credential: 'wrong', database: target('polaris_setup_page') });
  assert.equal(rejected.response.status, 401);
  const invalid = await request(env, '/api/auth/setup/database', { credential, database: { type: 'postgres', url: 'postgresql://user:secret@127.0.0.1/test' } });
  assert.equal(invalid.body.error, 'invalid_database_url');
  const unavailable = await request(env, '/api/auth/setup/database', { credential, database: target('database_does_not_exist') });
  assert.equal(unavailable.body.error, 'database_connection_failed');
  for (const name of ['polaris_setup_page', 'polaris_setup_reselected']) {
    const configured = await request(env, '/api/auth/setup/database', { credential, database: target(name) });
    assert.equal(configured.response.status, 200, JSON.stringify(configured.body));
  }
  const sql = postgres(`postgres://postgres@127.0.0.1:${port}/polaris_setup_reselected`, { max: 1 });
  try { assert.equal((await sql`SELECT count(*)::int AS n FROM users`)[0].n, 0, 'database configuration must not create an account'); }
  finally { await sql.end(); }
  const pending = await request({ ...env }, '/api/auth/session');
  assert.equal(pending.body.needsSetup, true);
  assert.equal(pending.body.setupDatabase.postgresConfigured, true);
  assert.ok(!JSON.stringify(pending.body).includes('private-password'));
  const saved = await store.get('database', 'json');
  assert.ok(saved.id);
  assert.equal(saved.phase, undefined, 'KV stores configuration, not initialization leases');
  assert.ok(saved.encrypted_url.startsWith('v1.'));
  assert.ok(!JSON.stringify(saved).includes('private-password'));
  let reads = 0;
  const lagging = await request({ ...env, CONFIG: { ...kv, get: async (...args) => reads++ === 0 ? null : store.get(...args) } }, '/api/auth/session');
  assert.equal(reads, 1, 'each request uses one consistent configuration snapshot');
  assert.equal(lagging.body.setupDatabase.postgresConfigured, false);
  assert.notEqual(lagging.body.setupDatabase.configurationId, saved.id, 'a stale KV read cannot confirm the new configuration');
  assert.equal(pending.body.setupDatabase.configurationId, saved.id);
  const failure = postgres(`postgres://postgres@127.0.0.1:${port}/polaris_setup_reselected`, { max: 1 });
  await failure.unsafe(`CREATE SEQUENCE finish_attempt;
    CREATE FUNCTION interrupt_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.phase = 'active' AND OLD.phase = 'pending' AND nextval('finish_attempt') = 1 THEN
        RAISE EXCEPTION 'fixture interrupted finish';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER interrupt_finish BEFORE UPDATE ON _polaris_database FOR EACH ROW EXECUTE FUNCTION interrupt_finish();`);
  await failure.end();
  const writesBeforeAccount = writes;
  const interrupted = await request(env, '/api/auth/setup', { credential, username: 'page-owner', password: 'fixture-password', database: { type: 'postgres' } });
  assert.equal(interrupted.body.error, 'database_configuration_failed');
  const resumed = await request(env, '/api/auth/setup/database', { credential, database: { type: 'postgres' } });
  assert.equal(resumed.response.status, 200, 'the database step must allow resuming after an interrupted account write');
  const completed = await request(env, '/api/auth/setup', { credential, username: 'page-owner', password: 'fixture-password', database: { type: 'postgres' } });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  const cookie = completed.response.headers.get('set-cookie').split(';')[0];
  await mf.setOptions(workerOptions);
  const fresh = { ...env, CONFIG: await mf.getKVNamespace('CONFIG') };
  assert.equal(writes, writesBeforeAccount, 'account setup and retries must not rewrite the KV key');
  const after = await request(fresh, '/api/auth/session', undefined, cookie);
  assert.equal(after.body.authenticated, true);
  assert.equal(after.body.user.username, 'page-owner');
  const lateD1 = await request({ ...fresh, DB: await mf.getD1Database('DB') }, '/api/auth/session', undefined, cookie);
  assert.equal(lateD1.body.user.username, 'page-owner', 'a late D1 binding must not replace the saved PostgreSQL selection');
  const blocked = await request(fresh, '/api/auth/setup/database', { credential, database: target('polaris_setup_page') });
  assert.equal(blocked.body.error, 'setup_complete');
  console.log('PASS page-configured PostgreSQL, account last, encrypted KV persistence and late D1 binding');
}

try {
  await admin`CREATE DATABASE polaris_setup_d1`;
  await admin`CREATE DATABASE polaris_setup_direct`;
  await scenario('polaris_setup_d1', true);
  await scenario('polaris_setup_direct', false);
  await pageConfiguration();
} finally { await admin.end(); await mf.dispose(); }
