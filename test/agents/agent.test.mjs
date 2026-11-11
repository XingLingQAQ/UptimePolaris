// 通过 Miniflare 验证 Agent 上报、汇总、认证与删除。
// Use Miniflare to check Agent reporting, aggregation, authentication, and deletion.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/** Machine reports and explicit monitor availability. / 机器上报与显式监控的可用性。 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const HARNESS = `
import { api } from './backends/worker/src/api';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { rollupAgentMetrics } from './backends/worker/src/lib/agent/rollup.ts';
import { loadLiveFresh } from './backends/worker/src/lib/monitor/store.ts';
import { AGENT_STALE_SEC } from './backends/worker/src/lib/agent/rollup';

/** Thin wrapper around the real API, plus test-only entry points. / 真实 API 的轻量包装，附带仅供测试的入口。 */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/__rollup') {
      const now = Math.floor(Number(url.searchParams.get('now') ?? Date.now() / 1000));
      await runTick(env, now);
      const live = await loadLiveFresh(env);
      return Response.json({ ok: true, live, stale_sec: AGENT_STALE_SEC });
    }
    if (url.pathname === '/__agent-rollup') {
      const now = Math.floor(Number(url.searchParams.get('now') ?? Date.now() / 1000));
      const result = await rollupAgentMetrics(env, now);
      return Response.json({ entries: [...result.entries] });
    }

    // Everything else is the real API app, gate and all - which is the point
    // of the WS assertions below. The gate's isPublic whitelist has to let
    // /api/public/agent/* through unauthenticated for the agent to work.
    // 其余请求都经过真实 API 和门禁，这是下方 WS 断言的重点；isPublic 白名单必须允许
    // 未认证请求访问 /api/public/agent/*，Agent 才能工作。
    return api.fetch(req, env, ctx);
  },
};
`;

async function harness() {
  const built = await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    logLevel: 'error',
    plugins: [
      {
        name: 'stub-workers-only',
        setup(b) {
          /* 本套件不执行原始 socket；替身被调用时立即失败。
           * Raw sockets are outside this fixture; fail if the stub is called. */
          b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
            path: 'cloudflare-sockets',
            namespace: 'stub',
          }));
          /* 此套件只用 D1；PostgreSQL 替身被调用时立即失败。
           * This fixture uses D1 only; fail if the PostgreSQL stub is called. */
          b.onResolve({ filter: /^postgres$/ }, () => ({
            path: 'postgres',
            namespace: 'stub',
          }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents: args.path === 'postgres'
              ? `export default function postgres() { throw new Error('postgres driver stubbed in test harness'); }`
              : `export const connect = () => { throw new Error('cloudflare:sockets stubbed in test harness'); };`,
          }));
        },
      },
    ],
  });

  const mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    bindings: {
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-api-token',
      ADMIN_TOKEN: 'test-admin-token',
    },
    d1Databases: { DB: 'agent-test' },
    analyticsEngineDatasets: { UPTIME: { dataset: 'uptime_heartbeats' } },
  });

  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);

  return mf;
}

// --- tiny assertion runner -------------------------------------------------
// 简易断言执行器 / Tiny assertion runner

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

// --- suite -----------------------------------------------------------------
// 测试套件 / Suite

const mf = await harness();
const origin = 'http://localhost';
const auth = { authorization: 'Bearer test-admin-token' };
const post = (path, body, method = 'POST', headers = {}) =>
  mf.dispatchFetch(`${origin}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const readJson = async (res) => ({ status: res.status, body: await res.json() });

async function monitoredAgent(name) {
  const machine = await readJson(await post('/api/admin/agents', { name }, 'POST', auth));
  check('machine enrollment succeeds', machine.status === 201, machine);
  const monitor = await readJson(await post('/api/monitors', { name, type: 'agent', agent_id: machine.body.id }, 'POST', auth));
  check('explicit machine monitor succeeds', monitor.status === 201, monitor);
  return { ...monitor, agent: machine.body };
}

