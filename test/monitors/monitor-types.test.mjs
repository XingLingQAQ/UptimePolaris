import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 在 Miniflare 中验证监控配置、探测结果与 Push；外部传输使用可控替身。
 * Check monitor configuration, probe results, and Push in Miniflare with controlled external transports. */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const HARNESS = `
import { api } from './backends/worker/src/api';
import { parseOptions } from './backends/worker/src/types.ts';
import { UP, DOWN, WARN } from './backends/worker/src/types.ts';
import { checkPush } from './backends/worker/src/lib/check/push.ts';
import { checkDns } from './backends/worker/src/lib/check/dns.ts';
import { runAddons } from './backends/worker/src/lib/check/run.ts';
import { checkTcp } from './backends/worker/src/lib/check/tcp.ts';
import { checkHttp } from './backends/worker/src/lib/check/http.ts';
import { readCapped } from './backends/worker/src/lib/util';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { loadLiveFresh } from './backends/worker/src/lib/monitor/store.ts';

/** Injected fetch used by both DoH and target requests; lastInit records what was sent. / 注入的 fetch 同时服务 DoH 和目标请求；lastInit 记录发送内容。 */
let route = null;
let lastInit = null;
globalThis.fetch = async (url, init) => {
  lastInit = init;
  if (!route) throw new Error('no fake transport installed');
  return route(String(url), init);
};

/** Injected socket; socketLog records that send happens before read. / 注入的 socket；socketLog 记录发送先于读取。 */
let socketPlan = null;
let socketLog = [];
let socketWritten = '';
globalThis.__fakeConnect = () => {
  socketLog = ['connect'];
  socketWritten = '';
  const plan = socketPlan || {};
  return {
    opened: Promise.resolve(),
    close: () => Promise.resolve(),
    writable: {
      getWriter: () => ({
        write: (chunk) => {
          socketLog.push('write');
          socketWritten += new TextDecoder().decode(chunk);
          return Promise.resolve();
        },
        releaseLock: () => {},
      }),
    },
    readable: {
      getReader: () => {
        let sent = false;
        return {
          read: () => {
            socketLog.push('read');
            // A server that accepts the connection and then says nothing. Only
            // the caller's deadline can end this.
            // 模拟接受连接后保持沉默的服务器，只能由调用方截止时间结束。
            if (plan.hang) return new Promise(() => {});
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(plan.banner || ''),
            });
          },
          cancel: () => Promise.resolve(),
        };
      },
    },
  };
};

/** A monitor with every field the four checkers read. / 含四个检查器读取的全部字段的监控。 */
function mon(over) {
  return Object.assign({
    id: 'm', num_id: 1, name: 'n', type: 'tcp', target: 'host:22',
    method: 'GET', expected_status: '200-299', keyword: null,
    interval_sec: 60, timeout_ms: 2000, warn_days: 14,
    check_ssl: 0, check_domain: 0, options_json: '{}', push_token: null,
    active: 1, created_at: 0, updated_at: 0,
  }, over);
}

const json = (o) => Response.json(o);

async function pure() {
  const out = {};

  // --- parseOptions -------------------------------------------------------
  // 解析选项 / Parse options
  out.optsEmpty = parseOptions('');
  out.optsNullish = parseOptions(null);
  out.optsNullText = parseOptions('null');
  out.optsArrayText = parseOptions('[]');
  out.optsCorrupt = parseOptions('not json');
  out.optsValid = parseOptions('{"recordType":"MX","expected":"mail"}');

  // --- checkPush ----------------------------------------------------------
  // Push 检查 / Check Push
  const now = 1_000_000;
  out.pushNever = checkPush(undefined, 3600, now);
  out.pushStale = checkPush({ ts: now - 3700, status: 1, msg: 'ok', ping: 12 }, 3600, now);
  out.pushFresh = checkPush({ ts: now - 10, status: 1, msg: 'backup ok', ping: 4213 }, 3600, now);
  out.pushFreshDown = checkPush({ ts: now - 10, status: 0, msg: 'job failed', ping: 0 }, 3600, now);
  out.pushExact = checkPush({ ts: now - 3600, status: 1, msg: '', ping: 0 }, 3600, now);

  // --- checkDns -----------------------------------------------------------
  // DNS 检查 / Check DNS
  const dnsRoute = (payload) => { route = async () => json(payload); };

  dnsRoute({ Status: 3, Answer: [] });
  out.nxdomain = await checkDns('gone.example.com', { recordType: 'A' }, 1000);

  dnsRoute({ Status: 2, Answer: [] });
  out.servfail = await checkDns('broken.example.com', { recordType: 'A' }, 1000);

  // NOERROR with an empty Answer: the misconfiguration, not a success.
  // NOERROR 但 Answer 为空表示配置错误，而非成功。
  dnsRoute({ Status: 0, Answer: [] });
  out.emptyAnswer = await checkDns('norecord.example.com', { recordType: 'AAAA' }, 1000);

  dnsRoute({ Status: 0, Answer: [{ name: 'a.example.com', type: 1, TTL: 60, data: '1.2.3.4' }] });
  out.aNoExpect = await checkDns('a.example.com', { recordType: 'A' }, 1000);
  out.aMismatch = await checkDns('a.example.com', { recordType: 'A', expected: '5.6.7.8' }, 1000);
  out.aMatch = await checkDns('a.example.com', { recordType: 'A', expected: '2.3' }, 1000);
  out.dnsSuccessAddon = await runAddons({
    type: 'http', target: 'https://a.example.com', check_dns: 1,
    timeout_ms: 1000, options_json: JSON.stringify({ dns: { recordType: 'A' } }),
  });

  dnsRoute({ Status: 0, Answer: [{ data: 'first, second' }] });
  out.txtCommaMismatch = await checkDns('example.com', { recordType: 'TXT', expected: 'missing' }, 1000);

  /** DNS names compare case-insensitively; TXT values do not. / DNS 名称忽略大小写；TXT 值不忽略。 */
  dnsRoute({ Status: 0, Answer: [{ data: 'Mail.Example.COM.' }] });
  out.mxCaseFolded = await checkDns('example.com', { recordType: 'MX', expected: 'mail.example.com' }, 1000);

  dnsRoute({ Status: 0, Answer: [{ data: 'v=SPF1 -all' }] });
  out.txtCaseExact = await checkDns('example.com', { recordType: 'TXT', expected: 'v=spf1 -all' }, 1000);

  // A resolver that answers with something other than DoH JSON.
  // 解析器返回非 DoH JSON 的响应。
  route = async () => new Response('<html>captive portal</html>', { status: 200 });
  out.dnsNotJson = await checkDns('example.com', { recordType: 'A' }, 1000);

  // The resolver from options must be the one queried.
  // 必须查询选项中指定的解析器。
  let askedUrl = '';
  route = async (url) => {
    askedUrl = url;
    return json({ Status: 0, Answer: [{ data: '1.2.3.4' }] });
  };
  await checkDns('example.com', { recordType: 'A', resolver: 'https://doh.internal/query' }, 1000);
  out.dnsUrl = askedUrl;

  askedUrl = '';
  await checkDns('example.com', { recordType: 'MX' }, 1000);
  out.dnsDefaultUrl = askedUrl;

  // --- tcp banner ---------------------------------------------------------
  // TCP 横幅 / TCP banner
  socketPlan = { banner: 'SSH-2.0-OpenSSH_9.6\\r\\n' };
  out.bannerMatch = await checkTcp(mon({
    options_json: JSON.stringify({ expect: 'SSH-2.0' }),
  }));
  out.bannerLog = socketLog.slice();

  socketPlan = { banner: '220 mail.example.com ESMTP\\r\\n' };
  out.bannerMismatch = await checkTcp(mon({
    options_json: JSON.stringify({ expect: 'SSH-2.0' }),
  }));

  // send + expect: the write must precede the read, and the CRLF must be added.
  // send 加 expect：写入必须先于读取，并须附加 CRLF。
  socketPlan = { banner: '+PONG\\r\\n' };
  out.bannerSend = await checkTcp(mon({
    options_json: JSON.stringify({ send: 'PING', expect: '+PONG' }),
  }));
  out.bannerSendLog = socketLog.slice();
  out.bannerSentBytes = JSON.stringify(socketWritten);

  // An explicit terminator is not doubled.
  // 显式终止符不能重复追加。
  socketPlan = { banner: '+PONG\\r\\n' };
  await checkTcp(mon({ options_json: JSON.stringify({ send: 'PING\\r\\n' }) }));
  out.bannerSentExplicit = JSON.stringify(socketWritten);

  // Connect-only is unchanged: no write, no read.
  // 仅连接行为不变：不写入，也不读取。
  socketPlan = { banner: '' };
  out.connectOnly = await checkTcp(mon({ options_json: '{}' }));
  out.connectOnlyLog = socketLog.slice();

  // A server that accepts and then says nothing must produce a timeout.
  // 接受连接后保持沉默的服务器必须产生超时。
  socketPlan = { hang: true };
  out.bannerSilent = await checkTcp(mon({
    timeout_ms: 300,
    options_json: JSON.stringify({ expect: 'SSH-2.0' }),
  }));

  // --- http assertions ----------------------------------------------------
  // HTTP 断言 / HTTP assertions
  const target = { status: 200, body: { status: { code: 200 }, data: [{ id: 'abc' }], note: 'hello' }, headers: { 'x-served-by': 'edge-7' } };
  route = async () =>
    new Response(JSON.stringify(target.body), {
      status: target.status,
      headers: Object.assign({ 'content-type': 'application/json' }, target.headers),
    });

  out.httpJsonMatch = await checkHttp(mon({
    type: 'http', target: 'https://api.example.com/status',
    keyword: 'hello',
    options_json: JSON.stringify({ jsonPath: 'status.code', jsonExpected: '200' }),
  }));

  // The array index form, and a string comparison against a non-string value.
  // 数组索引形式，以及用字符串比较非字符串值。
  out.httpJsonIndex = await checkHttp(mon({
    type: 'http', target: 'https://api.example.com/status',
    options_json: JSON.stringify({ jsonPath: 'data[0].id', jsonExpected: 'abc' }),
  }));

  out.httpJsonMissing = await checkHttp(mon({
    type: 'http', target: 'https://api.example.com/status',
    options_json: JSON.stringify({ jsonPath: 'data[9].id', jsonExpected: 'abc' }),
  }));

  out.httpJsonWrongValue = await checkHttp(mon({
    type: 'http', target: 'https://api.example.com/status',
    options_json: JSON.stringify({ jsonPath: 'status.code', jsonExpected: '503' }),
  }));

  // A body that is not JSON at all.
  // 完全不是 JSON 的正文。
  route = async () => new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  out.httpNotJson = await checkHttp(mon({
    type: 'http', target: 'https://www.example.com/',
    options_json: JSON.stringify({ jsonPath: 'status', jsonExpected: 'ok' }),
  }));

  // Response header containment, and the missing case.
  // 响应头包含匹配与缺失场景。
  route = async () => new Response('{}', { status: 200, headers: { 'x-served-by': 'edge-7' } });
  out.httpHeaderOk = await checkHttp(mon({
    type: 'http', target: 'https://www.example.com/',
    options_json: JSON.stringify({ headerName: 'X-Served-By', headerExpected: 'edge' }),
  }));
  out.httpHeaderMissing = await checkHttp(mon({
    type: 'http', target: 'https://www.example.com/',
    options_json: JSON.stringify({ headerName: 'x-cache' }),
  }));

  /** Latency breach is WARN, never DOWN; the route is reinstalled so the measurement is deterministic. / 延迟超限记为 WARN，不判 DOWN；重新安装路由以保证测量确定。 */
  route = async () => {
    await new Promise((r) => setTimeout(r, 60));
    return new Response('{}', { status: 200 });
  };
  out.httpSlow = await checkHttp(mon({
    type: 'http', target: 'https://slow.example.com/',
    options_json: JSON.stringify({ maxLatencyMs: 5 }),
  }));
  out.httpFast = await checkHttp(mon({
    type: 'http', target: 'https://slow.example.com/',
    options_json: JSON.stringify({ maxLatencyMs: 60000 }),
  }));

  // auth and headers reach the request.
  // 认证信息和请求头到达请求。
  route = async () => new Response('{}', { status: 200 });
  await checkHttp(mon({
    type: 'http', target: 'https://api.example.com/', method: 'POST',
    options_json: JSON.stringify({
      body: '{"a":1}',
      headers: { accept: 'application/json', 'user-agent': 'custom/2' },
      auth: { type: 'basic', username: 'u', password: 'p' },
    }),
  }));
  out.httpHeaders = lastInit.headers;
  out.httpBody = String(lastInit.body);
  out.httpMethod = lastInit.method;
  out.httpBasicExpected = 'Basic ' + btoa('u:p');

  await checkHttp(mon({
    type: 'http', target: 'https://api.example.com/',
    options_json: JSON.stringify({ auth: { type: 'bearer', token: 'tok-123' } }),
  }));
  out.httpBearer = lastInit.headers.authorization;

  /** An aborted body read must report timeout semantics, not "keyword absent". / 正文读取中断必须报告超时，而不是“没有关键词”。 */
  route = async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>partial page with no keyword'));
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  out.httpAbortedRead = await checkHttp(mon({
    type: 'http', target: 'https://aborted.example.com/',
    keyword: 'wanted-marker',
  }));

  /** Same for JSON assertions: partial text is not valid JSON. / JSON 断言同理：部分文本不是合法 JSON。 */
  out.httpAbortedJson = await checkHttp(mon({
    type: 'http', target: 'https://aborted.example.com/',
    options_json: JSON.stringify({ jsonPath: 'status', jsonExpected: 'ok' }),
  }));

  // A non-abort stream fault is still classified as a read failure, not a
  // timeout and not a content mismatch.
  // 非 abort 的流故障仍归类为读取失败，而非超时或内容不匹配。
  route = async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('socket hang up'));
      },
    });
    return new Response(body, { status: 200 });
  };
  out.httpReadFault = await checkHttp(mon({
    type: 'http', target: 'https://broken.example.com/',
    keyword: 'wanted-marker',
  }));

  // The three states readCapped must distinguish, directly.
  // 直接检查 readCapped 必须区分的三种状态。
  const plain = await readCapped(new Response('complete body'), 1024);
  out.capComplete = { body: plain.body, truncated: plain.truncated, error: plain.error === null };

  const long = await readCapped(new Response('x'.repeat(5000)), 100);
  out.capTruncated = { length: long.body.length, truncated: long.truncated, error: long.error === null };

  const failing = await readCapped(new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('aborted', 'AbortError')); },
  })), 1024);
  out.capError = { body: failing.body, truncated: failing.truncated, isError: failing.error instanceof Error };

  return out;
}

/** A full tick folds a passive push heartbeat into live_state, the ring and the transition log. / 一次完整 tick 会把 Push 心跳并入实时状态、环形点和状态变化。 */
async function tick(env) {
  const out = {};
  const now = Math.floor(Date.now() / 1000); // inside workerd, so the second boundary is the runtime's / 在 workerd 内获取，因此秒边界以运行时为准
  const db = env.DB;

  /** Insert a push monitor directly: the API's token is not what is under test. / 直接插入 Push 监控；本测试不关注 API 令牌。 */
  const pushId = 'tick-push';
  await db.prepare(
    \`INSERT INTO monitors (id, num_id, name, type, target, method, expected_status,
       interval_sec, timeout_ms, warn_days, check_ssl, check_domain, options_json,
       push_token, active, created_at, updated_at)
     VALUES (?, 900, 'nightly', 'push', '', 'GET', '200-299', 60, 10000, 14, 0, 0, '{}', 'tok-tick', 1, ?, ?)\`,
  ).bind(pushId, now - 600, now - 600).run();

  // A fresh heartbeat, as the public endpoint would have written it.
  // 新鲜心跳，形态与公开端点写入的一致。
  await db.prepare(
    'INSERT INTO push_heartbeats (monitor_id, ts, status, msg, ping) VALUES (?, ?, 1, ?, ?)',
  ).bind(pushId, now - 5, 'backup ok', 4213).run();

  // The row has no live entry yet, so the due-check sees a last-run of 0 and the
  // monitor is checked on this tick.
  // 此行尚无 live 条目，因此到期检查认为上次运行时间为 0，本次 tick 会检查它。
  await runTick(env, now);
  const live = await loadLiveFresh(env);
  out.fresh = live[pushId];

  const ring = await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind(pushId).first();
  out.ring = ring ? JSON.parse(ring.json) : null;

  /** A stale heartbeat must flip to DOWN and write a transition event. / 过期心跳必须转为 DOWN 并写入状态变化事件。 */
  await db.prepare('UPDATE push_heartbeats SET ts = ? WHERE monitor_id = ?').bind(now - 3700, pushId).run();
  await runTick(env, now + 120);
  const after = await loadLiveFresh(env);
  out.stale = after[pushId];

  const events = await db.prepare('SELECT status, message FROM events WHERE monitor_id = ?')
    .bind(pushId)
    .all();
  out.events = events.results;

  await db.prepare('DELETE FROM monitors WHERE id = ?').bind(pushId).run();
  await db.prepare('DELETE FROM push_heartbeats WHERE monitor_id = ?').bind(pushId).run();
  await db.prepare('DELETE FROM heartbeat_ring WHERE id = ?').bind(pushId).run();
  await db.prepare('DELETE FROM events WHERE monitor_id = ?').bind(pushId).run();

  return out;
}

export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    if (p === '/__checks') return json(await pure());
    if (p === '/__tick') return json(await tick(env));
    // Everything else is the real API app, gate and all - which is the point of
    // the push-route assertions below.
    // 其余请求经过真实 API 与认证门禁，这是下方 Push 路由断言的重点。
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
    /** Replace `cloudflare:sockets` with a controllable shim so checkTcp runs for real. / 用可控 shim 替换 `cloudflare:sockets`，让 checkTcp 运行真实逻辑。 */
    plugins: [
      {
        name: 'stub-sockets',
        setup(b) {
          b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
          b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const connect = (opts) => globalThis.__fakeConnect(opts);',
          }));
          b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
            contents: `export default function postgres() { throw new Error('postgres is stubbed in this test bundle'); }`,
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
      // Set, so "the push route is public" is a statement about the gate rather
      // than about a deployment that happens to have no token.
      // 设置令牌，使“Push 路由公开”的断言验证门禁，而非部署恰好没有令牌。
      ADMIN_TOKEN: 'test-admin-token',
    },
    d1Databases: { DB: 'monitor-types-test' },
    analyticsEngineDatasets: { UPTIME: { dataset: 'uptime_heartbeats' } },
  });

  // Every migration in filename order, applied as it ships - so 0008's table
  // rebuild and its CHECK widening are exercised rather than assumed.
  // 按文件名顺序应用发布的所有迁移，实际验证 0008 的表重建和 CHECK 扩展，而非假定其有效。
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

const mf = await harness();
const origin = 'http://localhost';
const checks = await (await mf.dispatchFetch(`${origin}/__checks`)).json();
// --- parseOptions -----------------------------------------------------------
// 解析选项 / Parse options

console.log('\nparseOptions: {} for anything unreadable, never a throw\n');
eq("'' -> {}", checks.optsEmpty, {});
eq('null -> {}', checks.optsNullish, {});
eq("'null' -> {}", checks.optsNullText, {});
eq("'[]' -> {} (an array is not an options object)", checks.optsArrayText, {});
eq("'not json' -> {}", checks.optsCorrupt, {});
eq('valid json -> the object', checks.optsValid, { recordType: 'MX', expected: 'mail' });

// --- checkPush --------------------------------------------------------------
// Push 检查 / Check Push

console.log('\ncheckPush\n');
{
  check('never pushed is DOWN', checks.pushNever.status === 0, checks.pushNever);
  eq('and says so', checks.pushNever.message, 'no push received');

  check('older than the interval is DOWN', checks.pushStale.status === 0, checks.pushStale);
  eq('and names the age', checks.pushStale.message, 'no push received in 3700s');

  check('age exactly equal to the interval is still fresh', checks.pushExact.status === 1, checks.pushExact);

  check('a fresh push is UP', checks.pushFresh.status === 1, checks.pushFresh);
  eq('and carries the pushed message', checks.pushFresh.message, 'backup ok');
  eq('and the pushed ping as its latency', checks.pushFresh.latencyMs, 4213);

  check('a pushed 0 is DOWN', checks.pushFreshDown.status === 0, checks.pushFreshDown);
  eq('and keeps the pushed message', checks.pushFreshDown.message, 'job failed');
}

// --- dns --------------------------------------------------------------------
// DNS 检查 / DNS

console.log('\nDNS over HTTPS\n');
{
  check('NXDOMAIN is DOWN', checks.nxdomain.status === 0, checks.nxdomain);
  check('and the message names NXDOMAIN', checks.nxdomain.message.includes('NXDOMAIN'), checks.nxdomain.message);

  check('SERVFAIL is DOWN', checks.servfail.status === 0, checks.servfail);
  check('and the message names SERVFAIL', checks.servfail.message.includes('SERVFAIL'), checks.servfail.message);

  // The one that would otherwise be a silent green: NOERROR, no records.
  // 否则会静默显示绿色的情况：NOERROR 但没有记录。
  check('NOERROR with an empty Answer is DOWN', checks.emptyAnswer.status === 0, checks.emptyAnswer);
  check(
    'and explains that no record came back',
    /no AAAA record/.test(checks.emptyAnswer.message),
    checks.emptyAnswer.message,
  );

  check('any answer with no expectation is UP', checks.aNoExpect.status === 1, checks.aNoExpect);
  check('a non-matching expected value is DOWN', checks.aMismatch.status === 0, checks.aMismatch);
  check('and quotes what came back', checks.aMismatch.message.includes('1.2.3.4'), checks.aMismatch.message);
  check('a matching substring is UP', checks.aMatch.status === 1, checks.aMatch);
  eq('successful DNS answers are retained', checks.aNoExpect.records, ['1.2.3.4']);
  eq('failed expectations retain the same answers', checks.aMismatch.records, ['1.2.3.4']);
  eq('TXT answers containing commas stay intact', checks.txtCommaMismatch.records, ['first, second']);
  eq('DNS query hostname is retained', checks.aNoExpect.hostname, 'a.example.com');
  eq('DNS query type is retained', checks.aNoExpect.recordType, 'A');
  eq('the response code is structured', checks.nxdomain.rcode, 'NXDOMAIN');
  eq('successful add-ons retain their answers', checks.dnsSuccessAddon.dns.records, ['1.2.3.4']);
  eq('successful add-ons retain their response code', checks.dnsSuccessAddon.dns.rcode, 'NOERROR');
  check('successful add-ons retain query latency', Number.isFinite(checks.dnsSuccessAddon.dns.latencyMs), checks.dnsSuccessAddon.dns);

  check('MX/CNAME/NS compare case-insensitively', checks.mxCaseFolded.status === 1, checks.mxCaseFolded);
  check('A/AAAA/TXT compare exactly', checks.txtCaseExact.status === 0, checks.txtCaseExact);

  check('a non-JSON DoH body is DOWN', checks.dnsNotJson.status === 0, checks.dnsNotJson);
  check('and says the response was not JSON', checks.dnsNotJson.message.includes('not JSON'), checks.dnsNotJson.message);

  check(
    'the resolver from options is queried',
    checks.dnsUrl.startsWith('https://doh.internal/query?name=example.com&type=A'),
    checks.dnsUrl,
  );
  check(
    'and the default is Cloudflare when none is set',
    checks.dnsDefaultUrl.startsWith('https://cloudflare-dns.com/dns-query?name=example.com&type=MX'),
    checks.dnsDefaultUrl,
  );
}

// --- tcp banner -------------------------------------------------------------
// TCP 横幅 / TCP banner

console.log('\nTCP banner matching\n');
{
  check('a matching banner is UP', checks.bannerMatch.status === 1, checks.bannerMatch);
  check('a mismatch is DOWN', checks.bannerMismatch.status === 0, checks.bannerMismatch);
  check(
    'and reports the banner the server actually sent',
    checks.bannerMismatch.message.includes('220 mail.example.com ESMTP'),
    checks.bannerMismatch.message,
  );
  check(
    'naming what was expected',
    checks.bannerMismatch.message.startsWith('expect "SSH-2.0" not found in "'),
    checks.bannerMismatch.message,
  );

  eq('send is written, and written before the first read', checks.bannerSendLog, ['connect', 'write', 'read']);
  check('a matching banner after a write is UP', checks.bannerSend.status === 1, checks.bannerSend);
  eq('a bare command gains CRLF', checks.bannerSentBytes, '"PING\\r\\n"');
  eq('an explicit terminator is not doubled', checks.bannerSentExplicit, '"PING\\r\\n"');

  // No send and no expect: connect-only, exactly as before.
  // 不指定 send 和 expect：仅连接，行为与此前一致。
  check('connect-only is UP', checks.connectOnly.status === 1, checks.connectOnly);
  eq('and neither writes nor reads', checks.connectOnlyLog, ['connect']);
  eq('reporting no message', checks.connectOnly.message, '');

  check('a silent server is DOWN', checks.bannerSilent.status === 0, checks.bannerSilent);
  eq('with a timeout, not a hang', checks.bannerSilent.message, 'timeout');
}

// --- http assertions --------------------------------------------------------
// HTTP 断言 / HTTP assertions

console.log('\nHTTP advanced assertions\n');
{
  /** One response serving keyword and JSON assertions must not read the body twice. / 同一响应同时做关键词和 JSON 断言时不能重复读正文。 */
  check('keyword + jsonPath both pass on one body read', checks.httpJsonMatch.status === 1, checks.httpJsonMatch);
  check('a dot path resolves', checks.httpJsonIndex.status === 1, checks.httpJsonIndex);

  check('a path that does not resolve is DOWN', checks.httpJsonMissing.status === 0, checks.httpJsonMissing);
  check(
    'and names the path',
    checks.httpJsonMissing.message.includes('data[9].id'),
    checks.httpJsonMissing.message,
  );

  check('a mismatched value is DOWN', checks.httpJsonWrongValue.status === 0, checks.httpJsonWrongValue);
  check('a non-JSON body is DOWN', checks.httpNotJson.status === 0, checks.httpNotJson);
  check('and says so', checks.httpNotJson.message === 'body is not JSON', checks.httpNotJson.message);

  check('a response header containing the value is UP', checks.httpHeaderOk.status === 1, checks.httpHeaderOk);
  check('the header name is case-insensitive', checks.httpHeaderMissing.status === 0, checks.httpHeaderMissing);
  check(
    'a missing header says which one',
    checks.httpHeaderMissing.message.includes('x-cache'),
    checks.httpHeaderMissing.message,
  );

  // WARN, not DOWN: a slow target is degraded, and paging for it would be wrong.
  // 应为 WARN 而非 DOWN：缓慢目标属于降级，为此发故障告警不正确。
  check('exceeding maxLatencyMs is WARN, not DOWN', checks.httpSlow.status === 2, checks.httpSlow);
  check('and the message states both numbers', /^slow: \d+ms > 5ms$/.test(checks.httpSlow.message), checks.httpSlow.message);
  check('staying under maxLatencyMs is UP', checks.httpFast.status === 1, checks.httpFast);
  check('and the delay was real, so the breach above was not a rounding artefact', checks.httpSlow.latencyMs >= 50, checks.httpSlow.latencyMs);

  eq('a custom header replaces the default', checks.httpHeaders['user-agent'], 'custom/2');
  eq('option headers are sent', checks.httpHeaders.accept, 'application/json');
  eq('basic auth is base64(user:pass)', checks.httpHeaders.authorization, checks.httpBasicExpected);
  eq('the body is sent', checks.httpBody, '{"a":1}');
  eq('and the method is the one configured, not upgraded', checks.httpMethod, 'POST');
  eq('bearer auth is a bearer header', checks.httpBearer, 'Bearer tok-123');
}

// Regression: a body read failure is a timeout, not a content mismatch. / 回归：正文读取失败是超时，不是内容不匹配。

console.log('\nA failed body read is reported as a read failure\n');
{
  const aborted = checks.httpAbortedRead;
  check('an aborted body read is DOWN', aborted.status === 0, aborted);
  check('and the message says it was a timeout', /timeout/i.test(aborted.message), aborted.message);
  check(
    'and does NOT claim the keyword was missing',
    !/keyword/i.test(aborted.message) && !/not found/i.test(aborted.message),
    aborted.message,
  );

  const abortedJson = checks.httpAbortedJson;
  check('an aborted read with a jsonPath is DOWN', abortedJson.status === 0, abortedJson);
  check('and reports the timeout, not malformed JSON', /timeout/i.test(abortedJson.message), abortedJson.message);
  check(
    'and does NOT claim the body was not JSON',
    !/not JSON/i.test(abortedJson.message),
    abortedJson.message,
  );

  // A genuine stream fault keeps its own wording: only aborts become "timeout".
  // 真实流故障保留自身措辞；只有 abort 转为“超时”。
  const fault = checks.httpReadFault;
  check('a non-abort read fault is DOWN', fault.status === 0, fault);
  check('and names the read, not the content', /body read failed/.test(fault.message), fault.message);
  check('quoting the underlying error', /socket hang up/.test(fault.message), fault.message);
  check('without calling it a timeout', !/timeout/i.test(fault.message), fault.message);

  // The three states, directly on the helper.
  // 直接在辅助函数上检查三种状态。
  eq('a complete body: not truncated, no error', checks.capComplete, {
    body: 'complete body', truncated: false, error: true,
  });
  eq('a capped body: truncated, still no error', checks.capTruncated, {
    length: 100, truncated: true, error: true,
  });
  eq('a failed read: empty body, no truncation, an error', checks.capError, {
    body: '', truncated: false, isError: true,
  });
}

// --- the API ----------------------------------------------------------------
// API 接口 / API

console.log('\nmonitor API: dns and push\n');

const post = (path, body, method = 'POST', headers = {}) =>
  mf.dispatchFetch(`${origin}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const auth = { authorization: 'Bearer test-admin-token' };
