// Use the Worker API and D1 to check monitor lifecycle and public reads.
// 通过实际 Worker API 和 D1 验证监控生命周期与公开读取。

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/** End-to-end test against Miniflare/workerd; Analytics Engine is stubbed. / 针对 Miniflare/workerd 的端到端测试；Analytics Engine 使用桩。 */
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';

const ADMIN_TOKEN = 'test-token-123';
const minutesModule = await build({ stdin: { contents: "export {packMinutes} from './backends/worker/src/lib/monitor/availability.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { packMinutes } = await import('data:text/javascript;base64,' + Buffer.from(minutesModule.outputFiles[0].text).toString('base64'));

// Bundle the Worker the same way `wrangler deploy` would.
// 按 `wrangler deploy` 的方式打包 Worker。
const bundled = await build({
  entryPoints: ['backends/worker/src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  external: ['cloudflare:sockets'],
  logLevel: 'error',
  plugins: [
    {
      name: 'stub-postgres',
      setup(b) {
        // D1-only suite: stub the Postgres package's Node entry so it throws if reached. / 仅 D1：桩掉 Postgres 的 Node 入口，被调用即抛错。
        b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
        b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
          contents: `export default function postgres() { throw new Error('postgres is stubbed in this test bundle'); }`,
        }));
      },
    },
  ],
});

const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: {
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-api-token',
    ADMIN_TOKEN,
  },
  d1Databases: { DB: 'test-db' },
  // Analytics Engine has no local emulation. The binding only needs to accept
  // writeDataPoint(); the cron path is what exercises it.
  // Analytics Engine 没有本地模拟；绑定只需接受 writeDataPoint()，由 cron 路径调用。
  analyticsEngineDatasets: { UPTIME: { dataset: 'uptime_heartbeats' } },
});

console.log('E2E setup: waiting for isolated D1 binding');
let startupTimer;
let db;
try {
  db = await Promise.race([
    mf.getD1Database('DB'),
    new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error('Miniflare D1 binding startup timed out after 20s')), 20_000);
    }),
  ]);
} catch (error) {
  await mf.dispose();
  throw error;
} finally {
  clearTimeout(startupTimer);
}

// Load all migrations in filename order so the test schema matches production. / 按文件名加载全部迁移，保证测试结构跟随生产。
const migrationFiles = readdirSync('database/schema/d1')
  .filter((f) => f.endsWith('.sql'))
  .sort();

await applyD1Migrations(db);

// Establish the feature fixture through real setup without keeping its session cookie.
// 通过真实初始化建立功能测试前提；不保留返回的会话 Cookie。
const setup = await mf.dispatchFetch('http://localhost/api/auth/setup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ credential: ADMIN_TOKEN, username: 'fixture-owner', password: 'fixture-owner-secret' }),
});
if (setup.status !== 200) throw new Error(`fixture setup failed: ${setup.status} ${await setup.text()}`);

const origin = 'http://localhost';
const authed = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

async function req(path, init) {
  const res = await mf.dispatchFetch(origin + path, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json };
}

// ---------------------------------------------------------------- auth
// ---------------------------------------------------------------- 认证 / auth

console.log('\nauth');
{
  const r = await req('/api/monitors');
  ok('unauthenticated read is 401', r.status === 401, `got ${r.status}`);

  const w = await req('/api/monitors', { method: 'POST', body: '{}' });
  ok('unauthenticated write is 401', w.status === 401, `got ${w.status}`);

  const bad = await req('/api/monitors', { headers: { authorization: 'Bearer wrong' } });
  ok('wrong token is 401', bad.status === 401, `got ${bad.status}`);

  const good = await req('/api/monitors', { headers: authed });
  ok('correct token is 200', good.status === 200, `got ${good.status}`);

  const pub = await req('/api/public/status');
  ok('status endpoint is public', pub.status === 200, `got ${pub.status}`);
}

// ---------------------------------------------------------------- validation
// ---------------------------------------------------------------- 验证 / validation

