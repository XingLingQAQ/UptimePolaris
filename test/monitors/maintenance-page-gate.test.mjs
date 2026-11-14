import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const source = `
import { handlePageRequest } from './backends/worker/src/lib/theme/page-handler';
import { publicMaintenance } from './backends/worker/src/lib/public/maintenance';
import { alertsSuppressed } from './backends/worker/src/lib/settings/maintenance';
export default { async fetch(request, env) {
  const scoped = { ...env, ADMIN_TOKEN: 'preview-token', ASSETS: { fetch: () => new Response('builtin') } };
  if (new URL(request.url).pathname === '/state') return Response.json(await publicMaintenance(scoped));
  if (new URL(request.url).pathname === '/suppressed') return Response.json(await alertsSuppressed(scoped, new Date()));
  return await handlePageRequest(request, scoped) ?? new Response('unhandled', { status: 418 });
} };`;
const bundle = await build({
  stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'maintenance-gate.ts' },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
  external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'pg', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'pg', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function() {}' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'maintenance-gate' }, kvNamespaces: { CONFIG: 'maintenance-gate-config' } });
const db = await mf.getD1Database('DB');
const kv = await mf.getKVNamespace('CONFIG');
await db.exec('CREATE TABLE presentation_state(id TEXT PRIMARY KEY,config_json TEXT,revision TEXT,updated_at INTEGER);');
let settings = {};
const putSettings = async (patch) => {
  for (const [key, value] of Object.entries(patch)) value === undefined ? delete settings[key] : settings[key] = value;
  await kv.put('settings', JSON.stringify(settings));
};
const start = new Date(Date.now() - 5 * 60_000);
const end = new Date(Date.now() + 5 * 60_000);
const time = (date) => date.toISOString().slice(11, 16);
const window = { kind: 'weekly', day: start.getUTCDay(), start: time(start), end: time(end) };
await putSettings({
  'maintenance.scheduleEnabled': true,
  'alerts.maintenanceWindows': [window],
  'maintenance.title': 'Upgrade <test>',
  'maintenance.description': 'Back soon',
});
const req = (path, init) => mf.dispatchFetch('http://localhost' + path, { redirect: 'manual', ...init });
try {
  let response = await req('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Upgrade &lt;test&gt;/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  for (const path of ['/monitor/1', '/server/1', '/status/main']) {
    response = await req(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), '/');
  }
  assert.equal(await (await req('/login')).text(), 'builtin');
  assert.equal((await req('/api/public/status')).status, 418);
  assert.match(await (await req('/?preview=monitor')).text(), /Upgrade &lt;test&gt;/);
  assert.equal(await (await req('/?preview=monitor', { headers: { authorization: 'Bearer preview-token' } })).text(), 'builtin');
  assert.equal((await (await req('/state')).json()).active, true);
  await putSettings({ 'alerts.maintenanceWindows': undefined });
  assert.equal((await (await req('/state')).json()).active, false);
  assert.equal(await (await req('/')).text(), 'builtin');
  await putSettings({ 'maintenance.enabled': true });
  let state = await (await req('/state')).json();
  assert.equal(state.source, 'manual');
  assert.equal(state.active, true);
  assert.equal(state.endsAt, null);
  assert.equal(state.description, 'Back soon');
  assert.equal((await (await req('/suppressed')).json()).suppressed, true);
  assert.match(await (await req('/')).text(), /Upgrade &lt;test&gt;/);
  assert.equal((await req('/server/1')).headers.get('location'), '/');
  assert.equal(await (await req('/admin/settings')).text(), 'builtin');
  assert.equal(await (await req('/setup')).text(), 'builtin');
  await putSettings({ 'maintenance.enabled': false });
  state = await (await req('/state')).json();
  assert.equal(state.active, false);
  assert.equal(state.source, null);
  assert.equal((await (await req('/suppressed')).json()).suppressed, false);
  assert.equal(await (await req('/')).text(), 'builtin');
  assert.match(await (await req('/polaris-maintenance.js')).text(), /api\/public\/maintenance/);
  await putSettings({ 'alerts.maintenanceWindows': [window] });
  await putSettings({ 'maintenance.scheduleEnabled': false });
  assert.equal((await (await req('/state')).json()).active, false);
  assert.equal((await (await req('/suppressed')).json()).suppressed, false);
  assert.ok(JSON.parse(await kv.get('settings'))['alerts.maintenanceWindows']);
  assert.match(await (await req('/')).text(), /builtin/);
  console.log('maintenance page gates, schedule toggle and fresh state passed');
} finally {
  await mf.dispose();
}
