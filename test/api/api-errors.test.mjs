// 验证请求客户端和 API 的错误、取消及认证边界。
// Check request-client and API error, cancellation, and authentication boundaries.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { makeStoredZip } from '../helpers/zip.mjs';

const client = await build({
  stdin: { contents: `export { requestJson } from './frontend/src/api/client'; export * from './frontend/src/api/errors'; export { fetchPublicConfig, publicConfigKey } from './frontend/src/config/api'; export { internalErrorResponse } from './backends/worker/src/lib/http/errors'; export { siteIconApi } from './frontend/src/admin/settings/api';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'frontend/tsconfig.json', logLevel: 'error',
});
const clientFile = resolve('artifacts/tmp/api-client-regression.mjs');
mkdirSync(dirname(clientFile), { recursive: true });
writeFileSync(clientFile, client.outputFiles[0].text);
const { requestJson, ApiError, UnauthorizedError, SESSION_EXPIRED_EVENT, isRetryableApiError, apiErrorMessageKey, fetchPublicConfig, publicConfigKey, internalErrorResponse, siteIconApi } = await import(pathToFileURL(clientFile).href);
const previousFetch = globalThis.fetch;
globalThis.window = new EventTarget();
window.location = new URL('https://console.example');
let expired = 0;
window.addEventListener(SESSION_EXPIRED_EVENT, () => expired++);
let calls = 0;
function response(body, status = 200, headers) { globalThis.fetch = async () => { calls++; return new Response(body, { status, headers }); }; }
async function rejected(code, status) {
  await assert.rejects(requestJson('/api/fixture'), error => error instanceof ApiError && error.code === code && error.status === status);
}
try {
  const diagnostic = [];
  const originalLog = console.error;
  try {
    console.error = message => diagnostic.push(JSON.parse(message));
    internalErrorResponse(new Error('private-first-line\nprivate-second-line'), 'GET', '/api/:token');
  } finally { console.error = originalLog; }
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-first-line|private-second-line/);
  assert.ok(diagnostic[0].stack.includes('at '));
  globalThis.fetch = async (_path, init) => {
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers.get('x-fixture'), 'kept');
    assert.equal(init.headers.get('content-type'), 'application/json');
    return Response.json({ ok: true });
  };
  assert.deepEqual(await requestJson('/api/fixture', { method: 'POST', headers: new Headers({ 'x-fixture': 'kept' }), body: '{}' }), { ok: true });
  const bytes = new Blob(['fixture']);
  globalThis.fetch = async (_path, init) => {
    assert.equal(init.body, bytes);
    assert.equal(init.headers.get('content-type'), 'application/zip');
    return Response.json({ ok: true });
  };
  await requestJson('/api/upload', { method: 'POST', body: bytes, headers: { 'content-type': 'application/zip' } });
  const iconFile = new File(['fixture'], '站点%.png', { type: 'image/png' });
  globalThis.fetch = async (_path, init) => {
    assert.equal(init.headers.get('x-icon-filename'), encodeURIComponent(iconFile.name));
    return Response.json({ ok: true });
  };
  await siteIconApi.upload(iconFile);

  const redirects = [];
  window.location.replace = path => redirects.push(path);
  for (const code of ['setup_required', 'setup_in_progress', 'deployment_incomplete']) {
    response(JSON.stringify({ error: code }), 503);
    await rejected(code, 503);
  }
  assert.deepEqual(redirects, ['/setup', '/setup', '/setup']);
  window.location.pathname = '/setup';
  response('{"error":"setup_in_progress"}', 503);
  await rejected('setup_in_progress', 503);
  assert.equal(redirects.length, 3);
  window.location.pathname = '/';

  response('{"error":"invalid_credentials"}', 401);
  await assert.rejects(requestJson('/api/auth/login'), error => error instanceof ApiError && !(error instanceof UnauthorizedError) && error.code === 'invalid_credentials');
  response('{"error":"invalid_setup_credential"}', 401);
  await rejected('invalid_setup_credential', 401);
  assert.equal(expired, 0);
  response('<html>private proxy response</html>', 401);
  await assert.rejects(requestJson('/api/protected'), UnauthorizedError);
  assert.equal(expired, 1);
  await assert.rejects(requestJson('/api/public/preview', { credentials: 'omit' }), UnauthorizedError);
  assert.equal(expired, 1);

  for (const status of [400, 404, 409, 413, 429, 500, 503]) {
    response('<html>private proxy response</html>', status);
    await rejected('request_failed', status);
  }
  for (const body of ['<html>wrong deployment</html>', 'null', '42', '']) {
    response(body);
    await rejected('invalid_response', 200);
  }
  response(null, 204);
  assert.equal(await requestJson('/api/delete'), undefined);
  response('{"success":false,"error":"all_failed"}');
  await rejected('all_failed', 200);
  response('{"ok":false,"error":"provider rejected the test"}');
  assert.equal((await requestJson('/api/test')).ok, false);
  response('{"success":true,"status":"partial_failed","monitors":[]}');
  assert.equal((await requestJson('/api/status')).status, 'partial_failed');
  response('{"error":"invalid_settings","message":"private diagnostics","failures":[{"key":"site.title","reason":"invalid_value"}]}', 400);
  await assert.rejects(requestJson('/api/settings'), error => error.message === 'invalid_settings' && error.details.failures[0].key === 'site.title');

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await rejected('network_error', 0);
  const abort = new DOMException('cancelled', 'AbortError');
  globalThis.fetch = async () => { throw abort; };
  await assert.rejects(requestJson('/api/cancelled'), error => error === abort);
  const programmingError = new Error('fixture programming failure');
  globalThis.fetch = async () => { throw programmingError; };
  await assert.rejects(requestJson('/api/fixture'), error => error === programmingError);
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500]) assert.equal(isRetryableApiError(new ApiError('request_failed', status)), false);
  assert.equal(isRetryableApiError(new ApiError('request_failed', 503)), true);
  assert.equal(isRetryableApiError(new ApiError('network_error', 0)), true);
  for (const code of ['invalid_auth_config', 'schema_behind', 'no_storage', 'theme_delete_storage_unavailable']) assert.equal(isRetryableApiError(new ApiError(code, 503)), false);
  for (const [code, key] of Object.entries({
    theme_delete_failed: 'admin.themes.deleteFailed', theme_delete_registry_failed: 'admin.themes.deleteRegistryFailed',
    theme_delete_storage_unavailable: 'admin.themes.deleteStorageUnavailable', theme_delete_invalid_path: 'admin.themes.deleteInvalidPath',
  })) assert.equal(apiErrorMessageKey(new ApiError(code, 503)), key);
  assert.equal(isRetryableApiError(new SyntaxError('bad JSON')), false);
  assert.equal(apiErrorMessageKey(new ApiError('monitor_paused', 409)), 'error.monitorPaused');
  assert.equal(apiErrorMessageKey(new ApiError('notification_language_invalid', 400)), 'admin.notify.error.notification_language_invalid');
  assert.equal(apiErrorMessageKey(new ApiError('avatar_invalid', 400)), 'admin.account.avatarInvalid');
  assert.equal(apiErrorMessageKey(new ApiError('agent_config_invalid', 400)), 'error.invalidRequest');
  assert.equal(apiErrorMessageKey(new ApiError('agent_config_conflict', 409)), 'error.conflict');
  assert.equal(apiErrorMessageKey(new ApiError('agent_config_unsupported', 409)), 'admin.agents.configUnreported');
  assert.equal(apiErrorMessageKey(new Error('private target and stack')), 'error.requestFailed');

  /* 输入校验错误应提示修改输入，并保留可供调用方处理的业务码。
   * Validation errors should prompt input changes while retaining the business code for callers. */
  for (const code of [
    'options_json_invalid', 'agent_options_invalid', 'agent_probe_enabled_invalid',
    'dns_options_invalid', 'dns_record_type_required', 'invalid_target', 'invalid_type',
    'invalid_value', 'invalid_option', 'values_must_be_object', 'url_required',
    'invalid_group', 'invalid_ids', 'invalid_limit', 'invalid_active', 'invalid_enabled',
    'invalid_name', 'unknown_key', 'filename_invalid', 'empty',
    // The monitor form's field codes: same family, same advice.
    // 监控表单的字段代码属于同一类，使用相同提示。
    'type_invalid', 'method_invalid', 'expected_status_invalid', 'keyword_invalid',
    'interval_sec_invalid', 'timeout_ms_invalid', 'addon_needs_hostname',
    'addon_needs_domain', 'check_source_invalid',
  ]) {
    assert.equal(apiErrorMessageKey(new ApiError(code, 400)), 'error.invalidRequest', `${code} must say "check the inputs"`);
  }

  // Alert-rule bodies get the form's own sentence, which names what to fix.
  // 告警规则请求体使用表单自己的提示，指出需要修正的内容。
  for (const code of ['agent_alerts_invalid', 'agent_threshold_invalid']) {
    assert.equal(apiErrorMessageKey(new ApiError(code, 400)), 'admin.form.agentThresholdInvalid', `${code} must name the thresholds`);
  }

  // 所选平台没有可下载版本时显示对应提示。
  // Report unavailable downloads for the selected platform.
  for (const code of ['release_not_found', 'release_asset_missing', 'unknown_platform']) {
    assert.equal(apiErrorMessageKey(new ApiError(code, 501)), 'admin.agent.noBuilds', `${code} must report missing builds`);
  }

  // A request too large to accept is about size, not about the page being stale.
  // 请求过大而无法接受是大小问题，而非页面已过期。
  assert.equal(apiErrorMessageKey(new ApiError('request_too_large', 413)), 'error.tooLarge');
  response('failed', 503);
  const beforePost = calls;
  await assert.rejects(requestJson('/api/mutation', { method: 'POST', body: '{}' }), ApiError);
  assert.equal(calls - beforePost, 1);

  const pages = [];
  let retry = false;
  globalThis.fetch = async path => {
    const pageId = new URL(path, 'https://fixture.test').searchParams.get('pageId');
    pages.push(pageId);
    if (pageId === 'retry' && !retry) return new Response('unavailable', { status: 503 });
    return Response.json({ pageId, pageIds: [pageId], defaultPageId: pageId, siteMeta: {}, pages: [], isPlaceholder: false, isEditThisPage: false, isShowStarButton: false });
  };
  const [a, b] = await Promise.all([fetchPublicConfig(publicConfigKey('a')), fetchPublicConfig(publicConfigKey('b'))]);
  assert.equal(a.pageId, 'a');
  assert.equal(b.pageId, 'b');
  assert.deepEqual(pages, ['a', 'b']);
  await assert.rejects(fetchPublicConfig(publicConfigKey('retry')), ApiError);
  retry = true;
  assert.equal((await fetchPublicConfig(publicConfigKey('retry'))).pageId, 'retry');
  console.log('PASS request client: HTTP/JSON/network/cancellation, auth signal, upload headers, partial outcomes, single mutation attempt and page identity isolation');
} finally { globalThis.fetch = previousFetch; delete globalThis.window; }

const worker = await build({
  stdin: { contents: `
    import { api } from './backends/worker/src/api'; import worker from './backends/worker/src/index'; import { HTTPException } from 'hono/http-exception';
    api.get('/api/__failure/:credential', () => { throw new Error('private-credential-and-driver-text'); });
    api.get('/api/__bad-request', () => { throw new HTTPException(422); });
    export default { fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__startup') return worker.fetch(request, { ...env, CONFIG: { get() { throw new Error('private-bootstrap-credential'); } } }, ctx);
      if (new URL(request.url).pathname === '/__settings') return api.fetch(new Request('https://fixture.test/api/admin/settings', { headers: request.headers }), { ...env, DB: { prepare() { throw new Error('private-settings-credential'); } } }, ctx);
      if (new URL(request.url).pathname === '/__no-storage') return api.fetch(new Request('https://fixture.test/api/themes/install', request), { ...env, THEMES: undefined }, ctx);
      return api.fetch(request, env, ctx);
    } };
  `, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'postgres-stub', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function() { throw new Error("unused Postgres driver"); }' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: worker.outputFiles[0].text, compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], bindings: { ADMIN_TOKEN: 'api-error-fixture' }, d1Databases: { DB: 'api-error-fixture' }, r2Buckets: { THEMES: 'api-error-themes' } });
const headers = { authorization: 'Bearer api-error-fixture', 'content-type': 'application/json' };
const request = (path, init = {}) => mf.dispatchFetch('https://fixture.test' + path, { ...init, headers: { ...headers, ...init.headers } });
async function expectError(path, status, code, init) {
  const result = await request(path, init);
  assert.equal(result.status, status, path);
  assert.match(result.headers.get('content-type'), /application\/json/);
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal((await result.json()).error, code, path);
}
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  await expectError('/api/not-a-route', 404, 'not_found');
  await expectError('/api/events?limit=abc', 400, 'invalid_limit');
  await expectError('/api/notifications/deliveries?limit=1.5', 400, 'invalid_limit');
  await expectError('/api/__failure/fixture-secret', 500, 'internal_error');
  await expectError('/api/__bad-request', 422, 'invalid_request');
  await expectError('/__startup', 503, 'database_configuration_failed');
  await expectError('/__settings', 500, 'internal_error');
  for (const body of ['null', '[]']) await expectError('/api/themes/install', 400, 'invalid_request', { method: 'POST', body });
  const zip = makeStoredZip({
    'polaris-theme.json': JSON.stringify({ schema: 2, id: 'error-fixture', short: 'error-fixture', name: 'Fixture', version: '1.0.0', themes: [{ id: 'monitor', name: 'Monitor', target: 'monitor', entry: 'index.html', capabilities: [], options: [] }] }),
    'index.html': '<html>Fixture</html>',
  });
  const installed = await request('/api/themes/install', { method: 'POST', body: zip, headers: { 'content-type': 'application/zip' } });
  assert.equal(installed.status, 200);
  await expectError('/__no-storage', 503, 'no_storage', { method: 'POST', body: zip, headers: { 'content-type': 'application/zip' } });
  const before = await (await request('/api/admin/presentation')).json();
  for (const body of ['{', 'null', '{"versionKey":42}']) {
    await expectError('/api/admin/presentation', 400, 'invalid_presentation', { method: 'PUT', body });
  }
  await expectError('/api/themes/error-fixture/activate', 404, 'not_found', { method: 'POST', body: '{}' });
  await expectError('/api/themes/error-fixture/config', 404, 'not_found', { method: 'POST', body: 'null' });
  assert.deepEqual((await (await request('/api/admin/presentation')).json()).config, before.config);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGNgYGD4z8Dwn4GBAQAAAAD//wMAAP8A//8AAoAAAf+amj8cAAAAAElFTkSuQmCC', 'base64');
  const icon = await request('/api/admin/site-icon', { method: 'POST', headers: { 'content-type': 'image/png', 'x-icon-filename': encodeURIComponent('站点%.png') }, body: png });
  assert.equal(icon.status, 200);
  assert.equal((await icon.json()).filename, '站点%.png');
  await expectError('/api/admin/site-icon', 400, 'filename_invalid', { method: 'POST', headers: { 'content-type': 'image/png', 'x-icon-filename': '%' }, body: png });
  console.log('PASS API errors: stable JSON/status/cache headers, startup boundary, numeric validation, malformed theme bodies and no accidental activation');
} finally { await mf.dispose(); }