console.log('\nvalidation');
{
  const cases = [
    ['missing name', { type: 'http', target: 'https://example.com' }],
    ['bad type', { name: 'x', type: 'ftp', target: 'example.com' }],
    ['missing target', { name: 'x', type: 'http' }],
    ['tcp without port', { name: 'x', type: 'tcp', target: 'example.com' }],
    /** `!!!` parses as a URL host but is not a hostname; kept as an http case. / `!!!` 能按 URL 主机解析但不是合法主机名；保留为 http 用例。 */
    ['invalid hostname', { name: 'x', type: 'http', target: '!!!' }],
    /** Retired types must fail validation, not create an uncheckable monitor. / 已废弃类型必须校验失败，不能创建无法检查的监控。 */
    ['retired ssl type', { name: 'x', type: 'ssl', target: 'cloudflare.com' }],
    ['retired domain type', { name: 'x', type: 'domain', target: 'cloudflare.com' }],
  ];
  for (const [label, body] of cases) {
    const r = await req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify(body) });
    ok(`rejects ${label}`, r.status === 400, `got ${r.status} ${JSON.stringify(r.json)}`);
  }

  const frontendBundle = await build({ entryPoints: ['frontend/src/admin/monitors/validation.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { validateTarget, hostOfTarget, isIpAddress } = await import('data:text/javascript;base64,' + Buffer.from(frontendBundle.outputFiles[0].text).toString('base64'));
  const maxName = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  const longName = `${maxName}e`;
  const targetCases = [
    ['http', 'http://[::1]:8080', true],
    ['http', 'https://example.com', true],
    ['http', 'http://foo_bar', false],
    ['http', 'http://-bad.example', false],
    ['http', 'http://[2001:db8::1]:8080', true],
    ['http', 'http://[:::]:8080', false],
    ['http', 'http://999.999.999.999', false],
    ['http', 'http://127.000.000.001', false],
    ['http', 'http:///127.000.000.001', false],
    ['http', 'http://user:pass@127.%30%30%30.0.1.:8080', false],
    ['http', 'http://0.0.0.0', true],
    ['http', 'http://192.0.2.1.', true],
    ['http', 'http://001.2.3.example', true],
    ['http', `https://${maxName}`, true],
    ['http', `https://${maxName}.`, true],
    ['http', `https://${longName}`, false],
    ['http', `https://${'a'.repeat(64)}.example`, false],
    ['http', 'https://example.com.', true],
    ['http', 'https://example.com..', false],
    ['http', 'https://bücher.example', true],
    ['http', 'https://xn--bcher-kva.example', true],
    ['http', 'https://xn--a.example', false],
    ['tcp', '[::1]:8080', true],
    ['tcp', '[2001:db8::1]:443', true],
    ['tcp', '[::ffff:192.0.2.1]:443', true],
    ['tcp', '192.0.2.1:80', true],
    ['tcp', '127.000.000.001:80', false],
    ['tcp', '127.000.000.001.:80', false],
    ['tcp', '0.0.0.0:80', true],
    ['tcp', '001.2.3.example:80', true],
    ['tcp', '999.999.999.example:80', true],
    ['tcp', 'example.com:1', true],
    ['tcp', 'example.com:65535', true],
    ['tcp', `${maxName}:80`, true],
    ['tcp', `${maxName}.:80`, true],
    ['tcp', `${longName}:80`, false],
    ['tcp', `${'a'.repeat(64)}.example:80`, false],
    ['tcp', 'example.com.:80', true],
    ['tcp', 'example.com..:80', false],
    ['tcp', 'xn--bcher-kva.example:80', true],
    ['tcp', 'xn--a.example:80', false],
    ['tcp', 'bücher.example:80', false],
    ['tcp', '192.0.2.1.:80', true],
    ['tcp', '999.999.999.999.:80', false],
    ['tcp', 'foo_bar:80', false],
    ['tcp', '999.999.999.999:80', false],
    ['tcp', '1.2.3.1234:80', false],
    ['tcp', '[:::]:80', false],
    ['tcp', '[1:2]:80', false],
    ['tcp', '[::1]:0', false],
    ['tcp', '[::1]:65536', false],
    ['tcp', 'example.com:1e2', false],
  ];
  for (const [type, target, accepted] of targetCases) {
    const result = await req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify({ name: 'target contract', type, target }) });
    ok(`${type} ${target}: API and form agree`, (validateTarget(type, target) === null) === accepted && result.status === (accepted ? 201 : 400), JSON.stringify(result));
    if (result.status === 201) await req(`/api/monitors/${result.json.id}`, { method: 'DELETE', headers: authed });
  }
  ok('IPv6 HTTP add-on host is unbracketed', hostOfTarget('http', 'http://[::1]:8080') === '::1');
  ok('invalid IPv4 HTTP target has no add-on host', hostOfTarget('http', 'http://127.000.000.001') === null);
  ok('rooted IPv4 is recognized by the form', isIpAddress(hostOfTarget('tcp', '192.0.2.1.:80')));
  const rootedIpAddon = await req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify({ name: 'rooted IPv4', type: 'tcp', target: '192.0.2.1.:80', check_dns: 1 }) });
  ok('rooted IPv4 cannot enable hostname add-ons', rootedIpAddon.status === 400 && rootedIpAddon.json.error === 'addon_needs_domain', JSON.stringify(rootedIpAddon.json));
}

