// 通过 D1 和 R2 验证主题变更与跨来源缓存失效。
// Use D1 and R2 to check theme changes and cross-origin cache invalidation.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { makeStoredZip } from '../helpers/zip.mjs';

function bounded(promise, label, ms = 10000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const bundled = await build({
  entryPoints: ['backends/worker/src/index.ts'], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
  external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'd1-fixture', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export default function postgres() { throw new Error('Postgres is outside this fixture'); }" }));
  } }],
});

async function checkExample(target) {
  const elements = new Map();
  function element() {
    return { textContent: '', className: '', disabled: false, dataset: {}, style: { setProperty(key, value) { this[key] = value; } },
      addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {} };
  }
  const root = element();
  const document = { body: { dataset: { target } }, documentElement: root, title: '',
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element, createTextNode: (text) => text };
  const config = { presentation: { locale: 'en', colorMode: 'light' }, siteMeta: { title: 'Site' },
    theme_settings: { accent: '#123456', headline: 'Custom title', description: 'Custom description' }, theme_content_html: '<b>Custom content</b>' };
  const sdk = { read: async (method) => method === 'config' ? config : target === 'agent' ? { servers: [] } : { monitors: [] } };
  vm.runInNewContext(readFileSync('examples/themes/polaris-simple/app.js', 'utf8'), { document, window: { polarisTheme: sdk }, navigator: { language: 'en' }, Intl, Date });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('title').textContent, 'Custom title');
  assert.equal(elements.get('description').textContent, 'Custom description');
  assert.equal(root.style['--accent'], '#123456');
  assert.equal(elements.get('custom-content').innerHTML, '<b>Custom content</b>');
}

await checkExample('monitor');
await checkExample('agent');

const token = 'theme-cache-fixture-token';
const mf = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'], bindings: { ADMIN_TOKEN: token },
  d1Databases: { DB: 'public-theme-cache-fixture' }, r2Buckets: { THEMES: 'public-theme-cache-fixture' },
});

const originA = 'https://theme-cache-a.example';
const originB = 'https://theme-cache-b.example';
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const short = 'cache-fixture';

async function request(origin, path, init) {
  const response = await bounded(mf.dispatchFetch(origin + path, init), path);
  return { status: response.status, headers: response.headers, body: await bounded(response.json(), `${path} body`) };
}

function packageBytes(version) {
  return makeStoredZip({
    'polaris-theme.json': JSON.stringify({
      schema: 2, id: 'theme-cache-fixture', short, name: 'Theme cache fixture', version,
      themes: [{ id:'monitor', name:'Monitor', target:'monitor', entry:'index.html', capabilities:['public.config'], options:[{key:'headline',label:'Headline',type:'string',default:version}] }],
    }),
    'index.html': `<html><head></head><body>${version}</body></html>`,
  });
}

