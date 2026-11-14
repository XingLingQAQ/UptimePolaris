// 验证 Worker 未绑定数据库时的初始化部署检查：只开放检查所需入口，其他请求转到 /setup 或返回 503。
// Check the Worker's pre-setup deployment check without a database: only the check's entry points respond, everything else goes to /setup or gets 503.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const watchdog = setTimeout(() => { console.error('Deployment check fixture timed out'); process.exit(2); }, 120_000);
const bundled = await build({
  entryPoints: ['backends/worker/src/index.ts'],
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
      builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'pg-stub', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: "export default function postgres() { throw new Error('postgres unavailable in deployment check test'); }",
      }));
    },
  }],
});

// 与 Fork 部署首次运行一致：没有 DB、THEMES、UPTIME 绑定。 / Matches a fresh fork deployment: no DB, THEMES or UPTIME binding.
function options(bindings, resources = {}) {
  return {
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { PBKDF2_ITERATIONS: '3000', ...bindings },
    ...resources,
  };
}

function worker(bindings, resources) {
  return new Miniflare(options(bindings, resources));
}

async function request(mf, path, init = {}) {
  const response = await mf.dispatchFetch('http://localhost' + path, { redirect: 'manual', ...init });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

const bare = worker({});
try {
  const session = await request(bare, '/api/auth/session');
  assert.equal(session.response.status, 200);
  assert.equal(session.body.needsSetup, true);
  assert.equal(session.body.authenticated, false);
  assert.equal(session.body.setupCredential, null);
  assert.deepEqual(session.body.setupDatabase, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: false, postgresUrlEditable: false });
  assert.deepEqual(session.body.setupRequirements, [
    { key: 'database', required: false, ok: false },
    { key: 'config', required: true, ok: false },
    { key: 'adminToken', required: true, ok: false },
    { key: 'themes', required: false, ok: false },
    { key: 'analytics', required: true, ok: false },
  ]);

  const capabilities = await request(bare, '/api/capabilities');
  assert.equal(capabilities.response.status, 200);
  assert.equal(capabilities.body.runtime, 'worker');
  assert.equal((await request(bare, '/api/public/icon')).response.status, 200);

  for (const path of ['/', '/admin', '/status', '/install.sh']) {
    const page = await request(bare, path);
    assert.equal(page.response.status, 302, path);
    assert.equal(page.response.headers.get('location'), '/setup', path);
  }

  for (const path of ['/api/monitors', '/api/public/status', '/api/overview']) {
    const blocked = await request(bare, path);
    assert.equal(blocked.response.status, 503, path);
    assert.equal(blocked.body.error, 'deployment_incomplete', path);
  }

  const setup = await request(bare, '/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'anything', username: 'owner', password: 'private-password' }),
  });
  assert.equal(setup.response.status, 503);
  assert.equal(setup.body.error, 'deployment_incomplete');

  // 定时任务在缺少数据库时直接跳过，不报错。 / Scheduled work is skipped without a database instead of failing.
  const scheduled = await (await bare.getWorker()).scheduled({ cron: '* * * * *' });
  assert.equal(scheduled.outcome, 'ok');
} finally { await bare.dispose(); }

const tokenOnly = worker({ ADMIN_TOKEN: 'setup-secret' });
try {
  const session = await request(tokenOnly, '/api/auth/session');
  assert.equal(session.body.setupCredential, 'ADMIN_TOKEN');
  assert.deepEqual(session.body.setupRequirements.filter(item => item.required).map(item => [item.key, item.ok]), [['config', false], ['adminToken', true], ['analytics', false]]);
  // 管理令牌也不能在部署检查通过前打开业务接口。 / The admin token cannot open business APIs before the check passes.
  const bearer = await request(tokenOnly, '/api/monitors', { headers: { authorization: 'Bearer setup-secret' } });
  assert.equal(bearer.response.status, 503);
  assert.equal(bearer.body.error, 'deployment_incomplete');
} finally { await tokenOnly.dispose(); }

const databaseLater = worker({ ADMIN_TOKEN: 'setup-secret' }, { analyticsEngineDatasets: { UPTIME: { dataset: 'setup_fixture' } } });
try {
  const session = await request(databaseLater, '/api/auth/session');
  assert.equal(session.response.status, 200);
  assert.deepEqual(
    session.body.setupRequirements.filter(item => item.required && !item.ok).map(item => item.key),
    ['config'],
    'the missing KV binding is the only required blocker; the database is selected later',
  );
  assert.deepEqual(session.body.setupRequirements.find(item => item.key === 'database'), { key: 'database', required: false, ok: false });
  assert.deepEqual(session.body.setupDatabase, { types: ['postgres'], defaultType: 'postgres', postgresConfigured: false, postgresUrlEditable: false });
  const blocked = await request(databaseLater, '/api/monitors');
  assert.equal(blocked.response.status, 503);
  assert.equal(blocked.body.error, 'deployment_incomplete');

  const submit = (database) => request(databaseLater, '/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'setup-secret', username: 'owner', password: 'private-password', database }),
  });
  const missingUrl = await submit({ type: 'postgres' });
  assert.equal(missingUrl.response.status, 400);
  assert.equal(missingUrl.body.error, 'invalid_database_url');
  const noD1 = await submit({ type: 'd1' });
  assert.equal(noD1.response.status, 400);
  assert.equal(noD1.body.error, 'invalid_database_type');
  const unsavedUrl = await submit({ type: 'postgres', url: 'postgres://fixture:fixture@db.example.com/polaris' });
  assert.equal(unsavedUrl.response.status, 400);
  assert.equal(unsavedUrl.body.error, 'invalid_database_url');
} finally { await databaseLater.dispose(); }