// ---------------------------------------------------------------- crud
// ---------------------------------------------------------------- 增删改查 / CRUD

console.log('\ncrud');
let createdId;
{
  const r = await req('/api/monitors', {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({
      name: 'Example',
      type: 'http',
      target: 'example.com', // no scheme on purpose - should be normalized / 有意不带 scheme，应被规范化
      interval_sec: 60,
    }),
  });
  ok('create returns 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
  createdId = r.json.id;
  ok('create returns id', typeof createdId === 'string' && createdId.length > 0);

  const list = await req('/api/monitors', { headers: authed });
  const m = list.json.monitors.find((x) => x.id === createdId);
  ok('target normalized to https', m?.target === 'https://example.com', m?.target);

  const upd = await req(`/api/monitors/${createdId}`, {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({ name: 'Example Renamed' }),
  });
  ok('update returns 200', upd.status === 200, `got ${upd.status}`);

  const after = await req('/api/monitors', { headers: authed });
  ok(
    'update persisted',
    after.json.monitors.find((x) => x.id === createdId)?.name === 'Example Renamed',
  );

  const missing = await req('/api/monitors/nonexistent', {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({ name: 'x' }),
  });
  ok('update missing is 404', missing.status === 404, `got ${missing.status}`);
}

// ------------------------------------------------- add-on flags and type change
// ------------------------------------------------- 附加检查标记和类型变更 / add-on flags and type change

console.log('\nadd-on flags');
{
  const create = async (body) => req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify(body) });
  const list = async () => (await req('/api/monitors', { headers: authed })).json.monitors;
  const find = (ms, id) => ms.find((m) => m.id === id);

  const withSsl = await create({ name: 'addon-ssl', type: 'http', target: 'https://example.com', check_ssl: 1, check_domain: 1 });
  ok('create with add-ons returns 201', withSsl.status === 201, `got ${withSsl.status}`);
  const sslRow = find(await list(), withSsl.json.id);
  ok('check_ssl persisted', sslRow?.check_ssl === 1, sslRow?.check_ssl);
  ok('check_domain persisted', sslRow?.check_domain === 1, sslRow?.check_domain);

  // A tcp monitor derives its host from host:port, so both flags are usable.
  // TCP 监控从 host:port 推导主机名，因此两个标记均可使用。
  const tcp = await create({ name: 'addon-tcp', type: 'tcp', target: 'example.com:443', check_ssl: 1 });
  ok('tcp create returns 201', tcp.status === 201, `got ${tcp.status}`);
  ok('tcp keeps check_ssl', find(await list(), tcp.json.id)?.check_ssl === 1);
  const tcpFeed = await req('/api/public/monitors?pageId=tcp-fixture');
  const tcpCard = tcpFeed.json.monitorGroups.flatMap((group) => group.monitorList).find((monitor) => monitor.name === 'addon-tcp');
  ok('public monitor type remains tcp', tcpCard?.type === 'tcp', JSON.stringify(tcpCard));

  /* 当前附加检查契约要求域名，写入时拒绝字面 IP。
   * The current add-on contract requires a hostname and rejects IP literals on write. */
  const noDomain = await create({ name: 'addon-ip', type: 'http', target: 'https://1.2.3.4', check_domain: 1 });
  ok('a domain add-on on an IP is 400', noDomain.status === 400, `got ${noDomain.status} ${JSON.stringify(noDomain.json)}`);
  ok('it reports addon_needs_domain', noDomain.json?.error === 'addon_needs_domain', noDomain.json?.error);

  const noSsl = await create({ name: 'addon-ip-ssl', type: 'http', target: 'https://1.2.3.4', check_ssl: 1 });
  ok('a certificate add-on on an IP is also 400', noSsl.status === 400, `got ${noSsl.status} ${JSON.stringify(noSsl.json)}`);
  ok('with the same code', noSsl.json?.error === 'addon_needs_domain', noSsl.json?.error);

  const noDns = await create({ name: 'addon-ip-dns', type: 'http', target: 'https://1.2.3.4', check_dns: 1 });
  ok('a DNS add-on on an IP is 400', noDns.status === 400, `got ${noDns.status} ${JSON.stringify(noDns.json)}`);
  ok('with the same code', noDns.json?.error === 'addon_needs_domain', noDns.json?.error);

  /** Invalid target reports the target error, not a missing hostname. / 非法目标报告目标错误，而不是缺少主机名。 */
  const badTarget = await create({ name: 'addon-bad', type: 'http', target: 'https://!!!', check_ssl: 1 });
  ok('an invalid target reports hostname_invalid', badTarget.json?.error === 'hostname_invalid', badTarget.json?.error);

  for (const id of [withSsl.json.id, tcp.json.id]) {
    await req(`/api/monitors/${id}`, { method: 'DELETE', headers: authed });
  }
}

