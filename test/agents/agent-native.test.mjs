// 使用实际 Agent 二进制验证上报、指令和传输恢复。
// Use an Agent binary to check reporting, commands, and transport recovery.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

if (process.platform !== 'win32') {
  const message = 'native agent acceptance requires Windows';
  if (process.env.UPTIME_AGENT_NATIVE_REQUIRED === '1') throw new Error(message);
  console.log(`SKIP ${message}`);
  process.exit(0);
}

const root = process.cwd();
const defaultTargetDir = join(root, 'agent', 'target');
const binary = process.env.AGENT_NATIVE_BINARY ?? join(process.env.CARGO_TARGET_DIR ?? defaultTargetDir, 'debug', 'polaris-agent.exe');
if (!existsSync(binary) && !process.env.AGENT_NATIVE_BINARY) {
  const message = `native agent acceptance requires a compiled agent: ${binary}`;
  if (process.env.UPTIME_AGENT_NATIVE_REQUIRED === '1') throw new Error(message);
  console.log(`SKIP ${message}`);
  process.exit(0);
}
const privateDir = join(tmpdir(), `uptime-polaris-native-${process.pid}`);
const pfxPath = join(privateDir, 'fixture.pfx');
const configPath = join(privateDir, 'agent-config.json');
const pfxPassword = 'uptime-polaris-native-fixture';
const versionResult = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(versionResult.status, 0, versionResult.error?.message ?? versionResult.stderr);
const expectedVersion = versionResult.stdout.trim().match(/^polaris-agent (\S+)$/)?.[1];
assert.ok(expectedVersion, 'Agent binary must report its version');
const adminToken = 'native-fixture-admin-token';
const logs = [];
let mf;
let agent;
let statusServer;
let tcpServer;
let tlsServer;
let proxyServer;
let workerOrigin;
let proxyForwards = 0;
let exitCode = 1;

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen(server.address().port);
    });
  });
}

async function waitFor(label, read, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(250);
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(last)}`);
}

function makePfx() {
  mkdirSync(privateDir, { recursive: true });
  const escapedPath = pfxPath.replaceAll("'", "''");
  const script = [
    "$rsa = [System.Security.Cryptography.RSA]::Create(2048)",
    "$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))",
    `[IO.File]::WriteAllBytes('${escapedPath}', $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${pfxPassword}'))`,
    "$cert.Dispose(); $rsa.Dispose()",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, `fixture certificate generation failed: ${result.stderr}`);
}