const rebound = worker({ ADMIN_TOKEN: 'setup-secret' });
try {
  const initial = await request(rebound, '/api/auth/session');
  assert.deepEqual(initial.body.setupDatabase.types, ['postgres']);
  assert.equal(initial.body.setupDatabase.defaultType, 'postgres');
  const bindings = { ADMIN_TOKEN: 'setup-secret' };
  const resources = { d1Databases: { DB: crypto.randomUUID() } };
  await rebound.setOptions(options(bindings, resources));
  const withDatabase = await request(rebound, '/api/auth/session');
  assert.equal(withDatabase.body.setupDatabase.defaultType, 'd1');
  assert.equal(withDatabase.body.setupRequirements.find((item) => item.key === 'database').ok, true);
  assert.deepEqual(withDatabase.body.setupRequirements.find((item) => item.key === 'analytics'), { key: 'analytics', required: true, ok: false });

  const account = { credential: 'setup-secret', username: 'owner', password: 'private-password', database: { type: 'd1' } };
  const submit = () => request(rebound, '/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
  });
  const missingAnalytics = await submit();
  assert.equal(missingAnalytics.response.status, 503);
  assert.equal(missingAnalytics.body.error, 'deployment_incomplete');
  assert.equal((await (await rebound.getD1Database('DB')).prepare('SELECT COUNT(*) AS n FROM users').first()).n, 0);

  resources.analyticsEngineDatasets = { UPTIME: { dataset: 'uptime_fixture' } };
  resources.r2Buckets = { THEMES: 'themes-fixture' };
  resources.kvNamespaces = { CONFIG: 'config-fixture' };
  await rebound.setOptions(options(bindings, resources));
  const ready = await request(rebound, '/api/auth/session');
  assert.ok(ready.body.setupRequirements.every((item) => item.ok));
  assert.deepEqual(ready.body.setupDatabase.types, ['d1', 'postgres']);

  delete resources.analyticsEngineDatasets;
  await rebound.setOptions(options(bindings, resources));
  const removed = await submit();
  assert.equal(removed.response.status, 503);
  assert.equal(removed.body.error, 'deployment_incomplete');

  resources.analyticsEngineDatasets = { UPTIME: { dataset: 'uptime_fixture' } };
  delete resources.r2Buckets;
  await rebound.setOptions(options(bindings, resources));
  const optionalMissing = await request(rebound, '/api/auth/session');
  assert.deepEqual(optionalMissing.body.setupRequirements.find((item) => item.key === 'themes'), { key: 'themes', required: false, ok: false });
  const completed = await submit();
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal((await request(rebound, '/api/auth/session')).body.setupRequirements, null);
} finally { await rebound.dispose(); }

// 只配置 PostgreSQL 也满足数据库要求，DATABASE_TYPE 可以省略；选库行为由 PostgreSQL 初始化夹具验证。
// A PostgreSQL URL alone satisfies the database requirement, DATABASE_TYPE is optional,; database choices are covered by the PostgreSQL setup fixture.
const pgOnly = await build({
  stdin: {
    contents: [
      "import { databaseConfigured, setupRequirements } from './backends/worker/src/lib/auth/setup-requirements.ts';",
            'export default { async fetch(request, env) {',
      "  if (new URL(request.url).pathname === '/fixture/pg-only') {",
      '    const session = { DATABASE_URL: env.DATABASE_URL };',
      '    return Response.json({ configured: databaseConfigured(session), requirements: setupRequirements(session) });',
      '  }',
      '  return new Response(null, { status: 404 });',
      '} };',
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  external: ['cloudflare:sockets'],
  plugins: [{ name: 'unused-postgres', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export default function postgres() { throw new Error('unexpected connection'); }" }));
  } }],
});
const pgOnlyWorker = new Miniflare({
  modules: true,
  script: pgOnly.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: { DATABASE_URL: 'postgres://fixture:fixture@db.example.com/polaris?sslmode=verify-full' },
});
try {
  const response = await pgOnlyWorker.dispatchFetch('http://localhost/fixture/pg-only');
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.requirements.find((item) => item.key === 'database'), { key: 'database', required: false, ok: false });
} finally { await pgOnlyWorker.dispose(); }

clearTimeout(watchdog);
console.log('Worker deployment check before setup passed');