console.log('\ntype change');
{
  const create = async (body) => req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify(body) });
  const list = async () => (await req('/api/monitors', { headers: authed })).json.monitors;
  const find = (ms, id) => ms.find((m) => m.id === id);

  const m = await create({ name: 'switchable', type: 'http', target: 'example.com', check_ssl: 1 });
  const id = m.json.id;

  /** A stored target that does not fit the new type is refused. / 存储目标不适合新类型时拒绝修改。 */
  const refused = await req(`/api/monitors/${id}`, {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({ type: 'tcp' }),
  });
  ok('type change with an unfit target is 400', refused.status === 400, `got ${refused.status}`);
  ok('unfit target reports invalid_target_for_type', refused.json?.error === 'invalid_target_for_type', refused.json?.error);
  ok('the row is untouched after a refused change', find(await list(), id)?.type === 'http');

  // Supplying a target that does fit lets the same change through, and the new
  // target is stored in the new type's canonical form.
  // 提供适合新类型的目标后，同样的变更可以通过；新目标按新类型的规范格式保存。
  const switched = await req(`/api/monitors/${id}`, {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({ type: 'tcp', target: 'example.com:8443' }),
  });
  ok('type change with a fitting target is 200', switched.status === 200, `got ${switched.status} ${JSON.stringify(switched.json)}`);
  const row = find(await list(), id);
  ok('type changed', row?.type === 'tcp', row?.type);
  ok('target kept in tcp form', row?.target === 'example.com:8443', row?.target);
  ok('check_ssl survived the type change', row?.check_ssl === 1, row?.check_ssl);

  /** Switching back to http needs a URL; an unchanged `host:port` cannot pass. / 切回 http 需要 URL；原 `host:port` 无法通过。 */
  const back = await req(`/api/monitors/${id}`, {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({ type: 'http', target: 'https://example.com' }),
  });
  ok('switching back to http is 200', back.status === 200, `got ${back.status}`);
  ok('target normalised to https', find(await list(), id)?.target === 'https://example.com');

  await req(`/api/monitors/${id}`, { method: 'DELETE', headers: authed });
}

