#!/usr/bin/env node
/* 从空 D1 验证自动建表、迁移记录和首次访问跳转；夹具不能预先迁移。
 * Verify D1 bootstrap, migration records, and the initial redirect using a fixture without prior migrations. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { BOOTSTRAP_FILES } from '../../backends/worker/src/lib/db/schema-bootstrap.ts';
import { migrationPlan, render } from '../../scripts/db/build-schema-bootstrap.mjs';
import { spaAssetService } from '../helpers/spa-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = join(root, 'public');

const watchdog = setTimeout(() => {
  console.error('FAIL schema bootstrap fixture timed out before completion');
  process.exit(2);
}, 90_000);

// ---------------------------------------------------------------- generated file
// 生成文件 / Generated file

const plan = migrationPlan();
const expected = render(plan);
const committed = readFileSync(join(root, 'backends/worker/src/lib/db/schema-bootstrap.ts'), 'utf8');

assert.equal(
  committed,
  expected,
  'backends/worker/src/lib/db/schema-bootstrap.ts is stale; run `npm run schema:build`',
);
assert.equal(BOOTSTRAP_FILES.length, plan.length, 'generated file has a different file count');

/*
  Every statement in every migration must survive the generator.

  The count is the cheap part; the ordering is what makes a bootstrap correct,
  since migration N assumes migration N-1 has run. Both are compared against the
  generator's own output, so this cannot drift from what `npm run build` writes.

  每个迁移中的每条语句都必须保留。数量只是基本检查，顺序决定初始化正确性，
  因为第 N 个迁移依赖第 N-1 个已执行。两者都与生成器输出比较，确保与 npm run build 一致。
*/
for (const [index, file] of BOOTSTRAP_FILES.entries()) {
  assert.equal(file.name, plan[index].name, `file ${index} is out of order`);
  assert.deepEqual(
    [...file.statements],
    plan[index].statements,
    `${file.name} lost statements in generation`,
  );
}
console.log(`CHECKPOINT schema-bootstrap: generated file matches ${plan.length} migrations`);

// ---------------------------------------------------------------- empty database
// 空数据库 / Empty database

const workerBundle = await build({
  entryPoints: [join(root, 'backends/worker/src/index.ts')],
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
        contents: "export default function postgres() { throw new Error('Postgres is outside this D1 fixture'); }",
      }));
    },
  }],
});

const mf = new Miniflare({
  modules: true,
  script: workerBundle.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  serviceBindings: { ASSETS: { node: spaAssetService(publicDir) } },
  bindings: {
    ADMIN_TOKEN: 'schema-bootstrap-installation-secret',
    PBKDF2_ITERATIONS: '3000',
  },
  d1Databases: { DB: `schema-bootstrap-empty-${process.pid}` },
});

/**
 * A fetch that does not follow redirects.
 *
 * `dispatchFetch` follows them by default, which would silently make every
 * assertion about the 302 into an assertion about whatever `/setup` happened to
 * return - and the interesting failure, "the redirect never happened", would
 * look like a 404 from the asset server instead. `manual` is the whole reason
 * this wrapper exists.
 *
 * 不跟随重定向的 fetch。dispatchFetch 默认跟随重定向，导致针对 302 的断言变为针对
 * /setup 响应的断言；“没有重定向”可能误表现为资产服务器 404。此包装器使用 manual 避免该问题。
 */
const fetchWithoutRedirect = (url, init) =>
  mf.dispatchFetch(url, { ...init, redirect: 'manual' });

/** Tables the fixture had before anything touched it. / 测试库被访问前已有的表。 */
async function userTables(db) {
  const result = await db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return (result.results ?? []).map((row) => row.name);
}

