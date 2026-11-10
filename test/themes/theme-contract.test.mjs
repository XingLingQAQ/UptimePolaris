// 验证主题清单、选项和页面引用约束。
// Check theme manifests, options, and page-reference constraints.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { makeStoredZip } from '../helpers/zip.mjs';

const token = 'theme-isolation-token';
// /__fixture/* drives installation and selection; regular pages and APIs use real handlers.
// failing throws on the second put; remove modes fail the second delete or omit the binding.
// counting records writes so invalid packages can assert rejection before storage changes.
// /__fixture/* 驱动安装和选版；failing/counting/remove 用于注入失败和统计写入。
const entry = `
import { api } from './backends/worker/src/api';
import { handlePageRequest } from './backends/worker/src/lib/theme/page-handler';
import { checkThemeUpdate, installPackage, readBoundedResponse, readBoundedStream } from './backends/worker/src/lib/theme/install';
import { defaultPresentation } from './shared/presentation';
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__fixture/')) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (url.pathname === '/__fixture/select') {
      const selections = JSON.parse(new TextDecoder().decode(bytes));
      const config = defaultPresentation();
      config.domains = [{hostname:'localhost',page:'monitor'},{hostname:'agent.test',page:'agent'}];
      config.agentEnabled = true;
      config.pages.monitor.theme = selections.monitor ?? null;
      config.pages.agent.theme = selections.agent ?? null;
      await env.DB.prepare("INSERT INTO presentation_state VALUES ('main',?,?,0) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision").bind(JSON.stringify(config),crypto.randomUUID()).run();
      return Response.json({ok:true});
    }
    if (url.pathname === '/__fixture/remove') {
      const { short } = JSON.parse(new TextDecoder().decode(bytes));
      const mode = url.searchParams.get('mode');
      let deletes = 0;
      const bucket = mode === 'no-storage' ? undefined : new Proxy(env.THEMES, { get(target, key) {
        if (key === 'delete' && mode === 'fail-delete') return async (...args) => {
          if (++deletes === 2) throw new Error('injected R2 deletion failure');
          return target.delete(...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      return api.fetch(new Request(url.origin + '/api/themes/' + encodeURIComponent(short), {
        method: 'DELETE', headers: request.headers,
      }), { ...env, THEMES: bucket }, ctx);
    }
    if (url.pathname === '/__fixture/delete') {
      const body = JSON.parse(new TextDecoder().decode(bytes));
      await env.THEMES.delete(body.key);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__fixture/bounded') {
      const streamed = () => new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(1)); controller.close();
      }});
      const results = [];
      for (const read of [() => readBoundedStream(streamed(), 16), () => readBoundedResponse(new Response(streamed()), 16)]) {
        try { await read(); results.push('accepted'); } catch (error) { results.push(error.code); }
      }
      return Response.json({ results });
    }
    if (url.pathname === '/__fixture/update-check') {
      const priorFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(bytes);
      try {
        const result = await checkThemeUpdate(env, 'https://fixture.invalid/theme.zip', url.searchParams.get('version') ?? '1.0.0', url.searchParams.get('digest'), 'sample-theme');
        return Response.json(result);
      } finally { globalThis.fetch = priorFetch; }
    }
    let fixtureEnv = env;
    let writes = null;
    if (url.pathname === '/__fixture/failing' || url.pathname === '/__fixture/counting') {
      let writeCount = 0;
      const bucket = new Proxy(env.THEMES, { get(target, key) {
        if (key === 'put') return async (...args) => { writeCount++; if (url.pathname === '/__fixture/failing' && writeCount === 2) throw new Error('injected R2 write failure'); return target.put(...args); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      fixtureEnv = { ...env, THEMES: bucket };
      const result = await installPackage(fixtureEnv, bytes);
      return Response.json({ result, writes: writeCount }, { status: result.ok ? 200 : 400 });
    }
    const result = await installPackage(fixtureEnv, bytes);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }
  const page = await handlePageRequest(request, env);
  return page ?? api.fetch(request, env, ctx);
} };
`;

const bundled = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'artifacts/tmp/theme-contract-worker.ts' },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
  external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'stub-postgres', setup(build) {
    build.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
    build.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({ contents: "export default function postgres() { throw new Error('postgres stub reached'); }" }));
  }}],
});

const mf = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'theme-test-db' }, r2Buckets: { THEMES: 'theme-test-bucket' },
  bindings: { ADMIN_TOKEN: token },
  serviceBindings: { ASSETS: async () => new Response('<html><div id="root">built-in</div></html>', { headers: { 'content-type': 'text/html' } }) },
});

