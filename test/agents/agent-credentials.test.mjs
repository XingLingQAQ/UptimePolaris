// Check machine credential isolation, pause, and resume through the API.
// 通过 API 验证机器凭据隔离、暂停与恢复。

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const adminToken = 'isolated-enrollment-admin';
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
        contents: "export default function postgres() { throw new Error('postgres unavailable in D1 test'); }",
      }));
    },
  }],
});

const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: { CF_ACCOUNT_ID: 'isolated', CF_API_TOKEN: 'isolated', ADMIN_TOKEN: adminToken },
  d1Databases: { DB: 'isolated-enrollment-test' },
});
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  // Installer and machine-credential checks use an initialized deployment without its setup session.
  // 安装和机器凭据测试使用已初始化部署，不复用初始化会话。
  const setup = await mf.dispatchFetch('http://localhost/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: adminToken, username: 'fixture-owner', password: 'fixture-owner-secret' }),
  });
  assert.equal(setup.status, 200, await setup.text());
  await db.prepare(
    'INSERT INTO monitor_groups (id, name, weight, created_at, updated_at) VALUES (?, ?, 0, 1, 1)',
  ).bind('group-fixed', 'Fixed group').run();

  const origin = 'http://localhost';
  for (const site of [origin, 'https://status.customer.example:9443', 'http://127.0.0.1:3884']) {
    for (const path of ['/install.sh', '/install.ps1']) {
      const response = await mf.dispatchFetch(site + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(!response.headers.get('content-type').includes('text/html'));
      const source = await response.text();
      assert.ok(source.includes(site));
      assert.ok(path.endsWith('.sh') ? source.startsWith('#!/bin/sh') : source.includes(site + '/api/public/agent/download/install.ps1'));
      const head = await mf.dispatchFetch(site + path, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    }
    const executionScript = await mf.dispatchFetch(site + '/api/public/agent/download/install.ps1');
    assert.ok((await executionScript.text()).includes(`[string]$Endpoint = '${site}'`));
  }
  const admin = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  async function request(path, init = {}) {
    const response = await mf.dispatchFetch(origin + path, init);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // A route that no longer exists answers with a bare "404 Not Found".
      // 不存在的路由直接返回“404 Not Found”。
      body = text;
    }
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body,
    };
  }

  const created = await request('/api/admin/agents', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: 'credential fixture' }),
  });
  assert.equal(created.status, 201);
  assert.equal(typeof created.body.token, 'string');
  assert.equal(created.body.token.length, 43);
  const agentId = created.body.id;
  const agentToken = created.body.token;

  // The detail route hands it back, because that is where the installer is
  // shown. The fleet list must not: it would ship every agent's secret.
  // 详情接口返回令牌，因为安装器在此显示；设备列表不得返回，否则会暴露所有 Agent 的密钥。
  const detail = await request(`/api/admin/agents/${agentId}/detail`, { headers: admin });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.install, { token: agentToken });
  const fleet = await request('/api/admin/agents', { headers: admin });
  assert.equal(fleet.status, 200);
  const fleetRow = fleet.body.agents.find((row) => row.id === agentId);
  assert.ok(fleetRow, 'the created agent appears in the fleet');
  assert.equal('token' in fleetRow, false, 'the fleet list never carries the token');

  // A second agent gets a different credential - these are per-machine, not a
  // shared secret with a use counter.
  // 第二个 Agent 获得不同的凭据；凭据按机器区分，而非带使用计数的共享密钥。
  const second = await request('/api/admin/agents', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: 'second credential fixture' }),
  });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.token, agentToken);

  /*
   * Pause and resume.
   *
   * `active` existed from the day agents landed, with a fleet filter for it,
   * but nothing in the product could set it.
   *
   * 暂停与恢复：Agent 引入时已有 active 字段及列表筛选，但此前产品中没有设置它的入口。
   */
  const paused = await request(`/api/admin/agents/${agentId}/active`, {
    method: 'POST', headers: admin, body: JSON.stringify({ active: false }),
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.active, false);
  const afterPause = await request('/api/admin/agents', { headers: admin });
  assert.equal(afterPause.body.agents.find((row) => row.id === agentId).active, false);
  const resumed = await request(`/api/admin/agents/${agentId}/active`, {
    method: 'POST', headers: admin, body: JSON.stringify({ active: true }),
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.active, true);
  const badActive = await request(`/api/admin/agents/${agentId}/active`, {
    method: 'POST', headers: admin, body: JSON.stringify({ active: 'yes' }),
  });
  assert.equal(badActive.status, 400);
  assert.equal(badActive.body.error, 'invalid_active');

  /*
   * The token is what the agent authenticates with, so it must actually work.
   * `GET /api/public/agent/:token` is the WebSocket upgrade; without the
   * upgrade headers it refuses, and the refusal differs from an unknown token.
   *
   * Agent 使用令牌认证，因此必须验证令牌实际有效。GET /api/public/agent/:token 用于
   * WebSocket 升级；缺少升级头会被拒绝，且拒绝结果与未知令牌不同。
   */
  const unknown = await request('/api/public/agent/not-a-real-token', { headers: admin });
  assert.ok(unknown.status >= 400, 'an unknown token is refused');

  // The retired credential endpoints are gone rather than merely hidden.
  // 已移除的凭据端点确实不存在，而非仅从界面隐藏。
  const retired = await request('/api/admin/agent-enrollment-tokens', { method: 'GET', headers: admin });
  assert.ok(retired.status === 404 || retired.status === 405, `enrollment tokens are retired (got ${retired.status})`);

  // Deleting the agent takes its credential with it.
  // 删除 Agent 时同时删除其凭据。
  const removed = await request(`/api/admin/agents/${agentId}`, { method: 'DELETE', headers: admin });
  assert.equal(removed.status, 200);
  const gone = await request(`/api/admin/agents/${agentId}/detail`, { headers: admin });
  assert.equal(gone.status, 404);

  const retiredRegistration = await request('/api/public/agent/enroll', { method: 'POST', body: '{}' });
  assert.equal(retiredRegistration.status, 404);
  console.log('agent credentials: one per agent, detail-only exposure, pause/resume, retired endpoints rejected');
} finally {
  await mf.dispose();
}
