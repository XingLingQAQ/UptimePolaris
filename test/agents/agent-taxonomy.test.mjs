// 验证机器分组和标签的权限、分配与删除。
// Check permissions, assignment, and deletion for machine groups and tags.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: "import { api } from './backends/worker/src/api'; export default { fetch: api.fetch };" },
  bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  plugins: [{ name: 'transports', setup(builder) {
    builder.onResolve({ filter: /^(postgres|cloudflare:sockets)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'postgres'
      ? 'export default function postgres(){throw new Error("Unexpected Postgres connection")}'
      : 'export function connect(){throw new Error("Unexpected TCP probe")}' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', d1Databases: { DB: 'taxonomy' }, bindings: { ADMIN_TOKEN: 'fixture', DATABASE_TYPE: 'd1' } });
async function request(path, method = 'GET', body, auth = true) {
  const response = await mf.dispatchFetch(`http://localhost${path}`, { method, headers: { ...(auth ? { authorization: 'Bearer fixture' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function success(path, method = 'GET', body) {
  const result = await request(path, method, body);
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.body;
}
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  assert.equal((await request('/api/admin/agent-groups', 'GET', undefined, false)).status, 401);
  assert.equal((await request('/api/admin/agent-groups', 'POST', { name: 'Shared' })).status, 409);
  assert.deepEqual((await success('/api/admin/agent-groups')).groups, []);
  const state = await success('/api/admin/presentation');
  await success('/api/admin/presentation', 'PUT', { config: { ...state.config, agentEnabled: true }, revision: state.revision });
  const monitorGroup = await success('/api/groups', 'POST', { name: 'Shared', weight: 0 });
  const group = await success('/api/admin/agent-groups', 'POST', { name: 'Shared', weight: 1 });
  const tag = await success('/api/admin/agent-tags', 'POST', { name: 'Shared', color: '#123456' });
  const machine = await success('/api/admin/agents', 'POST', { name: 'Host', probe_enabled: true });
  await success(`/api/admin/agents/${machine.id}/taxonomy`, 'PUT', { group_id: group.id, tag_ids: [tag.id] });
  assert.equal((await success('/api/admin/agent-groups')).groups[0].count, 1);
  assert.equal((await success('/api/admin/agent-tags')).tags[0].count, 1);
  assert.equal((await request(`/api/admin/agents/${machine.id}/taxonomy`, 'PUT', { group_id: group.id, tag_ids: ['missing'] })).status, 400);
  assert.equal((await success('/api/admin/agents')).agents[0].tags[0].id, tag.id);
  await success(`/api/admin/agent-groups/${group.id}`, 'PUT', { name: 'Renamed', weight: 1 });
  assert.equal((await success('/api/groups')).groups[0].name, 'Shared');
  await success(`/api/admin/agent-groups/${group.id}`, 'DELETE');
  assert.equal((await success('/api/groups')).groups[0].id, monitorGroup.id);
  assert.equal((await success('/api/admin/agents')).agents[0].group_id, null);
  await success(`/api/admin/agent-tags/${tag.id}`, 'DELETE');
  assert.deepEqual((await success('/api/admin/agents')).agents[0].tags, []);
  const retained = await success('/api/admin/agent-groups', 'POST', { name: 'Retained', weight: 0 });
  const retainedTag = await success('/api/admin/agent-tags', 'POST', { name: 'Retained', color: '#123456' });
  await success(`/api/admin/agents/${machine.id}/taxonomy`, 'PUT', { group_id: retained.id, tag_ids: [retainedTag.id] });
  const managedMachine = await success('/api/admin/agents', 'POST', { name: 'Managed machine', is_public: false });
  const managedMonitor = await success('/api/monitors', 'POST', { name: 'Managed monitor', type: 'http', target: 'https://example.com' });
  const common = await success('/api/admin/groups', 'POST', { name: 'Unified', type: 'common', weight: 3 });
  let unified = (await success('/api/admin/groups')).groups.find(group => group.key === common.key);
  assert.equal(unified.type, 'common'); assert.ok(unified.agentId); assert.ok(unified.monitorId);
  await success(`/api/admin/groups/${encodeURIComponent(common.key)}/members`, 'PUT', { kind: 'monitor', action: 'add', ids: [managedMonitor.id] });
  await success(`/api/admin/groups/${encodeURIComponent(common.key)}/members`, 'PUT', { kind: 'agent', action: 'add', ids: [managedMachine.id] });
  unified = (await success('/api/admin/groups')).groups.find(group => group.key === common.key);
  assert.equal(unified.monitorCount, 1); assert.equal(unified.agentCount, 1);
  const convert = { name: 'Converted', type: 'monitor', weight: 4 };
  assert.equal((await request(`/api/admin/groups/${encodeURIComponent(common.key)}`, 'PUT', convert)).body.error, 'group_members_reset_required');
  assert.equal((await success('/api/admin/groups')).groups.find(group => group.key === common.key).name, 'Unified');
  assert.equal((await request(`/api/admin/groups/${encodeURIComponent(common.key)}/members`, 'PUT', { kind: 'agent', action: 'add', ids: [machine.id, 'missing'] })).status, 404);
  assert.equal((await success('/api/admin/agents')).agents.find(agent => agent.id === machine.id).group_id, retained.id);
  assert.equal((await request(`/api/admin/groups/${encodeURIComponent(common.key)}/members`, 'PUT', { kind: 'agent', action: 'add', ids: [machine.id] })).body.error, 'group_members_assigned');
  assert.equal((await success('/api/admin/agents')).agents.find(agent => agent.id === machine.id).group_id, retained.id);
  const ungroupedOne = await success('/api/admin/agents', 'POST', { name: 'Ungrouped one' });
  const ungroupedTwo = await success('/api/admin/agents', 'POST', { name: 'Ungrouped two' });
  assert.equal((await request(`/api/admin/groups/${encodeURIComponent(common.key)}/members`, 'PUT', { kind: 'agent', action: 'add', ids: [ungroupedOne.id, machine.id] })).status, 409);
  assert.equal((await success('/api/admin/agents')).agents.find(agent => agent.id === ungroupedOne.id).group_id, null);
  await success(`/api/admin/groups/${encodeURIComponent(common.key)}/members`, 'PUT', { kind: 'agent', action: 'add', ids: [ungroupedOne.id, ungroupedTwo.id] });
  const assigned = (await success('/api/admin/agents')).agents;
  for (const id of [ungroupedOne.id, ungroupedTwo.id]) assert.equal(assigned.find(agent => agent.id === id).group_id, unified.agentId);
  await success(`/api/admin/groups/${encodeURIComponent(common.key)}`, 'PUT', { ...convert, confirm_membership_reset: true });
  assert.equal((await success('/api/admin/agents')).agents.find(agent => agent.id === managedMachine.id).group_id, null);
  assert.equal((await db.prepare('SELECT group_id FROM monitors WHERE id=?').bind(managedMonitor.id).first()).group_id, unified.monitorId);
  await success(`/api/admin/groups/${encodeURIComponent(common.key)}`, 'PUT', { ...convert, name: 'Common again', type: 'common' });
  unified = (await success('/api/admin/groups')).groups.find(group => group.key === common.key);
  await success(`/api/admin/groups/${encodeURIComponent(common.key)}?scope=agent`, 'DELETE');
  assert.equal((await success('/api/admin/groups')).groups.find(group => group.key === common.key).type, 'monitor');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM agent_groups WHERE id=?').bind(unified.agentId).first()).n, 0);
  await success('/api/admin/agents/visibility', 'POST', { ids: [managedMachine.id], is_public: true });
  const current = await success('/api/admin/presentation');
  await success('/api/admin/presentation', 'PUT', { config: { ...current.config, agentEnabled: false }, revision: current.revision });
  assert.equal((await request('/api/admin/agents/visibility', 'POST', { ids: [managedMachine.id], is_public: false })).status, 409);
  assert.equal((await request('/api/admin/agents', 'POST', { name: 'Disabled public', is_public: true })).status, 409);
  assert.equal((await success('/api/admin/agents')).agents.find(agent => agent.id === managedMachine.id).is_public, 1);
  assert.equal((await request('/api/admin/groups', 'POST', { name: 'Disabled common', type: 'common', weight: 0 })).status, 409);
  assert.ok((await success('/api/admin/groups')).groups.every(group => group.type === 'monitor'));
  assert.equal((await request('/api/admin/agent-tags', 'POST', { name: 'Disabled', color: '#123456' })).status, 409);
  assert.equal((await request(`/api/admin/agents/${machine.id}/taxonomy`, 'PUT', { group_id: null, tag_ids: [] })).status, 409);
  assert.equal((await success('/api/admin/agent-groups')).groups[0].id, retained.id);
  assert.equal((await success('/api/admin/agents')).agents[0].tags[0].id, retainedTag.id);
  console.log('PASS Agent taxonomy access, isolation, assignment and deletion');
} finally { await mf.dispose(); }