const db = await mf.getD1Database('DB');
// Seed only the tables and monitor fixture needed by theme/page handlers, not the full app.
// 只建立主题和页面处理所需的表与监控夹具，不运行完整应用初始化。
await db.exec(`
CREATE TABLE themes (short TEXT PRIMARY KEY, id TEXT UNIQUE, name TEXT NOT NULL, version TEXT NOT NULL, description TEXT, author TEXT, source_url TEXT, manifest_json TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0);
CREATE TABLE theme_versions (id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,prefix TEXT NOT NULL,manifest_json TEXT NOT NULL,installed_at INTEGER NOT NULL,PRIMARY KEY(id,version,digest));
CREATE TABLE presentation_state (id TEXT PRIMARY KEY,config_json TEXT NOT NULL,revision TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE theme_operations (id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE monitors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE live_state (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO monitors (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Fixture monitor');
`);
const origin = 'http://localhost';
const authHeaders = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
// A two-page ZIP with root-relative CSS, JS and images exercises rewriting and per-page version selection.
// 双页面 ZIP 含根路径 CSS、JS 和图片，覆盖资源重写及各页面独立选版。
const makePackage = (version, marker, id = 'sample-theme', short = 'sample') => makeStoredZip({
  'polaris-theme.json': JSON.stringify({ schema: 2, id, short, name: 'Sample', version, themes: [{ id: 'monitor', name: 'Monitor', target: 'monitor', entry: 'dist/index.html', capabilities: ['public.status', 'public.monitors'], options: [{ key: 'headline', label: 'Headline', type: 'string', default: marker }] }, { id: 'agent', name: 'Agent', target: 'agent', entry: 'agent/index.html', capabilities: ['public.servers'], options: [] }] }),
  'dist/index.html': '<html><head><link rel="preload" as="image" href="/assets/bg.svg"><link rel="stylesheet" href="/assets/main.css"></head><body><script type="module" src="/assets/main.js"></script><img src="/api/public/icon"><img src="/assets/bg.svg"><a href="/monitor/check-123">route</a><div>' + marker + '</div></body></html>',
  'dist/assets/main.js': 'export const marker = ' + JSON.stringify(marker) + '; export const lazy = () => import("/assets/lazy.js"); export const image = "/assets/bg.svg";',
  'dist/assets/lazy.js': 'export const lazy = true;',
  'dist/assets/main.css': '.hero { background-image: url("/assets/bg.svg"); }',
  'dist/assets/bg.svg': '<svg></svg>',
  'agent/index.html': '<html><head></head><body>agent-' + marker + '</body></html>',
});
const req = (path, init = {}) => mf.dispatchFetch(origin + path, init);
const install = async (bytes, failing = false) => req(failing ? '/__fixture/failing' : '/__fixture/install', { method: 'POST', body: bytes });
const json = async (response) => {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error('expected JSON, got HTTP ' + response.status + ': ' + text.slice(0, 120)); }
};