const readJson = async (res) => ({ status: res.status, body: await res.json() });

{
  // push: no target required, and a token is minted.
  // Push 不要求目标，并会生成令牌。
  const created = await readJson(
    await post('/api/monitors', { name: 'nightly backup', type: 'push' }, 'POST', auth),
  );
  check('POST accepts a push monitor with no target', created.status === 201, created);
  const token = created.body.push_token;
  check('and returns a 32-hex push token', typeof token === 'string' && /^[0-9a-f]{32}$/.test(token), token);

  // The public write path, with no credentials at all.
  // 完全不带凭据的公开写入路径。
  const ping = await readJson(await mf.dispatchFetch(`${origin}/api/public/push/${token}?status=1&msg=backup+ok&ping=4213`, { method: 'POST' }));
  check('POST /api/public/push/:token needs no credentials', ping.status === 200, ping);
  eq('and answers ok', ping.body, { ok: true });

  const row = await mf.getD1Database('DB');
  const stored = await row
    .prepare('SELECT monitor_id, status, msg, ping FROM push_heartbeats')
    .first();
  check('the heartbeat was recorded', stored !== null, stored);
  eq('with the pushed status', stored?.status, 1);
  eq('the pushed message', stored?.msg, 'backup ok');
  eq('and the pushed ping', stored?.ping, 4213);

  /* 用从未上报的第二个监控证明 GET 不写入心跳。
   * Use a second monitor without reports to show that GET does not write a heartbeat. */
  const silent = await readJson(
    await post('/api/monitors', { name: 'never pinged', type: 'push' }, 'POST', auth),
  );
  const silentToken = silent.body.push_token;
  const countFor = async (id) => (await row
    .prepare('SELECT COUNT(*) AS n FROM push_heartbeats WHERE monitor_id = ?')
    .bind(id)
    .first()).n;
  eq('a fresh push monitor starts with no heartbeat', await countFor(silent.body.id), 0);

  const viaGetResponse = await mf.dispatchFetch(`${origin}/api/public/push/${silentToken}?status=0`);
  const viaGet = await readJson(viaGetResponse);
  check('GET /api/public/push/:token is refused with 405', viaGet.status === 405, viaGet);
  eq('and says which method to use', viaGet.body.error, 'method_not_allowed');
  check('with a hint naming POST', /POST/.test(viaGet.body.hint ?? ''), viaGet.body.hint);
  eq('and advertises Allow: POST', viaGetResponse.headers.get('allow'), 'POST');

  eq('GET produces no push_heartbeats row', await countFor(silent.body.id), 0);
  // The first monitor's row is untouched by a GET too: same count, same status.
  // GET 也不得改变第一个监控的行：行数和状态均不变。
  const storedAfterGet = await row
    .prepare('SELECT status FROM push_heartbeats WHERE monitor_id = ?')
    .bind(created.body.id)
    .first();
  eq('and does not overwrite an existing heartbeat', storedAfterGet.status, 1);

  // POST still writes: the one write path the route keeps.
  // POST 仍会写入，这是路由保留的唯一写入路径。
  const pingAgain = await readJson(
    await mf.dispatchFetch(`${origin}/api/public/push/${silentToken}?status=0&msg=late`, { method: 'POST' }),
  );
  eq('POST still writes after a refused GET', pingAgain.body, { ok: true });
  eq('POST produces a push_heartbeats row', await countFor(silent.body.id), 1);
  const rewritten = await row
    .prepare('SELECT status, msg FROM push_heartbeats WHERE monitor_id = ?')
    .bind(silent.body.id)
    .first();
  eq('and stores the POSTed status', rewritten.status, 0);
  eq('and the POSTed message', rewritten.msg, 'late');

  const unknown = await readJson(await mf.dispatchFetch(`${origin}/api/public/push/deadbeef`, { method: 'POST' }));
  check('an unknown token is 404', unknown.status === 404, unknown);
  eq('with a fixed error, and never the token back', unknown.body, { error: 'unknown_token' });

  /** Push route is public; notification routes are not. / Push 路由公开；通知路由不公开。 */
  const notifications = await mf.dispatchFetch(`${origin}/api/notifications`);
  check('/api/notifications without credentials is 401', notifications.status === 401, notifications.status);

  const monitors = await mf.dispatchFetch(`${origin}/api/monitors`);
  check('and so is the monitor listing', monitors.status === 401, monitors.status);

  // dns is a retired type: naming it now fails like any other unknown type.
  // dns 是已停用类型，现在与其他未知类型一样被拒绝。
  const dnsType = await readJson(
    await post('/api/monitors', { name: 'x', type: 'dns', target: 'example.com' }, 'POST', auth),
  );
  check('dns as a type is refused', dnsType.status === 400, dnsType);
  /* API 返回稳定错误码，界面负责翻译。
   * Return stable API error codes for the interface to translate. */
  eq('with the type code', dnsType.body.error, 'type_invalid');

  // The DNS add-on: a flag on an http/tcp monitor whose options carry a
  // `dns` sub-block.
  // DNS 附加检查是 HTTP/TCP 监控上的标志，其选项含 dns 子块。
  const dnsAddon = await readJson(
    await post('/api/monitors', {
      name: 'zone apex', type: 'http', target: 'https://example.com',
      check_dns: 1,
      options_json: JSON.stringify({ dns: { recordType: 'A', expected: '203.' } }),
    }, 'POST', auth),
  );
  check('POST accepts an http monitor with check_dns', dnsAddon.status === 201, dnsAddon);
  const dnsRow = await row
    .prepare('SELECT check_dns, options_json FROM monitors WHERE id = ?')
    .bind(dnsAddon.body.id)
    .first();
  eq('check_dns is stored as 1', dnsRow.check_dns, 1);
  check(
    'the dns options block is stored as a sub-object',
    dnsRow.options_json.includes('"dns":{"recordType":"A","expected":"203."}'),
    dnsRow.options_json,
  );

  // A DNS add-on against an IP literal is refused, not stored.
  // 针对 IP 字面量的 DNS 附加检查应拒绝而非存储。
  const dnsOnIp = await readJson(
    await post('/api/monitors', {
      name: 'x', type: 'http', target: 'https://1.2.3.4',
      check_dns: 1,
      options_json: JSON.stringify({ dns: { recordType: 'A' } }),
    }, 'POST', auth),
  );
  check('check_dns on an IP literal is refused', dnsOnIp.status === 400, dnsOnIp);
  eq('with the addon_needs_domain code', dnsOnIp.body.error, 'addon_needs_domain');

  // ssl on an IP is refused too: a certificate is issued to a name, not an
  // address, and there is no peer name for the handshake to verify.
  // IP 的 SSL 检查也被拒绝：证书签发给名称而非地址，握手没有可验证的对端名称。
  const sslOnIp = await readJson(
    await post('/api/monitors', {
      name: 'x', type: 'http', target: 'https://1.2.3.4', check_ssl: 1,
    }, 'POST', auth),
  );
  eq('check_ssl on an IP is also refused as addon_needs_domain', sslOnIp.body.error, 'addon_needs_domain');

  // check_dns is coerced to 0 on a type that cannot carry it, matching the
  // behaviour of the other flags.
  // 不支持 DNS 附加检查的类型将 check_dns 强制设为 0，与其他标志一致。
  const dnsOnPush = await readJson(
    await post('/api/monitors', { name: 'x', type: 'push', check_dns: 1 }, 'POST', auth),
  );
  check('a push monitor can still be created', dnsOnPush.status === 201, dnsOnPush);
  const pushDnsRow = await row
    .prepare('SELECT check_dns FROM monitors WHERE id = ?')
    .bind(dnsOnPush.body.id)
    .first();
  eq('and its check_dns flag is coerced to 0', pushDnsRow.check_dns, 0);

  // Malformed dns options blocks are refused at write time.
  // 格式错误的 dns 选项块在写入时拒绝。
  const badDnsBlock = await readJson(
    await post('/api/monitors', {
      name: 'x', type: 'http', target: 'https://example.com',
      check_dns: 1,
      options_json: JSON.stringify({ dns: 'not-an-object' }),
    }, 'POST', auth),
  );
  eq('a non-object dns block is refused', badDnsBlock.body.error, 'dns_options_invalid');

  const badRecord = await readJson(
    await post('/api/monitors', {
      name: 'x', type: 'http', target: 'https://example.com',
      check_dns: 1,
      options_json: JSON.stringify({ dns: { recordType: 'SOA' } }),
    }, 'POST', auth),
  );
  eq('an unsupported record type is refused', badRecord.body.error, 'dns_record_type_required');

  const badJson = await readJson(
    await post('/api/monitors', {
      name: 'x', type: 'http', target: 'https://example.com', options_json: '{not json',
    }, 'POST', auth),
  );
  eq('corrupt options_json is refused rather than silently dropped', badJson.body.error, 'options_json_invalid');

  // PUT keeps the push token, and every existing case still works.
  // PUT 保留 Push 令牌，所有现有场景仍然有效。
  const pushId = created.body.id;
  const put = await readJson(
    await post(`/api/monitors/${pushId}`, { name: 'nightly backup (2am)', type: 'push' }, 'PUT', auth),
  );
  check('PUT on a push monitor succeeds', put.status === 200, put);
  eq('and keeps the same token, because it is already in a crontab', put.body.push_token, token);

  // An http monitor's options survive an unrelated edit.
  // HTTP 监控的选项在无关编辑后保留。
  const optsJson = JSON.stringify({ headerName: 'x-cache', headerExpected: 'HIT' });
  const httpOpts = await readJson(
    await post('/api/monitors', { name: 'cdn', type: 'http', target: 'https://cdn.example.com', options_json: optsJson }, 'POST', auth),
  );
  check('POST accepts http options', httpOpts.status === 201, httpOpts);
  await post(`/api/monitors/${httpOpts.body.id}`, { name: 'cdn (renamed)' }, 'PUT', auth);
  const afterRename = await row
    .prepare('SELECT options_json FROM monitors WHERE id = ?').bind(httpOpts.body.id).first();
  eq('an edit that omits options_json keeps them', afterRename.options_json, optsJson);

  // The pre-existing types still validate exactly as before.
  // 原有类型的校验行为完全不变。
  const tcp = await readJson(await post('/api/monitors', { name: 't', type: 'tcp', target: 'db.example.com:5432' }, 'POST', auth));
  check('tcp still validates', tcp.status === 201, tcp);
  const noTarget = await readJson(await post('/api/monitors', { name: 'h', type: 'http' }, 'POST', auth));
  eq('http still requires a target', noTarget.body.error, 'target_required');
  const badType = await readJson(await post('/api/monitors', { name: 'h', type: 'ssl', target: 'x.com' }, 'POST', auth));
  check('a retired type is still refused', badType.status === 400, badType);

  /* 切换为 Push 时清除原目标，公开读取不能泄露遗留凭据。
   * Clear the old target when switching to Push; public reads must not expose leftover credentials. */
  const secretTarget = 'https://user:pass@health.example/health?token=SECRET123';
  const secretHttp = await readJson(
    await post('/api/monitors', { name: 'signed health', type: 'http', target: secretTarget }, 'POST', auth),
  );
  check('POST accepts an http monitor with a credentialed URL', secretHttp.status === 201, secretHttp);

  const numId = (await row
    .prepare('SELECT num_id FROM monitors WHERE id = ?')
    .bind(secretHttp.body.id).first()).num_id;
  /** Read past the public cache so the test sees the current row. / 绕过公开缓存读取当前行。 */
  const publicDetail = async () =>
    readJson(await mf.dispatchFetch(`${origin}/api/public/monitors/${numId}?nocache=${Math.random()}`));

  // The http case was always redacted; this half guards that it still is.
  // HTTP 情况一直会脱敏；此部分防止回归。
  const publicHttp = await publicDetail();
  eq('an http monitor never publishes userinfo or query', publicHttp.body.target, 'https://health.example/health');

  const toPush = await readJson(
    await post(`/api/monitors/${secretHttp.body.id}`, { type: 'push' }, 'PUT', auth),
  );
  check('PUT accepts the type change to push', toPush.status === 200, toPush);

  const afterFlip = await row
    .prepare('SELECT type, target FROM monitors WHERE id = ?')
    .bind(secretHttp.body.id).first();
  eq('the stored type changed', afterFlip.type, 'push');
  eq('and the inherited URL is cleared from the row', afterFlip.target, '');

  const publicPush = await publicDetail();
  eq('the public DTO no longer carries the old target', publicPush.body.target, '');
  const publicJson = JSON.stringify(publicPush.body);
  check('no part of the secret URL reaches the public DTO', !publicJson.includes('SECRET123'), publicJson);
  check('and not the userinfo either', !publicJson.includes('user:pass'), publicJson);
}