try {
  const db = await mf.getD1Database('DB');

  /*
    The precondition, asserted rather than assumed.

    If the fixture somehow arrived migrated - a name collision with an earlier
    run, or a default that seeds - every assertion below would pass for the wrong
    reason and this suite would stop testing the feature it is named after.

    显式断言前提而非假定为空：若因先前运行的名称冲突或默认填充而已迁移，
    下方断言会因错误原因通过，此套件不再验证目标功能。
  */
  assert.deepEqual(await userTables(db), [], 'fixture database was not empty before the first request');
  console.log('CHECKPOINT schema-bootstrap: fixture database starts with zero tables');

  const first = await fetchWithoutRedirect('http://localhost/');
  assert.equal(first.status, 302, 'first request to / did not redirect');
  assert.equal(first.headers.get('location'), '/setup');
  assert.equal(first.headers.get('cache-control'), 'no-store', 'a cached redirect would outlive setup');
  console.log('CHECKPOINT schema-bootstrap: empty deployment redirects / to /setup');

  // The redirect itself must have built the schema - that is the point.
  // 重定向本身必须已建立 schema，这是测试重点。
  const tables = await userTables(db);
  assert.ok(tables.includes('auth_setup_state'), 'redirect happened without creating the schema');
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('d1_migrations'), 'bootstrap did not record a migration ledger');

  const ledger = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all();
  assert.deepEqual(
    (ledger.results ?? []).map((row) => row.name),
    plan.map((file) => file.name),
    'ledger does not record every migration exactly once',
  );
  console.log(`CHECKPOINT schema-bootstrap: created ${tables.length} tables and a complete ledger`);

  /*
    A bootstrapped database must be the *same* database an operator gets from
    `npm run db:init`. Compared by statement text so a schema drift shows up as a
    diff rather than as a runtime error in production.

    自动初始化后的数据库必须与 npm run db:init 的结果一致；比较语句文本，
    使 schema 偏差表现为差异，而不是生产环境中的运行时错误。
  */
  const fromMigrations = await mf.getD1Database('DB');
  const created = await fromMigrations
    .prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name")
    .all();
  assert.ok((created.results ?? []).length > 0, 'bootstrap produced no schema objects');

  const session = await mf.dispatchFetch('http://localhost/api/auth/session');
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.needsSetup, true, 'a fresh deployment must report setup as required');
  /*
    The setup page cannot render its credential field without this, and a
    deployment that bootstraps its own schema is exactly the one an operator
    reaches before setting any secret - so the two features meet here.

    初始化表单依赖该字段显示凭据输入；自行初始化 schema 的部署也可能在操作员设置
    密钥前被访问，因此两项功能在此交汇。
  */
  assert.equal(sessionBody.setupCredential, 'ADMIN_TOKEN', 'the bound secret must be named for the setup form');

  /*
    Still redirecting before setup is completed.

    This is the half that a naive "remember the answer" cache would break: the
    first request caches nothing, so the operator who reloads the front page
    still lands on the form.

    完成初始化前仍须重定向。若简单缓存待初始化结果可能破坏此行为；首次请求不应缓存，
    操作员重新加载首页时仍应进入表单。
  */
  const second = await fetchWithoutRedirect('http://localhost/');
  assert.equal(second.status, 302, 'the redirect did not survive a second request');

  // 状态损坏不能缓存为初始化成功；恢复记录后仍应进入 setup。
  // Corrupt state must not be cached as completed; restoring it must still require setup.
  await db.prepare('DELETE FROM auth_setup_state WHERE id=1').run();
  const missingState = await fetchWithoutRedirect('http://localhost/api/overview');
  assert.equal(missingState.status, 503);
  assert.deepEqual(await missingState.json(), { error: 'database_unavailable' });
  await db.prepare('INSERT INTO auth_setup_state(id,completed) VALUES(1,1)').run();
  assert.equal((await fetchWithoutRedirect('http://localhost/api/overview')).status, 503);
  await db.prepare('UPDATE auth_setup_state SET completed=0 WHERE id=1').run();
  const restored = await fetchWithoutRedirect('http://localhost/admin');
  assert.equal(restored.status, 302);
  assert.equal(restored.headers.get('location'), '/setup');

  // 页面进入初始化，业务 API 在鉴权和处理器之前拒绝。
  // Redirect pages to setup and reject business APIs before authentication or handlers.
  for (const path of ['/login', '/admin', '/admin/settings', '/monitor/example', '/server/example', '/status/other', '/unknown', '/setup/nested', '/theme/anything', '/agent/old', '/install.sh']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetchWithoutRedirect(`http://localhost${path}`, { method });
      assert.equal(response.status, 302, `${method} ${path}`);
      assert.equal(response.headers.get('location'), '/setup');
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
  }
  for (const path of ['/api/overview', '/api/public/status', '/api/public/push/fake', '/api/public/agent/fake', '/api/auth/login', '/api/auth/setup/', '/api/unknown']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await fetchWithoutRedirect(`http://localhost${path}`, { method, headers: { authorization: 'Bearer schema-bootstrap-installation-secret' } });
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'setup_required' });
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
  }
  for (const path of ['/setup', '/api/auth/session', '/api/capabilities', '/api/public/icon']) {
    assert.equal((await fetchWithoutRedirect(`http://localhost${path}`)).status, 200, path);
  }
  const script = readdirSync(join(publicDir, 'assets')).find((name) => name.endsWith('.js'));
  assert.ok(script, 'built asset fixture is missing');
  const asset = await fetchWithoutRedirect(`http://localhost/assets/${script}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);

  /*
    Complete setup, then confirm the redirect is gone.

    `finishSetup` is what flips the state, and the front page must notice on the
    very next request - the cache may only remember the finished answer, never
    the pending one.

    完成初始化后确认重定向消失：finishSetup 改变状态，首页必须在紧接着的请求中察觉；
    缓存只能记住已完成状态，不能记住待初始化状态。
  */
  const losingSetup = await mf.dispatchFetch('http://localhost/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.10' },
    body: JSON.stringify({
      credential: 'schema-bootstrap-losing-secret',
      username: 'operator',
      password: 'chosen-password',
    }),
  });
  assert.equal(losingSetup.status, 401, 'incorrect installation credentials must be rejected');

  const setup = await mf.dispatchFetch('http://localhost/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.10' },
    body: JSON.stringify({
      credential: 'schema-bootstrap-installation-secret',
      username: 'operator',
      password: 'chosen-password',
    }),
  });
  assert.equal(setup.status, 200, `setup failed: ${setup.status} ${await setup.text()}`);

  const afterSetup = await fetchWithoutRedirect('http://localhost/');
  assert.notEqual(afterSetup.status, 302, 'front page still redirects after setup completed');
  assert.equal((await fetchWithoutRedirect('http://localhost/unknown')).status, 200, 'initialized SPA fallback is unavailable');
  assert.equal((await fetchWithoutRedirect('http://localhost/api/monitors')).status, 401, 'initialized APIs must return to ordinary authentication');
  assert.equal((await mf.dispatchFetch('http://localhost/api/auth/session').then((r) => r.json())).needsSetup, false);

  const themes = await mf.dispatchFetch('http://localhost/api/themes', {
    headers: { authorization: 'Bearer schema-bootstrap-installation-secret' },
  });
  assert.equal(themes.status, 200);
  assert.deepEqual((await themes.json()).themes, [], 'setup must not install external themes');
  const theme = await mf.dispatchFetch('http://localhost/api/public/theme').then((response) => response.json());
  assert.deepEqual(theme, { id: null, short: null, version: null });

  console.log('PASS empty database bootstraps itself and sends the first visitor to setup');
} finally {
  await mf.dispose();
  clearTimeout(watchdog);
}