console.log('monitor API: explicit machine selection');
{
  const missing = await readJson(await post('/api/monitors', { name: 'missing machine', type: 'agent' }, 'POST', auth));
  eq('Agent monitors require an enrolled machine', [missing.status, missing.body.error], [400, 'agent_required']);
  const created = await monitoredAgent('homelab box');
  check('machine has a unique credential', /^[A-Za-z0-9_-]{43}$/.test(created.agent.token));
  check('monitor responses do not expose machine credentials', !('agent_token' in created.body) && !('token' in created.body));
  const db = await mf.getD1Database('DB');
  const row = await db.prepare('SELECT type,target,agent_id,push_token FROM monitors WHERE id=?').bind(created.body.id).first();
  eq('the monitor explicitly binds the machine', row.agent_id, created.agent.id);
  eq('an Agent monitor needs no target', row.target, '');
  eq('no Push credential is minted', row.push_token, null);
  const malformed = await readJson(await post('/api/monitors', {
    name: 'bad thresholds', type: 'agent', agent_id: created.agent.id,
    options_json: { alerts: { cpu: { enabled: true, threshold: 101, duration_sec: 30, recovery_pct: 90 } } },
  }, 'POST', auth));
  eq('CPU thresholds above 100% are rejected', [malformed.status, malformed.body.error], [400, 'agent_threshold_invalid']);
  const unknown = await readJson(await post('/api/monitors', {
    name: 'unknown threshold', type: 'agent', agent_id: created.agent.id,
    options_json: { alerts: { cpu: { enabled: true, threshold: 90, duration_sec: 30, recovery_pct: 90, typo: true } } },
  }, 'POST', auth));
  eq('unknown threshold properties are rejected', [unknown.status, unknown.body.error], [400, 'agent_threshold_invalid']);
  const http = await readJson(await post('/api/monitors', { name: 'convert', type: 'http', target: 'https://example.com' }, 'POST', auth));
  const flip = await readJson(await post(`/api/monitors/${http.body.id}`, { type: 'agent', target: '', agent_id: created.agent.id }, 'PUT', auth));
  eq('changing type selects an existing machine', flip.status, 200);
  eq('changing type creates no extra machine', (await db.prepare('SELECT COUNT(*) AS n FROM agents').first()).n, 1);
}

// --- WS endpoint: bad tokens -----------------------------------------------
// WS 端点的无效令牌 / Bad WS tokens

console.log('\nagent WS: token rejection\n');
{
  // No upgrade header: not a WebSocket handshake. Fixed 426, same shape as
  // the upgrade dance on any WS endpoint.
  // 无升级头不是 WebSocket 握手，固定返回 426，与普通 WS 端点的升级流程一致。
  const noUpgrade = await mf.dispatchFetch(`${origin}/api/public/agent/deadbeef`);
  check('missing Upgrade header is 426', noUpgrade.status === 426, noUpgrade.status);

  // With the Upgrade header but an unknown token: 401 either way. The
  // answer is deliberately the same as "token that exists but belongs to
  // an http monitor" so the endpoint cannot be used as a lookup oracle.
  // 带 Upgrade 头但令牌未知时返回 401；与属于 HTTP 监控的现有令牌返回相同结果，
  // 防止将端点用作令牌查询 oracle。
  const badToken = await mf.dispatchFetch(`${origin}/api/public/agent/deadbeef`, {
    headers: { Upgrade: 'websocket' },
  });
  check('unknown token is 401', badToken.status === 401, badToken.status);
  const body = await badToken.json();
  eq('with a fixed error string', body, { error: 'invalid token' });
}

// --- WS: end-to-end frame flow ----------------------------------------------
// WS 帧端到端流程 / End-to-end WS frame flow

console.log('\nagent WS: basicReport + report frames\n');

let agentMonitorId = null;
let agentMachineId = null;
let agentToken = null;