// --- body validation --------------------------------------------------------
// 请求正文校验 / Body validation

/* 非法请求返回 400 且不写入；有效请求作为成功对照。
 * Reject malformed requests with 400 and no writes; retain valid requests as success controls. */
console.log('\nmonitor API: malformed bodies are 400, not 500\n');
{
  const rawBody = (path, text, method = 'POST') =>
    mf.dispatchFetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...auth },
      body: text,
    });
  const rows = async (where = '1=1', ...args) =>
    (await (await mf.getD1Database('DB'))
      .prepare(`SELECT COUNT(*) AS n FROM monitors WHERE ${where}`)
      .bind(...args).first()).n;

  // 1. A number where a string belongs. This is the TypeError that became a 500.
  // 1. 字符串位置传数字；此 TypeError 曾变成 500。
  const numericName = await readJson(
    await post('/api/monitors', { name: 123, type: 'http', target: 'https://x.test' }, 'POST', auth),
  );
  check('a numeric name is a 400, not a 500', numericName.status === 400, numericName);
  // A number where a string belongs gets the same code an empty name gets, so the
  // console shows one sentence for "name is unusable" however it arrived.
  // 字符串位置传数字与空名称返回相同错误码，使控制台无论原因如何均显示“名称不可用”的提示。
  eq('and names the field the same way an empty one does', numericName.body.error, 'name_required');
  eq('and no row was created for it', await rows("name = '123'"), 0);

  // The same bug on the target and on PUT.
  // target 字段和 PUT 中的同一缺陷。
  const numericTarget = await readJson(
    await post('/api/monitors', { name: 'n', type: 'http', target: 42 }, 'POST', auth),
  );
  check('a numeric target is a 400', numericTarget.status === 400, numericTarget);
  eq('with the target code', numericTarget.body.error, 'target_required');

  // 2. Text that is not JSON at all - `c.req.json()` used to throw a 500.
  // 2. 完全不是 JSON 的文本；c.req.json() 曾抛错并产生 500。
  const notJson = await readJson(await rawBody('/api/monitors', 'not json'));
  check('a body that is not JSON is a 400', notJson.status === 400, notJson);
  eq('with the code the settings route already uses', notJson.body.error, 'invalid_request');

  const emptyBody = await readJson(await rawBody('/api/monitors', ''));
  check('an empty body is a 400 too', emptyBody.status === 400, emptyBody);

  // A JSON scalar parses fine and then has no properties: same answer, and it
  // must not reach the INSERT.
  // JSON 标量可解析但无属性；应返回相同结果，且不得进入 INSERT。
  const scalar = await readJson(await rawBody('/api/monitors', '5'));
  check('a JSON scalar body is a 400', scalar.status === 400, scalar);

  // 3. PUT cannot blank a name. `COALESCE(?, name)` keeps a NULL and writes
  //    `''`, so the row would keep its id and lose its title.
  // 3. PUT 不得清空名称。COALESCE(?, name) 对空字符串会写入空字符串，
  // 而只有 NULL 才保留原值，因此数据行可能保留 ID 却失去标题。
  const named = await readJson(
    await post('/api/monitors', { name: 'keep me', type: 'http', target: 'https://kept.example' }, 'POST', auth),
  );
  check('the fixture monitor exists', named.status === 201, named);

  const blankName = await readJson(
    await post(`/api/monitors/${named.body.id}`, { name: '' }, 'PUT', auth),
  );
  check('PUT with an empty name is a 400', blankName.status === 400, blankName);
  eq('with the create code', blankName.body.error, 'name_required');

  const numberName = await readJson(
    await post(`/api/monitors/${named.body.id}`, { name: 7 }, 'PUT', auth),
  );
  check('PUT with a numeric name is a 400', numberName.status === 400, numberName);

  const keptName = await (await mf.getD1Database('DB'))
    .prepare('SELECT name FROM monitors WHERE id = ?').bind(named.body.id).first();
  eq('and the stored name is untouched', keptName?.name, 'keep me');
  eq('and no unnamed row exists anywhere', await rows("name = ''"), 0);

  // A PUT body that is not JSON is refused before the row is even read.
  // 非 JSON 的 PUT 正文在读取数据行之前即被拒绝。
  const putNotJson = await readJson(
    await rawBody(`/api/monitors/${named.body.id}`, 'not json', 'PUT'),
  );
  check('a PUT body that is not JSON is a 400', putNotJson.status === 400, putNotJson);

  // And on the test endpoint, which shares `validate` and used to share the bug.
  // 测试端点共享 validate，也曾共享该缺陷，同样需要验证。
  const checkNotJson = await readJson(await rawBody('/api/monitors/check', 'not json'));
  check('a check body that is not JSON is a 400', checkNotJson.status === 400, checkNotJson);

  // An invalid expected_status would make every check fail permanently. / 非法 expected_status 会让所有检查永久失败。
  const badExpected = await readJson(
    await post('/api/monitors', {
      name: 'bad expected', type: 'http', target: 'https://expected.example', expected_status: 'abc',
    }, 'POST', auth),
  );
  check('an unparseable expected_status is a 400', badExpected.status === 400, badExpected);
  eq('with its own code', badExpected.body.error, 'expected_status_invalid');
  eq('and nothing was stored', await rows("name = 'bad expected'"), 0);

  // The same value as a number, which used to be stored and then throw on
  // `spec.split` inside the checker.
  // 相同值若以数字传入，过去会被存储并在检查器内的 spec.split 抛错。
  const numericExpected = await readJson(
    await post('/api/monitors', {
      name: 'numeric expected', type: 'http', target: 'https://expected.example', expected_status: 200,
    }, 'POST', auth),
  );
  check('a numeric expected_status is a 400', numericExpected.status === 400, numericExpected);

  /** Every documented form still creates a monitor with the value sent. / 每种文档化写法仍能创建监控并保存原值。 */
  const goodExpected = await readJson(
    await post('/api/monitors', {
      name: 'good expected', type: 'http', target: 'https://expected.example', expected_status: '200,301',
    }, 'POST', auth),
  );
  check('a valid list expected_status still creates a monitor', goodExpected.status === 201, goodExpected);
  const storedExpected = await (await mf.getD1Database('DB'))
    .prepare('SELECT expected_status FROM monitors WHERE id = ?').bind(goodExpected.body.id).first();
  eq('and stores it verbatim', storedExpected?.expected_status, '200,301');

  for (const spec of ['200-299', '204', '200 - 299', '200-204,301']) {
    const r = await readJson(
      await post('/api/monitors', {
        name: `spec ${spec}`, type: 'http', target: 'https://expected.example', expected_status: spec,
      }, 'POST', auth),
    );
    check(`"${spec}" is still accepted`, r.status === 201, r);
  }

  // 5. A method `fetch` will not send. Stored, it is a DOWN every tick.
  // 5. fetch 不会发送的请求方法；若存储，每次 tick 都会 DOWN。
  const badMethod = await readJson(
    await post('/api/monitors', {
      name: 'trace', type: 'http', target: 'https://method.example', method: 'TRACE',
    }, 'POST', auth),
  );
  check('a method outside the whitelist is a 400', badMethod.status === 400, badMethod);
  // Method errors return a code like the type and target errors. / 方法错误与类型、目标错误一样返回错误码。
  eq('and reports the method code', badMethod.body.error, 'method_invalid');
  eq('and nothing was stored', await rows("name = 'trace'"), 0);

  const lowerMethod = await readJson(
    await post('/api/monitors', {
      name: 'lower method', type: 'http', target: 'https://method.example', method: 'post',
    }, 'POST', auth),
  );
  check('a lowercase method is accepted', lowerMethod.status === 201, lowerMethod);
  const storedMethod = await (await mf.getD1Database('DB'))
    .prepare('SELECT method FROM monitors WHERE id = ?').bind(lowerMethod.body.id).first();
  eq('and normalised to upper case', storedMethod?.method, 'POST');

  const nounMethod = await readJson(
    await post('/api/monitors', {
      name: 'noun method', type: 'http', target: 'https://method.example', method: 7,
    }, 'POST', auth),
  );
  check('a numeric method is a 400', nounMethod.status === 400, nounMethod);

  // keyword: a string, bounded. `null` and '' both still mean "no assertion".
  // keyword 必须是有长度限制的字符串；null 和空串仍表示“不做断言”。
  const longKeyword = await readJson(
    await post('/api/monitors', {
      name: 'long keyword', type: 'http', target: 'https://kw.example', keyword: 'k'.repeat(257),
    }, 'POST', auth),
  );
  check('an over-long keyword is a 400', longKeyword.status === 400, longKeyword);
  eq('with the keyword code', longKeyword.body.error, 'keyword_invalid');

  const numericKeyword = await readJson(
    await post('/api/monitors', {
      name: 'numeric keyword', type: 'http', target: 'https://kw.example', keyword: 404,
    }, 'POST', auth),
  );
  check('a numeric keyword is a 400', numericKeyword.status === 400, numericKeyword);

  const boundedKeyword = await readJson(
    await post('/api/monitors', {
      name: 'bounded keyword', type: 'http', target: 'https://kw.example', keyword: 'k'.repeat(256),
    }, 'POST', auth),
  );
  check('a 256-character keyword is accepted', boundedKeyword.status === 201, boundedKeyword);

  // Omitting all three still takes the defaults, which is what every client does.
  // 省略三个字段仍使用默认值，符合现有客户端行为。
  const defaults = await readJson(
    await post('/api/monitors', { name: 'defaults', type: 'http', target: 'https://defaults.example' }, 'POST', auth),
  );
  check('omitting the transport fields still works', defaults.status === 201, defaults);
  const defaultRow = await (await mf.getD1Database('DB'))
    .prepare('SELECT method, expected_status, keyword FROM monitors WHERE id = ?')
    .bind(defaults.body.id).first();
  eq('and falls back to GET / 200-299 / no keyword', defaultRow, { method: 'GET', expected_status: '200-299', keyword: null });

  // A PUT that sends a bad value is refused and leaves the row alone.
  // PUT 发送错误值时拒绝，并保持原数据行不变。
  const renamedSnapshot = await (await mf.getD1Database('DB'))
    .prepare('SELECT method, expected_status FROM monitors WHERE id = ?').bind(named.body.id).first();
  const putBadMethod = await readJson(
    await post(`/api/monitors/${named.body.id}`, { method: 'TRACE' }, 'PUT', auth),
  );
  check('PUT refuses a bad method too', putBadMethod.status === 400, putBadMethod);
  const putBadExpected = await readJson(
    await post(`/api/monitors/${named.body.id}`, { expected_status: 'abc' }, 'PUT', auth),
  );
  check('PUT refuses a bad expected_status too', putBadExpected.status === 400, putBadExpected);
  const untouched = await (await mf.getD1Database('DB'))
    .prepare('SELECT method, expected_status FROM monitors WHERE id = ?').bind(named.body.id).first();
  eq('and neither write changed the row', untouched, renamedSnapshot);

  await (await mf.getD1Database('DB')).prepare('DELETE FROM monitors WHERE id = ?').bind(named.body.id).run();
}

