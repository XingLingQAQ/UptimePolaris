// 验证 Worker 未绑定数据库时的初始化部署检查：只开放检查所需入口，其他请求转到 /setup 或返回 503。
// Check the Worker's pre-setup deployment check without a database: only the check's entry points respond, everything else goes to /setup or gets 503.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const watchdog = setTimeout(() => { console.error('Deployment check fixture timed out'); process.exit(2); }, 60_000);
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
function worker(bindings) {
  return new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { PBKDF2_ITERATIONS: '3000', ...bindings },
  });
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
  assert.equal(session.body.setupDatabase, null);
  assert.deepEqual(session.body.setupRequirements, [
    { key: 'database', required: true, ok: false },
    { key: 'adminToken', required: true, ok: false },
    { key: 'themes', required: false, ok: false },
    { key: 'analytics', required: false, ok: false },
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
  assert.deepEqual(session.body.setupRequirements.filter(item => item.required).map(item => [item.key, item.ok]), [['database', false], ['adminToken', true]]);
  // 管理令牌也不能在部署检查通过前打开业务接口。 / The admin token cannot open business APIs before the check passes.
  const bearer = await request(tokenOnly, '/api/monitors', { headers: { authorization: 'Bearer setup-secret' } });
  assert.equal(bearer.response.status, 503);
  assert.equal(bearer.body.error, 'deployment_incomplete');
} finally { await tokenOnly.dispose(); clearTimeout(watchdog); }

console.log('Worker deployment check before setup passed');
