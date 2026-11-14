import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
mkdirSync('artifacts/tmp', { recursive: true });
const directory = mkdtempSync(resolve('artifacts/tmp/static-assets-'));
const assets = {
  'index.html': '<!doctype html><title>SPA shell</title><div id="root"></div>',
  '404.html': '<!doctype html><title>Not found</title><div data-http-status="404"></div>',
  '500.html': '<!doctype html><title>Page error</title><div data-http-status="500"></div>',
  '503.html': '<!doctype html><title>Page error</title><div data-http-status="503"></div>',
  'assets/app.js': 'window.assetLoaded = true;',
  'assets/app.css': 'body { color: black; }',
  'assets/font.woff2': 'fixture-font',
  'assets/image.png': 'fixture-image',
  'polaris-theme-sdk.js': 'window.themeSDK = true;',
  'favicon.ico': 'fixture-icon',
  'api/shadow.html': '<title>Must not shadow the API</title>',
  'agent/private.bin': 'must not be served directly',
};
for (const [file, body] of Object.entries(assets)) {
  const path = join(directory, file);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, body);
}
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `import worker from './backends/worker/src/index';
import { pageErrorResponse } from './backends/worker/src/lib/http/page-errors';
export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  const status = Number(path.split('/').at(-1));
  let response;
  if (/^\\/(?:admin|api)\\/error\\//.test(path)) {
    response = await pageErrorResponse(request, env, Response.json({error:'internal_error'}, {status, headers:{'cache-control':'private, no-store'}}));
  } else {
    response = await worker.fetch(request, env, ctx);
  }
  const headers = new Headers(response.headers);
  headers.set('x-worker-invoked', '1');
  return new Response(response.body, {status:response.status, headers});
}};`,
  },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'no-postgres', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default function() { throw new Error("Unexpected database connection"); }' }));
  } }],
});
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  kvNamespaces: { CONFIG: 'static-assets-config' },
  assets: {
    directory, binding: 'ASSETS',
    routerConfig: { has_user_worker: true, static_routing: { user_worker: config.assets.run_worker_first } },
    assetConfig: {
      html_handling: config.assets.html_handling,
      not_found_handling: config.assets.not_found_handling,
      has_static_routing: true,
    },
  },
});
const request = (path, init) => mf.dispatchFetch('http://localhost' + path, { redirect: 'manual', ...init });
try {
  for (const file of ['assets/app.js', 'assets/app.css', 'assets/font.woff2', 'assets/image.png', 'polaris-theme-sdk.js', 'favicon.ico']) {
    const response = await request('/' + file);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('x-worker-invoked'), null, file);
    assert.equal(await response.text(), assets[file]);
  }
  for (const path of ['/unknown-page', '/unknown/nested', '/index.html', '/404', '/500', '/503']) {
    const response = await request(path, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
    assert.equal(response.headers.get('x-worker-invoked'), null, path);
    assert.ok([200, 307].includes(response.status), path + ': ' + response.status);
    if (response.status === 200) assert.match(await response.text(), /SPA shell|data-http-status/);
  }
  for (const path of ['/', '/admin', '/admin/settings', '/login', '/login/', '/setup', '/setup/', '/monitor/one', '/status/main', '/server/one', '/theme/a/b/c/d/e/app.js', '/polaris-maintenance.js', '/agent/private.bin', '/install.sh', '/install.ps1', '/api', '/api/shadow', '/api/public/maintenance', '/__scheduled']) {
    const response = await request(path, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
    assert.equal(response.headers.get('x-worker-invoked'), '1', path);
    if (['/', '/admin', '/login', '/monitor/one'].includes(path)) {
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), '/setup', path);
    }
    if (path.startsWith('/api') && path !== '/api/public/icon') {
      assert.match(response.headers.get('content-type'), /application\/json/, path);
    }
    if (path === '/setup' || path === '/setup/') assert.match(await response.text(), /SPA shell/);
  }
  for (const status of [404, 500, 502, 503, 504]) {
    const response = await request('/admin/error/' + status, { headers: { accept: 'text/html' } });
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(await response.text(), new RegExp('data-http-status="' + (status === 404 ? 404 : status === 500 ? 500 : 503) + '"'));
    const head = await request('/admin/error/' + status, { method: 'HEAD', headers: { accept: 'text/html' } });
    assert.equal(head.status, status);
    assert.equal(await head.text(), '');
    const api = await request('/api/error/' + status, { headers: { accept: 'text/html' } });
    assert.equal(api.status, status);
    assert.deepEqual(await api.json(), { error: 'internal_error' });
  }
  const namespace = await mf.getKVNamespace('CONFIG');
  await namespace.put('database', JSON.stringify({ invalid: true }));
  const unavailable = await request('/', { headers: { accept: 'text/html' } });
  assert.equal(unavailable.status, 503);
  assert.match(await unavailable.text(), /data-http-status="503"/);
  const unavailableApi = await request('/api/auth/session', { headers: { accept: 'text/html' } });
  assert.equal(unavailableApi.status, 503);
  assert.deepEqual(await unavailableApi.json(), { error: 'database_configuration_failed' });
  const availableAsset = await request('/assets/app.js');
  assert.equal(availableAsset.status, 200);
  assert.equal(availableAsset.headers.get('x-worker-invoked'), null);
  const json = await request('/admin/error/503', { headers: { accept: 'application/json' } });
  assert.deepEqual(await json.json(), { error: 'internal_error' });
  const post = await request('/admin/error/503', { method: 'POST', headers: { accept: 'text/html' } });
  assert.deepEqual(await post.json(), { error: 'internal_error' });
  console.log('PASS asset bypass, SPA fallback, setup redirects, dynamic routing, static error HTML and API boundaries');
} finally {
  await mf.dispose();
}