// --- cron folds a push heartbeat in -----------------------------------------
// Cron 汇总 Push 心跳 / Cron folds in a Push heartbeat

console.log('\ncron: a passive monitor through the normal tick\n');
{
  const t = await (await mf.dispatchFetch(`${origin}/__tick`)).json();

  check('a push heartbeat becomes a live entry', Boolean(t.fresh), t.fresh);
  check('with the pushed status', t.fresh?.st === 1, t.fresh);
  check('Push has no measured latency', t.fresh?.v === null, t.fresh);
  check('and the pushed message', t.fresh?.msg === 'backup ok', t.fresh);

  check('and a ring point, so it charts like any other monitor', Array.isArray(t.ring) && t.ring.length >= 1, t.ring);
  eq('Push history has no latency sample', t.ring?.[0]?.ms, null);
  eq('counted as up', t.ring?.[0]?.up, 1);

  check('a stale push immediately becomes DOWN', t.stale?.st === 0, t.stale);
  check('naming the age', /no push received in \d+s/.test(t.stale?.msg ?? ''), t.stale?.msg);

  check('and a transition event was recorded', t.events?.length === 1, t.events);
  eq('from UP to DOWN, with the stale message', [t.events?.[0]?.status, /no push received/.test(t.events?.[0]?.message ?? '')], [0, true]);
}

