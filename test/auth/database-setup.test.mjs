// Check D1 selection, concurrent setup, encrypted connections, and cold-start recovery.
// 验证 D1 选库、并发初始化、加密连接与冷启动恢复。

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import app from './backends/worker/src/index.ts';
import { claimDatabase, releaseDatabaseClaim, finishDatabaseClaim, setupDatabaseOptions } from './backends/worker/src/lib/db/setup-control.ts';
import { withIndependentDBScope } from './backends/worker/src/lib/db/factory.ts';
export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path === '/fixture/calls') return Response.json({calls: globalThis.__fixturePgCalls || 0});
  if (path === '/fixture/readonly') return Response.json(await setupDatabaseOptions({DATABASE_TYPE:'postgres', DATABASE_URL:'postgres://u:p@db.example.com/db'}));
  if (path === '/fixture/independent') return withIndependentDBScope(env, async scoped => Response.json({type:scoped.DATABASE_TYPE, hasUrl:!!scoped.DATABASE_URL}));
  if (path === '/fixture/cron') {
    const jobs = [];
    await app.scheduled({cron:'* * * * *'}, env, {waitUntil(promise) { jobs.push(promise); }});
    await Promise.all(jobs);
    return Response.json({calls: globalThis.__fixturePgCalls || 0});
  }
  if (path === '/fixture/pending') {
    const claim = await claimDatabase(env, 'postgres', 'postgres://fixture:fixture@db.example.com/polaris?sslmode=verify-full');
    if (!claim) return new Response(null, {status: 409});
    await releaseDatabaseClaim(env, claim.operation, claim.lease);
    return new Response(null, {status: 204});
  }
  if (path === '/fixture/activate') {
    const claim = await claimDatabase(env, 'postgres', 'postgres://fixture:fixture@db.example.com/polaris?sslmode=verify-full');
    if (!claim) return new Response(null, {status: 409});
    await finishDatabaseClaim(env, claim.operation, claim.lease);
    return new Response(null, {status: 204});
  }
  return app.fetch(request, env, ctx);
} }`;
const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
  format: 'esm', platform: 'neutral', target: 'es2022', write: false, external: ['cloudflare:sockets'],
  plugins: [{ name: 'failing-postgres', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'pg', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import {pgCall} from './entry'; export default function postgres(){ pgCall(); throw new Error('fixture connection failure'); }` }));
    builder.onResolve({ filter: /^\.\/entry$/, namespace: 'fixture' }, () => ({ path: 'entry', namespace: 'fixture-entry' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture-entry' }, () => ({ contents: `export function pgCall() { globalThis.__fixturePgCalls = (globalThis.__fixturePgCalls || 0) + 1; }` }));
  } }] });