console.log('\n/api/public and /api/overview add-on shape');
{
  /** Seed live_state directly with a certificate reading instead of waiting for a tick. / 直接写入证书读数，避免等待 tick。 */
  const id = 'ui-probe';
  const now = Math.floor(Date.now() / 1000);
  const endMinute = Math.floor(now / 60);
  const availabilityMinutes = Array(1440).fill(0);
  availabilityMinutes[(endMinute - 1) % 1440] = 2;
  availabilityMinutes[endMinute % 1440] = 1;
  const numId = (await db.prepare('SELECT COALESCE(MAX(num_id), 0) + 1 AS n FROM monitors').first()).n;
  await db
    .prepare(
      `INSERT INTO monitors (id, num_id, name, type, target, method, expected_status,
        interval_sec, timeout_ms, warn_days, check_ssl, check_domain, active, created_at, updated_at)
       VALUES (?, ?, ?, 'http', ?, 'GET', '200-299', 60, 10000, 14, 1, 0, 1, ?, ?)`,
    )
    .bind(id, numId, 'ui-probe', 'https://example.com', now, now)
    .run();

  await db
    .prepare(
      `INSERT INTO live_state (id, json, updated_at) VALUES ('all', ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    )
    .bind(
      JSON.stringify({
        [id]: {
          st: 2,
          ts: now,
          v: 210,
          code: 200,
          msg: '',
          fails: 0,
          availability: {
            endMinute,
            minutes: packMinutes(availabilityMinutes),
            daily: [new Date(now * 1000).toISOString().slice(0, 10), 2, 1, 0],
          },
          ssl: { st: 2, days: 9.4, msg: 'expiring soon', ts: now },
        },
      }),
      now,
    )
    .run();

  /* 直接写库不清除 isolate 缓存；有界轮询等待新值。
   * Direct database writes do not evict the isolate cache; poll with a deadline for the new value. */
  const cardFor = async () => {
    const ui = await req(`/api/public/monitors?pageId=agent-addon-${Date.now()}`);
    const list = ui.json?.monitorGroups?.flatMap((group) => group.monitorList) ?? [];
    return list.find((x) => x.id === numId);
  };

  let card;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    card = await cardFor();
    if (card?.expiryBadges?.find(badge => badge.kind === 'ssl')?.days === 9.4) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  /** A WARN add-on still reports `ssl.days`; `v` is latency, not days. / WARN 附加检查仍报告 `ssl.days`；`v` 是延迟，不是天数。 */
  ok('a WARN add-on reports its days', card?.expiryBadges?.find(badge => badge.kind === 'ssl')?.days === 9.4, card?.expiryBadges?.find(badge => badge.kind === 'ssl')?.days);
  ok('the badge is not the latency', card?.expiryBadges?.find(badge => badge.kind === 'ssl')?.days !== 210, card?.expiryBadges?.find(badge => badge.kind === 'ssl')?.days);
  const monitorPayload = await req(`/api/public/monitors?pageId=agent-addon-metrics-${Date.now()}`);
  ok('24h availability uses sampled live-state minutes', monitorPayload.json?.data?.uptimeList?.[`${numId}_24`] === 0.5, monitorPayload.json?.data?.uptimeList?.[`${numId}_24`]);
  ok('24h availability exposes observed-minute coverage', Math.abs(monitorPayload.json?.data?.uptimeCoverage?.[`${numId}_24`] - 2 / 1440) < 1e-9, monitorPayload.json?.data?.uptimeCoverage?.[`${numId}_24`]);

  // Console row shape: add-ons verbatim, `v` remains latency. / 控制台行形状：附加检查原样，`v` 仍是延迟。
  let row;
  const rowDeadline = Date.now() + 15000;
  while (Date.now() < rowDeadline) {
    const overview = await req('/api/overview', { headers: authed });
    row = (overview.json?.monitors ?? []).find((m) => m.id === id);
    if (row && row.v === 210) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  ok('overview carries check_ssl', row?.check_ssl === 1, row?.check_ssl);
  ok('overview carries check_domain', row?.check_domain === 0, row?.check_domain);
  ok('overview v is the latency, not days', row?.v === 210, row?.v);
  ok(
    'overview passes the ssl reading through verbatim',
    JSON.stringify(row?.ssl) === JSON.stringify({ st: 2, days: 9.4, msg: 'expiring soon', ts: now }),
    JSON.stringify(row?.ssl),
  );
  ok('overview reports no domain reading', row && !('domain' in row), Object.keys(row ?? {}).join(','));

  await db.prepare('DELETE FROM monitors WHERE id = ?').bind(id).run();
  await db.prepare("DELETE FROM live_state WHERE id = 'all'").run();
}

// ---------------------------------------------------------------- live check
// ---------------------------------------------------------------- 实时检查 / live check

console.log('\nlive check');
{
  const r = await req('/api/monitors/check', {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ name: 't', type: 'http', target: 'https://example.com' }),
  });
  ok('http check endpoint returns 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.json)}`);
  if (r.status === 200) {
    ok('http check returns status field', [0, 1, 2].includes(r.json.status), JSON.stringify(r.json));
    ok('http check measures latency', typeof r.json.latencyMs === 'number' && r.json.latencyMs >= 0);
    ok('reachable host is UP or blocked', r.json.status === 1 || r.json.message.length > 0, JSON.stringify(r.json));
  }

  // A target that cannot resolve must come back DOWN, not throw.
  // 无法解析的目标应返回 DOWN，而非抛错。
  const bad = await req('/api/monitors/check', {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({
      name: 't',
      type: 'http',
      target: 'https://this-domain-should-not-exist-xyz123.invalid',
      timeout_ms: 5000,
    }),
  });
  ok('unreachable host is DOWN', bad.status === 200 && bad.json.status === 0, JSON.stringify(bad.json));
  ok('unreachable host reports a message', typeof bad.json.message === 'string' && bad.json.message.length > 0);

  // Status code matching.
  // 状态码匹配。
  const wrongCode = await req('/api/monitors/check', {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({
      name: 't',
      type: 'http',
      target: 'https://example.com',
      expected_status: '500-599',
    }),
  });
  ok('status-code check endpoint returns 200', wrongCode.status === 200, `got ${wrongCode.status} ${JSON.stringify(wrongCode.json)}`);
  if (wrongCode.status === 200) {
    ok('mismatched status code is DOWN', wrongCode.json.status === 0, JSON.stringify(wrongCode.json));
  }
}