try {
  const bounded = await json(await req('/__fixture/bounded', { method: 'POST', body: new Uint8Array([1]) }));
  assert.deepEqual(bounded.results, ['too_large', 'too_large']);

  const oversizedEntries = { 'polaris-theme.json': '{}', 'dist/index.html': 'x' };
  for (let index = 0; index < 499; index++) oversizedEntries['assets/' + index + '.txt'] = 'x';
  const tooManyFiles = await json(await req('/__fixture/counting', { method: 'POST', body: makeStoredZip(oversizedEntries) }));
  assert.equal(tooManyFiles.result.error, 'too_many_entries');
  assert.equal(tooManyFiles.writes, 0);

  // Inflate only the declared ZIP size to test rejection before writes without allocating a large file.
  // 只放大 ZIP 声明的解压大小，验证写入前拒绝，无需创建真正的大文件。
  const sizeBomb = makeStoredZip({ 'polaris-theme.json': '{}', 'dist/index.html': 'x' });
  const central = new DataView(sizeBomb.buffer, sizeBomb.byteOffset, sizeBomb.byteLength);
  let centralAt = -1;
  for (let index = 0; index < sizeBomb.length - 4; index++) if (central.getUint32(index, true) === 0x02014b50) { centralAt = index; break; }
  assert.notEqual(centralAt, -1);
  const firstNameLength = central.getUint16(centralAt + 28, true);
  const firstExtraLength = central.getUint16(centralAt + 30, true);
  const firstCommentLength = central.getUint16(centralAt + 32, true);
  const secondAt = centralAt + 46 + firstNameLength + firstExtraLength + firstCommentLength;
  central.setUint32(secondAt + 24, 0x7fffffff, true);
  const tooLarge = await json(await req('/__fixture/counting', { method: 'POST', body: sizeBomb }));
  assert.equal(tooLarge.result.error, 'too_large');
  assert.equal(tooLarge.writes, 0);

  const missingAssetFiles = {
    'polaris-theme.json': JSON.stringify({ schema: 2, id: 'missing-html', short: 'missing-html', name: 'Missing', version: '1.0.0', themes: [{id:'monitor',name:'Monitor',target:'monitor',entry:'dist/index.html',capabilities:[],options:[]}] }),
    'dist/index.html': '<script type="module" src="/assets/missing.js"></script>',
  };
  const missingHtmlAsset = await json(await req('/__fixture/counting', { method: 'POST', body: makeStoredZip(missingAssetFiles) }));
  assert.equal(missingHtmlAsset.result.error, 'root_asset_missing');
  assert.equal(missingHtmlAsset.writes, 0);

  const missingScriptAsset = await json(await req('/__fixture/counting', { method: 'POST', body: makeStoredZip({
    'polaris-theme.json': JSON.stringify({ schema: 2, id: 'missing-script', short: 'missing-script', name: 'Missing', version: '1.0.0', themes: [{id:'monitor',name:'Monitor',target:'monitor',entry:'dist/index.html',capabilities:[],options:[]}] }),
    'dist/index.html': '<script type="module" src="/assets/main.js"></script>',
    'dist/assets/main.js': 'import("/assets/missing.js");',
  }) }));
  assert.equal(missingScriptAsset.result.error, 'root_asset_missing');
  assert.equal(missingScriptAsset.writes, 0);

  const invalid = await install(makeStoredZip({ 'polaris-theme.json': JSON.stringify({ schema: 1, id: 'bad', short: 'bad', name: 'Bad', version: '1.0.0', entry: 'index.html' }) }));
  assert.equal(invalid.status, 400);
  assert.equal((await json(invalid)).error, 'manifest_field_unknown');

  const firstInstall = await json(await req('/api/themes/install', { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/zip' }, body: makePackage('1.2.3', 'first') }));
  assert.equal(firstInstall.ok, true);
  assert.match(firstInstall.prefix, /themes\/sample-theme\/1\.2\.3\/[a-f0-9]{64}\/[0-9a-f-]{36}$/);
  const previewPath = '/api/themes/sample/preview?version=' + encodeURIComponent(firstInstall.versionKey) + '&theme=monitor';
  assert.equal((await req(previewPath)).status, 401);
  const previewInfo = await req(previewPath, { headers: authHeaders });
  assert.equal(previewInfo.status, 200);
  assert.equal(previewInfo.headers.get('cache-control'), 'private, no-store');
  assert.equal((await json(previewInfo)).values.headline, 'first');
  const select = (monitor, agent = null) => req('/__fixture/select', { method:'POST', body:JSON.stringify({monitor,agent}) });
  const pick = (version, theme) => ({short:'sample',version,theme});
  await select(pick(firstInstall.versionKey,'monitor'),pick(firstInstall.versionKey,'agent'));
  const oldAssetPath = '/theme/' + firstInstall.prefix + '/dist/assets/main.js';
  const oldAsset = await req(oldAssetPath);
  assert.equal(oldAsset.status, 200);
  assert.equal(oldAsset.headers.get('access-control-allow-origin'), '*');
  assert.equal(oldAsset.headers.get('access-control-allow-credentials'), null);
  const rewrittenModule = await oldAsset.text();
  assert.match(rewrittenModule, /first/);
  assert.ok(rewrittenModule.includes('/theme/' + firstInstall.prefix + '/dist/assets/lazy.js'));
  assert.ok(rewrittenModule.includes('/theme/' + firstInstall.prefix + '/dist/assets/bg.svg'));
  const firstShell = await (await req('/')).text();
  assert.match(firstShell, /<base href="\/theme\/[^\"]+\/dist\/">/);
  assert.match(firstShell, /src="\/polaris-theme-sdk\.js" data-capabilities="public\.status public\.monitors"/);
  assert.match(firstShell, /href="assets\/main\.css"/);
  assert.match(firstShell, /src="\/api\/public\/icon"/);
  assert.match(firstShell, /href="\/monitor\/check-123"/);
  assert.match(await (await req('/theme/' + firstInstall.prefix + '/dist/assets/main.css')).text(), /url\("bg\.svg"\)/);
  assert.match(await (await mf.dispatchFetch('http://agent.test/')).text(), /agent-first/);
  assert.match(await (await req('/?preview=monitor')).text(), /built-in/);
  const sameVersion = await json(await install(makePackage('1.2.3', 'second')));
  assert.notEqual(sameVersion.versionKey, firstInstall.versionKey);
  const updateCheck = await json(await req('/__fixture/update-check?version=1.2.3&digest=' + firstInstall.digest, { method: 'POST', body: makePackage('1.2.3', 'second') }));
  assert.equal(updateCheck.available, true);
  assert.match(await (await req('/')).text(), /first/);
  await select(pick(sameVersion.versionKey,'monitor'),pick(firstInstall.versionKey,'agent'));
  assert.match(await (await req('/')).text(), /second/);
  assert.match(await (await mf.dispatchFetch('http://agent.test/')).text(), /agent-first/);
  const failed = await install(makePackage('4.0.0', 'partial'), true);
  assert.equal((await json(failed)).result.error, 'storage_write_failed');
  const conflict = await install(makePackage('5.0.0', 'conflict', 'different-id', 'sample'));
  assert.equal((await json(conflict)).error, 'theme_id_short_conflict');
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM theme_versions WHERE id='different-id'").first()).count, 0);
  const themeList = await json(await req('/api/themes', { headers: authHeaders }));
  assert.equal(themeList.themes[0].versions.length, 2);
  assert.deepEqual(themeList.themes[0].versions[0].themes.map(item => item.target).sort(), ['agent','monitor']);
  const bucket = await mf.getR2Bucket('THEMES');
  await bucket.delete(sameVersion.prefix + '/dist/index.html');
  const unavailableList = await json(await req('/api/themes', { headers: authHeaders }));
  assert.equal(unavailableList.themes[0].versions.find(item => item.versionKey === sameVersion.versionKey).themes.find(item => item.id === 'monitor').available, false);
  for (const path of ['/admin', '/admin/settings', '/login', '/setup']) assert.match(await (await req(path)).text(), /built-in/);
  assert.equal((await req('/api/themes/sample', { method: 'DELETE' })).status, 401);
  const removeWithMode = (short, mode) => req('/__fixture/remove?mode=' + mode, { method:'POST', headers:authHeaders, body:JSON.stringify({short}) });
  assert.equal((await removeWithMode('sample','no-storage')).status,503);
  const neighbor = await json(await install(makePackage('1.0.0','neighbor','sample-theme-neighbor','neighbor')));
  await bucket.put('unrelated/keep.txt','keep');
  // 1002 orphan keys force multi-page deletion while neighboring themes and unrelated prefixes must survive.
  // 1002 个孤儿键覆盖跨页删除，同时保留邻居主题和无关前缀。
  const additions=Array.from({length:1002},(_,i)=>'themes/sample-theme/orphan-'+String(i).padStart(4,'0'));
  for(let i=0;i<additions.length;i+=50) await Promise.all(additions.slice(i,i+50).map(key=>bucket.put(key,'orphan')));
  const failedRemoval=await removeWithMode('sample','fail-delete');
  assert.equal((await json(failedRemoval)).error,'theme_delete_failed');
  assert.ok(await db.prepare("SELECT short FROM themes WHERE short='sample'").first());
  const state=await db.prepare("SELECT * FROM presentation_state WHERE id='main'").first();
  for(const config of [JSON.parse(state.config_json)]) for(const page of Object.values(config.pages)) assert.equal(page.theme,null);
  assert.equal((await req('/api/themes/sample',{method:'DELETE',headers:authHeaders})).status,200);
  assert.equal((await bucket.list({prefix:'themes/sample-theme/'})).objects.length,0);
  assert.ok(await bucket.head(neighbor.prefix+'/dist/index.html'));
  assert.ok(await bucket.head('unrelated/keep.txt'));
  assert.equal((await req(oldAssetPath)).status,404);
  // 安装随项目提供的实际 ZIP，覆盖示例打包和清单编码。
  // Install the shipped ZIP to cover example packaging and manifest encoding.
  const example = await json(await install(readFileSync('examples/themes/polaris-simple/polaris-simple.zip')));
  assert.equal(example.id, 'polaris-simple');
  const examples = await json(await req('/api/themes', { headers: authHeaders }));
  const shipped = examples.themes.find(theme => theme.id === example.id);
  assert.deepEqual(shipped.versions[0].themes.map(theme => [theme.target, theme.available]).sort(), [['agent', true], ['monitor', true]]);
  console.log('theme schema 2 contract: passed');
} finally { await mf.dispose(); }