{
  const created = await monitoredAgent('e2e box');
  agentMonitorId = created.body.id;
  agentMachineId = created.agent.id;
  agentToken = created.agent.token;

  /* 通过升级响应的客户端 socket 向实际 Worker 发送帧。
   * Send frames to the Worker through the upgrade response's client socket. */
  const upgradeRes = await mf.dispatchFetch(`${origin}/api/public/agent/${agentToken}`, {
    headers: { Upgrade: 'websocket' },
  });
  check('valid token upgrades to 101', upgradeRes.status === 101, upgradeRes.status);
  check('and the response carries a webSocket', upgradeRes.webSocket !== null && upgradeRes.webSocket !== undefined, null);

  const ws = upgradeRes.webSocket;
  ws.accept();
  const acknowledgements = [];
  ws.addEventListener('message', (event) => {
    try { acknowledgements.push(JSON.parse(String(event.data))); } catch { /* Ignore non-JSON frames. / 忽略非 JSON 帧。 */ }
  });

  // Give the runtime a tick to route the frame listeners before sending.
  // Miniflare fires 'message' synchronously once accepted, so a single
  // microtask is enough.
  // 发送前让运行时有机会注册帧监听器；Miniflare 接受后同步触发 message，一个微任务即可。
  const basicFrame = {
    jsonrpc: '2.0',
    id: 1,
    method: 'basicReport',
    params: { transport: 'ws', capabilities: [],
      name: 'test-box',
      os: 'linux',
      arch: 'x86_64',
      kernel: '6.6.0',
      cpu_model: 'Test CPU 3000',
      cpu_cores: 8,
      mem_total: 17_179_869_184,
      version: '0.1.0',
      publicIpv6: '2001:db8::1',
      report_interval_secs: 60,
    },
  };
  ws.send(JSON.stringify(basicFrame));

  // 等待本地 WebSocket 处理器完成写入和发送确认。
  // Wait for the local WebSocket handler to persist and acknowledge the frame.
  await new Promise((r) => setTimeout(r, 200));
  eq('basicReport is acknowledged after its write', acknowledgements[0], {
    jsonrpc: '2.0', id: 1, result: { ack: true, ignored: false },
  });

  const db = await mf.getD1Database('DB');
  let live = await db.prepare('SELECT * FROM machine_live WHERE agent_id = ?')
    .bind(agentMachineId)
    .first();

  check('basicReport landed a row in machine_live', live !== null, live);
  eq('identity columns match', [
    live?.os, live?.arch, live?.kernel, live?.cpu_model, live?.cpu_cores,
  ], ['linux', 'x86_64', '6.6.0', 'Test CPU 3000', 8]);
  eq('reported_at is still NULL - basicReport does not move it', live?.reported_at, null);

  // Now the periodic report frame.
  // 接下来发送周期性 report 帧。
  const observedAt = Math.floor(Date.now() / 1000);
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'report',
    params: { interfaces: null, mounts: null,
      observed_at: observedAt,
      summaries: [{
        bucket_ts: Math.floor(observedAt / 60) * 60,
        sample_count: 2,
        cpu_samples: 2,
        cpu_avg: 25,
        cpu_max: 42.5,
        mem_samples: 2,
        mem_pct_avg: 45,
        mem_pct_max: 50,
        load_1_avg: 0.4,
        load_5_avg: 0.6,
        net_up_bytes: 6000,
        net_down_bytes: 24000,
        duration_sec: 55,
        network_duration_sec: 55,
      }],
      cpu: { usage: 42.5 },
      ram: { total: 17_179_869_184, used: 8_589_934_592 },
      swap: { total: 2_147_483_648, used: 0 },
      load: { load1: 0.5, load5: 0.7, load15: 0.9 },
      disk: { total: 1_000_000_000_000, used: 500_000_000_000 },
      network: {
        up: 1024, down: 4096,
        totalUp: 1_000_000, totalDown: 4_000_000,
      },
      connections: { tcp: 12, udp: 3 },
      uptime: 36000,
      process: 180,
      message: 'all good',
    },
  }));
  await new Promise((r) => setTimeout(r, 200));
  eq('report is acknowledged after its write', acknowledgements[1], {
    jsonrpc: '2.0', id: 2, result: { ack: true, ignored: false },
  });

  live = await db.prepare('SELECT * FROM machine_live WHERE agent_id = ?')
    .bind(agentMachineId)
    .first();

  eq('dynamic columns updated', [
    live?.cpu_usage, live?.mem_used, live?.load_1, live?.disk_used,
    live?.net_up_rate, live?.net_down_rate,
    live?.connections_tcp, live?.connections_udp,
    live?.process_count, live?.uptime, live?.message,
  ], [42.5, 8_589_934_592, 0.5, 500_000_000_000, 1024, 4096, 12, 3, 180, 36000, 'all good']);

  check('reported_at moved forward', typeof live?.reported_at === 'number' && live.reported_at > 0, live?.reported_at);
  eq('basic info persists version, IPv6 and report interval', [live?.version, live?.public_ipv6, live?.report_interval_secs], ['0.1.0', '2001:db8::1', 60]);
  check('identity columns are still intact after the second upsert', [
    live?.os, live?.arch, live?.cpu_model,
  ].every((v) => v !== null), [live?.os, live?.arch, live?.cpu_model]);

  await db.exec("CREATE TRIGGER fail_agent_update BEFORE UPDATE ON machine_live BEGIN SELECT RAISE(FAIL, 'fixture write failure'); END");
  ws.send(JSON.stringify({ ...basicFrame, id: 3 }));
  await new Promise((r) => setTimeout(r, 200));
  eq('failed database write receives no acknowledgement', acknowledgements.length, 2);
  await db.exec('DROP TRIGGER fail_agent_update');
  const replayUpgrade = await mf.dispatchFetch(`${origin}/api/public/agent/${agentToken}`, { headers: { Upgrade: 'websocket' } });
  const replaySocket = replayUpgrade.webSocket;
  replaySocket.accept();
  const replayAcks = [];
  replaySocket.addEventListener('message', (event) => {
    try { replayAcks.push(JSON.parse(String(event.data))); } catch { /* Ignore non-JSON frames. / 忽略非 JSON 帧。 */ }
  });
  replaySocket.send(JSON.stringify({ ...basicFrame, id: 3 }));
  await new Promise((r) => setTimeout(r, 200));
  eq('replayed write is acknowledged once persisted', replayAcks[0], {
    jsonrpc: '2.0', id: 3, result: { ack: true, ignored: false },
  });

  try { ws.close(); } catch { /* already closed / 已关闭 */ }
}

// --- HTTP transport: the fallback path ---------------------------------------
// HTTP 备用传输 / HTTP fallback transport

console.log('\nagent HTTP transport\n');

let httpMachineId = null;
let httpToken = null;