function worker(persist, name = crypto.randomUUID()) {
  return new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], bindings: { ADMIN_TOKEN: 'fixture-secret', PBKDF2_ITERATIONS: '3000' },
    analyticsEngineDatasets: { UPTIME: { dataset: 'setup_fixture' } }, d1Databases: { DB: name }, ...(persist ? {d1Persist: persist} : {}) });
}
async function req(mf, path, body) {
  const response = await mf.dispatchFetch('https://fixture.test' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}
const password = 'fixture-password';
const credential = 'fixture-secret';
const pgUrl = 'postgres://fixture:fixture@db.example.com/polaris';
const setup = (database, key = credential, username = 'owner') => ({ credential: key, username, password, database });
const timeout = setTimeout(() => { console.error('fixture timeout'); process.exit(2); }, 90000);
try {
  const mf = worker();
  try {
    const db = await mf.getD1Database('DB');
    const first = await req(mf, '/api/auth/session');
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.setupDatabase, { types: ['d1', 'postgres'], defaultType: 'd1', postgresConfigured: false, postgresUrlEditable: true });
    assert.deepEqual((await req(mf, '/fixture/readonly')).body, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: true, postgresUrlEditable: false });
    assert.equal((await req(mf, '/api/auth/setup', setup({ type: 'postgres', url: pgUrl }, 'wrong'))).response.status, 401);
    assert.equal((await req(mf, '/api/auth/setup', setup({ type: 'postgres', url: 'postgres://u:p@127.0.0.1/db' }))).body.error, 'invalid_database_url');
    assert.equal((await req(mf, '/fixture/calls')).body.calls, 0);
    const unavailable = await req(mf, '/api/auth/setup', setup({ type: 'postgres', url: pgUrl }));
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error, 'database_connection_failed');
    assert.ok((await req(mf, '/fixture/calls')).body.calls > 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM _polaris_database').first()).n, 0);
    assert.equal((await req(mf, '/api/auth/session')).body.needsSetup, true);
    const results = await Promise.all(['one', 'two'].map(name => req(mf, '/api/auth/setup', setup({ type: 'd1' }, credential, name))));
    assert.deepEqual(results.map(x => x.response.status).sort(), [200, 409]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM _polaris_database').first()).n, 0);
    const cookie = results.find(x => x.response.status === 200).response.headers.get('set-cookie').split(';')[0];
    const session = await mf.dispatchFetch('https://fixture.test/api/auth/session', { headers: { cookie } });
    const current = await session.json();
    assert.equal(current.authenticated, true);
    assert.equal(current.setupDatabase, null);
    assert.equal((await req(mf, '/api/auth/setup', setup({ type: 'd1' }))).response.status, 409);
    console.log('PASS default D1 selection, session, repeat and concurrency, invalid URL, PG failure retry');
  } finally { await mf.dispose(); }

  const pending = worker();
  try {
    await req(pending, '/api/auth/session');
    assert.equal((await req(pending, '/fixture/pending')).response.status, 204);
    const session = await req(pending, '/api/auth/session');
    assert.deepEqual(session.body.setupDatabase, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: true, postgresUrlEditable: false });
    assert.equal(JSON.stringify(session.body).includes('fixture:fixture'), false);
    // Pending database selection must not reach PostgreSQL business tables.
    // 待恢复选库时不能触碰 PostgreSQL 业务表。
    for (const path of ['/', '/admin', '/monitor/example', '/unknown']) {
      const response = await pending.dispatchFetch('https://fixture.test' + path, { redirect: 'manual' });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), '/setup');
    }
    for (const path of ['/api/monitors', '/api/public/status', '/api/auth/login']) {
      const response = await pending.dispatchFetch('https://fixture.test' + path, { headers: { authorization: `Bearer ${credential}` } });
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).error, 'setup_in_progress');
    }
    assert.equal((await pending.dispatchFetch('https://fixture.test/api/public/icon')).status, 200);
    assert.equal((await req(pending, '/fixture/calls')).body.calls, 0);
    assert.equal((await req(pending, '/api/auth/setup', setup({ type: 'd1' }))).body.error, 'setup_in_progress');
    assert.equal((await req(pending, '/fixture/cron')).body.calls, 0);
    const db = await pending.getD1Database('DB');
    const row = await db.prepare('SELECT encrypted_url, phase FROM _polaris_database').first();
    assert.equal(row.phase, 'pending');
    assert.equal(row.encrypted_url.includes('fixture:fixture'), false);
    const retry = await req(pending, '/api/auth/setup', setup({ type: 'postgres' }));
    assert.equal(retry.body.error, 'database_connection_failed');
    assert.equal((await req(pending, '/api/auth/session')).body.needsSetup, true);
    console.log('PASS pending lock, encrypted URL, no URL in session');
  } finally { await pending.dispose(); }

  const persist = resolve('artifacts/tmp/database-setup-d1-cold');
  const name = crypto.randomUUID();
  const before = worker(persist, name);
  try {
    await req(before, '/api/auth/session');
    assert.equal((await req(before, '/fixture/activate')).response.status, 204);
  } finally { await before.dispose(); }
  const after = worker(persist, name);
  try {
    assert.deepEqual((await req(after, '/fixture/independent')).body, { type: 'postgres', hasUrl: true });
    assert.ok((await req(after, '/fixture/cron')).body.calls > 0);
    const db = await after.getD1Database('DB');
    const row = await db.prepare('SELECT encrypted_url, phase FROM _polaris_database').first();
    assert.equal(row.phase, 'active');
    assert.equal(row.encrypted_url.includes('fixture:fixture'), false);
    console.log('PASS cold isolate and independent scope resolve encrypted active pointer');
  } finally { await after.dispose(); }
} finally { clearTimeout(timeout); }