async function publish(versionKey, headline, headCode = "", contentHtml = "") {
  const state = await request(originA, '/api/admin/presentation', { headers: auth });
  assert.equal(state.status, 200, JSON.stringify(state.body));
  const config = state.body.config;
  config.pages.monitor.theme = versionKey ? { short, version:versionKey, theme:'monitor' } : null;
  config.pages.monitor.themeOptions = versionKey ? {headline} : {};
  config.pages.monitor.headCode = versionKey ? headCode : "";
  config.pages.monitor.contentHtml = versionKey ? contentHtml : "";
  const result = await request(originA, '/api/admin/presentation', { method:'PUT', headers:auth, body:JSON.stringify({config,revision:state.body.revision}) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

async function upload(version) {
  const result = await request(originA, '/api/themes/install', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, body: packageBytes(version),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  return result.body;
}

async function freshConfig() {
  const result = await request(originB, '/api/public/config?fresh=1');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal(result.headers.get('x-public-cache'), null);
  return result.body;
}

try {
  await bounded((async () => {
    console.log('CHECKPOINT theme-cache: opening isolated D1/R2 fixture');
    const db = await bounded(mf.getD1Database('DB'), 'D1 startup', 20000);
    await applyD1Migrations(db);
    await db.prepare("UPDATE auth_setup_state SET completed=1 WHERE id=1").run();
    const first = await upload('1.0.0');
    for (const origin of [originA, originB]) {
      const config = await request(origin, '/api/public/config');
      assert.equal(config.body.theme, null);
    }
    await publish(first.versionKey, 'saved first');
    const headCode = '<style>body{color:red}</style><script>window.customHead=true</script>';
    const contentHtml = '<b>Public content</b>';
    await publish(first.versionKey, 'saved first', headCode, contentHtml);
    const persisted = await request(originA, '/api/admin/presentation', { headers: auth });
    assert.equal(persisted.body.config.pages.monitor.headCode, headCode);
    assert.equal(persisted.body.config.pages.monitor.contentHtml, contentHtml);
    assert.equal(persisted.body.config.pages.monitor.themeOptions.headline, 'saved first');
    const preview = await request(originA, `/api/themes/${short}/preview?version=${encodeURIComponent(first.versionKey)}&theme=monitor`, { headers: auth });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.headCode, headCode);
    assert.equal(preview.body.contentHtml, contentHtml);
    assert.equal(preview.body.values.headline, 'saved first');
    const shell = await mf.dispatchFetch(originA + '/');
    assert.ok((await shell.text()).includes(headCode));
    const bad = persisted.body.config;
    bad.pages.monitor.headCode = 'x'.repeat(16385);
    const oversized = await request(originA, '/api/admin/presentation', { method:'PUT', headers:auth, body:JSON.stringify({config:bad,revision:persisted.body.revision}) });
    assert.equal(oversized.status, 400);
    bad.pages.monitor.headCode = '';
    bad.pages.monitor.contentHtml = '汉'.repeat(10923);
    const oversizedContent = await request(originA, '/api/admin/presentation', { method:'PUT', headers:auth, body:JSON.stringify({config:bad,revision:persisted.body.revision}) });
    assert.equal(oversizedContent.status, 400);
    const activated = await request(originA, '/api/public/config');
    assert.equal(activated.body.theme.short, short);
    assert.equal(activated.body.theme_settings.headline, 'saved first');
    assert.equal(activated.body.theme_content_html, contentHtml);
    const other = await request(originB, '/api/public/config');
    assert.notEqual(other.headers.get('x-public-cache'), 'HIT');
    assert.equal(other.body.theme.short, short);
    assert.equal(other.body.theme_settings.headline, 'saved first');
    const fresh = await freshConfig();
    assert.equal(fresh.theme_settings.headline, 'saved first');
    assert.deepEqual(Object.keys(fresh).sort(), Object.keys(activated.body).sort());
    await publish(first.versionKey, 'saved second');
    assert.equal((await freshConfig()).theme_settings.headline, 'saved second');
    const second = await upload('2.0.0');
    assert.equal((await freshConfig()).theme_settings.headline, 'saved second');
    const inactivePreview = await request(originA, `/api/themes/${short}/preview?version=${encodeURIComponent(second.versionKey)}&theme=monitor`, { headers: auth });
    assert.equal(inactivePreview.status, 200, JSON.stringify(inactivePreview.body));
    assert.equal(inactivePreview.body.headCode, '');
    assert.equal(inactivePreview.body.values.headline, '2.0.0');
    await publish(second.versionKey, 'version two');
    assert.equal((await freshConfig()).theme.version, second.versionKey);
    await publish(first.versionKey, 'saved first');
    assert.equal((await freshConfig()).theme.version, first.versionKey);
    await publish(null, '');
    const inactive = await freshConfig();
    assert.equal(inactive.theme, null);
    assert.equal(inactive.theme_settings, null);
    assert.deepEqual(Object.keys(inactive).sort(), Object.keys(fresh).sort());
    assert.equal((await request(originB, '/api/public/config?fresh=0')).status, 400);
    await publish(first.versionKey, 'saved first');
    const removed = await request(originA, `/api/themes/${short}`, { method: 'DELETE', headers: auth });
    assert.equal(removed.status, 200);
    assert.equal((await freshConfig()).theme, null);
    assert.equal((await freshConfig()).theme_settings, null);
    assert.equal((await request(originA, '/api/public/theme')).body.short, null);
    console.log('PASS actual D1/R2 theme selection, settings, version changes, deletion, and fresh config with cross-origin cache invalidation');
  })(), 'theme cache lifecycle', 60000);
} finally {
  await bounded(mf.dispose(), 'Miniflare disposal');
}
