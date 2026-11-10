// 通过浏览器验证主题隔离预览与应用页面。
// Use a browser to check isolated theme previews and applied pages.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const externalBrowser = process.env.UPTIME_BROWSER_EXTERNAL === '1';
const browserCandidates = [
  process.env.CHROME_BIN,
  process.env.EDGE_BIN,
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.LocalAppData && join(process.env.LocalAppData, 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);
let chrome;
for (const candidate of browserCandidates) {
  try { await stat(candidate); chrome = candidate; break; } catch { }
}
if (!chrome && !externalBrowser) {
  const message = 'theme browser test requires CHROME_BIN or EDGE_BIN';
  if (process.env.UPTIME_BROWSER_REQUIRED === '1') throw new Error(message);
  console.log(`SKIP ${message}`);
  process.exit(0);
}
const originPath = resolve(process.env.UPTIME_FRONTEND_DIR ?? join(repoRoot, 'public'));
const brandModule = await build({ entryPoints: [join(repoRoot, 'backends/worker/src/lib/brand.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error' });
const { brandIconSvg } = await import(`data:text/javascript;base64,${Buffer.from(brandModule.outputFiles[0].text).toString('base64')}`);
const brandIcon = brandIconSvg({ tight: true });
const screenshotDir = join(repoRoot, 'artifacts', 'tmp');
await mkdir(screenshotDir, { recursive: true });
const screenshotStem = `theme-preview-browser-${Date.now()}`;
const previewDesktopScreenshot = join(screenshotDir, `${screenshotStem}-preview-desktop.png`);
const previewMobileScreenshot = join(screenshotDir, `${screenshotStem}-preview-mobile.png`);
/* 从构建资源选取实际字体，验证主题预览与应用后的字体请求。
 * Use a font from the build to check requests in theme preview and the applied page. */
const fontFile = (await readdir(join(originPath, 'assets'))).find((name) => name.startsWith('geist-') && name.endsWith('.woff2'));
assert.ok(fontFile, 'UI build must include a local font fixture (Geist ships with the console)');
const fontBytes = await readFile(join(originPath, 'assets', fontFile));
const prefix = 'themes/sample-theme/1.0.0/' + 'a'.repeat(64) + '/00000000-0000-4000-8000-000000000001';
const uuid = '00000000-0000-4000-8000-000000000002';
let active = false;
let publicReads = 0;
let fontRequests = 0;
let privateApiHits = 0;
let publicCredentialLeak = null;
let previewScopeFailure = null;
let previewReads = 0;
let finishExternal;
const externalResult = new Promise(resolveResult => { finishExternal = resolveResult; });
const requests = [];
const configValues = { headline: 'preview saved value', monitorRef: null, limit: null, enabled: null };
const capabilities = ['public.status', 'public.config', 'public.monitors', 'public.monitor-detail', 'public.agent-detail'];
const versionKey = '1.0.0+' + 'a'.repeat(64);
const definition = { id: 'monitor', name: 'Monitor', target: 'monitor', entry: 'dist/index.html', capabilities, options: [{ key: 'headline', label: 'Headline', type: 'string', default: 'default headline' }] };
const manifest = { schema: 2, id: 'sample-theme', short: 'sample', name: 'Fixture theme', version: '1.0.0', themes: [definition] };

const moduleBody = `const status=await window.polarisTheme.read('status');const id=status.monitors[0].id;const detail=await window.polarisTheme.read('monitor-detail',{id});const agent=await window.polarisTheme.read('agent-detail',{id,minutes:5});const config=await window.polarisTheme.read('config');const rejects=async(method,params)=>{try{await window.polarisTheme.read(method,params);return false}catch{return true}};const adminRejected=await rejects('admin',{url:'/api/auth/session'});const urlRejected=await rejects('status',{url:'/api/auth/session'});let directRejected=true;if(parent!==window){try{await fetch('/api/auth/session');directRejected=false}catch{}}const result={directRejected,statusId:id,detailId:detail.id,agentNumId:agent.monitor.num_id,agentMetric:agent.live.cpu_usage,configSite:config.siteMeta.title,configHeadline:config.theme_settings.headline,configTheme:config.theme,adminRejected,urlRejected};document.body.dataset.fixtureResult=JSON.stringify(result);parent.postMessage({type:'fixture-preview-result',result},'*');`;
const themeHtml = `<html><head><link rel="preload" as="font" href="/theme/${prefix}/dist/assets/test.woff2" crossorigin><script type="module" src="/theme/${prefix}/dist/assets/app.js"></script></head><body><main>fixture theme</main></body></html>`;
const harness = `(() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (fn, label) => { for (let i=0;i<${externalBrowser ? 3000 : 200};i++) { const value=fn(); if(value) return value; await sleep(50); } throw Error('Timed out: '+label); };
  const click = async label => { const button=await waitFor(()=>[...document.querySelectorAll('button')].find(e=>(e.textContent.trim()===label||e.getAttribute('aria-label')===label)&&!e.disabled),label+' button'); button.click(); };
  const report = async () => { if (${externalBrowser}) await fetch('/__test/finish', {method:'POST',body:document.querySelector('#__BROWSER_TEST_RESULT__').textContent}); };
  localStorage.setItem('uptime-polaris-locale','en-US');
  document.cookie='private_admin=fixture-secret; Path=/; SameSite=Lax';
  window.addEventListener('message', event => { if(event.data?.type==='fixture-preview-result') window.__previewFixture=event.data.result; });
  (async () => {
    try {
      if(location.pathname==='/admin/themes') {
        await waitFor(()=>document.body.innerText.includes('Installed themes'),'theme list');
        window.__previewFixture=null;
        const previewButton=await waitFor(()=>document.querySelector('button[aria-label="Preview this revision"]'),'preview button after config save');
        const beforePreview=await (await fetch('/__test/stats')).json();
        sessionStorage.setItem('theme-private-api-baseline', String(beforePreview.privateApiHits));
        previewButton.click();
        await waitFor(()=>window.__previewFixture,'preview module and bridge');
        const savedPreview=window.__previewFixture;
        if(savedPreview.statusId!=='${uuid}'||savedPreview.detailId!==7||savedPreview.agentNumId!==7||savedPreview.agentMetric!==42) throw Error('Preview public detail mismatch: '+JSON.stringify(savedPreview));
        if(!savedPreview.adminRejected||!savedPreview.urlRejected||!savedPreview.directRejected) throw Error('Preview exposed an unapproved request');
        if(savedPreview.configSite!=='Fixture site'||savedPreview.configHeadline!=='preview saved value'||savedPreview.configTheme.short!=='sample') throw Error('Preview config contract mismatch: '+JSON.stringify(savedPreview));
        window.__testPreviewReady=true;
        await waitFor(()=>window.__continuePreviewCapture,'desktop and mobile preview screenshots');
        const previewFrame=await waitFor(()=>document.querySelector('iframe[title="Preview: Fixture theme"]'),'preview frame');
        const nonce=previewFrame.srcdoc.match(/data-nonce="([^"]+)"/)[1];
        const beforeForeign=(await(await fetch('/__test/stats')).json()).publicReads;
        const foreign=document.createElement('iframe');
        foreign.setAttribute('sandbox','allow-scripts');
        foreign.srcdoc='<script>parent.postMessage({type:"polaris-theme:request",nonce:'+JSON.stringify(nonce)+',requestId:"987",method:"status"},"*")<\\/script>';
        document.body.append(foreign);
        await sleep(250);
        foreign.remove();
        const afterForeign=(await(await fetch('/__test/stats')).json()).publicReads;
        if(afterForeign!==beforeForeign) throw Error('Foreign frame triggered a public data request');
        const afterPreview=await (await fetch('/__test/stats')).json();
        if(afterPreview.privateApiHits!==beforePreview.privateApiHits||afterPreview.publicCredentialLeak||afterPreview.previewScopeFailure||afterPreview.previewReads===0) throw Error('Preview bridge leaked into a private request');
        await click('Close preview');
        await fetch('/__test/publish', {method:'POST'});
        location.assign('/');
      } else if(location.pathname==='/') {
        const result=await waitFor(()=>document.body.dataset.fixtureResult,'active module and SDK');
        const active=JSON.parse(result);
        if(active.statusId!=='${uuid}'||active.detailId!==7||active.agentNumId!==7||active.agentMetric!==42||active.configSite!=='Fixture site'||active.configHeadline!=='active public value'||active.configTheme.short!=='sample'||!active.adminRejected||!active.urlRejected) throw Error('Active result mismatch: '+result);
        const stats=await(await fetch('/__test/stats')).json();
        if(stats.privateApiHits!==Number(sessionStorage.getItem('theme-private-api-baseline'))||stats.publicCredentialLeak) throw Error('SDK sent credentials or requested private API: '+JSON.stringify(stats));
        document.body.innerHTML='<pre id="__BROWSER_TEST_RESULT__">PASS preview UUID mapping, agent metrics, theme-specific config, scoped preview authentication, module/font CORS, private credential exclusion, malicious method/URL rejection, foreign frame source check, active SDK</pre>';
        await report();
      }
    } catch(error) {
      document.body.innerHTML='<pre id="__BROWSER_TEST_RESULT__">FAIL '+String(error.stack||error).replaceAll('<','&lt;')+'</pre>';
      await report();
    }
  })();
})();`;

function send(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  response.writeHead(status, { 'content-type': contentType, ...headers });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push(`${request.method} ${url.pathname}`);
  if (externalBrowser && url.pathname === '/__test/finish' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    finishExternal(Buffer.concat(chunks).toString());
    return send(response, 200, JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/__test/overview-light.svg' || url.pathname === '/__test/overview-dark.svg') {
    return send(response, 200, await readFile(join(repoRoot, 'assets/readme', url.pathname.endsWith('light.svg') ? 'overview-light.svg' : 'overview-dark.svg')), 'image/svg+xml');
  }
  if (url.pathname === '/__test/stats') return send(response, 200, JSON.stringify({ publicReads, privateApiHits, publicCredentialLeak, previewScopeFailure, previewReads }));
  if (url.pathname === '/__test/publish' && request.method === 'POST') { active = true; return send(response, 200, JSON.stringify({ ok: true })); }
  if (url.pathname === '/api/public/icon') return send(response, 200, brandIcon, 'image/svg+xml; charset=utf-8');
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/auth/session') privateApiHits++;
    if (/^\/api\/public\/(?:status|config|monitors(?:\/|$)|agent\/detail\/)/.test(url.pathname)) {
      publicReads++;
      if (url.searchParams.has('preview')) {
        previewReads++;
        if (url.searchParams.get('preview') !== 'monitor' || !request.headers.cookie?.includes('private_admin=fixture-secret')) previewScopeFailure = url.pathname + url.search;
      } else if (request.headers.cookie || request.headers.authorization) publicCredentialLeak = { path: url.pathname, cookie: request.headers.cookie ?? null, authorization: request.headers.authorization ?? null };
    }
    if (url.pathname === '/api/auth/session') return send(response, 200, JSON.stringify({ authenticated: true, user: { id: 'fixture', username: 'fixture' }, needsSetup: false, setupCredential: null }));
    if (url.pathname === '/api/themes') return send(response, 200, JSON.stringify({ storageReady: true, themes: [{ id: manifest.id, short: manifest.short, name: manifest.name, version: manifest.version, description: null, author: null, sourceUrl: null, supported: true, versions: [{ versionKey, version: manifest.version, prefix, themes: [{ ...definition, available: true }] }] }] }));
    if (url.pathname === '/api/admin/presentation') return send(response, 200, JSON.stringify({ config: { agentEnabled: false, workerService: 'uptime-polaris', domains: [], pages: { monitor: { theme: null, themeOptions: {} }, agent: { theme: null, themeOptions: {} } } }, revision: 'fixture' }));
    if (url.pathname === '/api/themes/sample/preview') {
      if (url.searchParams.get('version') !== versionKey || url.searchParams.get('theme') !== definition.id) return send(response, 400, JSON.stringify({ error: 'invalid_request' }));
      return send(response, 200, JSON.stringify({ id: manifest.id, versionKey, prefix, manifest, definition, values: configValues }));
    }
    if (url.pathname === '/api/public/status') return send(response, 200, JSON.stringify({ monitors: [{ id: uuid, num_id: 7, type: 'agent', name: 'same-name' }] }));
    if (url.pathname === '/api/public/monitors') return send(response, 200, JSON.stringify({ success: true, monitorGroups: [] }));
    if (url.pathname === '/api/public/monitors/7') return send(response, 200, JSON.stringify({ id: 7, name: 'same-name', type: 'agent' }));
    if (url.pathname === '/api/public/agent/detail/7') return send(response, 200, JSON.stringify({ monitor: { id: uuid, num_id: 7, name: 'same-name', type: 'agent' }, live: { cpu_usage: 42 }, history: [], minutes: 5 }));
    if (url.pathname === '/api/public/config') return send(response, 200, JSON.stringify({ siteMeta: { title: 'Fixture site', description: '', icon: '/api/public/icon' }, pages: [{ id: 'default', siteMeta: { title: 'Fixture site' } }], config: { slug: 'default', title: 'Fixture site' }, theme: { short: 'sample', name: 'Fixture theme', version: '1.0.0' }, theme_settings: { headline: 'active public value' } }));
    return send(response, 404, JSON.stringify({ error: 'not_found' }));
  }
  if (url.pathname === '/test-harness.js') return send(response, 200, harness, 'text/javascript; charset=utf-8');
  if (url.pathname.startsWith('/theme/')) {
    if (url.pathname.endsWith('/dist/index.html')) return send(response, 200, themeHtml, 'text/html; charset=utf-8', { 'access-control-allow-origin': '*' });
    if (url.pathname.endsWith('/dist/assets/app.js')) return send(response, 200, moduleBody, 'text/javascript; charset=utf-8', { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
    if (url.pathname.endsWith('/dist/assets/test.woff2')) { fontRequests++; return send(response, 200, fontBytes, 'font/woff2', { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }); }
    return send(response, 404, 'not found', 'text/plain');
  }
  if (/^\/(?:admin|login)(?:\/|$)/.test(url.pathname)) {
    const body = (await readFile(join(originPath, 'index.html'))).toString().replace('</body>', '<script src="/test-harness.js"></script></body>');
    return send(response, 200, body, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/' && active) {
    const activeHtml = themeHtml.replace('<head>', `<head><base href="/theme/${prefix}/dist/"><script src="/polaris-theme-sdk.js" data-capabilities="${capabilities.join(' ')}"></script>`);
    return send(response, 200, activeHtml + '<script src="/test-harness.js"></script>', 'text/html; charset=utf-8');
  }
  let path = normalize(join(originPath, decodeURIComponent(url.pathname.slice(1))));
  if (!path.startsWith(originPath + sep) && path !== originPath) return send(response, 400, 'bad path', 'text/plain');
  try {
    let body = await readFile(path);
    let contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff' })[extname(path)] ?? 'application/octet-stream';
    send(response, 200, body, contentType);
  } catch {
    send(response, 404, 'not found', 'text/plain');
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
if (externalBrowser) {
  let timer;
  try {
    console.log(`EXTERNAL_BROWSER_READY http://127.0.0.1:${port}/admin/themes`);
    const result = await Promise.race([externalResult, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('External browser fixture timed out')), 180000); })]);
    assert.match(result, /^PASS /, result);
    assert.ok(publicReads >= 6, `Expected fixture public reads, got ${publicReads}`);
    assert.ok(fontRequests >= 2, `Expected preview and active font requests, got ${fontRequests}`);
    assert.ok(previewReads > 0);
    assert.equal(publicCredentialLeak, null);
    assert.equal(previewScopeFailure, null);
    console.log(result);
  } finally {
    clearTimeout(timer);
    server.close();
  }
} else {
const profileRoot = await mkdtemp(join(tmpdir(), 'uptime-theme-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profileRoot}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
browser.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
let socket;
try {
  const activePortFile = join(profileRoot, 'DevToolsActivePort');
  let debugPort;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { debugPort = Number((await readFile(activePortFile, 'utf8')).split(/\r?\n/, 1)[0]); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.ok(Number.isInteger(debugPort) && debugPort > 0, `Chrome DevTools did not start. ${stderr.slice(-2000)}`);
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/admin/themes`)}`, { method: 'PUT' });
  assert.equal(targetResponse.status, 200);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/admin/themes` });
  const deadline = Date.now() + 60000;
  let resultText = '';
  let previewScreenshotsCaptured = false;
  while (Date.now() < deadline) {
    const capturePair = async (desktopPath, mobilePath, releaseExpression) => {
      const desktop = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(desktopPath, Buffer.from(desktop.data, 'base64'));
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const mobile = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(mobilePath, Buffer.from(mobile.data, 'base64'));
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await cdp('Runtime.evaluate', { expression: releaseExpression });
    };
    if (!previewScreenshotsCaptured) {
      const previewState = await cdp('Runtime.evaluate', { expression: 'window.__testPreviewReady === true && window.__continuePreviewCapture !== true', returnByValue: true });
      if (previewState.result?.value === true) {
        await capturePair(previewDesktopScreenshot, previewMobileScreenshot, 'window.__continuePreviewCapture = true');
        previewScreenshotsCaptured = true;
      }
    }
    const evaluation = await cdp('Runtime.evaluate', { expression: "document.querySelector('#__BROWSER_TEST_RESULT__')?.textContent ?? ''", returnByValue: true });
    resultText = evaluation.result?.value ?? '';
    if (/^(PASS|FAIL) /.test(resultText)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(resultText, /^PASS /, `Browser fixture did not finish. Requests: ${requests.join(', ')}. Browser errors: ${browserErrors.join(' | ')}. ${stderr.slice(-1000)}`);
  assert.ok(publicReads >= 6, `Expected fixture public reads, got ${publicReads}`);
  assert.ok(fontRequests >= 2, `Expected preview and active font requests, got ${fontRequests}`);
  assert.ok(previewScreenshotsCaptured, 'Desktop and mobile preview screenshots should be captured');
  for (const screenshot of [previewDesktopScreenshot, previewMobileScreenshot]) assert.ok((await stat(screenshot)).size > 0, `${screenshot} should be written`);
  console.log(`${resultText}\nPreview screenshots: ${previewDesktopScreenshot}, ${previewMobileScreenshot}`);
} finally {
  socket?.close();
  browser.kill();
  if (browser.exitCode === null) await once(browser, 'close');
  server.close();
  const absoluteProfile = resolve(profileRoot);
  const absoluteTemp = resolve(tmpdir());
  assert.ok(absoluteProfile.startsWith(absoluteTemp + sep));
  await rm(absoluteProfile, { recursive: true, force: true });
}
}