const harness = `
import { api } from './backends/worker/src/api';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
const workerErrors = [];
const reportError = console.error.bind(console);
console.error = (...args) => { workerErrors.push(args.join(' ')); reportError(...args); };
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/__fault') {
    const body = await request.json();
    await env.DB.prepare('UPDATE native_fixture_state SET reject_upgrade = ?, reject_results = ? WHERE id = 1')
      .bind(body.upgrade === true ? 1 : 0, body.results === true ? 1 : 0).run();
    return Response.json({ ok: true });
  }
  if (url.pathname === '/__tick') {
    const tick = await runTick(env, Math.floor(Date.now() / 1000));
    return Response.json({ ok: true, tick: tick.status, reason: tick.status === 'skipped' ? tick.reason : undefined });
  }
  if (url.pathname.startsWith('/api/public/agent/') && request.headers.get('Upgrade') === 'websocket') {
    await env.DB.prepare('UPDATE native_fixture_state SET upgrade_attempts = upgrade_attempts + 1 WHERE id = 1').run();
    const fault = await env.DB.prepare('SELECT reject_upgrade FROM native_fixture_state WHERE id = 1').first();
    if (fault?.reject_upgrade) {
      await env.DB.prepare('UPDATE native_fixture_state SET upgrade_blocked = upgrade_blocked + 1 WHERE id = 1').run();
      return new Response('fixture upgrade blocked', { status: 503 });
    }
  }
  if (url.pathname.includes('/results/') && request.method === 'POST') {
    await env.DB.prepare('UPDATE native_fixture_state SET result_attempts = result_attempts + 1 WHERE id = 1').run();
    const fault = await env.DB.prepare('SELECT reject_results FROM native_fixture_state WHERE id = 1').first();
    if (fault?.reject_results) return new Response('fixture result retry', { status: 503 });
  }
  if (url.pathname.includes('/push/') && request.method === 'POST') {
    await env.DB.prepare('UPDATE native_fixture_state SET push_attempts = push_attempts + 1 WHERE id = 1').run();
  }
  if (url.pathname === '/__state') {
    const db = env.DB;
    const agents = await db.prepare('SELECT id, token FROM agents').all();
    const live = await db.prepare('SELECT agent_id, reported_at, version, probe_capabilities, transport FROM machine_live').all();
    const jobs = await db.prepare('SELECT run_id, monitor_id, state, observed_at, status, status_code, message, consumed_at, addons_json FROM agent_probe_jobs').all();
    // Remote-command history, so the acceptance test can assert the real agent
    // executed what the Worker sent rather than only that it was queued.
    // 记录远程命令历史，验证实际 Agent 执行了 Worker 下发的命令，而非仅检查入队。
    const commands = await db.prepare('SELECT id, agent_id, action, state, ok, message, issued_by FROM agent_commands').all();
    const heartbeats = await db.prepare("SELECT json FROM live_state WHERE id = 'all'").first();
    const fixture = await db.prepare('SELECT result_attempts, reject_upgrade, upgrade_attempts, upgrade_blocked, push_attempts FROM native_fixture_state WHERE id = 1').first();
    return Response.json({ agents: agents.results, live: live.results, jobs: jobs.results, commands: commands.results, heartbeats: heartbeats?.json ?? null, resultAttempts: fixture.result_attempts, upgradeFault: fixture.reject_upgrade, upgradeAttempts: fixture.upgrade_attempts, upgradeBlocked: fixture.upgrade_blocked, pushAttempts: fixture.push_attempts, workerErrors });
  }
  return api.fetch(request, env, ctx);
} };
`;

async function startWorker() {
  const bundled = await build({
    stdin: { contents: harness, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
    external: ['cloudflare:sockets'], logLevel: 'error',
    plugins: [{ name: 'stub-postgres', setup(builder) {
      builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'pg-stub', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export default function postgres() { throw new Error('postgres unavailable in D1 fixture'); }" }));
    } }],
  });
  mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    bindings: { CF_ACCOUNT_ID: 'isolated', CF_API_TOKEN: 'isolated', ADMIN_TOKEN: adminToken },
    analyticsEngineDatasets: { UPTIME: { dataset: 'setup_fixture' } }, d1Databases: { DB: 'native-agent-acceptance' },
  });
  const origin = (await mf.ready).origin;
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  await db.exec('CREATE TABLE native_fixture_state (id INTEGER PRIMARY KEY, reject_upgrade INTEGER NOT NULL, reject_results INTEGER NOT NULL, result_attempts INTEGER NOT NULL, upgrade_attempts INTEGER NOT NULL, upgrade_blocked INTEGER NOT NULL, push_attempts INTEGER NOT NULL); INSERT INTO native_fixture_state VALUES (1, 0, 0, 0, 0, 0, 0)');
  return origin;
}

