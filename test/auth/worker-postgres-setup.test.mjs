// Check setup and sessions with a D1 control record and with PostgreSQL alone.
// 验证带 D1 控制记录及纯 PostgreSQL 的初始化与会话。

import assert from 'node:assert/strict';
import postgres from 'postgres';
import { Miniflare } from 'miniflare';
import app from '../../backends/worker/src/index.ts';

const port = Number(process.env.UPTIME_FIXTURE_PORT);
assert.ok(Number.isInteger(port) && port > 0);
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
  compatibilityDate: '2025-01-01', d1Databases: { DB: crypto.randomUUID() } });
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
  const env = { ...config(name), ...(withD1 ? { DB: db } : {}) };
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
    const row = await db.prepare('SELECT phase, type, encrypted_url FROM _polaris_database WHERE id = 1').first();
    assert.equal(row.phase, 'active'); assert.equal(row.type, 'postgres');
    assert.ok(row.encrypted_url.startsWith('v1.'));
    assert.equal(row.encrypted_url.includes('127.0.0.1'), false);
    const coldEnv = { ...env, DATABASE_TYPE: 'd1', DATABASE_URL: undefined };
    const cold = await request(coldEnv, '/api/auth/session', undefined, cookie);
    assert.equal(cold.response.status, 200, JSON.stringify(cold.body));
    assert.equal(cold.body.authenticated, true);
    assert.equal(cold.body.user.username, 'owner');
  }
  console.log(`PASS real PostgreSQL setup ${withD1 ? 'with D1 pointer and fresh scope' : 'without D1 binding'}`);
}
try {
  await admin`CREATE DATABASE polaris_setup_d1`;
  await admin`CREATE DATABASE polaris_setup_direct`;
  await scenario('polaris_setup_d1', true);
  await scenario('polaris_setup_direct', false);
} finally { await admin.end(); await mf.dispose(); }