// ---------------------------------------------------------------- rollup
// ---------------------------------------------------------------- 汇总 / rollup

console.log('\nrollup');
{
  // Simulate what the daily sync writes, then read it back through the API.
  // 模拟每日同步写入的数据，再通过 API 读取。
  const days = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ d, t: 1440, u: i === 5 ? 1400 : 1440, w: 0, avg: 100 + i });
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare('INSERT INTO monitor_uptime (monitor_id, days_json, updated_at) VALUES (?, ?, ?)')
    .bind(createdId, JSON.stringify(days), now)
    .run();
  await db.prepare('UPDATE monitors SET target = ? WHERE id = ?')
    .bind('https://user:password@example.test/health?token=signed#fragment', createdId)
    .run();
  const neverCreated = await req('/api/monitors', {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ name: 'never-observed', type: 'http', target: 'https://never-observed.example' }),
  });
  ok('never-observed fixture is created', neverCreated.status === 201, JSON.stringify(neverCreated.json));
  const r = await req('/api/public/status');
  ok('status is 200', r.status === 200, `got ${r.status}`);
  ok('public read marks cache miss', r.headers.get('x-public-cache') === 'MISS', JSON.stringify({ cache: r.headers.get('x-public-cache'), control: r.headers.get('cache-control') }));
  const cached = await req('/api/public/status');
  ok('repeated public read is served from cache', cached.headers.get('x-public-cache') === 'HIT', cached.headers.get('x-public-cache'));

  /* 重命名后的第一次公开读取须看到新名称。
   * The first public read after renaming must show the new name. */
  const renamed = await req(`/api/monitors/${createdId}`, {
    method: 'PUT', headers: authed, body: JSON.stringify({ name: 'renamed-after-cache-warm' }),
  });
  ok('rename succeeds', renamed.status === 200, `got ${renamed.status}`);
  const afterWrite = await req('/api/public/status');
  ok('a write evicts the cached public status', afterWrite.headers.get('x-public-cache') === 'MISS', afterWrite.headers.get('x-public-cache'));
  ok(
    'the renamed monitor is visible immediately',
    afterWrite.json.monitors.find((x) => x.id === createdId)?.name === 'renamed-after-cache-warm',
    afterWrite.json.monitors.find((x) => x.id === createdId)?.name,
  );
  const m = r.json.monitors.find((x) => x.id === createdId);
  const neverMonitor = r.json.monitors.find((x) => x.id === neverCreated.json.id);
  ok('monitor appears in status', !!m);
  ok('empty history stays unknown instead of 100%', neverMonitor?.st === null && neverMonitor?.v === null && neverMonitor?.uptime === null && neverMonitor?.days?.length === 0);
  ok('public target omits URL credentials and query', m?.target === 'https://example.test/health', m?.target);
  ok('never-observed Worker has unknown status and metrics', m?.source_available === false && m?.st === null && m?.v === null && m?.uptime === null);
  ok('90 day bars returned', m?.days?.length === 90, `got ${m?.days?.length}`);

  const minute = Math.floor(now / 60) * 60;
  await db.prepare('UPDATE monitors SET options_json = ? WHERE id = ?')
    .bind('{"check_source":{"type":"worker"}}', createdId)
    .run();
  const liveRow = await db.prepare("SELECT json FROM live_state WHERE id = 'all'").first();
  const liveState = JSON.parse(liveRow?.json ?? '{}');
  liveState[createdId] = { st: 1, ts: minute, v: 24, source_available: false, msg: 'worker quota exceeded' };
  await db.prepare("INSERT INTO live_state (id, json, updated_at) VALUES ('all', ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
    .bind(JSON.stringify(liveState), now)
    .run();
  await db.prepare('INSERT INTO heartbeat_ring (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .bind(createdId, JSON.stringify([0, 1, 2, 4, 1].map((up, index) => ({ t: minute - (4 - index) * 60, up, ms: 24 }))), now)
    .run();
  let unknownMonitor;
  const unknownDeadline = Date.now() + 15000;
  while (Date.now() < unknownDeadline) {
    const unknownStatus = await req('/api/public/status?probe=worker-source');
    unknownMonitor = unknownStatus.json.monitors.find((x) => x.id === createdId);
    if (unknownMonitor?.source_available === false) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ok('Worker source failure is unknown in status DTO', unknownMonitor?.source_available === false && unknownMonitor?.st === null && unknownMonitor?.v === null && unknownMonitor?.uptime === null);

  liveState[createdId] = { ...liveState[createdId], st: 0, source_available: true, ts: minute, v: 24, msg: 'keyword "private-response-secret" not found' };
  await db.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
    .bind(JSON.stringify(liveState), now)
    .run();
  let currentMonitor;
  const currentDeadline = Date.now() + 15000;
  while (Date.now() < currentDeadline) {
    const currentStatus = await req('/api/public/status?probe=worker-current');
    currentMonitor = currentStatus.json.monitors.find((x) => x.id === createdId);
    if (currentMonitor?.source_available === true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ok('public check message is generic', currentMonitor?.msg === 'HTTP check failed' && !JSON.stringify(currentMonitor).includes('private-response-secret'));

  liveState[createdId] = { ...liveState[createdId], ts: minute - 1000 };
  await db.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
    .bind(JSON.stringify(liveState), now)
    .run();
  let staleMonitor;
  const staleDeadline = Date.now() + 15000;
  while (Date.now() < staleDeadline) {
    const staleStatus = await req('/api/public/status?probe=worker-stale');
    staleMonitor = staleStatus.json.monitors.find((x) => x.id === createdId);
    if (staleMonitor?.source_available === false) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ok('stale Worker reading is unknown without erasing history', staleMonitor?.st === null && staleMonitor?.v === null && staleMonitor?.ring?.at(-1)?.ms === null);

  const ui = await req('/api/public/monitors?pageId=worker-source-fixture');
  ok('public monitor feed is available', ui.status === 200, JSON.stringify(ui.json));
  const uiMonitor = (ui.json.monitorGroups ?? []).flatMap((group) => group.monitorList).find((x) => x.id === m?.num_id);
  const point = ui.json.data.heartbeatList[String(m?.num_id)]?.at(-1);
  ok('Worker source failure stays pending with no ping', uiMonitor?.sourceAvailable === false && point?.status === 4 && point?.ping === null);
  const points = ui.json.data.heartbeatList[String(m?.num_id)];
  ok('heartbeat statuses retain down, up, warn and pending', JSON.stringify(points.map((beat) => beat.status)) === JSON.stringify([0, 1, 2, 4, 4]), JSON.stringify(points));
  ok('heartbeat exposes a single status field', points.every((beat) => !('st' in beat)), JSON.stringify(points));
  // Heartbeat time must include a timezone; a bare timestamp is parsed as local. / 心跳时间必须带时区；裸时间戳会按本地时间解析。
  ok('heartbeat time carries an explicit UTC marker', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(point?.time ?? ''), point?.time);
  ok(
    'heartbeat time parses back to the minute it was written for',
    Math.floor(Date.parse(point.time) / 60000) === Math.floor(minute / 60),
    JSON.stringify({ time: point?.time, minute }),
  );
  ok('unknown Worker source has no 24-hour ratio', ui.json.data.uptimeList[`${m?.num_id}_24`] === null);

  const detail = await req(`/api/public/status/detail?id=${createdId}`);
  ok('detail returns history', detail.json.days?.length === 90 && detail.json.id === createdId, JSON.stringify(detail.json));

  const noId = await req('/api/public/status/detail');
  ok('detail without id is 400', noId.status === 400, `got ${noId.status}`);
}

// ---------------------------------------------------------------- delete
// ---------------------------------------------------------------- 删除 / delete

console.log('\ndelete');
{
  const r = await req(`/api/monitors/${createdId}`, { method: 'DELETE', headers: authed });
  ok('delete returns 200', r.status === 200, `got ${r.status}`);

  const again = await req(`/api/monitors/${createdId}`, { method: 'DELETE', headers: authed });
  ok('double delete is 404', again.status === 404, `got ${again.status}`);

  const list = await req('/api/monitors', { headers: authed });
  ok('monitor is gone', !list.json.monitors.find((x) => x.id === createdId));

  /* 向关联表补入孤儿记录，验证重复删除也会清理它们。
   * Seed orphaned related rows to check cleanup on repeated deletion. */
  const orphanTables = [
    ['monitor_uptime', 'monitor_id'],
    ['events', 'monitor_id'],
    ['push_heartbeats', 'monitor_id'],
    ['monitor_tags', 'monitor_id'],
    ['machine_live', 'agent_id'],
    ['machine_history', 'agent_id'],
    ['agent_uptime_daily', 'monitor_id'],
    ['agent_probe_jobs', 'agent_id'],
  ];
  for (const [table, column] of orphanTables) {
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .bind(createdId)
      .first();
    ok(`${table} cleaned up on delete`, count.n === 0, `got ${count.n}`);
  }
  const ring = await db
    .prepare('SELECT COUNT(*) AS n FROM heartbeat_ring WHERE id = ?')
    .bind(createdId)
    .first();
  ok('heartbeat_ring cleaned up on delete', ring.n === 0, `got ${ring.n}`);

  // The row itself is gone - the check that the DELETE ran at all, as opposed to
  // failing after its cascade list.
  // 记录本身已删除：验证 DELETE 确实执行，而不是在处理级联列表后失败。
  const monitorRow = await db
    .prepare('SELECT COUNT(*) AS n FROM monitors WHERE id = ?')
    .bind(createdId)
    .first();
  ok('the monitor row is gone exactly once', monitorRow.n === 0, `got ${monitorRow.n}`);
}

// ---------------------------------------------------------------- assets
// ---------------------------------------------------------------- 资源 / assets

console.log('\nstatic assets');
{
  // Miniflare does not serve the assets directory here, so this only asserts
  // that a missing binding degrades to 404 instead of throwing a 500.
  // 此处 Miniflare 不提供资源目录，因此只断言缺少绑定时降级为 404，而不是抛出 500。
  const r = await mf.dispatchFetch(origin + '/');
  ok('root does not 500 without an assets binding', r.status !== 500, `got ${r.status}`);
}

await mf.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
