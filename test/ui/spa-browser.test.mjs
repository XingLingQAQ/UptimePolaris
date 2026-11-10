#!/usr/bin/env node
// 通过浏览器验证公开页面、账号、管理操作和主题流程。
// Use a browser to check public pages, accounts, administration, and theme flows.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { spaAssetService } from '../helpers/spa-assets.mjs';
import { makeStoredZip } from '../helpers/zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = join(root, 'public');
const browserCandidates = [
  process.env.CHROME_BIN,
  process.env.EDGE_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.LocalAppData && join(process.env.LocalAppData, 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);
let chrome;
for (const candidate of browserCandidates) {
  try { await stat(candidate); chrome = candidate; break; } catch { }
}
if (!chrome) {
  const message = 'SPA browser integration requires CHROME_BIN or EDGE_BIN';
  if (process.env.UPTIME_BROWSER_REQUIRED === '1') throw new Error(message);
  console.log(`SKIP ${message}`);
  process.exit(0);
}

const checkpoint = (name) => console.log(`checkpoint: ${name}`);
function bounded(promise, label, ms = 30_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const workerBundle = await build({
  entryPoints: [join(root, 'backends/worker/src/index.ts')],
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
        contents: "export default function postgres() { throw new Error('Postgres is outside this D1 fixture'); }",
      }));
    },
  }],
});
const runtimeFixtureBundle = await build({
  entryPoints: [join(root, 'test/helpers/frontend-runtime-fixture.tsx')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  jsx: 'automatic',
  tsconfig: join(root, 'frontend/tsconfig.json'), nodePaths: [join(root, 'frontend/node_modules')],
  plugins: [{ name: 'controlled-locale-catalogs', setup(builder) {
    builder.onLoad({ filter: /[\\/]i18n[\\/]IntlProvider\.tsx$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const publicGlob = "import.meta.glob<{ default: MessageTree }>(['../locales/*.json', '!../locales/en-US.json'])";
      const adminGlob = "import.meta.glob<{ default: MessageTree }>('../locales/admin/*.json')";
      if (!source.includes(publicGlob) || !source.includes(adminGlob)) throw new Error('IntlProvider catalog fixture no longer matches its source');
      return { loader: 'tsx', resolveDir: dirname(path), contents: source
        .replace(publicGlob, 'new Proxy({}, { get: (_, key) => window.fixture.catalogs[key] })')
        .replace(adminGlob, '{}') };
    });
  } }],
});
checkpoint('Worker bundle built');

const mf = new Miniflare({
  modules: true,
  script: workerBundle.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  serviceBindings: { ASSETS: { node: spaAssetService(publicDir) } },
  host: '127.0.0.1',
  port: 0,
  bindings: { ADMIN_TOKEN: 'browser-fixture-bootstrap', PBKDF2_ITERATIONS: '3000' },
  d1Databases: { DB: 'uptime-polaris-browser-fixture' },
  r2Buckets: { THEMES: 'uptime-polaris-spa-theme-fixture' },
});

let browser;
let socket;
let staticServer;
let profile;
let screenshots;
let exitCode = 1;
const browserErrors = [];
const networkFailures = [];
const networkRequests = [];
const consoleMessages = [];
const themeFlowFailures = [];

async function closeBrowser() {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (!browser || browser.exitCode !== null) return;
  browser.kill();
  await Promise.race([
    new Promise((resolveClose) => browser.once('close', resolveClose)),
    new Promise((resolveClose) => setTimeout(resolveClose, 3_000)),
  ]);
}

try {
  checkpoint('Miniflare created; awaiting isolated D1');
  const db = await bounded(mf.getD1Database('DB'), 'Miniflare D1 startup');
  checkpoint('isolated D1 opened');

  const migrationsDir = join(root, 'database/schema/d1');
  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  await applyD1Migrations(db);
  checkpoint(`isolated schema applied (${migrations.length} migrations)`);

  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO monitors
    (id, num_id, name, type, target, options_json, active, created_at, updated_at)
    VALUES (?, ?, ?, 'agent', '', ?, 1, ?, ?)`)
    .bind('00000000-0000-4000-8000-000000000001', 1, 'Unknown source fixture',
      JSON.stringify({ check_source: { type: 'agent', agent_id: '00000000-0000-4000-8000-000000000002' } }), now, now)
    .run();
  await db.prepare(`INSERT INTO monitors
    (id, num_id, name, type, target, check_ssl, check_domain, options_json, active, created_at, updated_at)
    VALUES (?, ?, ?, 'http', ?, ?, ?, '{}', 1, ?, ?)`)
    .bind('browser-warning', 2, 'Warning fixture', 'https://warning.invalid', 1, 1, now, now)
    .run();
  await db.prepare(`INSERT INTO monitors
    (id, num_id, name, type, target, options_json, active, created_at, updated_at)
    VALUES (?, ?, ?, 'http', ?, '{}', 1, ?, ?)`)
    .bind('browser-down', 3, 'Down fixture', 'https://down.invalid', now, now)
    .run();
  await db.prepare(`INSERT INTO monitors
    (id, num_id, name, type, target, options_json, active, created_at, updated_at)
    VALUES (?, ?, ?, 'http', ?, '{}', 1, ?, ?)`)
    .bind('browser-worker-stale', 4, 'Stale worker fixture', 'https://stale.invalid', now, now)
    .run();
  await db.prepare(`INSERT INTO machine_live
    (monitor_id, os, arch, cpu_model, cpu_cores, cpu_usage, mem_used, mem_total, reported_at, updated_at)
    VALUES (?, 'fixture-os', 'x86_64', 'fixture-cpu', 8, 42.3, 4294967296, 8589934592, ?, ?)`)
    .bind('00000000-0000-4000-8000-000000000001', now, now)
    .run();
  await db.prepare('INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?)')
    .bind('all', JSON.stringify({
      'browser-warning': {
        st: 2, ts: now, v: 12, code: 200, msg: '', fails: 0, source_available: true,
        ssl: { st: 2, ts: now, days: 5, msg: 'certificate expires soon' },
        domain: { st: 2, ts: now, days: 6, msg: 'domain expires soon' },
      },
      'browser-down': { st: 0, ts: now, v: null, code: 503, msg: 'fixture down', fails: 3 },
      'browser-worker-stale': { st: 1, ts: now - 600, v: 11, code: 200, msg: '', fails: 0, source_available: true },
    }), now)
    .run();
  await db.prepare('INSERT INTO heartbeat_ring (id, json, updated_at) VALUES (?, ?, ?)')
    .bind('browser-down', JSON.stringify([{ t: now, up: 0, ms: null }]), now)
    .run();
  checkpoint('source, warning, and down fixtures seeded');

  const workerOrigin = (await bounded(mf.ready, 'Miniflare server startup')).origin;
  assert.ok(workerOrigin, 'Miniflare exposes its local Worker origin');
  const workerShell = await fetch(new URL('/admin', workerOrigin));
  const workerShellHtml = await workerShell.text();
  assert.equal(workerShell.status, 200, `Worker admin shell response: ${workerShell.status} ${workerShellHtml.slice(0, 200)}`);
  assert.match(workerShellHtml, /<div id="root"><\/div>/, `Worker admin shell body: ${workerShellHtml.slice(0, 200)}`);

  staticServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__frontend-runtime') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><div id="root"></div><script type="module" src="/__frontend-runtime.js"></script>');
        return;
      }
      if (url.pathname === '/__frontend-runtime.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(runtimeFixtureBundle.outputFiles[0].text);
        return;
      }
      if (url.pathname === '/' || /^\/(?:admin|login)(?:\/|$)/.test(url.pathname) || url.pathname.startsWith('/theme/') || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const headers = new Headers(request.headers);
        headers.delete('host');
        headers.set('accept-encoding', 'identity');
        const upstream = await fetch(new URL(url.pathname + url.search, workerOrigin), {
          method: request.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }

      let file = resolve(publicDir, `.${decodeURIComponent(url.pathname)}`);
      if (file !== publicDir && !file.startsWith(publicDir + sep)) {
        response.writeHead(400).end('bad path');
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        file = join(publicDir, 'index.html');
      }
      const contentType = ({
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
      })[extname(file)] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType });
      response.end(await readFile(file));
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else response.writeHead(502).end(String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    staticServer.once('error', reject);
    staticServer.listen(0, '127.0.0.1', () => {
      staticServer.removeListener('error', reject);
      resolveListen();
    });
  });
  const browserOrigin = `http://127.0.0.1:${staticServer.address().port}`;
  for (const path of ['/', '/admin', '/login']) {
    const page = await fetch(new URL(path, browserOrigin));
    const html = await page.text();
    assert.equal(page.status, 200, `${path} should serve the built SPA shell`);
    assert.match(html, /<div id="root"><\/div>/, `${path} should contain the React root`);
  }
  checkpoint('Worker serves built assets and API from isolated D1');

  const iconResponse = await fetch(new URL('/api/public/icon', workerOrigin));
  const icon = await iconResponse.text();
  assert.equal(iconResponse.status, 200);
  assert.match(icon, /stroke="#006FEE"/i);
  assert.match(icon, /fill="none"/i);
  assert.doesNotMatch(icon, /<rect\b/i);
  checkpoint('Worker brand endpoint returns transparent blue ring');

  const profileRoot = await mkdtemp(join(tmpdir(), 'uptime-polaris-spa-chrome-'));
  profile = profileRoot;
  browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', '--remote-debugging-port=0',
    '--remote-allow-origins=*', `--user-data-dir=${profileRoot}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const activePortFile = join(profileRoot, 'DevToolsActivePort');
  let debugPort;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { debugPort = Number((await readFile(activePortFile, 'utf8')).split(/\r?\n/, 1)[0]); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  assert.ok(Number.isInteger(debugPort) && debugPort > 0, `Chrome DevTools did not start: ${stderr.slice(-1600)}`);

  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  assert.equal(targetResponse.status, 200);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await bounded(new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), 'Chrome DevTools connection');
  let sequence = 0;
  const pending = new Map();
  let failNextSession = false;
  let corruptNextMonitorPayload = false;
  let sessionFaultInjected = false;
  let renderFaultInjected = false;
  // 会话失败仅注入一次；损坏的监控响应持续到测试显式关闭开关。
  // Fail the session request once; corrupt monitor responses until the test disables the switch.
  function handleFetchPaused(message) {
    const url = message.params.request.url;
    let method = 'Fetch.continueRequest';
    let params = { requestId: message.params.requestId };
    if (failNextSession && url.includes('/api/auth/session')) {
      failNextSession = false;
      sessionFaultInjected = true;
      method = 'Fetch.failRequest';
      params.errorReason = 'Failed';
    } else if (corruptNextMonitorPayload && url.includes('/api/public/monitors')) {
      renderFaultInjected = true;
      method = 'Fetch.fulfillRequest';
      params = {
        requestId: message.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ monitorGroups: [null], data: { heartbeatList: {}, uptimeList: {} } })).toString('base64'),
      };
    }
    socket.send(JSON.stringify({ id: ++sequence, method, params }));
  }
  // 诊断事件不参与 CDP 请求配对，保留失败时所需的控制台和网络信息。
  // Diagnostic events do not resolve CDP requests; retain console and network details for failures.
  function handleRuntimeEvent(message) {
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push(message.params.args.map((item) => item.value ?? item.description ?? '').join(' '));
    }
    if (message.method === 'Network.responseReceived') {
      networkRequests.push({ url: message.params.response.url, status: message.params.response.status, headers: message.params.response.headers });
    }
    if (message.method === 'Network.loadingFailed') networkFailures.push(message.params);
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      networkFailures.push({ url: message.params.response.url, status: message.params.response.status });
    }
  }
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Fetch.requestPaused') { handleFetchPaused(message); return; }
    handleRuntimeEvent(message);
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.reject(new Error(`${task.method}: ${message.error.message}`)) : task.resolve(message.result);
  });
  // 请求 id 与响应配对，通知事件由专用处理器收集。
  // Pair requests and responses by ID; dedicated handlers collect notification events.
  const cdp = (method, params = {}) => bounded(new Promise((resolveCommand, rejectCommand) => {
    const id = ++sequence;
    pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  }), `Chrome ${method}`);
  const evaluate = async (expression) => {
    let result;
    try {
      result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    } catch (error) {
      throw new Error(`Runtime expression failed (${expression}): ${error.message}`);
    }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (error) {
        if (!String(error).includes('Inspected target navigated or closed')) throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const diagnostic = await evaluate(`({url:location.href, text:document.body.innerText.slice(0,500)})`);
    throw new Error(`Timed out waiting for ${label}; page=${JSON.stringify(diagnostic)}; browser=${browserErrors.join('; ')}; console=${consoleMessages.join('; ')}; failed=${JSON.stringify(networkFailures)}; requests=${JSON.stringify(networkRequests)}`);
  };
  const navigate = async (url, readyExpression, label) => {
    await cdp('Page.navigate', { url });
    return waitFor(readyExpression, label);
  };
  const setInput = async (selector, value) => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('Missing input ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const clickText = async (text) => evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)} && !item.disabled);
    if (!button) throw new Error('Missing enabled button: ' + ${JSON.stringify(text)});
    button.click();
    return true;
  })()`);
  /* 此控件是链接，单独查询以验证链接语义。
   * Query this control as a link to preserve its navigation semantics. */
  const clickLink = async (text) => evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((item) => item.textContent.trim() === ${JSON.stringify(text)});
    if (!link) throw new Error('Missing link: ' + ${JSON.stringify(text)});
    link.click();
    return true;
  })()`);
  const measure = () => evaluate(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, dark: document.documentElement.classList.contains('dark') })`);
  screenshots = join(root, 'artifacts', 'tmp');
  await mkdir(screenshots, { recursive: true });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await navigate(`${browserOrigin}/__frontend-runtime`, 'Boolean(window.fixture?.start)', 'React runtime fixture loaded');
  await evaluate(`(() => {
    localStorage.removeItem('uptime-polaris-locale');
    localStorage.setItem('uptime-polaris.motion', 'full');
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
    window.fixture.start();
  })()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'pending' && document.querySelector('#config-state')?.textContent === 'present:ok'`, 'real React hooks and SWR initial state');
  await evaluate(`window.fixture.nextCommandResponse = {status:503}; document.querySelector('#command-refresh').click()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'error'`, 'command refresh failure');
  await evaluate(`window.fixture.commandResponse = {status:200,commands:[{state:'completed'}]}; document.querySelector('#command-refresh').click()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'completed' && window.fixture.updates === 1`, 'pending completion after failed refresh and retry');
  await evaluate(`window.fixture.commandResponse = {status:200,commands:[{state:'pending'}]}; document.querySelector('#command-refresh').click()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'pending'`, 'new pending command');
  await evaluate(`window.fixture.commandResponse = {status:200,commands:[{state:'completed'}]}; document.querySelector('#command-agent').click()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'completed'`, 'new agent command history');
  assert.equal(await evaluate('window.fixture.updates'), 1, 'switching agents clears pending transition');
  await evaluate(`window.fixture.commandResponse = {status:200,commands:[{state:'pending'}]}; document.querySelector('#command-refresh').click()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'pending'`, 'pending before mode change');
  await evaluate(`window.fixture.commandResponse = {status:200,commands:[{state:'completed'}]}; document.querySelector('#command-mode').click()`);
  await waitFor(`document.querySelector('#command-state')?.textContent === 'completed'`, 'new mode command history');
  assert.equal(await evaluate('window.fixture.updates'), 1, 'mode switch does not report a completion');
  await evaluate(`document.querySelector('#default-fr').click(); document.querySelector('#choose-zh').click(); window.fixture.release('zh-CN')`);
  await waitFor(`document.querySelector('#locale')?.textContent === 'zh-CN'`, 'explicit locale wins over pending site default');
  await evaluate(`window.fixture.release('zh-CN')`);
  await evaluate(`window.fixture.release('fr-FR')`);
  assert.equal(await evaluate(`document.querySelector('#locale').textContent`), 'zh-CN');
  assert.equal(await evaluate(`localStorage.getItem('uptime-polaris-locale')`), 'zh-CN');
  await evaluate(`document.querySelector('#default-fr').click(); window.fixture.release('fr-FR')`);
  assert.equal(await evaluate(`document.querySelector('#locale').textContent`), 'zh-CN', 'site default cannot override saved visitor choice');

  for (const status of [503, 401, 403, 404]) {
    await evaluate(`window.fixture.configStatus = ${status}; document.querySelector('#config-refresh').click()`);
    const expected = status === 503 ? 'present:error' : 'absent:error';
    await waitFor(`document.querySelector('#config-state')?.textContent === '${expected}'`, `real SWR config refresh ${status}`);
    await evaluate(`window.fixture.configStatus = 200; document.querySelector('#config-refresh').click()`);
    await waitFor(`document.querySelector('#config-state')?.textContent === 'present:ok'`, `config recovery after ${status}`);
  }

  const brandDuration = `document.querySelector('.polaris-mark-spin')?.getAnimations()[0]?.effect?.getTiming().duration`;
  await waitFor(`${brandDuration} === 1400`, 'full motion loader animation');
  await evaluate(`document.querySelector('#motion-reduced').click()`);
  await waitFor(`${brandDuration} === 4200`, 'loader reacts to reduced motion preference');
  await evaluate(`document.querySelector('#motion-add').click()`);
  await waitFor(`document.querySelectorAll('#motion-list > *').length === 1`, 'reduced motion list item');
  assert.equal(await evaluate(`document.querySelector('#motion-list > *').getAnimations().length`), 0, 'reduced motion does not animate an inserted list item');
  await evaluate(`document.querySelector('#motion-full').click()`);
  await waitFor(`${brandDuration} === 1400`, 'loader reacts to restored motion preference');
  await evaluate(`document.querySelector('#motion-add').click()`);
  await waitFor(`document.querySelectorAll('#motion-list > *')[1]?.getAnimations().length > 0`, 'list adapter reattaches after full motion is restored');
  await waitFor(`document.querySelector('h1')?.textContent === 'Detail fixture'`, 'monitor detail with cached data');
  await evaluate(`window.fixture.monitorStatus = 503; document.querySelector('#monitor-refresh').click()`);
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(button => button.parentElement?.getAttribute('role') === 'status' && button.textContent.trim()))`, 'transient monitor failure exposes detail retry');
  assert.equal(await evaluate(`document.querySelector('h1')?.textContent`), 'Detail fixture');
  const zhPublic = JSON.parse(await readFile(join(root, 'frontend/src/locales/zh-CN.json'), 'utf8'));
  assert.ok(await evaluate(`document.body.innerText.includes(${JSON.stringify(zhPublic.timer.staleData)})`), 'stale notice identifies retained data');
  await evaluate(`window.fixture.monitorStatus = 200; [...document.querySelectorAll('button')].find(button => button.parentElement?.getAttribute('role') === 'status' && button.textContent.trim()).click()`);
  await waitFor(`!document.body.innerText.includes(${JSON.stringify(zhPublic.timer.staleData)})`, 'detail retry recovers');
  for (const status of [401, 403, 404]) {
    await evaluate(`window.fixture.monitorStatus = ${status}; document.querySelector('#monitor-refresh').click()`);
    await waitFor(`!document.querySelector('h1')`, `monitor detail hides cached data after ${status}`);
    const expected = status === 401 ? zhPublic.error.sessionExpired : status === 403 ? zhPublic.error.forbidden : zhPublic.error.notFound;
    assert.ok(await evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`), `detail displays the ${status} error`);
    await evaluate(`window.fixture.monitorStatus = 200; document.querySelector('#monitor-refresh').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'Detail fixture'`, `monitor detail recovers after ${status}`);
  }
  await evaluate(`window.fixture.monitorStatus = 503; document.querySelector('#monitor-refresh').click()`);
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(button => button.parentElement?.getAttribute('role') === 'status' && button.textContent.trim()))`, 'stale monitor before config revocation');
  await evaluate(`window.fixture.configStatus = 401; document.querySelector('#config-refresh').click()`);
  await waitFor(`!document.querySelector('h1')`, 'config access revocation takes precedence over monitor 503');
  assert.ok(await evaluate(`document.body.innerText.includes(${JSON.stringify(zhPublic.error.sessionExpired)})`), 'config access error is not masked by monitor failure');
  await evaluate(`window.fixture.monitorStatus = 200; window.fixture.configStatus = 200; document.querySelector('#monitor-refresh').click(); document.querySelector('#config-refresh').click()`);
  await waitFor(`document.querySelector('h1')?.textContent === 'Detail fixture'`, 'detail recovers from simultaneous failures');
  checkpoint('real React runtime: locale intent, command retry, SWR revocation and motion subscription');
  await cdp('Page.navigate', { url: browserOrigin });
  await waitFor(`document.readyState === 'complete'`, 'built SPA shell');
  await evaluate("localStorage.setItem('uptime-polaris-locale','en-US'); localStorage.setItem('theme','light')");
  await cdp('Page.reload');
  await waitFor(`document.readyState === 'complete'`, 'English locale reload');
  failNextSession = true;
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*api/auth/session*', requestStage: 'Request' }] });
  await cdp('Page.navigate', { url: `${browserOrigin}/admin` });
  await waitFor(`document.body.innerText.includes('Could not reach the sign-in service') && [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry')`, 'localized session retry');
  assert.equal(sessionFaultInjected, true, 'initial session request was intentionally failed');
  await clickText('Retry');
  await waitFor(`Boolean(document.querySelector('input[autocomplete="off"]') && document.querySelector('input[autocomplete="username"]') && document.querySelector('input[autocomplete="new-password"]'))`, 'account setup form after retry');
  await cdp('Fetch.disable');
  const setupText = await evaluate('document.body.innerText');
  const pageDiagnostic = await evaluate('JSON.stringify({url:location.href,title:document.title,root:document.querySelector("#root")?.innerHTML,scripts:[...document.scripts].map((s)=>s.src)})');
  const sessionDiagnostic = await evaluate('fetch("/api/auth/session").then(r=>r.text())');
  assert.match(setupText, /Create account/, `fresh D1 setup form text: ${setupText.slice(0, 500)}; page=${pageDiagnostic}; session=${sessionDiagnostic}; browser=${browserErrors.join('; ')}; console=${consoleMessages.join('; ')}; network=${JSON.stringify(networkFailures)}; requests=${JSON.stringify(networkRequests)}`);
  let layout = await measure();
  assert.ok(layout.scrollWidth <= layout.width + 1, `setup page overflows horizontally: ${JSON.stringify(layout)}`);
  checkpoint('real browser rendered setup page');

  await setInput('input[autocomplete="off"]', 'browser-fixture-bootstrap');
  await setInput('input[autocomplete="username"]', 'browser-admin');
  await setInput('input[name="password"]', 'fixture-password-123');
  await setInput('input[name="confirmPassword"]', 'different-password');
  await evaluate(`document.querySelector('form').requestSubmit()`);
  await waitFor(`document.querySelector('input[name="confirmPassword"]')?.getAttribute('aria-invalid') === 'true'`, 'password confirmation mismatch');
  assert.equal(await evaluate(`location.pathname`), '/setup', 'mismatched passwords keep setup open');
  await setInput('input[name="confirmPassword"]', 'fixture-password-123');
  await evaluate(`document.querySelector('form').requestSubmit()`);
  await waitFor(`location.pathname.startsWith('/admin') && !document.querySelector('input[autocomplete="username"]')`, 'post-setup admin');
  checkpoint('setup form completed in browser');

  const frenchMessages = JSON.parse(await readFile(join(root, 'frontend', 'src', 'locales', 'fr-FR.json'), 'utf8'));
  await evaluate("localStorage.setItem('uptime-polaris-locale','fr-FR')");
  corruptNextMonitorPayload = true;
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*api/public/monitors*', requestStage: 'Request' }] });
  await cdp('Page.navigate', { url: `${browserOrigin}/` });
  await waitFor(`document.body.innerText.includes(${JSON.stringify(frenchMessages.errorPage.title)}) && document.body.innerText.includes(${JSON.stringify(frenchMessages.errorPage.recoveryHint)})`, 'localized safe root render fallback');
  const fallbackText = await evaluate('document.body.innerText');
  assert.equal(renderFaultInjected, true, 'malformed monitor response reached the actual page');
  assert.doesNotMatch(fallbackText, /TypeError|ReferenceError| at .*\.tsx?:\d|node_modules|debug/i, 'root fallback omits private error details');
  corruptNextMonitorPayload = false;
  await cdp('Fetch.disable');
  await evaluate("localStorage.setItem('uptime-polaris-locale','en-US')");
  checkpoint('controlled render fault shows generic fallback without stack details');

  await navigate(`${browserOrigin}/`, `document.body.innerText.includes('Source unavailable') && document.body.innerText.includes('Warning fixture')`, 'public status page');
  const monitorPayload = await evaluate(`fetch('/api/public/monitors').then(r=>r.json())`);
  const publicMonitors = monitorPayload.monitorGroups.flatMap((group) => group.monitorList);
  const sourceMonitor = publicMonitors.find((item) => item.name === 'Unknown source fixture');
  const warningMonitor = publicMonitors.find((item) => item.name === 'Warning fixture');
  const staleWorker = publicMonitors.find((item) => item.name === 'Stale worker fixture');
  assert.equal(sourceMonitor.sourceAvailable, false, 'unknown agent source is unavailable');
  assert.equal(sourceMonitor.source, 'agent');
  const agentDetail = await evaluate(`fetch('/api/public/agent/detail/1?minutes=60').then(r=>r.json())`);
  assert.equal(agentDetail.monitor.type, 'agent');
  assert.equal(agentDetail.online, true);
  assert.equal(agentDetail.live.cpu_usage, 42.3);
  assert.equal(staleWorker.source, 'worker');
  assert.equal(staleWorker.sourceAvailable, false, 'stale worker reading is unavailable');
  assert.deepEqual(warningMonitor.expiryBadges.map(({ kind, status }) => [kind, status]), [['ssl', 2], ['domain', 2]]);
  assert.equal(monitorPayload.data.heartbeatList['3'].at(-1).status, 0, 'down fixture is DOWN in the real UI payload');
  assert.ok(await evaluate(`document.body.innerText.includes('SSL 5d') && document.body.innerText.includes('DOMAIN 6d')`), 'warning add-ons render their day counts');
  assert.ok(await evaluate(`document.body.innerText.includes('Down fixture')`), 'down monitor renders');
  const toneProbe = await evaluate(`(() => {
    const title = (name) => [...document.querySelectorAll('h3')].find((el) => el.textContent.trim() === name);
    const markup = (name) => { let el = title(name); const parts = []; for (let i=0; el && i<5; i++, el=el.parentElement) parts.push(el.outerHTML.slice(0, 1600)); return parts; };
    const warning = [...document.querySelectorAll('.text-warning')].find((el) => el.textContent.includes('SSL 5d'));
    const danger = [...document.querySelectorAll('.text-danger')].map((el) => ({ tag: el.tagName, className: el.getAttribute('class'), text: el.textContent.trim() }));
    return { warning: warning && { className: warning.className, text: warning.textContent }, danger, warningCard: markup('Warning fixture'), downCard: markup('Down fixture') };
  })()`);
  assert.ok(toneProbe.warning?.className.includes('warning') && toneProbe.danger.length > 0, `warning and down tones: ${JSON.stringify(toneProbe)}`);
  const publicMeasure = await measure();
  assert.ok(publicMeasure.scrollWidth <= publicMeasure.width + 1, `public page overflows: ${JSON.stringify(publicMeasure)}`);
  const measurePublicColumns = () => evaluate(`(() => {
    const shell = document.querySelector('.polaris');
    const main = shell?.querySelector('main');
    const header = shell?.querySelector('header > div');
    const footer = shell?.querySelector('footer > div');
    const boxes = [header, main, footer].map(node => node && ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width }));
    return { viewport: innerWidth, boxes };
  })()`);
  const checkPublicColumns = layout => {
    assert.equal(layout.boxes.length, 3);
    assert.ok(layout.boxes.every(Boolean), `public header, main and footer exist: ${JSON.stringify(layout)}`);
    for (const box of layout.boxes) assert.ok(box.left >= -1 && box.right <= layout.viewport + 1 && box.width <= 1121, `public column exceeds viewport or default maximum: ${JSON.stringify(layout)}`);
    assert.ok(Math.max(...layout.boxes.map(box => box.left)) - Math.min(...layout.boxes.map(box => box.left)) <= 1, `public columns share a left edge: ${JSON.stringify(layout)}`);
  };
  checkPublicColumns(await measurePublicColumns());
  const publicShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(screenshots, 'spa-public-desktop.png'), Buffer.from(publicShot.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileMeasure = await measure();
  assert.ok(mobileMeasure.scrollWidth <= mobileMeasure.width + 1, `mobile public page overflows: ${JSON.stringify(mobileMeasure)}`);
  checkPublicColumns(await measurePublicColumns());
  const mobileShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(screenshots, 'spa-public-mobile.png'), Buffer.from(mobileShot.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  checkpoint('public page rendered unknown-source state at desktop and mobile sizes');

  await evaluate(`localStorage.setItem('uptime-polaris.status.view', 'list')`);
  await navigate(`${browserOrigin}/?preview=monitor`, `Boolean([...document.querySelectorAll('a')].find(a => a.textContent.includes('Warning fixture')))`, 'preview monitor list');
  const previewMonitorLink = () => evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('Warning fixture'));
    return link && { href: link.href, className: link.className };
  })()`);
  let previewLink = await previewMonitorLink();
  assert.equal(new URL(previewLink.href).searchParams.get('pageId'), 'default');
  assert.equal(new URL(previewLink.href).searchParams.get('preview'), 'monitor');
  assert.match(previewLink.className, /grid-cols-1/, 'list row is rendered');
  await evaluate(`document.querySelector('button[aria-label="Switch to Full View"]').click()`);
  await waitFor(`Boolean([...document.querySelectorAll('a')].find(a => a.textContent.includes('Warning fixture') && a.className.includes('polaris-card')))`, 'preview monitor cards');
  previewLink = await previewMonitorLink();
  assert.equal(new URL(previewLink.href).searchParams.get('preview'), 'monitor');
  await evaluate(`([...document.querySelectorAll('a')].find(a => a.textContent.includes('Warning fixture'))).click()`);
  await waitFor(`location.pathname === '/monitor/2' && document.querySelector('h1')?.textContent === 'Warning fixture'`, 'preview monitor detail');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('preview')`), 'monitor');
  await clickText('Back to monitor list');
  await waitFor(`location.pathname === '/' && new URLSearchParams(location.search).get('preview') === 'monitor'`, 'history back retains preview');

  await navigate(`${browserOrigin}/monitor/2?pageId=default&preview=monitor`, `document.querySelector('h1')?.textContent === 'Warning fixture'`, 'direct preview detail');
  await evaluate(`history.replaceState({...history.state, idx: 0}, '')`);
  await clickText('Back to monitor list');
  await waitFor(`location.pathname === '/' && new URLSearchParams(location.search).get('preview') === 'monitor'`, 'preview detail fallback');

  checkpoint('preview navigation');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
  await navigate(`${browserOrigin}/monitor/1?pageId=default`, `Boolean(document.querySelector('svg[role="img"][aria-label="CPU: 42%"]'))`, 'agent detail CPU percentage');
  const gaugeLayout = await evaluate(`([...document.querySelectorAll('svg[role="img"]')].map((svg) => ({ label: svg.getAttribute('aria-label'), width: Math.round(svg.getBoundingClientRect().width) })))`);
  assert.equal(gaugeLayout.length, 3, `agent detail renders CPU, memory, and disk gauges: ${JSON.stringify(gaugeLayout)}`);
  assert.equal(new Set(gaugeLayout.map((gauge) => gauge.width)).size, 1, `agent gauges have equal diameter: ${JSON.stringify(gaugeLayout)}`);
  const agentMobile = await measure();
  assert.ok(agentMobile.scrollWidth <= agentMobile.width + 1, `agent detail overflows at 420px: ${JSON.stringify(agentMobile)}`);
  const agentMobileShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-agent-detail-mobile.png'), Buffer.from(agentMobileShot.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const agentDesktopShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-agent-detail-desktop.png'), Buffer.from(agentDesktopShot.data, 'base64'));
  checkpoint('agent detail keeps CPU as a percentage and three gauges aligned without overflow');

  await evaluate(`fetch('/api/auth/logout',{method:'POST'}).then(()=>location.assign('/login'))`);
  await waitFor(`location.pathname === '/login' && Boolean(document.querySelector('input[autocomplete="username"]'))`, 'login form');
  assert.equal(await evaluate(`document.body.innerText.includes('Sign in')`), true, 'login screen renders after logout');
  for (const locale of ['en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'zh-CN', 'zh-HK', 'zh-TW']) {
    const messages = JSON.parse(await readFile(join(root, 'frontend', 'src', 'locales', 'admin', `${locale}.json`), 'utf8'));
    const submit = messages.login.submit;
    assert.equal(typeof submit, 'string', `${locale} login submit label exists`);
    await evaluate(`localStorage.setItem('uptime-polaris-locale', ${JSON.stringify(locale)})`);
    await cdp('Page.reload');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(submit)})`, `${locale} login copy`);
  }
  await evaluate("localStorage.setItem('uptime-polaris-locale','en-US')");
  await cdp('Page.reload');
  await waitFor(`document.body.innerText.includes('Sign in')`, 'English login copy');
  await setInput('input[autocomplete="username"]', 'browser-admin');
  await setInput('input[autocomplete="current-password"]', 'fixture-password-123');
  await evaluate(`document.querySelector('form').requestSubmit()`);
  await waitFor(`location.pathname.startsWith('/admin') && !document.querySelector('input[autocomplete="current-password"]')`, 'authenticated admin');
  checkpoint('login form completed in browser');
  await navigate(`${browserOrigin}/admin/groups`, `document.body.innerText.includes('No groups yet')`, 'admin groups');

  for (const [mode, expectedDark] of [['light', false], ['dark', true]]) {
    await evaluate(`localStorage.setItem('theme', ${JSON.stringify(mode)})`);
    await cdp('Page.reload');
    await waitFor(`document.documentElement.classList.contains('dark') === ${expectedDark}`, `${mode} theme`);
    await waitFor(`document.body.innerText.includes('No groups yet')`, `${mode} admin content`);
    const themeShot = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(screenshots, `spa-admin-theme-${mode}.png`), Buffer.from(themeShot.data, 'base64'));
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await evaluate("localStorage.setItem('theme','system')");
  await cdp('Page.reload');
  await waitFor(`!document.documentElement.classList.contains('dark')`, 'system light theme');
  await waitFor(`document.body.innerText.includes('No groups yet')`, 'system light admin content');
  const systemLightShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-admin-theme-system-light.png'), Buffer.from(systemLightShot.data, 'base64'));
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await waitFor(`document.documentElement.classList.contains('dark')`, 'system dark theme change');
  await waitFor(`document.body.innerText.includes('No groups yet')`, 'system dark admin content');
  const systemDarkShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-admin-theme-system-dark.png'), Buffer.from(systemDarkShot.data, 'base64'));
  checkpoint('built-in light, dark, system, and OS theme changes rendered');

  await clickText('Add group');
  await waitFor(`document.querySelectorAll('input[type="text"]').length >= 1`, 'group form');
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('input[type="text"]')].at(-1);
    if (!input) throw new Error('Missing group name input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Browser fixture');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await clickText('Save');
  await waitFor(`document.querySelector('[data-sonner-toast]')?.textContent.includes('Saved')`, 'Sonner toast');
  const toastTheme = await evaluate(`document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme')`);
  assert.equal(toastTheme, 'dark', 'Sonner follows the resolved dark theme');
  const adminMeasure = await measure();
  assert.ok(adminMeasure.scrollWidth <= adminMeasure.width + 1, `admin page overflows: ${JSON.stringify(adminMeasure)}`);
  const adminShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(screenshots, 'spa-admin-desktop.png'), Buffer.from(adminShot.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const adminMobile = await measure();
  assert.ok(adminMobile.scrollWidth <= adminMobile.width + 1, `mobile admin page overflows: ${JSON.stringify(adminMobile)}`);
  /*
   * The top bar on a phone.
   *
   * The status island is deliberately absent below `lg`: there is no room for
   * it beside the wordmark and five controls, and the Monitors page leads with
   * the same information. Keeping it would mean hiding most of it again, which
   * is what the earlier attempts did and what this asserts against.
   *
   * 手机顶部栏：lg 以下有意隐藏状态岛，因为它与文字标识及五个控件并排时空间不足，
   * 而监控页开头已有相同信息。保留它最终还需隐藏大部分内容，之前的尝试正是如此；此处防止回归。
   */
  const headerMobile = JSON.parse(await evaluate(`(() => {
    const header = document.querySelector('.polaris > header');
    const island = header.querySelector('button[data-status-island]');
    const brand = header.querySelector('a');
    return JSON.stringify({
      scrollWidth: header.scrollWidth,
      clientWidth: header.clientWidth,
      height: Math.round(header.getBoundingClientRect().height),
      islandPresent: Boolean(island),
      islandVisible: island ? island.getBoundingClientRect().width > 0 : false,
      brandText: brand ? brand.textContent.trim() : null,
      docScrollWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
    });
  })()`));
  assert.ok(
    headerMobile.scrollWidth <= headerMobile.clientWidth + 1,
    `mobile admin top bar overflows: ${JSON.stringify(headerMobile)}`,
  );
  assert.ok(
    !headerMobile.islandVisible,
    `mobile admin top bar still shows the status island: ${JSON.stringify(headerMobile)}`,
  );
  assert.ok(
    headerMobile.brandText?.startsWith('uptime'),
    `mobile admin top bar lost its wordmark: ${JSON.stringify(headerMobile)}`,
  );
  assert.ok(
    headerMobile.docScrollWidth <= headerMobile.viewport + 1,
    `mobile admin page overflows: ${JSON.stringify(headerMobile)}`,
  );
  assert.ok(headerMobile.height <= 64, `mobile admin bar grew beyond one row: ${JSON.stringify(headerMobile)}`);
  const adminMobileShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(screenshots, 'spa-admin-mobile.png'), Buffer.from(adminMobileShot.data, 'base64'));

  /*
   * Chinese, because its labels are the widest of the nine locales and the
   * nine-locale loop above only ever checked the login screen. The console
   * itself was only ever measured in English.
   *
   * 选择中文，因为九种语言中其标签最宽；上方九语言循环只检查登录页，控制台此前只按英文测量。
   */
  await evaluate("localStorage.setItem('uptime-polaris-locale','zh-CN')");
  await cdp('Page.reload');
  await waitFor(`Boolean(document.querySelector('.polaris > header')) && document.body.innerText.includes('监控项')`, 'Chinese console chrome');
  const headerChinese = JSON.parse(await evaluate(`(() => {
    const header = document.querySelector('.polaris > header');
    const island = header.querySelector('button[data-status-island]');
    return JSON.stringify({
      scrollWidth: header.scrollWidth,
      clientWidth: header.clientWidth,
      height: Math.round(header.getBoundingClientRect().height),
      islandVisible: island ? island.getBoundingClientRect().width > 0 : false,
      docScrollWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
    });
  })()`));
  assert.ok(
    headerChinese.scrollWidth <= headerChinese.clientWidth + 1,
    `Chinese mobile top bar overflows: ${JSON.stringify(headerChinese)}`,
  );
  assert.ok(
    !headerChinese.islandVisible,
    `Chinese mobile top bar shows the status island: ${JSON.stringify(headerChinese)}`,
  );
  assert.ok(
    headerChinese.docScrollWidth <= headerChinese.viewport + 1,
    `Chinese mobile admin page overflows: ${JSON.stringify(headerChinese)}`,
  );

  /*
   * The capsule's panel is a desktop affordance now, so this runs at desktop
   * width: it was `absolute` inside the capsule's 152px-wide wrapper, putting
   * the 400px panel at x=-57 and clipping its left edge. `fixed` + centring on
   * the viewport is the fix.
   *
   * 状态胶囊面板现在用于桌面，因此以桌面宽度测试。此前它在宽 152px 的包装内使用 absolute，
   * 将宽 400px 的面板放在 x=-57，左边缘被裁切；改为 fixed 并相对视口居中可修复。
   */
  await evaluate("localStorage.setItem('uptime-polaris-locale','en-US'), true");
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload');
  await waitFor(`document.readyState === 'complete'`, 'desktop reload settled');
  await waitFor(`Boolean(document.querySelector('header button[data-status-island]'))`, 'desktop status island');
  await evaluate(`document.querySelector('header button[data-status-island]').click()`);
  /*
   * `[data-status-island-panel]`, not `[role="dialog"]`: HeroUI's popovers and
   * dropdowns are dialogs too, so the role alone is ambiguous once the bell or
   * the account menu has been opened.
   *
   * 使用 [data-status-island-panel] 而非 [role="dialog"]：HeroUI 的弹出框和下拉菜单也是 dialog，
   * 打开通知铃或账号菜单后，仅按 role 选择会有歧义。
   */
  await waitFor(`Boolean(document.querySelector('[data-status-island-panel]'))`, 'status panel open');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  const panelBox = JSON.parse(await evaluate(`(() => {
    const panel = document.querySelector('[data-status-island-panel]');
    const box = panel.getBoundingClientRect();
    return JSON.stringify({
      left: Math.round(box.left),
      right: Math.round(box.right),
      width: Math.round(box.width),
      height: Math.round(box.height),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    });
  })()`));
  assert.ok(panelBox.left >= 0, `status panel is clipped on the left: ${JSON.stringify(panelBox)}`);
  assert.ok(panelBox.right <= panelBox.viewportWidth + 1, `status panel runs off the right: ${JSON.stringify(panelBox)}`);
  assert.ok(panelBox.height <= panelBox.viewportHeight, `status panel is taller than the screen: ${JSON.stringify(panelBox)}`);
  // The island listens on `window`; a document-level event never reaches it.
  // 状态岛监听 window；document 级事件无法到达。
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('[data-status-island-panel]')`, 'status panel closed');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(`${browserOrigin}/admin/themes`, `document.body.innerText.includes('Installed themes') && document.body.innerText.includes('No themes installed.')`, 'empty theme manager');
  const themeId = 'spa-fixture';
  const themeUuid = '00000000-0000-4000-8000-000000000001';
  const themeFiles = {
    'polaris-theme.json': JSON.stringify({
      schema: 1,
      id: themeId,
      short: themeId,
      name: 'SPA R2 Fixture',
      version: '1.0.0',
      entry: 'dist/index.html',
      capabilities: ['public.status', 'public.config', 'public.monitors'],
      options: [
        { key: 'headline', label: 'Headline', type: 'string', default: 'fixture default' },
        { key: 'monitorRef', label: 'Monitor', type: 'monitor' },
      ],
    }),
    'dist/index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="theme-result">Loading theme data</main><script type="module" src="./theme.js"></script></body></html>',
    'dist/theme.js': `Promise.all([window.polarisTheme.read('config'),window.polarisTheme.read('status'),window.polarisTheme.read('monitors')]).then(([config,status,monitors])=>{const result={themeShort:config.theme?.short??null,headline:config.theme_settings?.headline??null,monitorRef:config.theme_settings?.monitorRef??null,statusCount:status.monitors.length,monitorCount:monitors.monitorGroups.flatMap(group=>group.monitorList).length};document.body.dataset.spaThemeResult=JSON.stringify(result);document.querySelector('#theme-result').textContent=JSON.stringify(result);parent.postMessage({type:'spa-theme-r2-result',result},'*')}).catch(error=>{document.body.dataset.spaThemeError=String(error);document.querySelector('#theme-result').textContent=String(error)})`,
  };
  const themeArchive = makeStoredZip(themeFiles);
  const themeArchiveBase64 = Buffer.from(themeArchive).toString('base64');
  await evaluate(`window.addEventListener('message',(event)=>{if(event.data?.type==='spa-theme-r2-result')window.__spaThemePreviewResult=event.data.result})`);
  await evaluate(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error('Theme ZIP input is missing');
    const binary = atob(${JSON.stringify(themeArchiveBase64)});
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'spa-r2-fixture.zip', { type: 'application/zip' }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set.call(input, transfer.files);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files[0].name;
  })()`);
  await clickText('Upload ZIP');
  await waitFor(`document.body.innerText.includes('SPA R2 Fixture') && Boolean(document.querySelector('button[aria-label="Preview this revision"]'))`, 'uploaded theme from real R2');
  const themeList = await evaluate(`fetch('/api/themes').then((response)=>response.json())`);
  assert.equal(themeList.storageReady, true, 'theme manager sees its R2 binding');
  const installedTheme = themeList.themes.find((theme) => theme.short === themeId);
  assert.ok(installedTheme?.versions.length === 1 && installedTheme.hasEntry, `installed theme revision: ${JSON.stringify(installedTheme)}`);
  const themePrefix = installedTheme.versions[0].prefix;
  assert.ok(await (await mf.getR2Bucket('THEMES')).head(`${themePrefix}/dist/index.html`), 'install stored the entry in the isolated R2 bucket');

  await clickText('Settings');
  await waitFor(`location.pathname === '/admin/themes/${themeId}' && Boolean(document.querySelector('input[type="text"]') && document.querySelector('[aria-label="Monitor"]'))`, 'installed theme configuration');
  await setInput('input[type="text"]', 'saved from admin UI');
  await evaluate(`document.querySelector('[aria-label="Monitor"]').click()`);
  await waitFor(`[...document.querySelectorAll('[role="option"]')].some((option)=>option.textContent.includes('Unknown source fixture'))`, 'UUID monitor option');
  await evaluate(`(() => [...document.querySelectorAll('[role="option"]')].find((option)=>option.textContent.includes('Unknown source fixture'))?.click())()`);
  const configShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-theme-config.png'), Buffer.from(configShot.data, 'base64'));
  await clickText('Save');
  await waitFor(`document.querySelector('[data-sonner-toast]')?.textContent.includes('Theme settings saved.')`, 'theme setting save toast');
  const savedThemeConfig = await evaluate(`fetch('/api/themes/${themeId}/config').then((response)=>response.json())`);
  assert.deepEqual(savedThemeConfig.values, { headline: 'saved from admin UI', monitorRef: themeUuid }, 'admin saved the selected monitor UUID');

  await clickLink('Back to themes');
  await waitFor(`location.pathname === '/admin/themes' && document.body.innerText.includes('SPA R2 Fixture')`, 'theme list after config save');
  const previewRequestStart = networkRequests.length;
  await evaluate(`document.querySelector('button[aria-label="Preview this revision"]').click()`);
  await waitFor(`window.__spaThemePreviewResult?.themeShort === '${themeId}'`, 'sandbox preview SDK public reads');
  const previewResult = await evaluate('window.__spaThemePreviewResult');
  assert.equal(previewResult.themeShort, themeId);
  assert.equal(previewResult.headline, 'saved from admin UI');
  assert.equal(previewResult.monitorRef, themeUuid);
  assert.equal(previewResult.statusCount, 4);
  assert.equal(previewResult.monitorCount, 4);
  const previewPaths = networkRequests.slice(previewRequestStart).map((request) => new URL(request.url).pathname);
  for (const path of ['/api/public/config', '/api/public/status', '/api/public/monitors']) {
    assert.ok(previewPaths.includes(path), `sandbox SDK called the real Worker endpoint ${path}`);
  }
  const previewConfigResponse = networkRequests.slice(previewRequestStart).find((request) => {
    const url = new URL(request.url);
    return url.pathname === '/api/public/config' && !url.searchParams.has('fresh');
  });
  assert.ok(previewConfigResponse, 'preview populated the ordinary public config cache before activation');
  assert.ok(['HIT', 'MISS'].includes(new Headers(previewConfigResponse.headers).get('x-public-cache')), 'preview uses the ordinary cached config path');
  const previewShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-theme-preview.png'), Buffer.from(previewShot.data, 'base64'));
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1408, y: 30, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1408, y: 30, button: 'left', clickCount: 1 });
  await waitFor(`!document.querySelector('iframe[title="Preview: SPA R2 Fixture"]')`, 'close sandbox preview');
  await clickText('Activate');
  await waitFor(`document.body.innerText.includes('Selected')`, 'theme activation');
  const activeShell = await fetch(new URL('/', workerOrigin));
  const activeHtml = await activeShell.text();
  assert.equal(activeShell.status, 200);
  assert.ok(activeHtml.includes(`/theme/${themePrefix}/dist/`) && activeHtml.includes('polaris-theme-sdk.js'), 'Worker serves the custom active theme shell');
  const activeConfigResponse = await fetch(new URL('/api/public/config', workerOrigin));
  const activeConfig = await activeConfigResponse.json();
  assert.notEqual(activeConfigResponse.headers.get('x-public-cache'), 'HIT', 'activation invalidated the cached built-in config');
  if (activeConfig.theme?.short !== themeId) themeFlowFailures.push(`active public config omitted theme identity: ${JSON.stringify(activeConfig.theme)}`);
  const activeSdkRequestStart = networkRequests.length;
  await navigate(`${browserOrigin}/`, `Boolean(document.body.dataset.spaThemeResult)`, 'active R2 theme shell and SDK');
  const sdkConfigRequest = networkRequests.slice(activeSdkRequestStart).find((request) => {
    const url = new URL(request.url);
    return url.pathname === '/api/public/config' && url.searchParams.get('fresh') === '1';
  });
  assert.ok(sdkConfigRequest, 'active SDK marks its config read fresh');
  const sdkConfigHeaders = new Headers(sdkConfigRequest.headers);
  assert.match(sdkConfigHeaders.get('cache-control') ?? '', /no-store/i);
  assert.equal(sdkConfigHeaders.get('x-public-cache'), null, 'active SDK cannot consume an old public-cache response');
  const activeResult = JSON.parse(await evaluate('document.body.dataset.spaThemeResult'));
  if (JSON.stringify(activeResult) !== JSON.stringify({ themeShort: themeId, headline: 'saved from admin UI', monitorRef: themeUuid, statusCount: 4, monitorCount: 4 })) {
    themeFlowFailures.push(`active theme SDK result: ${JSON.stringify(activeResult)}`);
  }
  const activeTheme = await evaluate(`fetch('/api/public/theme').then((response)=>response.json())`);
  assert.equal(activeTheme.short, themeId);
  await navigate(`${browserOrigin}/admin/themes`, `document.body.innerText.includes('Use built-in page')`, 'active theme manager');
  await clickText('Use built-in page');
  await waitFor(`document.querySelector('[data-sonner-toast]')?.textContent.includes('Built-in page restored.')`, 'theme deactivation');
  const inactiveTheme = await fetch(new URL('/api/public/theme', workerOrigin)).then((response) => response.json());
  assert.equal(inactiveTheme.short, null);
  const builtinShell = await fetch(new URL('/', workerOrigin));
  assert.match(await builtinShell.text(), /<div id="root"><\/div>/, 'deactivation restores the built-in SPA shell');
  const missingActivatedCopy = consoleMessages.find((message) => message.includes('MISSING_MESSAGE: admin.themes.activated'));
  if (missingActivatedCopy) themeFlowFailures.push('admin theme activation emitted a missing activated translation');
  checkpoint('real R2 theme upload, UUID config, sandbox API preview, activation, and built-in restore exercised');
  assert.deepEqual(themeFlowFailures, [], 'active theme contract and activation copy');

  const zhMessages = JSON.parse(await readFile(join(root, 'frontend', 'src', 'locales', 'admin', 'zh-CN.json'), 'utf8')).themes;
  const zhVisibleKeys = ['title', 'subtitle', 'installTitle', 'installHint', 'uploadZip', 'installedTitle', 'previewVersion', 'selected', 'activate', 'activated', 'settings', 'useBuiltIn', 'deactivated', 'configTitle', 'backToThemes', 'save', 'configSaved', 'previewClose'];
  for (const key of zhVisibleKeys) {
    assert.equal(typeof zhMessages[key], 'string', `zh-CN theme copy ${key} exists`);
    assert.ok(zhMessages[key].trim() && !zhMessages[key].includes('?'), `zh-CN theme copy ${key} is translated: ${JSON.stringify(zhMessages[key])}`);
  }
  await evaluate("localStorage.setItem('uptime-polaris-locale','zh-CN')");
  await cdp('Page.reload');
  await waitFor(`document.body.innerText.includes(${JSON.stringify(zhMessages.title)}) && document.body.innerText.includes(${JSON.stringify(zhMessages.installedTitle)})`, 'Chinese theme manager');
  let chineseThemeText = await evaluate('document.body.innerText');
  assert.doesNotMatch(chineseThemeText, /\?{3,}/, 'Chinese theme manager contains no question-mark placeholders');
  const chineseThemeShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-theme-zh-CN.png'), Buffer.from(chineseThemeShot.data, 'base64'));
  await clickText(zhMessages.activate);
  await waitFor(`document.querySelector('[data-sonner-toast]')?.textContent.includes(${JSON.stringify(zhMessages.activated)})`, 'Chinese theme activation toast');
  chineseThemeText = await evaluate('document.body.innerText');
  assert.doesNotMatch(chineseThemeText, /\?{3,}/, 'Chinese activation state contains no question-mark placeholders');
  const activatedChineseShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-theme-zh-CN-activated.png'), Buffer.from(activatedChineseShot.data, 'base64'));
  await clickText(zhMessages.useBuiltIn);
  await waitFor(`document.querySelector('[data-sonner-toast]')?.textContent.includes(${JSON.stringify(zhMessages.deactivated)})`, 'Chinese theme deactivation toast');
  chineseThemeText = await evaluate('document.body.innerText');
  assert.doesNotMatch(chineseThemeText, /\?{3,}/, 'Chinese deactivation state contains no question-mark placeholders');
  const deactivatedChineseShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-theme-zh-CN-deactivated.png'), Buffer.from(deactivatedChineseShot.data, 'base64'));
  checkpoint('Chinese theme management, activation toast, and deactivation toast rendered');

  /* 检查输入与包装器的最终焦点样式，避免双重轮廓或丢失焦点反馈。
   * Check computed input and wrapper focus styles for duplicate outlines or missing focus feedback. */
  await navigate(`${browserOrigin}/admin/settings`, `location.pathname === '/admin/settings' && Boolean(document.querySelector('[data-slot="input-wrapper"]'))`, 'settings page');
  /* 实际点击触发 HeroUI 的焦点事件；仅调用 focus 不覆盖同一路径。
   * Click to trigger HeroUI focus events; focus() alone does not exercise the same path. */
  const fieldPoint = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((el) => el.type === 'text' && el.getBoundingClientRect().width > 40);
    if (!input) return null;
    input.scrollIntoView({ block: 'center' });
    const rect = input.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  assert.ok(fieldPoint, 'settings page has a text field to focus');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x: fieldPoint.x, y: fieldPoint.y, button: 'left', clickCount: 1 });
  }
  // Wait for HeroUI to finish its focus transition before reading the styles.
  // 等待 HeroUI 完成焦点过渡后再读取样式。
  await waitFor(`document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('[data-slot="input-wrapper"]')?.getAttribute('data-focus') === 'true'`, 'settings field focus state');
  const fieldFocus = await evaluate(`(() => {
    const input = document.activeElement;
    const style = getComputedStyle(input);
    const wrapper = input.closest('[data-slot="input-wrapper"]');
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    return {
      focusVisible: input.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      wrapperBoxShadow: wrapperStyle?.boxShadow ?? null,
      wrapperDataFocus: wrapper?.getAttribute('data-focus') ?? null,
    };
  })()`);
  /*
   * The ring rules key on `:focus-visible`, so the field has to actually match
   * it or the assertions below prove nothing about the focus state.
   * 焦点框规则依赖 :focus-visible；字段必须实际匹配，下方断言才对焦点状态有意义。
   */
  assert.equal(fieldFocus.focusVisible, true, 'clicked settings field matches :focus-visible');
  /* 依据计算后的样式、宽度和透明度判断轮廓是否可见。
   * Determine outline visibility from computed style, width, and opacity. */
  const outlineAlpha = Number((/rgba?\(([^)]+)\)/.exec(fieldFocus.outlineColor)?.[1] ?? '').split(',').map((part) => part.trim()).at(-1));
  const outlineVisible = fieldFocus.outlineStyle !== 'none'
    && !/^0(?:px)?$/.test(fieldFocus.outlineWidth ?? '')
    && !(Number.isFinite(outlineAlpha) && outlineAlpha === 0);
  assert.equal(
    outlineVisible,
    false,
    `focused settings input must not paint an outline of its own, got style=${fieldFocus.outlineStyle} width=${fieldFocus.outlineWidth} colour=${fieldFocus.outlineColor}`,
  );
  /*
   * The wrapper keeps the focus feedback. HeroUI marks a focused field with
   * `data-focus="true"` on the wrapper (not `data-focus-visible`, which it never
   * sets), and that wrapper's ring is what the operator should see instead.
   * 包装器保留焦点反馈。HeroUI 在聚焦字段的包装器上设置 data-focus="true"，
   * 不会设置 data-focus-visible；操作员应看到包装器的焦点框。
   */
  assert.equal(fieldFocus.wrapperDataFocus, 'true', 'focused settings field wrapper carries data-focus');
  assert.ok(
    fieldFocus.wrapperBoxShadow && fieldFocus.wrapperBoxShadow !== 'none',
    `focused settings field wrapper must keep its own ring, got ${fieldFocus.wrapperBoxShadow}`,
  );
  const focusedFieldShot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(screenshots, 'spa-settings-field-focus.png'), Buffer.from(focusedFieldShot.data, 'base64'));
  checkpoint('settings field focus paints one ring on the wrapper, none inside the input');

  assert.deepEqual(browserErrors, [], `browser runtime errors: ${browserErrors.join('; ')}`);
  checkpoint('Sonner toast rendered; desktop/mobile admin layout measured');
  console.log(`screenshots: ${screenshots}`);
  exitCode = 0;
} catch (error) {
  console.error(`browser integration failed after last checkpoint: ${error.stack ?? error}`);
} finally {
  await closeBrowser();
  if (staticServer?.listening) await new Promise((resolveClose) => staticServer.close(resolveClose));
  try { await bounded(mf.dispose(), 'Miniflare disposal', 10_000); }
  catch (error) { console.error(`cleanup checkpoint: ${error.message}`); exitCode = 1; }
  if (profile) {
    const resolvedProfile = await realpath(profile);
    const tempRoot = await realpath(tmpdir());
    const rel = relative(tempRoot, resolvedProfile);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`refusing to remove Chrome profile outside temp: ${profile}`);
    await rm(resolvedProfile, { recursive: true, force: true });
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}
