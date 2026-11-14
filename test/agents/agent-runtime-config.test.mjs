// 验证运行配置的权限、版本冲突、投递与确认。
// Check runtime configuration permissions, revision conflicts, delivery, and acknowledgement.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const bundle = await build({ entryPoints: ['backends/worker/src/index.ts'], bundle: true, write: false, format: 'esm', target: 'es2022', plugins: workerBundlePlugins(), logLevel: 'error' });
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], analyticsEngineDatasets: { UPTIME: { dataset: 'setup_fixture' } }, d1Databases: ['DB'], kvNamespaces: { CONFIG: 'agent-runtime-config-fixture' }, bindings: { ADMIN_TOKEN: 'config-fixture-admin' } });
const request = (path, method = 'GET', body, auth = true) => mf.dispatchFetch('http://config.test' + path, { method, headers: { ...(auth ? { authorization: 'Bearer config-fixture-admin' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const checked = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const initial = { sample_interval_secs: 5, report_interval_secs: 60, include_nics: [], exclude_nics: ['lo'], include_mounts: [], exclude_mounts: ['/proc'], auto_update: false };
const installation = { service_tier: 'manual', config_path: '/fixture/config.json', executable_path: '/fixture/polaris-agent', auto_update_supported: false };

try {
  await checked(await request('/api/auth/setup', 'POST', { credential: 'config-fixture-admin', username: 'config-fixture', password: 'config-fixture-password' }));
  const agent = await checked(await request('/api/admin/agents', 'POST', { name: 'Runtime fixture' }), 201);
  const configPath = `/api/admin/agents/${agent.id}/config`;
  const exchangePath = `/api/public/agent/config/${agent.token}`;
  const exchange = (config = initial, revision = null, error = null) => request(exchangePath, 'POST', { config, revision, installation, error }, false);
  const settings = (enabled) => request('/api/admin/settings', 'PUT', { 'security.allowAgentCommands': enabled });
  const save = (config, expected_revision) => request(configPath, 'PUT', { config, expected_revision });
  await checked(await request(configPath, 'GET', undefined, false), 401);
  const missing = await checked(await request(configPath));
  assert.equal(missing.status, 'unreported');
  assert.equal(missing.current, null);
  await checked(await settings(true));
  await checked(await save(initial, null), 409);
  await checked(await request('/api/public/agent/config/not-a-token', 'POST', { config: initial, revision: null, installation }, false), 401);
  assert.equal((await checked(await exchange())).runtime_config, null);
  assert.deepEqual((await checked(await request(configPath))).current, initial);
  await checked(await settings(false));
  await checked(await save(initial, null), 403);
  await checked(await settings(true));
  for (const config of [{ ...initial, token: 'replacement-secret' }, { ...initial, sample_interval_secs: 0 }, { ...initial, report_interval_secs: 1801 }, { ...initial, sample_interval_secs: 61 }, { ...initial, include_nics: ['bad\nname'] }, { ...initial, include_nics: Array(33).fill('eth0') }, { ...initial, auto_update: true }]) await checked(await save(config, null), 400);
  const desired = { ...initial, sample_interval_secs: 10, report_interval_secs: 120, include_mounts: ['/'] };
  const saved = await checked(await save(desired, null));
  assert.match(saved.revision, /^[0-9a-f]{32}$/);
  await checked(await save(initial, null), 409);
  const delivery = await checked(await exchange());
  assert.deepEqual(delivery.runtime_config, { revision: saved.revision, config: desired });
  assert.equal((await checked(await request(configPath))).status, 'pending');
  await checked(await exchange(initial, saved.revision));
  assert.equal((await checked(await request(configPath))).applied_revision, null);
  await checked(await exchange(initial, null, 'cannot persist configuration'));
  assert.equal((await checked(await request(configPath))).status, 'error');
  assert.equal((await checked(await exchange(desired, saved.revision))).runtime_config, null);
  const applied = await checked(await request(configPath));
  assert.equal(applied.status, 'synced');
  assert.equal(applied.applied_revision, saved.revision);
  assert.deepEqual(applied.current, desired);
  await checked(await request(`/api/admin/agents/${agent.id}/active`, 'POST', { active: false }));
  const second = await checked(await save(initial, saved.revision));
  assert.equal((await checked(await exchange(desired, saved.revision))).runtime_config.revision, second.revision);
  await checked(await settings(false));
  assert.equal((await checked(await exchange(desired, saved.revision))).runtime_config, null);
  await checked(await settings(true));
  await checked(await exchange(initial, second.revision));
  assert.equal((await checked(await request(configPath))).status, 'synced');
  installation.service_tier = 'A';
  installation.auto_update_supported = true;
  await checked(await exchange(initial, second.revision));
  assert.equal((await checked(await request(configPath))).allowed, true);
  const automatic = { ...initial, auto_update: true };
  const enabled = await checked(await save(automatic, second.revision));
  assert.equal((await checked(await exchange())).runtime_config.config.auto_update, true);
  await checked(await exchange(automatic, enabled.revision));
  assert.equal((await checked(await request(configPath))).current.auto_update, true);
  const disabled = await checked(await save(initial, enabled.revision));
  await checked(await exchange(initial, disabled.revision));
  assert.equal((await checked(await request(configPath))).current.auto_update, false);
  const filters = { ...initial, include_nics: ['Eth0', 'eth0'], exclude_nics: ['lo', 'docker0'], include_mounts: ['/', '/data'], exclude_mounts: ['/proc', '/sys'] };
  const filtered = await checked(await save(filters, disabled.revision));
  const equivalent = { ...filters };
  for (const key of ['include_nics', 'exclude_nics', 'include_mounts', 'exclude_mounts']) equivalent[key] = [...filters[key]].reverse().concat(filters[key][0]);
  assert.equal((await checked(await exchange(equivalent, filtered.revision))).runtime_config, null);
  assert.equal((await checked(await request(configPath))).status, 'synced');
  for (const key of ['include_nics', 'exclude_nics', 'include_mounts', 'exclude_mounts']) {
    const changed = { ...equivalent, [key]: [...equivalent[key], 'different-member'] };
    assert.equal((await checked(await exchange(changed, filtered.revision))).runtime_config.revision, filtered.revision);
    assert.equal((await checked(await request(configPath))).applied_revision, null);
  }
  assert.equal((await checked(await exchange({ ...equivalent, include_nics: ['ETH0', 'eth0'] }, filtered.revision))).runtime_config.revision, filtered.revision);
  assert.equal((await checked(await exchange({ ...equivalent, report_interval_secs: 61 }, filtered.revision))).runtime_config.revision, filtered.revision);
  assert.equal((await checked(await exchange(equivalent, filtered.revision, 'cannot apply'))).runtime_config.revision, filtered.revision);
  assert.equal((await checked(await exchange(equivalent, filtered.revision))).runtime_config, null);
  const db = await mf.getD1Database('DB');
  await checked(await request(`/api/admin/agents/${agent.id}`, 'DELETE'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM agent_runtime_configs WHERE agent_id=?').bind(agent.id).first()).n, 0);
  await checked(await exchange(), 401);
  console.log('PASS Agent runtime configuration: authenticated reports, actual current values, permission/capability gates, validation, revision conflicts, delivery/ACK/error, paused agents, deletion cascade');
} finally { await mf.dispose(); }