await mf.dispose();

// --- migration 0008 ---------------------------------------------------------
// 迁移 0008 / Migration 0008

/* 从 0007 的数据验证 0008 重建表时保留监控。
 * Start with 0007 data and check that the 0008 table rebuild preserves monitors. */
console.log('\nmigration 0008: the table rebuild\n');
{
  const probe = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response("ok") }',
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'migration-0008-probe' },
  });
  const db = await probe.getD1Database('DB');

  const statements = (sql) =>
    sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

  /* 仅准备到 0007，避免后续迁移改变本测试的起始结构。
   * Apply only through 0007 so later migrations cannot change this test's starting schema. */
  const upTo0007 = readdirSync('database/schema/d1')
    .filter((f) => f.endsWith('.sql') && f < '0008')
    .sort();
  for (const file of upTo0007) {
    for (const s of statements(readFileSync(`database/schema/d1/${file}`, 'utf8'))) await db.exec(s);
  }

  const now = 1_750_000_000;
  const insert = (id, numId, type, target, extra) =>
    db
      .prepare(
        `INSERT INTO monitors (id, num_id, name, type, target, method, expected_status, keyword,
           interval_sec, timeout_ms, warn_days, check_ssl, check_domain, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'GET', '200-299', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, numId, id, type, target, extra.keyword ?? null, extra.interval ?? 60,
        extra.timeout ?? 10000, extra.warn ?? 14, extra.ssl ?? 0, extra.domain ?? 0,
        extra.active ?? 1, now, now)
      .run();

  // Two rows that exercise the columns 0002 and 0005 added, plus a NULL keyword,
  // which is the value a positional copy is most likely to get wrong.
  // 两行覆盖 0002 和 0005 新增的列，并包含 NULL keyword，这是按位置复制最易出错的值。
  await insert('keep-http', 7, 'http', 'https://example.com', { keyword: 'ok', ssl: 1 });
  await insert('keep-tcp', 8, 'tcp', 'db.example.com:5432', { domain: 1, active: 0, interval: 300 });

  const m8 = readFileSync('database/schema/d1/0008_monitor_types.sql', 'utf8');
  for (const s of statements(m8)) await db.exec(s);

  const rows = (await db.prepare('SELECT * FROM monitors ORDER BY id').all()).results;
  eq('every row survived the rebuild', rows.length, 2);

  const http = rows.find((r) => r.id === 'keep-http');
  const tcp = rows.find((r) => r.id === 'keep-tcp');

  // Named field by field, not row by row: a positional `SELECT *` copy that
  // shifted a column would keep both rows and corrupt their contents.
  // 逐字段而非逐行命名：按位置 SELECT * 复制若列错位，仍会保留两行却损坏其内容。
  eq('http: every column kept its value', [http.num_id, http.name, http.type, http.target, http.method, http.expected_status, http.keyword, http.interval_sec, http.timeout_ms, http.warn_days, http.check_ssl, http.check_domain, http.active, http.created_at, http.updated_at], [7, 'keep-http', 'http', 'https://example.com', 'GET', '200-299', 'ok', 60, 10000, 14, 1, 0, 1, now, now]);
  eq('tcp: every column kept its value', [tcp.num_id, tcp.type, tcp.target, tcp.check_domain, tcp.active, tcp.interval_sec], [8, 'tcp', 'db.example.com:5432', 1, 0, 300]);
  eq('the new columns get their defaults', [http.options_json, http.push_token], ['{}', null]);

  /** The old index is dropped with the table, so 0008 must recreate it. / 旧索引随表删除，0008 必须重建。 */
  const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='monitors'").all())
    .results.map((r) => r.name);
  check('the num_id unique index was recreated', indexes.includes('idx_monitors_num_id'), indexes);
  check('and the push_token index exists', indexes.includes('idx_monitors_push_token'), indexes);

  const other = await db.prepare('SELECT COUNT(*) AS n FROM monitors WHERE 1=1').all();
  check('the rebuilt table answers queries', other.results[0].n === 2, other.results);

  let storable = true;
  try {
    for (const [id, numId, type, opts] of [['new-push', 10, 'push', '{}']]) {
      await db
        .prepare(
          `INSERT INTO monitors (id, num_id, name, type, target, method, expected_status, interval_sec,
             timeout_ms, warn_days, check_ssl, check_domain, options_json, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 'GET', '200-299', 60, 10000, 14, 0, 0, ?, 1, ?, ?)`,
        )
        .bind(id, numId, id, type, opts, now, now)
        .run();
    }
  } catch (e) {
    storable = false;
    console.log(`        ${String(e.message || e)}`);
  }
  check('Push is insertable after the rebuild', storable);

  /** A second apply must fail on the duplicate column before any rebuild step. / 第二次应用必须在重建前因重复列失败。 */
  let secondApply = '';
  try {
    for (const s of statements(m8)) await db.exec(s);
  } catch (e) {
    secondApply = String(e.message || e);
  }
  check('a double apply is fatal', secondApply !== '', secondApply);
  check(
    'and dies on the duplicate column, before the rebuild',
    /duplicate column/i.test(secondApply),
    secondApply,
  );
  const survived = await db.prepare('SELECT COUNT(*) AS n FROM monitors').first();
  eq('with the data still intact', survived.n, 3);

  await probe.dispose();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