async function request(origin, path, init = {}) {
  const response = await fetch(new URL(path, origin), init);
  const body = await response.json().catch(() => null);
  assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function state(origin) {
  return request(origin, '/__state');
}

async function setFault(origin, values) {
  return request(origin, '/__fault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
}

try {
  assert(readFileSync(binary).length > 0, `compiled agent missing: ${binary}`);
  makePfx();

  statusServer = createHttpServer((req, res) => {
    const code = req.url === '/down' ? 503 : 200;
    res.writeHead(code, { 'content-type': 'text/plain', 'content-length': 2 });
    res.end('ok');
  });
  const httpPort = await listen(statusServer);
  tcpServer = createTcpServer((socket) => socket.end('native-tcp-ok\r\n'));
  const tcpPort = await listen(tcpServer);
  tlsServer = createTlsServer({ pfx: readFileSync(pfxPath), passphrase: pfxPassword }, (req, res) => res.end('unexpected TLS success'));
  const tlsPort = await listen(tlsServer);
  proxyServer = createHttpServer(async (req, res) => {
    try {
      const target = new URL(req.url);
      if (!workerOrigin || target.origin !== workerOrigin) throw new Error('external proxy target blocked');
      proxyForwards++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers);
      headers.delete('host');
      headers.delete('proxy-connection');
      const response = await fetch(target, {
        method: req.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(403, { connection: 'close' });
      res.end();
    }
  });
  proxyServer.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  const proxyPort = await listen(proxyServer);

  const origin = await startWorker();
  workerOrigin = origin;
  const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  await request(origin, '/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: adminToken, username: 'native-fixture', password: 'native-fixture-secret' }),
  });
  const agentMonitor = await request(origin, '/api/admin/agents', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Native Windows agent fixture' }),
  });
  const createProbe = async (name, type, target, options = {}, addons = {}) => {
    const result = await request(origin, '/api/monitors', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name, type, target, interval_sec: 60, ...addons, options_json: { check_source: { type: 'agent', agent_id: agentMonitor.id }, ...options } }),
    });
    return result;
  };
  const workerUrl = new URL(origin);
  const endpoint = `http://${workerUrl.host}/api/public/agent/${agentMonitor.token}`;
  const childEnv = {
    ...process.env,
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    ALL_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`,
    https_proxy: `http://127.0.0.1:${proxyPort}`, all_proxy: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    POLARIS_AGENT_AUTO_UPDATE: 'false',
  };
  delete childEnv.POLARIS_AGENT_TOKEN;
  delete childEnv.POLARIS_AGENT_ENDPOINT;
  writeFileSync(configPath, '{}');
  agent = spawn(binary, ['run', '--config', configPath, '--endpoint', endpoint, '--token', agentMonitor.token, '--sample-interval', '1', '--report-interval', '1', '--auto-update=false'], {
    cwd: privateDir, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.setEncoding('utf8');
  agent.stderr.setEncoding('utf8');
  agent.stdout.on('data', (chunk) => logs.push(chunk));
  agent.stderr.on('data', (chunk) => logs.push(chunk));

  const online = await waitFor('native WebSocket report', () => state(origin), (current) =>
    current.live.some((row) => row.agent_id === agentMonitor.id && row.version === expectedVersion && row.reported_at > 0), 30_000);
  assert(online.live.find((row) => row.agent_id === agentMonitor.id).probe_capabilities.includes('probe_tcp'));
  console.log('PASS real Windows agent connected over WebSocket, announced current capabilities and wrote reported_at');

  /*
    Remote commands, end to end, through the compiled agent.

    This is the only place the whole channel is exercised against real Rust: a
    fixture that fabricates a capability array proves the server's gate, but not
    that the shipped binary announces it or can act on what it receives.
    `re_report` is chosen because it is the one action with no side effect on the
    host - the other two end the process.

    通过编译后的 Rust Agent 端到端测试远程命令，验证二进制声明能力并执行命令。
    选择 re_report 是因为它不会影响主机；另外两个动作会结束进程。
  */
  {
    const capabilities = JSON.parse(
      online.live.find((row) => row.agent_id === agentMonitor.id).probe_capabilities,
    );
    assert(capabilities.includes('commands'), `agent must announce commands: ${capabilities}`);

    await request(origin, '/api/admin/settings', {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ 'security.allowAgentCommands': true }),
    });
    const issued = await request(origin, `/api/admin/agents/${agentMonitor.id}/commands`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 're_report' }),
    });
    assert.equal(issued.id !== undefined, true);

    // The agent polls on its own interval, so this waits out one cycle.
    // Agent 按自身间隔轮询，等待一个周期。
    const completed = await waitFor('the agent to answer a remote command', () => state(origin), (current) =>
      (current.commands ?? []).find((row) => row.action === 're_report' && row.state === 'completed'), 90_000);
    const upload = completed.commands.find((row) => row.action === 're_report' && row.state === 'completed');
    assert.equal(upload.ok, 1, `command failed: ${upload.message}`);
    console.log(`PASS real Windows agent executed a remote command (${upload.message})`);

    const restart = await request(origin, `/api/admin/agents/${agentMonitor.id}/commands`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'restart' }),
    });
    const refusal = await waitFor('unsupervised agent refusal', () => state(origin), (current) =>
      current.commands.some((row) => row.id === restart.id && row.state === 'completed'), 90_000);
    const restartResult = refusal.commands.find((row) => row.id === restart.id);
    assert.equal(restartResult.ok, 0);
    assert.match(restartResult.message, /nothing supervises/i);
    assert.equal(agent.exitCode, null);

    await request(origin, '/api/admin/settings/security.allowAgentCommands', { method: 'DELETE', headers: adminHeaders });
    const before = (await state(origin)).commands;
    const refused = await fetch(new URL(`/api/admin/agents/${agentMonitor.id}/commands`, origin), {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'restart' }),
    });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'commands_disabled');
    assert.deepEqual((await state(origin)).commands, before);
    console.log('PASS remote commands are gated at the API after disabling');
  }

  const httpProbe = await createProbe('native HTTP UP', 'http', `http://127.0.0.1:${httpPort}/ok`);
  const tcpProbe = await createProbe('native TCP IPv4 fallback', 'tcp', `localhost:${tcpPort}`, { expect: 'native-tcp-ok' });
  const tlsProbe = await createProbe('native TLS rejection', 'http', `https://localhost:${tlsPort}/`, {}, { check_ssl: 1 });

  await setFault(origin, { results: true });
  await delay(60_100 - (Date.now() % 60_000));
  await request(origin, '/__tick', { method: 'POST' });
  await waitFor('leased native probe jobs and failed result upload', () => state(origin), (current) =>
    current.jobs.filter((job) => [httpProbe.id, tcpProbe.id, tlsProbe.id].includes(job.monitor_id) && job.state === 'leased').length === 3 && current.resultAttempts >= 1, 65_000);
  await setFault(origin, { results: false });
  const polled = await waitFor('native probe results', () => state(origin), (current) =>
    current.jobs.filter((job) => [httpProbe.id, tcpProbe.id, tlsProbe.id].includes(job.monitor_id) && job.state === 'completed').length === 3, 20_000);
  const completed = polled.jobs.filter((job) => [httpProbe.id, tcpProbe.id, tlsProbe.id].includes(job.monitor_id) && job.state === 'completed');
  assert.equal(completed.length, 3);
  assert.equal(completed.find((job) => job.monitor_id === httpProbe.id).status, 1);
  assert.equal(completed.find((job) => job.monitor_id === tcpProbe.id).status, 1, 'localhost must fall through an unreachable IPv6 result to the IPv4 listener');
  assert.equal(completed.find((job) => job.monitor_id === tlsProbe.id).status, 0, 'self-signed target TLS must fail with normal verification');
  const ssl = JSON.parse(completed.find(job => job.monitor_id === tlsProbe.id).addons_json).ssl;
  assert.equal(ssl.st, 2);
  assert.equal(ssl.tls_valid, false);
  assert.ok(ssl.days > 0, 'the real certificate expiry survives a trust failure');
  assert(polled.resultAttempts >= 1, 'native result upload must reach the real HTTP result endpoint');
  assert(polled.resultAttempts >= 4, 'failed HTTP result ACK must be retried before all three queued results are accepted');
  console.log('PASS native HTTP/TCP/TLS jobs executed and failed result uploads replayed');
  await delay(60_100 - (Date.now() % 60_000));
  const tick = await request(origin, '/__tick', { method: 'POST' });
  assert.equal(tick.tick, 'completed', 'the next actual minute owns a fresh tick lease');
  await waitFor('cron consumption', () => state(origin), (current) =>
    current.jobs.filter((job) => [httpProbe.id, tcpProbe.id, tlsProbe.id].includes(job.monitor_id) && job.state === 'completed' && job.consumed_at != null).length === 3, 20_000);
  const cronState = await state(origin);
  const entries = JSON.parse(cronState.heartbeats ?? '{}');
  assert.equal(entries[httpProbe.id]?.source_available, true);
  assert.equal(entries[tcpProbe.id]?.source_available, true);
  assert.equal(entries[tlsProbe.id]?.source_available, true);
  assert.equal(entries[tlsProbe.id]?.st, 2, 'the certificate trust warning is visible during primary failure confirmation');
  assert.equal(entries[tlsProbe.id]?.fails, 1, 'the primary failure still uses the existing confirmation counter');
  assert.equal(entries[tlsProbe.id]?.ssl.tls_valid, false);
  console.log('PASS real runTick consumed source_available=true results and retained the certificate warning with primary failure confirmation');

  const oldReportedAt = cronState.live.find((row) => row.agent_id === agentMonitor.id).reported_at;
  const updateStatement = `CREATE TRIGGER native_report_failure BEFORE UPDATE ON machine_live WHEN OLD.agent_id = '${agentMonitor.id}' BEGIN SELECT RAISE(FAIL, 'fixture report write failure'); END`;
  await (await mf.getD1Database('DB')).exec(updateStatement);
  await setFault(origin, { upgrade: true });
  assert.equal((await state(origin)).upgradeFault, 1);
  await waitFor('forced native report write failure', () => state(origin), (current) =>
    current.workerErrors.some((line) => line.includes('fixture report write failure')), 10_000);
  await (await mf.getD1Database('DB')).exec('DROP TRIGGER native_report_failure');
  await waitFor('blocked WebSocket reconnect', () => state(origin), (current) => current.upgradeBlocked >= 1, 10_000);
  const fallback = await waitFor('HTTP transport fallback', () => state(origin), (current) =>
    current.pushAttempts > 0 && current.live.some((row) => row.agent_id === agentMonitor.id && row.transport === 'http' && row.reported_at > oldReportedAt), 60_000);
  assert(fallback.upgradeBlocked >= 3, 'fixture must refuse the native agent WebSocket reconnects');
  assert.equal(proxyForwards, 0, 'NO_PROXY must keep local HTTP fallback traffic off the proxy');
  assert(fallback.live.find((row) => row.agent_id === agentMonitor.id).reported_at > oldReportedAt);
  console.log('PASS database write failure closed the socket; queued report replayed and HTTP transport advanced reported_at');

  exitCode = 0;
} catch (error) {
  console.error(error);
  if (logs.length) console.error(logs.join('').slice(-8000));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill('SIGINT');
    await Promise.race([new Promise((resolveExit) => agent.once('exit', resolveExit)), delay(2_000)]);
    if (agent.exitCode === null) {
      try { process.kill(agent.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise((resolveExit) => agent.once('exit', resolveExit)), delay(2_000)]);
    }
    if (agent.exitCode === null) {
      try { process.kill(agent.pid, 'SIGKILL'); } catch {}
    }
  }
  await Promise.allSettled([mf?.dispose(), ...[statusServer, tcpServer, tlsServer, proxyServer].filter(Boolean).map((server) => new Promise((resolveClose) => server.close(resolveClose)))]);
  const { rmSync } = await import('node:fs');
  assert(resolve(privateDir).startsWith(resolve(tmpdir()) + '\\'), 'fixture cleanup must remain under the OS temp directory');
  rmSync(privateDir, { recursive: true, force: true });
}

process.exit(exitCode);
