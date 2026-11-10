// 通过浏览器验证机器编辑、更新指令和批量操作。
// Use a browser to check machine editing, upgrade commands, and batch actions.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';
import { spaAssetService } from '../helpers/spa-assets.mjs';

// Isolated Worker/D1 serves real APIs; a local HTTP proxy serves assets and injects failures.
// 隔离 Worker/D1 承载真实 API，本地 HTTP 代理提供网页并注入失败响应。
const owner = crypto.randomUUID();
const profile = await mkdtemp(join(tmpdir(), 'polaris-agent-controls-'));
await writeFile(join(profile, '.owner'), owner);
const bundle = await build({ entryPoints: ['backends/worker/src/index.ts'], bundle: true, write: false, format: 'esm', target: 'es2022', plugins: workerBundlePlugins(), logLevel: 'error' });
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text, host: '127.0.0.1', port: 0,
  compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  bindings: { ADMIN_TOKEN: 'agent-browser-admin' },
  serviceBindings: { ASSETS: { node: spaAssetService(resolve('public')) } },
});
let browser;
let socket;
let closed;
let staticServer;
let sequence = 0;
const waiting = new Map();
const writes = [];
// Each armed switch returns one 503 and resets so the retry reaches the real API.
// 开关命中一次即返回 503 并复位，供后续重试走真实 API。
let rejectActive = true;
let rejectProbe = false;
let rejectDeleteId = null;
const deletedRequests = [];
const nativeDialogs = [];
const browserErrors = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// Match CDP replies by request ID; the message listener below collects events separately.
// CDP 响应按请求 id 配对，事件由下方消息监听器另行收集。
const command = (method, params = {}) => new Promise((resolveCommand, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
  waiting.set(id, { method, resolve: (result) => { clearTimeout(timer); resolveCommand(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
// Return serialized page values and propagate page-side JavaScript exceptions.
// 按值返回页面结果，并将页面 JavaScript 异常抛给测试。
const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
// Retry transient navigation-context errors; propagate other evaluation errors.
// 导航会短暂销毁执行上下文；其他执行错误直接使测试失败。
const until = async (expression) => {
  for (let i = 0; i < 160; i++) {
    try { if (await evaluate(expression)) return; }
    catch (error) { if (!/context.*destroyed|Cannot find context|Inspected target navigated/i.test(error.message)) throw error; }
    await pause(100);
  }
  console.error(JSON.stringify(await evaluate('({url:location.href,title:document.title,text:document.body.textContent.slice(0,1800)})')));
  console.error(JSON.stringify(browserErrors.slice(-10)));
  throw new Error(`Condition timed out: ${expression}`);
};

try {
  const workerOrigin = (await mf.ready).origin;
  const setup = await mf.dispatchFetch(workerOrigin + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'agent-browser-admin', username: 'agent-ui-test', password: 'agent-ui-password' }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const db = await mf.getD1Database('DB');
  const create = await mf.dispatchFetch(workerOrigin + '/api/admin/agents', {method:'POST',headers:{authorization:'Bearer agent-browser-admin','content-type':'application/json'},body:JSON.stringify({ name: 'Agent fixture' })});
  assert.equal(create.status,201,await create.clone().text());
  const agent = await create.json();
  const currentConfiguration = { sample_interval_secs: 5, report_interval_secs: 60, include_nics: ['eth0'], exclude_nics: ['lo'], include_mounts: ['/'], exclude_mounts: [], auto_update: false };
  const installation = { service_tier: 'systemd', config_path: '/etc/polaris-agent/config.json', executable_path: '/usr/local/bin/polaris-agent', auto_update_supported: true };
  // Simulate Agent config reports and revision acknowledgments, separating desired and reported state.
  // 模拟 Agent 上报实际配置及修订确认，区分期望值与已生效值。
  const reportConfiguration = async (config, revision = null) => {
    const response = await mf.dispatchFetch(workerOrigin + '/api/public/agent/config/' + agent.token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, revision, installation }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  await reportConfiguration(currentConfiguration);
  await db.prepare("INSERT INTO machine_live(agent_id,os,arch,kernel,cpu_model,cpu_cores,public_ip,region,isp,version,transport,report_interval_secs,probe_capabilities,reported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(agent.id,'linux','x86_64','6.8.0','Fixture CPU',4,'192.0.2.40','CN','Fixture ISP','0.2.0','http',60,JSON.stringify(['commands']),Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).run();
  const settings = await mf.dispatchFetch(workerOrigin + '/api/admin/settings', { method: 'PUT', headers: { authorization: 'Bearer agent-browser-admin', 'content-type': 'application/json' }, body: JSON.stringify({ 'security.allowAgentCommands': true }) });
  assert.equal(settings.status, 200, await settings.clone().text());
  const catalog = JSON.parse(await readFile('frontend/src/locales/admin/zh-CN.json','utf8'));
  const assets = spaAssetService(resolve('public'));
  staticServer = createServer(async (request, response) => {
    try {
      if (request.method === 'DELETE' && request.url.endsWith('/' + rejectDeleteId)) {
        rejectDeleteId = null;
        response.writeHead(503, {'content-type':'application/json'}).end(JSON.stringify({error:'db_unavailable'}));
        return;
      }
      if (request.method==='POST' && request.url.endsWith('/active') && rejectActive) {
        rejectActive=false;
        response.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'db_unavailable'}));
        return;
      }
      if (request.method==='POST' && request.url.endsWith('/probe') && rejectProbe) {
        rejectProbe=false;
        response.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'db_unavailable'}));
        return;
      }
      if (!request.url.startsWith('/api/')) return await assets(request, response);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.set('accept-encoding', 'identity');
      const upstream = await fetch(workerOrigin + request.url, {
        method: request.method, headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else response.writeHead(502).end(String(error));
    }
  });
  await new Promise((done) => staticServer.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${staticServer.address().port}`;
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--window-size=1440,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  closed = new Promise((done) => browser.once('exit', done));
  let port;
  for (let i = 0; i < 120; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await pause(100); } }
  assert.ok(port);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') browserErrors.push(message.params.args.map((item) => item.value ?? item.description));
    if (message.method === 'Network.requestWillBeSent' && ['POST','PUT'].includes(message.params.request.method) && /\/(rename|active|probe|commands|config)$/.test(message.params.request.url)) writes.push(message.params.request.url);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.method === 'DELETE') deletedRequests.push(message.params.request.url);
    // Dismiss native dialogs to avoid blocking; the final assertion still requires none to have opened.
    // 取消原生确认框以免阻塞测试，最后仍断言页面从未打开过它们。
    if (message.method === 'Page.javascriptDialogOpening') {
      nativeDialogs.push(message.params);
      socket.send(JSON.stringify({id:++sequence,method:'Page.handleJavaScriptDialog',params:{accept:false}}));
    }
    if (!message.id) return;
    const handler = waiting.get(message.id);
    if (!handler) return;
    waiting.delete(message.id);
    message.error ? handler.reject(new Error(handler.method + ': ' + message.error.message)) : handler.resolve(message.result);
  });
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const click = (label, scope='document') => evaluate(`[...${scope}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
  const dialog = "document.querySelector('[role=dialog]')";
  const probeInput = `${dialog}.querySelector('input[name=probe_enabled]')`;
  const readProbeEnabled = async () => JSON.parse((await db.prepare('SELECT options_json FROM monitors WHERE id=?').bind(agent.id).first()).options_json).probe_enabled !== false;
  // Existing rows may belong to the old page; require a new document before accepting them.
  // 旧页面也可能已有表格行，须先用标记确认新文档已加载。
  const reload = async () => {
    const marker = crypto.randomUUID();
    await evaluate(`window.__agentReloadMarker=${JSON.stringify(marker)}`);
    await command('Page.reload');
    await until(`window.__agentReloadMarker!==${JSON.stringify(marker)} && !!document.querySelector('tbody tr')`);
  };
  const openEdit = async () => {
    await evaluate(`document.querySelector('tbody button[aria-label=${JSON.stringify(catalog.agents.editTitle)}]').click()`);
    await until(`!!${dialog}?.querySelector('input[maxlength="200"]') && !!${dialog}.querySelector('input[name=sample_interval_secs]')`);
  };
  await command('Page.navigate', { url: origin + '/login' });
  await until('!!document.querySelector("input[autocomplete=username]")');
  assert.equal(await evaluate("fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'agent-ui-test',password:'agent-ui-password'})}).then(response=>response.status)"),200);
  await command('Page.navigate',{url:origin+'/admin/agents'});
  await until("!!document.querySelector('tbody tr')");
  await evaluate(`document.querySelector('tbody button[aria-label=${JSON.stringify(catalog.agents.viewDetail)}]').click()`);
  await until(`!!${dialog} && ${dialog}.textContent.includes(${JSON.stringify(catalog.agents.sectionInterfaces)})`);
  assert.equal(await evaluate(`${dialog}.textContent.includes(${JSON.stringify(catalog.agents.sectionInstall)})`),false);
  assert.equal(await evaluate(`${dialog}.querySelectorAll('[role=switch]').length`),0);
  const heights = await evaluate(`[...${dialog}.querySelectorAll('section')].filter(section=>[...${JSON.stringify([catalog.agents.sectionIdentity,catalog.agents.sectionNetwork])}].includes(section.querySelector('h3')?.textContent)).map(section=>({height:section.getBoundingClientRect().height,rows:section.querySelectorAll('dt').length}))`);
  assert.equal(heights.length,2);
  assert.deepEqual(heights.map(section=>section.rows),[5,5]);
  assert.ok(Math.abs(heights[0].height-heights[1].height)<2);
  assert.equal(await evaluate(`${dialog}.textContent.includes(${JSON.stringify(catalog.agents.fieldPublicIpv6)})`),true);
  await click(catalog.agents.close,dialog);
  await until(`!${dialog}`);
  console.log('PASS Agent detail: network includes IPv6, installation settings moved out');

  await openEdit();
  assert.equal(await evaluate(`${dialog}.querySelector('input[name=sample_interval_secs]').value`),'5');
  assert.equal(await evaluate(`${dialog}.querySelectorAll('code').length`),0);
  assert.equal(await evaluate(`${dialog}.textContent.includes(${JSON.stringify(catalog.agent.howToInstall)})`),false);
  await click(catalog.agents.reinstall,dialog);
  const topDialog = "[...document.querySelectorAll('[role=dialog]')].at(-1)";
  const builds = await fetch(origin + '/api/public/agent/capabilities').then(response=>response.json());
  await until(`${topDialog}.querySelectorAll('code').length===${builds.platforms.length} && ${builds.platforms.length}>0`);
  for(const platform of builds.platforms) assert.ok((await evaluate(`${topDialog}.textContent`)).includes(platform.key));
  await click(catalog.agents.close,topDialog);
  await until("document.querySelectorAll('[role=dialog]').length===1");
  console.log('PASS Agent configuration: actual reported values, inline install command removed, reinstall opens all packaged platform commands');
  assert.equal(await evaluate(`document.getElementById(${probeInput}.getAttribute('aria-labelledby')).textContent`),catalog.agents.probeEnabled);
  assert.equal(await evaluate(`${probeInput}.checked`),true);
  await evaluate(`${probeInput}.click()`);
  assert.equal(writes.filter(url=>url.endsWith('/probe')).length,0);
  await click(catalog.agents.cancel,dialog);
  await until(`!${dialog}`);
  assert.equal(await readProbeEnabled(),true);
  await openEdit();
  assert.equal(await evaluate(`${probeInput}.checked`),true);
  await evaluate(`${probeInput}.click()`);
  const editorText = await evaluate(`${dialog}.textContent`);
  for (const text of [catalog.agent.howToInstall,catalog.agent.upgradeCommand,catalog.agent.diskScope,catalog.agent.installNote,'ws://','可用版本：','最新版本：']) assert.ok(!editorText.includes(text),text);
  await evaluate(`(()=>{for(const [name,value] of Object.entries({sample_interval_secs:'10',report_interval_secs:'120'})){const input=${dialog}.querySelector('input[name='+name+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await evaluate(`(()=>{const input=${dialog}.querySelector('input[maxlength="200"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Renamed fixture');input.dispatchEvent(new Event('input',{bubbles:true}));${dialog}.querySelector('input[type=checkbox]').click();})()`);
  await click(catalog.action.save,dialog);
  await until(`${dialog}?.textContent.includes(${JSON.stringify(catalog.agents.savePartial)})`);
  assert.equal((await db.prepare('SELECT name FROM monitors WHERE id=?').bind(agent.id).first()).name,'Renamed fixture');
  assert.equal(await readProbeEnabled(),false);
  const desired = await fetch(workerOrigin + '/api/admin/agents/' + agent.id + '/config',{headers:{authorization:'Bearer agent-browser-admin'}}).then(response=>response.json());
  assert.equal(desired.status,'pending');
  assert.deepEqual(desired.current,currentConfiguration);
  assert.equal(desired.desired.sample_interval_secs,10);
  await reportConfiguration(desired.desired,desired.desired_revision);
  await until(`${dialog}.textContent.includes(${JSON.stringify(catalog.agents.configSynced)})`);
  await click(catalog.action.save,dialog);
  await until(`!${dialog}`);
  assert.equal((await db.prepare('SELECT active FROM monitors WHERE id=?').bind(agent.id).first()).active,0);
  assert.equal(writes.filter(url=>url.endsWith('/rename')).length,1);
  assert.equal(writes.filter(url=>url.endsWith('/probe')).length,1);
  assert.equal(writes.filter(url=>url.endsWith('/config')).length,1);
  console.log('PASS Agent editor: probe changes save with name/lifecycle, cancellation discards changes, partial retry skips successful fields');

  await evaluate(`document.querySelector('tbody button[aria-label=${JSON.stringify(catalog.agents.viewDetail)}]').click()`);
  await until(`!!${dialog} && ${dialog}.textContent.includes(${JSON.stringify(catalog.agents.probeDisabledHint)})`);
  assert.equal(await evaluate(`${dialog}.querySelectorAll('[role=switch]').length`),0);
  await click(catalog.agents.close,dialog);
  await until(`!${dialog}`);
  await openEdit();
  assert.equal(await evaluate(`${probeInput}.checked`),false);
  rejectProbe=true;
  await evaluate(`${probeInput}.click()`);
  await click(catalog.action.save,dialog);
  await until(`!!${dialog}?.querySelector('[role=alert]') && ![...${dialog}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(catalog.action.save)}).disabled`);
  assert.equal(await evaluate(`${probeInput}.checked`),true);
  assert.equal(await readProbeEnabled(),false);
  await click(catalog.action.save,dialog);
  await until(`!${dialog}`);
  assert.equal(await readProbeEnabled(),true);
  console.log('PASS Agent probe setting: read-only detail shows disabled status, failed save retains switch value for retry');

  await db.prepare('UPDATE monitors SET active=1 WHERE id=?').bind(agent.id).run();
  await reload();
  const versionButton = `[...document.querySelectorAll('tbody button[aria-label]')].find(button=>button.getAttribute('aria-label').includes('Renamed fixture')&&button.getBoundingClientRect().height>0)`;
  await evaluate(versionButton+'.click()');
  await until(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()===${JSON.stringify(catalog.agents.commandUpgrade)}&&!button.disabled)`);
  await writeFile('artifacts/tmp/agent-upgrade-desktop.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await click(catalog.agents.commandUpgrade);
  await until(`document.body.textContent.includes(${JSON.stringify(catalog.agents.updateInProgress)})`);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE agent_id=? AND action='upgrade'").bind(agent.id).first()).n,1);
  await db.prepare("UPDATE agent_commands SET state='completed',ok=1,completed_at=? WHERE agent_id=?").bind(Math.floor(Date.now()/1000),agent.id).run();
  await db.prepare("UPDATE machine_live SET version='0.4.0',reported_at=? WHERE monitor_id=?").bind(Math.floor(Date.now()/1000),agent.id).run();
  await until(`document.body.textContent.includes(${JSON.stringify(catalog.agents.commandOk)}) && document.querySelector('tbody').textContent.includes('0.4.0')`);
  console.log('PASS Agent upgrade: version popover queues one command and reflects completion and refreshed version');
  await reload();
  await openEdit();
  assert.equal(await evaluate(`${probeInput}.checked`),true);
  assert.equal(await evaluate(`${dialog}.querySelector('input[name=sample_interval_secs]').value`),'10');
  await writeFile('artifacts/tmp/agent-editor-desktop.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  assert.equal(await evaluate(`${dialog}.querySelector('input[type=checkbox]').closest('label').lastElementChild.getBoundingClientRect().height<=22`),true);
  await writeFile('artifacts/tmp/agent-editor-mobile.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await click(catalog.agents.cancel,dialog);
  await until(`!${dialog}`);
  await evaluate(versionButton+'.click()');
  await until(`document.body.textContent.includes(${JSON.stringify(catalog.agent.latestVersion.replace('{version}','0.4.0'))})`);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  console.log('PASS Agent controls: mobile editor and version popover stay within viewport');

  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const extras=[];
  for(const [name,version] of [['Current Agent','0.4.0'],['Old Agent','0.3.0']]) {
    const response=await mf.dispatchFetch(workerOrigin+'/api/admin/agents',{method:'POST',headers:{authorization:'Bearer agent-browser-admin','content-type':'application/json'},body:JSON.stringify({ name })});
    assert.equal(response.status,201);
    const extra=await response.json(); extras.push(extra);
    await db.prepare('INSERT INTO machine_live(agent_id,version,probe_capabilities,report_interval_secs,reported_at,updated_at) VALUES(?,?,?,?,?,?)').bind(extra.id,version,JSON.stringify(['commands']),60,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).run();
  }
  await reload();
  const rowFor=(name)=>`[...document.querySelectorAll('tbody tr')].find(row=>[...row.querySelectorAll('button')].some(button=>button.textContent.trim()===${JSON.stringify(name)}))`;
  await evaluate(`${rowFor('Current Agent')}.querySelector('button[aria-label=${JSON.stringify(catalog.agents.remove)}]').click()`);
  await until(`!!${dialog} && ${dialog}.textContent.includes('Current Agent')`);
  assert.equal(await evaluate(`${dialog}.querySelectorAll('li').length`),1);
  assert.equal(deletedRequests.length,0);
  await click(catalog.action.cancel,dialog);
  await until(`!${dialog}`);
  await evaluate(`${rowFor('Current Agent')}.querySelector('input[type=checkbox]').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()===${JSON.stringify(catalog.agents.commandUpgrade)})`),false);
  await evaluate(`${rowFor('Old Agent')}.querySelector('input[type=checkbox]').click()`);
  await until(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()===${JSON.stringify(catalog.agents.commandUpgrade)})`);
  await click(catalog.agents.commandUpgrade);
  await until(`!!${dialog}`);
  assert.ok((await evaluate(`${dialog}.textContent`)).includes('Old Agent'));
  await click(catalog.action.cancel,dialog);
  await until(`!${dialog}`);
  await click(catalog.agents.batchRemove);
  await until(`!!${dialog}`);
  assert.deepEqual(await evaluate(`[...${dialog}.querySelectorAll('li p:first-child')].map(item=>item.textContent)`),['Current Agent','Old Agent']);
  assert.equal(deletedRequests.length,0);
  await writeFile('artifacts/tmp/agent-delete-confirm.png',Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  rejectDeleteId=extras[1].id;
  await click(catalog.action.delete,dialog);
  await until(`!!${dialog}?.querySelector('[role=alert]')`);
  assert.equal(await evaluate(`${dialog}.querySelectorAll('li').length`),1);
  assert.ok((await evaluate(`${dialog}.textContent`)).includes('Old Agent'));
  await click(catalog.action.delete,dialog);
  await until(`!${dialog}`);
  assert.equal(deletedRequests.length,3);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM monitors WHERE id IN (?,?)').bind(extras[0].id,extras[1].id).first()).n,0);
  assert.deepEqual(nativeDialogs,[]);
  console.log('PASS Agent batch controls: upgrades hidden for current versions, custom single/bulk delete confirmation lists exact targets, partial delete retries only failures');
  await command('Page.navigate',{url:origin+'/admin/settings#settings-account'});
  await until("!!document.querySelector('input[autocomplete=new-password]')");
  assert.ok(await evaluate("!!document.querySelector('input[autocomplete=new-password]').closest('[data-slot=input-wrapper]').querySelector('svg')"));
  console.log('PASS Account settings: new password field includes its leading icon');
  assert.deepEqual(browserErrors,[]);
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
  if (browser) { await Promise.race([closed, pause(4000)]); if (browser.exitCode === null) browser.kill(); }
  socket?.close();
  if (staticServer) {
    staticServer.closeAllConnections();
    await new Promise((done) => staticServer.close(done));
  }
  await mf.dispose();
  const child = relative(resolve(tmpdir()), resolve(profile));
  if (!child.startsWith('polaris-agent-controls-') || child.includes(sep) || await readFile(join(profile, '.owner'), 'utf8') !== owner) throw new Error('Refusing to remove an unowned browser profile');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