{
  const created = await monitoredAgent('http transport box');
  httpMachineId = created.agent.id;
  httpToken = created.agent.token;
  const db = await mf.getD1Database('DB');

  /**
   * The route answers a GET with a description rather than a 404 or a 405.
   * Someone who pastes this URL into a browser is checking whether it exists,
   * and telling them what the endpoint wants is the useful answer. It must not
   * be a WebSocket 426 either - the whole point of this path is that the
   * client is deliberately not using a socket.
   * GET 此路由应返回说明，而非 404 或 405。将 URL 粘贴到浏览器的人是在检查端点是否存在，
   * 说明所需请求更有用；也不能返回 WebSocket 426，因为此路径的客户端有意不使用 socket。
   */
  const probe = await readJson(await mf.dispatchFetch(`${origin}/api/public/agent/push/${httpToken}`));
  check('GET describes the transport rather than erroring', probe.status === 200, probe);
  eq('and names itself', probe.body.transport, 'http-push');

  // Same token discipline as the socket: one fixed answer for every kind of
  // bad token, so this cannot be used to probe which tokens exist.
  // 与 socket 相同的令牌规则：所有无效令牌返回固定结果，避免探测令牌是否存在。
  const bad = await readJson(
    await post('/api/public/agent/push/deadbeef', { jsonrpc: '2.0', method: 'report', params: {} }),
  );
  check('unknown token is 401', bad.status === 401, bad);
  eq('with the same fixed string the socket uses', bad.body, { error: 'invalid token' });

  // A single frame, exactly what the agent posts first.
  // 单帧，与 Agent 首次发送的内容一致。
  const single = await readJson(
    await post(`/api/public/agent/push/${httpToken}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'basicReport',
      params: { kernel: 'fixture-kernel', version: '0.1.0', report_interval_secs: 60, capabilities: [],
        name: 'http-box',
        os: 'linux',
        arch: 'aarch64',
        cpu_model: 'HTTP Test CPU',
        cpu_cores: 4,
        mem_total: 8_589_934_592,
        transport: 'http',
        isp: 'Test ISP',
        virtualization: 'docker',
      },
    }),
  );
  check('a single basicReport is accepted', single.status === 200, single);
  eq('and reports one applied', single.body.applied, 1);

  let live = await db.prepare('SELECT * FROM machine_live WHERE agent_id = ?')
    .bind(httpMachineId)
    .first();
  eq('identity columns landed over HTTP', [
    live?.os, live?.arch, live?.cpu_model, live?.isp, live?.virtualization,
  ], ['linux', 'aarch64', 'HTTP Test CPU', 'Test ISP', 'docker']);

  /**
   * `transport` is the field that makes "is this fleet on the socket or the
   * fallback" answerable from the console. It has to survive the whole path -
   * agent to JSON to the schema guard to the column - and a guard that drops
   * an optional field is silent, so it is asserted by name.
   * transport 字段使控制台能够区分设备群使用 socket 还是备用传输；它必须贯穿 Agent、JSON、
   * schema 守卫和数据库列。守卫若静默丢弃可选字段难以发现，因此按字段名断言。
   */
  eq('the transport is recorded', live?.transport, 'http');
  eq('and basicReport still does not move reported_at', live?.reported_at, null);

  // A batch, which is what the agent sends after a link recovers. The last
  // frame's values must win: machine_live is an overwrite, and the agent
  // queues oldest-first.
  // 网络恢复后 Agent 发送批次；machine_live 使用覆盖写入，队列按从旧到新排列，最后一帧必须生效。
  const batch = await readJson(
    await post(`/api/public/agent/push/${httpToken}`, [
      {
        jsonrpc: '2.0', id: null, method: 'report',
        params: { observed_at: Math.floor(Date.now() / 1000), summaries: [], interfaces: null, mounts: null,
          cpu: { usage: 10 }, ram: { total: 1000, used: 100 }, swap: { total: 0, used: 0 },
          load: { load1: 0.1, load5: 0.1, load15: 0.1 },
          disk: { total: 2000, used: 200 },
          network: { up: 1, down: 2, totalUp: 10, totalDown: 20 },
          connections: { tcp: 1, udp: 0 }, uptime: 100, process: 10, message: 'first',
        },
      },
      {
        jsonrpc: '2.0', id: null, method: 'report',
        params: { observed_at: Math.floor(Date.now() / 1000), summaries: [], interfaces: null, mounts: null,
          cpu: { usage: 50 }, ram: { total: 1000, used: 500 }, swap: { total: 0, used: 0 },
          load: { load1: 0.5, load5: 0.5, load15: 0.5 },
          disk: { total: 2000, used: 1000 },
          network: { up: 5, down: 6, totalUp: 50, totalDown: 60 },
          connections: { tcp: 5, udp: 1 }, uptime: 200, process: 20, message: 'last',
        },
      },
    ]),
  );
  check('a batch of frames is accepted', batch.status === 200, batch);
  eq('and every frame is applied', [batch.body.applied, batch.body.received], [2, 2]);

  const heavyReport = {
    jsonrpc: '2.0', id: null, method: 'report', params: { observed_at: Math.floor(Date.now() / 1000), interfaces: null, mounts: null,
      summaries: Array(20).fill({}),
      cpu: { usage: 1 }, ram: { total: 10, used: 1 }, swap: { total: 0, used: 0 },
      load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 10, used: 1 },
      network: { up: 0, down: 0, totalUp: 0, totalDown: 0 }, connections: { tcp: 0, udp: 0 },
      uptime: 1, process: 1, message: '',
    },
  };
  const oversized = await readJson(await post(`/api/public/agent/push/${httpToken}`, [heavyReport, heavyReport]));
  eq('POST work above the aggregate budget is rejected before processing', [oversized.status, oversized.body.maxWork, oversized.body.work], [413, 40, 44]);

  live = await db.prepare('SELECT * FROM machine_live WHERE agent_id = ?')
    .bind(httpMachineId)
    .first();
  eq('the last frame in the batch wins', [live?.cpu_usage, live?.process_count, live?.message], [50, 20, 'last']);
  check('and reported_at moved', typeof live?.reported_at === 'number' && live.reported_at > 0, live?.reported_at);

  // A frame the server cannot understand is a 400, not a silent 200. The
  // agent uses this to tell "the server is rejecting my frames" from "the
  // server is unreachable", and those need different responses.
  // 无法理解的帧应返回 400 而非静默 200；Agent 据此区分服务器拒绝帧和服务器不可达，
  // 两者需要不同处理。
  const junk = await readJson(
    await post(`/api/public/agent/push/${httpToken}`, { jsonrpc: '2.0', method: 'nonsense', params: {} }),
  );
  check('an unknown method is refused, not silently accepted', junk.status === 400, junk);
  eq('and says nothing was applied', junk.body.applied, 0);

  const notJson = await mf.dispatchFetch(`${origin}/api/public/agent/push/${httpToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'this is not json',
  });
  check('a non-JSON body is a 400', notJson.status === 400, notJson.status);

  const empty = await readJson(await post(`/api/public/agent/push/${httpToken}`, []));
  check('an empty batch is refused', empty.status === 400, empty);
}

// --- Rollup: the cron side ---------------------------------------------------
// 定时任务侧汇总 / Cron rollup

console.log('\nagent rollup\n');
{
  const now = Math.floor(Date.now() / 1000);
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?')
    .bind(now, httpMachineId).run();

  // The e2e agent above has a fresh reported_at, so it should be UP.
  // 上方端到端 Agent 的 reported_at 新鲜，因此应为 UP。
  const r1 = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now}`)).json();
  const e2e = r1.live[agentMonitorId];
  check('fresh agent is UP', e2e?.st === 1, e2e);
  check('CPU percent is in v', e2e?.v === 42.5, e2e);
  eq('msg passes through', e2e?.msg, 'all good');

  let hist = await (await mf.getD1Database('DB'))
    .prepare('SELECT * FROM machine_history WHERE agent_id = ? ORDER BY bucket_ts DESC')
    .bind(agentMachineId)
    .all();
  check('one history bucket written', hist.results.length === 1, hist.results);
  const bucket = hist.results[0];
  check('bucket timestamp is minute-aligned', bucket.bucket_ts % 60 === 0, bucket.bucket_ts);
  eq('varied samples retain true average and peak', [bucket.cpu_avg, bucket.cpu_max, bucket.sample_count], [25, 42.5, 2]);
  eq('summary records measured network bytes and duration', [bucket.net_up_bytes, bucket.net_down_bytes, bucket.network_duration_sec], [6000, 24000, 55]);
  const availabilityBefore = await db.prepare('SELECT total, last_minute_ts FROM agent_uptime_daily WHERE monitor_id = ?')
    .bind(agentMonitorId).first();
  await mf.dispatchFetch(`${origin}/__agent-rollup?now=${now}`);
  await mf.dispatchFetch(`${origin}/__agent-rollup?now=${now}`);
  const availabilityAfter = await db.prepare('SELECT total, last_minute_ts FROM agent_uptime_daily WHERE monitor_id = ?')
    .bind(agentMonitorId).first();
  eq('duplicate minute availability updates are idempotent', availabilityAfter, availabilityBefore);

  const duplicateObservedAt = Math.floor(Date.now() / 1000);
  await post(`/api/public/agent/push/${agentToken}`, {
    jsonrpc: '2.0', id: null, method: 'report', params: { interfaces: null, mounts: null,
      observed_at: duplicateObservedAt,
      summaries: [{
        bucket_ts: bucket.bucket_ts, sample_count: 2, cpu_samples: 2, cpu_avg: 25, cpu_max: 42.5,
        mem_samples: 2, mem_pct_avg: 45, mem_pct_max: 50, load_1_avg: 0.4, load_5_avg: 0.6,
        net_up_bytes: 6000, net_down_bytes: 24000, duration_sec: 55, network_duration_sec: 55,
      }],
      cpu: { usage: 42.5 }, ram: { total: 1000, used: 500 }, swap: { total: 0, used: 0 },
      load: { load1: 0.5, load5: 0.5, load15: 0.5 }, disk: { total: 1000, used: 100 },
      network: { up: 1, down: 2, totalUp: 100, totalDown: 200 }, connections: { tcp: 1, udp: 0 },
      uptime: 100, process: 10, message: '',
    },
  });
  const duplicateCount = await db.prepare('SELECT COUNT(*) AS n FROM machine_history WHERE agent_id = ? AND bucket_ts = ?')
    .bind(agentMachineId, bucket.bucket_ts).first();
  eq('duplicate finalized report keeps one history bucket', duplicateCount.n, 1);

  const alertOptions = { alerts: {
    cpu: { enabled: true, threshold: 80, duration_sec: 120, recovery_pct: 90 },
    disk: { enabled: true, threshold: 80, duration_sec: 120, recovery_pct: 90 },
    load: { enabled: true, threshold: 0.1, duration_sec: 120, recovery_pct: 90 },
  } };
  await db.prepare('UPDATE monitors SET options_json = ? WHERE id = ?').bind(JSON.stringify(alertOptions), agentMonitorId).run();
  await db.prepare('UPDATE machine_live SET cpu_usage = 95, load_1 = 0.5, reported_at = ? WHERE agent_id = ?').bind(now + 60, agentMachineId).run();
  let alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 60}`)).json();
  eq('a short resource spike stays online without warning', alertTick.live[agentMonitorId].st, 1);
  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 120}`);
  await db.prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?').bind(now + 120, agentMachineId).run();
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 180}`)).json();
  eq('a short resource spike stays below its sustained duration', alertTick.live[agentMonitorId].st, 1);
  await db.prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?').bind(now + 180, agentMachineId).run();
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 240}`)).json();
  eq('sustained CPU enters WARN', alertTick.live[agentMonitorId].st, 2);
  const sustainedEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 2 AND message LIKE 'cpu %'").bind(agentMonitorId).first();
  eq('sustained entry records one warning event', sustainedEvents.n, 1);
  const simultaneousEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 2 AND (message LIKE 'cpu %' OR message LIKE 'load %')").bind(agentMonitorId).first();
  eq('two resources crossing together keep distinct events', simultaneousEvents.n, 2);
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 300}`)).json();
  eq('repeated active report preserves WARN', alertTick.live[agentMonitorId].st, 2);
  const duplicateEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 2 AND message LIKE 'cpu %'").bind(agentMonitorId).first();
  eq('duplicate cron rollup does not repeat the alert', duplicateEvents.n, 1);
  await db.prepare('UPDATE machine_live SET cpu_usage = NULL, disk_used = 900, reported_at = ? WHERE agent_id = ?').bind(now + 360, agentMachineId).run();
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 360}`)).json();
  eq('missing CPU keeps an active warning visible', alertTick.live[agentMonitorId].st, 2);
  await db.prepare('UPDATE machine_live SET cpu_usage = 95, reported_at = ? WHERE agent_id = ?').bind(now + 600, agentMachineId).run();
  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 600}`);
  const diskEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND message LIKE 'disk %'").bind(agentMonitorId).first();
  eq('a long observation gap restarts disk sustain time', diskEvents.n, 0);
  await db.prepare('UPDATE machine_live SET cpu_usage = 70, load_1 = 0.5, disk_used = 100, reported_at = ? WHERE agent_id = ?').bind(now + 660, agentMachineId).run();
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 660}`)).json();
  eq('partial recovery keeps WARN while load remains active', alertTick.live[agentMonitorId].st, 2);
  const recoveryEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 2 AND message LIKE 'cpu recovered%'").bind(agentMonitorId).first();
  eq('partial recovery does not announce false UP', recoveryEvents.n, 1);
  await db.prepare('UPDATE machine_live SET load_1 = 0.05, reported_at = ? WHERE agent_id = ?').bind(now + 720, agentMachineId).run();
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 720}`)).json();
  eq('last active rule recovery clears WARN', alertTick.live[agentMonitorId].st, 1);
  const finalRecovery = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 1 AND message LIKE 'load recovered%'").bind(agentMonitorId).first();
  eq('final recovery announces UP once', finalRecovery.n, 1);
  await db.prepare('UPDATE monitors SET options_json = ? WHERE id = ?').bind('{}', agentMonitorId).run();
  await db.prepare('UPDATE machine_live SET cpu_usage = 99, reported_at = ? WHERE agent_id = ?').bind(now + 780, agentMachineId).run();
  alertTick = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 780}`)).json();
  eq('removed alert rules no longer affect status', alertTick.live[agentMonitorId].st, 1);

  const aggregateBucketTs = Math.floor(duplicateObservedAt / 60) * 60 - 60;
  const summary = {
    bucket_ts: aggregateBucketTs, sample_count: 2, cpu_samples: 2, cpu_avg: 30, cpu_max: 70,
    mem_samples: 2, mem_pct_avg: 40, mem_pct_max: 60, load_1_avg: 0.3, load_5_avg: 0.5,
    net_up_bytes: 300, net_down_bytes: 500, duration_sec: 5, network_duration_sec: 5,
  };
  const summaryFrame = {
    jsonrpc: '2.0', id: null, method: 'report', params: { interfaces: null, mounts: null,
      observed_at: duplicateObservedAt, summaries: [summary],
      cpu: { usage: 70 }, ram: { total: 1000, used: 400 }, swap: { total: 0, used: 0 },
      load: { load1: 0.3, load5: 0.5, load15: 0.7 }, disk: { total: 1000, used: 100 },
      network: { up: 1, down: 2, totalUp: 100, totalDown: 200 }, connections: { tcp: 1, udp: 0 },
      uptime: 100, process: 10, message: '',
    },
  };
  await post(`/api/public/agent/push/${httpToken}`, summaryFrame);
  const finalized = await db.prepare('SELECT quality, cpu_avg, cpu_max FROM machine_history WHERE agent_id = ? AND bucket_ts = ?')
    .bind(httpMachineId, aggregateBucketTs).first();
  eq('finalized summary records observed mean and peak', [finalized.quality, finalized.cpu_avg, finalized.cpu_max], ['aggregate', 30, 70]);
  await post(`/api/public/agent/push/${httpToken}`, {
    ...summaryFrame,
    params: { ...summaryFrame.params, summaries: [{ ...summary, cpu_avg: 99, cpu_max: 99 }] },
  });
  const duplicateAggregate = await db.prepare('SELECT cpu_avg, cpu_max FROM machine_history WHERE agent_id = ? AND bucket_ts = ?')
    .bind(httpMachineId, aggregateBucketTs).first();
  eq('duplicate aggregate does not replace finalized values', [duplicateAggregate.cpu_avg, duplicateAggregate.cpu_max], [30, 70]);
  const overflow = await readJson(await post(`/api/public/agent/push/${httpToken}`, {
    ...summaryFrame,
    params: { ...summaryFrame.params, summaries: Array(33).fill(summary) },
  }));
  eq('reports above the summary write bound are refused', [overflow.status, overflow.body.applied], [400, 0]);

  // Stale agent: backdate reported_at beyond the staleness deadline and
  // tick again. The entry should now read DOWN.
  // 过期 Agent：将 reported_at 回拨到过期阈值之前并再次执行 tick，此时应为 DOWN。
  const staleDeadline = 180;
  await (await mf.getD1Database('DB'))
    .prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?')
    .bind(now - staleDeadline - 60, agentMachineId)
    .run();
  const neverConnected = await monitoredAgent('never booted');

  const r2 = await (await mf.dispatchFetch(`${origin}/__rollup?now=${now + 840}`)).json();
  const stale = r2.live[agentMonitorId];
  check('stale agent is DOWN', stale?.st === 0, stale);
  check('message names the staleness', /not reporting for \d+s/.test(stale?.msg ?? ''), stale?.msg);
  const offlineEvent = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 0 AND message LIKE 'agent not reporting%'").bind(agentMonitorId).first();
  eq('confirmed agent offline transition records an event', offlineEvent.n, 1);
  const never = r2.live[neverConnected.body.id];
  check('agent without its first report is unknown', never?.st === 4 && never?.ts === 0, never);
  eq('with the waiting message', never?.msg, 'waiting for first agent report');


  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 900}`);
  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 960}`);
  const ringRow = await (await mf.getD1Database('DB'))
    .prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind(agentMonitorId).first();
  const agentRing = JSON.parse(ringRow.json).filter((point) => point.t >= Math.floor(now / 60) * 60);
  check('stopped agent records DOWN ticks with distinct evaluated minutes',
    agentRing.length >= 2 && agentRing.slice(-2).every((point) => point.up === 0) && agentRing.at(-1).t > agentRing.at(-2).t,
    agentRing);
  const staleBuckets = await (await mf.getD1Database('DB'))
    .prepare('SELECT COUNT(*) AS n FROM machine_history WHERE agent_id = ?').bind(agentMachineId).first();
  eq('stale rollups do not fabricate metric buckets', staleBuckets.n, 1);
  const detail = await readJson(await mf.dispatchFetch(`${origin}/api/public/agent/detail/${(await db.prepare('SELECT num_id FROM monitors WHERE id = ?').bind(agentMonitorId).first()).num_id}?minutes=60`));
  eq('detail uses the same offline verdict', detail.body.online, false);
  eq('offline detail keeps only the received aggregate bucket', detail.body.buckets.length, 1);

  await db.prepare('UPDATE machine_live SET cpu_usage = 42.5, reported_at = ? WHERE agent_id = ?').bind(now + 1020, agentMachineId).run();
  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 1020}`);
  const onlineEvent = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 1 AND message = 'agent reporting resumed'").bind(agentMonitorId).first();
  eq('offline-to-online recovery records an event', onlineEvent.n, 1);

  // Rolled-up rows are not doubled for the never-connected monitor (no live
  // row means no history, by design).
  // 从未连接的监控不会重复生成汇总行；按设计，没有 live 行就没有历史。
  const neverHist = await (await mf.getD1Database('DB'))
    .prepare('SELECT COUNT(*) AS n FROM machine_history WHERE agent_id = ?')
    .bind(neverConnected.agent.id)
    .first();
  eq('no history bucket for a never-connected agent', neverHist.n, 0);

  // Idempotence: another rollup *in the same minute* does not double the
  // bucket, just replaces its values. The `now` used above is already
  // minute-aligned, so re-running it touches the same bucket_ts.
  // 幂等性：同一分钟再次汇总只替换桶值，不重复计数；上方 now 已对齐分钟，故重跑触及同一 bucket_ts。
  const keysBefore = await (await mf.getD1Database('DB'))
    .prepare('SELECT bucket_ts FROM machine_history WHERE agent_id = ? ORDER BY bucket_ts')
    .bind(agentMachineId)
    .all();
  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 1021}`);
  const keysAfter = await (await mf.getD1Database('DB'))
    .prepare('SELECT bucket_ts FROM machine_history WHERE agent_id = ? ORDER BY bucket_ts')
    .bind(agentMachineId)
    .all();
  eq('re-running in the same minute does not add new buckets',
    keysAfter.results.map((r) => r.bucket_ts),
    keysBefore.results.map((r) => r.bucket_ts));

  await mf.dispatchFetch(`${origin}/__rollup?now=${now + 86400}`);
  const uptime = await (await mf.getD1Database('DB'))
    .prepare('SELECT days_json FROM monitor_uptime WHERE monitor_id = ?').bind(agentMonitorId).first();
  const days = JSON.parse(uptime.days_json);
  check('availability materializes separate elapsed days', days.length >= 2 && new Set(days.map((day) => day.d)).size === days.length, days);
  check('daily availability retains accumulated cron minutes', days.every((day) => day.t >= 1 && day.u + day.w <= day.t), days);
}

console.log('\npaused agent acknowledgement\n');
{
  const created = await monitoredAgent('paused agent');
  const id = created.body.id;
  const token = created.agent.token;
  await post(`/api/admin/agents/${created.agent.id}/active`, { active: false }, 'POST', auth);
  const ignored = await readJson(await post(`/api/public/agent/push/${token}`, [
    { jsonrpc: '2.0', id: 1, method: 'basicReport', params: { kernel: 'fixture-kernel', mem_total: 1024, version: '0.1.0', transport: 'ws', report_interval_secs: 60, capabilities: [], name: 'paused', os: 'linux', arch: 'x64', cpu_model: 'x', cpu_cores: 1 } },
    { jsonrpc: '2.0', id: null, method: 'report', params: { observed_at: Math.floor(Date.now() / 1000), summaries: [], interfaces: null, mounts: null, cpu: { usage: 1 }, ram: { total: 10, used: 1 }, swap: { total: 0, used: 0 }, load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 10, used: 1 }, network: { up: 0, down: 0, totalUp: 0, totalDown: 0 }, connections: { tcp: 0, udp: 0 }, uptime: 1, process: 1, message: '' } },
  ]));
  eq('paused frames are acknowledged as ignored', [ignored.status, ignored.body.applied, ignored.body.accepted, ignored.body.ignored], [200, 2, 0, 2]);
  const row = await (await mf.getD1Database('DB')).prepare('SELECT COUNT(*) AS n FROM machine_live WHERE agent_id = ?').bind(created.agent.id).first();
  eq('paused agent does not write live metrics', row.n, 0);
}

// --- monitor DELETE cascade --------------------------------------------------
// 监控删除级联 / Monitor DELETE cascade

console.log('Agent monitor and machine deletion');
{
  await post(`/api/monitors/${agentMonitorId}`, null, 'DELETE', auth);
  const db = await mf.getD1Database('DB');
  check('deleting the monitor preserves machine telemetry', (await db.prepare('SELECT COUNT(*) AS n FROM machine_live WHERE agent_id=?').bind(agentMachineId).first()).n > 0);
  await post(`/api/admin/agents/${agentMachineId}`, null, 'DELETE', auth);
  eq('deleting an unused machine clears its snapshot', (await db.prepare('SELECT COUNT(*) AS n FROM machine_live WHERE agent_id=?').bind(agentMachineId).first()).n, 0);
  eq('deleting an unused machine clears its history', (await db.prepare('SELECT COUNT(*) AS n FROM machine_history WHERE agent_id=?').bind(agentMachineId).first()).n, 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);

/* WebSocket 测试以进程退出结束；此处未验证 Miniflare 的资源回收。
 * Exit ends this WebSocket fixture; Miniflare teardown is not verified here. */
process.exit(fail === 0 ? 0 : 1);
