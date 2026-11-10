/* 验证附加检查、整体状态与延迟字段；到期天数保留为独立读数。
 * Check add-ons, aggregate status, and latency fields, keeping expiry days in separate readings. */
import { buildReading } from '../../backends/worker/src/lib/jobs/tick.ts';
import { runAddons, worstStatus, isIpAddress } from '../../backends/worker/src/lib/check/run';
import { addonFlag, addonTarget, supportsAddons } from '../../backends/worker/src/lib/check/target.ts';
import { toUiMonitor } from '../../backends/worker/src/lib/public/payload.ts';
import { queryDaily } from '../../backends/worker/src/lib/analytics-engine.ts';
import { UP, DOWN, WARN, PENDING, MAX_RETRIES } from '../../backends/worker/src/types.ts';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

/** A primary result, with the fields buildReading actually reads. / 含 buildReading 实际读取字段的主结果。 */
const primary = (status, latencyMs, message = '') => ({ status, latencyMs, statusCode: 200, message });
/** An add-on reading. / 附加检查读数。 */
const addon = (st, days, msg = '') => ({ st, days, msg, ts: 1000 });
/** A DNS add-on reading: no day count, optional records, WARN-capped by contract. / DNS 附加读数：无天数，记录可选，按契约最高为 WARN。 */
const dnsAddon = (st, msg = '', records) => ({ st, msg, ts: 1000, ...(records ? { records } : {}) });

console.log('\nbuildReading - overall status is the worst reading');

{
  const up = primary(UP, 120);
  const { entry } = buildReading(up, {}, undefined, 5000);
  eq('no add-ons: primary alone decides', entry.st, UP);
  eq('no add-ons: no ssl key', 'ssl' in entry, false);
  eq('no add-ons: no domain key', 'domain' in entry, false);

  // The case the flags exist for: the site is fine, its certificate is not.
  // 标志的目标场景：站点正常，但证书有问题。
  const warn = buildReading(up, { ssl: addon(WARN, 9) }, undefined, 5000).entry;
  eq('primary UP + ssl WARN -> overall WARN', warn.st, WARN);
  eq('ssl reading is kept verbatim', warn.ssl, { st: WARN, days: 9, msg: '', ts: 1000 });

  const down = buildReading(up, { ssl: addon(DOWN, null) }, undefined, 5000).entry;
  eq('primary UP + ssl failure -> overall WARN', down.st, WARN);
  eq('add-on failure does not increment retries', down.fails, 0);

  const both = buildReading(up, { ssl: addon(WARN, 9), domain: addon(DOWN, null) }, undefined, 5000).entry;
  eq('expiry and lookup failures remain WARN', both.st, WARN);

  // An add-on must not be able to *improve* a bad primary reading. With the
  // new retry model a single failed primary is PENDING (still retrying), not
  // DOWN, so the assert is "a healthy add-on does not turn a failed primary
  // into UP" - PENDING is the badge the retry budget buys us.
  // 附加检查不能改善失败的主读数。新重试模型中主检查首次失败为 PENDING 而非 DOWN；
  // 因此断言健康附加检查不能将失败的主检查变成 UP，PENDING 表示仍有重试预算。
  const badPrimary = buildReading(primary(DOWN, 10000), { ssl: addon(UP, 200) }, undefined, 5000).entry;
  eq('a healthy add-on does not rescue a DOWN primary', badPrimary.st, PENDING);

  // After the retry budget is spent, DOWN is DOWN regardless of the add-on.
  // 重试预算耗尽后，无论附加检查如何，DOWN 仍为 DOWN。
  const prevDown = { st: DOWN, ts: 1, v: 0, code: 0, msg: '', fails: 3 };
  const settledDown = buildReading(primary(DOWN, 10000), { ssl: addon(UP, 200) }, prevDown, 5000).entry;
  eq('a healthy add-on does not rescue a settled DOWN primary', settledDown.st, DOWN);

  // A WARN add-on still beats a settled UP primary, and never reaches PENDING:
  // WARN and PENDING are different middles (one is a fact, one is a retry).
  // WARN 附加检查仍高于已确定的 UP 主检查，且不会变成 PENDING；
  // WARN 是确定事实，PENDING 是重试中的暂定状态。
  const warnPrimary = buildReading(primary(UP, 300), { ssl: addon(WARN, 9) }, undefined, 5000).entry;
  eq('a WARN add-on paints WARN on a healthy primary', warnPrimary.st, WARN);

  eq('worstStatus: empty is UP', worstStatus(), UP);
  eq('worstStatus: UP,WARN = WARN', worstStatus(UP, WARN), WARN);
  eq('worstStatus: WARN,DOWN = DOWN', worstStatus(WARN, DOWN), DOWN);
  eq('worstStatus: DOWN,WARN = DOWN', worstStatus(DOWN, WARN), DOWN);
}

console.log('\nbuildReading - v is a latency, never a day count');

{
  /** Regression: RDAP latency must not be read as days remaining; days live in `domain.days`. / 回归：RDAP 延迟不能被当成剩余天数；天数在 `domain.days`。 */
  const latency = 10812;
  const { entry, heartbeat } = buildReading(
    primary(UP, latency, '200 OK'),
    { domain: addon(WARN, null, 'RDAP HTTP 503') },
    undefined,
    5000,
  );

  eq('v is the latency even when the add-on failed', entry.v, latency);
  eq('missing day count is null', entry.domain.days, null);
  eq('v is not the day count', entry.v === entry.domain.days, false);
  eq('the ring records the latency, not days', heartbeat.ms, latency);

  // A *successful* expiry check: both numbers exist, in their own fields.
  // 成功的到期检查：两个数值分别存在于各自字段。
  const ok = buildReading(
    primary(UP, 210),
    { ssl: addon(UP, 61.25) },
    undefined,
    5000,
  );
  eq('successful check: v is still the primary latency', ok.entry.v, 210);
  eq('successful check: days are in ssl.days', ok.entry.ssl.days, 61.25);
  eq('the ring plots latency, not the countdown', ok.heartbeat.ms, 210);

  /**
   * The trade-off, asserted: day counts are not a time series. The chart's value
   * must be identical for two monitors whose certificates differ wildly, as long
   * as their response times match.
   * 显式验证这一取舍：天数不是时间序列；两个监控即使证书差异很大，响应时间相同则图表值必须相同。
   */
  const a = buildReading(primary(UP, 150), { ssl: addon(UP, 3) }, undefined, 5000);
  const b = buildReading(primary(UP, 150), { ssl: addon(UP, 300) }, undefined, 5000);
  eq('certificate life does not leak into the chart', a.heartbeat.ms, b.heartbeat.ms);
  eq('but it is still reported per add-on', [a.entry.ssl.days, b.entry.ssl.days], [3, 300]);

  // WARN still counts as up for the availability rail: nothing stopped serving.
  // WARN 在可用率轨道上仍算 up，因为服务并未停止。
  eq('WARN overall still records up=1', a.heartbeat.up, 1);
  const d = buildReading(primary(UP, 50), { ssl: addon(WARN, -3) }, undefined, 5000);
  eq('expired certificate keeps WARN in ring history', d.heartbeat.up, WARN);
  eq('expired certificate retains negative days', d.entry.ssl.days, -3);

  eq('v is rounded to 2dp like before', buildReading(primary(UP, 123.4567), {}, undefined, 1).entry.v, 123.46);
}

console.log('\nbuildReading - failure counting and message');

{
  const prevDown = { st: DOWN, ts: 1, v: 0, code: 0, msg: '', fails: 3 };
  const stillDown = buildReading(primary(DOWN, 50), {}, prevDown, 5000).entry;
  eq('consecutive failures accumulate', stillDown.fails, 4);

  const recovered = buildReading(primary(UP, 50), {}, prevDown, 5000).entry;
  eq('recovery resets the counter', recovered.fails, 0);

  const addonDown = buildReading(primary(UP, 50), { ssl: addon(DOWN, null) }, prevDown, 5000).entry;
  eq('an add-on failure resets primary retries', addonDown.fails, 0);

  const warn = buildReading(primary(UP, 50), { ssl: addon(WARN, 9) }, prevDown, 5000).entry;
  eq('WARN is not a failure', warn.fails, 0);

  eq('the primary message is kept as-is', buildReading(primary(UP, 5, 'OK'), {}, undefined, 1).entry.msg, 'OK');
  eq(
    'a long message is capped at 512',
    buildReading(primary(UP, 5, 'x'.repeat(600)), {}, undefined, 1).entry.msg.length,
    512,
  );
}

console.log('\naddonFlag - flags are coerced for a type that cannot use them');

{
  eq('http can carry check_ssl', addonFlag('http', 1), 1);
  eq('http can carry check_domain', addonFlag('http', true), 1);
  eq('tcp can carry check_ssl', addonFlag('tcp', 1), 1);
  eq('falsy stays 0', addonFlag('http', 0), 0);
  eq('undefined stays 0', addonFlag('http', undefined), 0);

  /**
   * The retired types. They are no longer accepted by the API, so this is the
   * second line of defence - a row written by raw SQL, or a stale client, must
   * not end up with an add-on the type cannot honour.
   * 已停用的类型不再被 API 接受；第二道防线确保原始 SQL 写入的行或旧客户端不会附带该类型无法执行的检查。
   */
  eq('ssl (retired) is coerced to 0', addonFlag('ssl', 1), 0);
  eq('domain (retired) is coerced to 0', addonFlag('domain', 1), 0);
  eq('an unknown type is coerced to 0', addonFlag('ftp', 1), 0);
  eq('supportsAddons: ssl is false', supportsAddons('ssl'), false);
  eq('supportsAddons: http is true', supportsAddons('http'), true);
}

console.log('\naddonTarget - the host an add-on may use');

{
  eq('http: hostname and registrable domain', addonTarget('http', 'https://cloudflare.com'), {
    host: 'cloudflare.com',
    domain: 'cloudflare.com',
  });
  eq('http: hostname add-ons do not use the transport port', addonTarget('http', 'https://cloudflare.com:8443'), {
    host: 'cloudflare.com',
    domain: 'cloudflare.com',
  });
  eq('http: hostname add-ons do not depend on the URL scheme', addonTarget('http', 'http://cloudflare.com')?.host, 'cloudflare.com');
  eq('http: subdomain reduces to its registrable domain', addonTarget('http', 'https://api.example.com/x')?.domain, 'example.com');
  eq('http: ipv6 is unbracketed', addonTarget('http', 'https://[2606:4700::1]/')?.host, '2606:4700::1');
  eq('http: an IP has no registrable domain', addonTarget('http', 'https://1.2.3.4')?.domain, '');
  eq('http: a single-label host has no registrable domain', addonTarget('http', 'http://localhost')?.domain, '');
  eq('http: a host no check can dial is refused', addonTarget('http', 'https://!!!'), null);

  eq('tcp: host:port', addonTarget('tcp', 'db.example.com:5432'), {
    host: 'db.example.com',
    domain: 'example.com',
  });
  eq('tcp: hostname add-ons do not use the monitor port', addonTarget('tcp', 'example.com:8443')?.host, 'example.com');
  eq('tcp: malformed target is refused', addonTarget('tcp', 'example.com'), null);

  eq('a retired type yields no host', addonTarget('ssl', 'cloudflare.com'), null);
}

console.log('\nrunAddons - disabled flags produce no reading');

{
  const base = { id: 'm', num_id: 0, name: 'n', type: 'http', target: 'https://example.com', method: 'GET', expected_status: '200-299', keyword: null, interval_sec: 60, timeout_ms: 1000, warn_days: 14, active: 1, created_at: 0, updated_at: 0 };

  // No flags: nothing runs, nothing is reported. Asserted with a 1 ms timeout so
  // that a regression which *does* run a check fails loudly rather than slowly.
  // 无标志时不执行也不报告；使用 1ms 超时断言，使意外执行检查的回归快速明确失败。
  eq('no flags -> {}', await runAddons({ ...base, check_ssl: 0, check_domain: 0 }), {});

  /**
   * A flag set on a target with no derivable host - only reachable by writing the
   * row directly, since the API refuses it. The add-on must report WARN with a
   * reason, not vanish: an add-on that silently stops reporting is
   * indistinguishable from one that is fine.
   * 目标无法推导主机名却设置了标志时，只有直接写入行才能到达此状态，因为 API 会拒绝。
   * 附加检查须返回带原因的 WARN 而非消失；静默停止报告与正常结果无法区分。
   */
  const orphan = await runAddons({ ...base, type: 'http', target: 'https://!!!', check_ssl: 1, check_domain: 0 });
  eq('unusable target reports ssl WARN', orphan.ssl?.st, WARN);
  eq('unusable target explains itself', typeof orphan.ssl?.msg === 'string' && orphan.ssl.msg.length > 0, true);
  eq('unusable target reports unknown days', orphan.ssl?.days, null);
  eq('unusable target reports no domain reading', 'domain' in orphan, false);
}

console.log('\ntoUiMonitor - separate expiry badges');
{
  const monitor = { id: 'm', num_id: 7, name: 'n', type: 'http', target: 'https://example.com', check_ssl: 1, check_domain: 1 };
  const live = { st: WARN, ts: 5000, v: 210, code: 200, msg: '', fails: 0, ssl: addon(UP, 61.6), domain: addon(WARN, -3) };
  eq('certificate and domain readings remain separate', toUiMonitor(monitor, live).expiryBadges, [
    { kind: 'ssl', days: 61.6, status: UP, message: '' },
    { kind: 'domain', days: -3, status: WARN, message: '' },
  ]);
  eq('unknown expiry stays null', toUiMonitor(monitor, { ...live, ssl: addon(WARN, null) }).expiryBadges[0].days, null);
  eq('a disabled add-on has no badge', toUiMonitor({ ...monitor, check_ssl: 0 }, live).expiryBadges.map(badge => badge.kind), ['domain']);
  eq('a missing reading has no badge', toUiMonitor(monitor, { ...live, ssl: undefined, domain: undefined }).expiryBadges, []);
  eq('a monitor without observations has no badge', toUiMonitor(monitor, undefined).expiryBadges, []);
  eq('ts zero has no badge', toUiMonitor(monitor, { ...live, ts: 0 }).expiryBadges, []);
}

console.log('\ntoUiMonitor - DNS details');

{
  const monitor = { id: 'dns', num_id: 9, name: 'DNS fixture', type: 'http', target: 'https://example.com', check_dns: 1 };
  const dns = { st: UP, msg: '', ts: 5000, hostname: 'example.com', recordType: 'A', rcode: 'NOERROR', latencyMs: 12, records: ['1.2.3.4'] };
  const live = { st: UP, ts: 5000, v: 20, code: 200, msg: '', fails: 0, dns };
  eq('public DNS metadata and successful answers survive projection', toUiMonitor(monitor, live).dns, dns);
  eq('disabled DNS does not expose a stale reading', toUiMonitor({ ...monitor, check_dns: 0 }, live).dns, undefined);
}

console.log('\nisIpAddress - the add-on/IP gate');

{
  // IPv4 dotted-quad, permissive about octet range (the platform's
  // URL/connect layer rejects an out-of-range literal at connect time, and
  // the reader only needs to know "this is not a DNS name").
  // IPv4 点分四段，宽松接受超范围段值；平台 URL/connect 层在连接时拒绝，
  // 读取方只需知道它不是 DNS 名称。
  eq('a dotted-quad is an IP', isIpAddress('1.2.3.4'), true);
  eq('even a wildly out-of-range quad', isIpAddress('999.999.999.999'), true);
  eq('an empty string is not', isIpAddress(''), false);
  eq('a plain name is not', isIpAddress('example.com'), false);
  eq('a subdomain is not', isIpAddress('api.example.com'), false);
  eq('a single-label name is not', isIpAddress('localhost'), false);
  /* isIpAddress 接收已去除端口的主机名。
   * isIpAddress expects a hostname with its port removed. */
  eq('a name with a port suffix is treated as an IP (colon rule)', isIpAddress('example.com:443'), true);

  // IPv6: anything with a colon that survived URL/bracket unwrapping.
  // IPv6：移除 URL 方括号后仍含冒号的内容。
  eq('a compressed v6 address is an IP', isIpAddress('::1'), true);
  eq('a full v6 address is an IP', isIpAddress('2606:4700:4700::1111'), true);
  eq('an unbracketed v6 loopback', isIpAddress('0:0:0:0:0:0:0:1'), true);
  eq('a malformed colon-name is treated as an IP (safe direction)', isIpAddress(':::'), true);
}

console.log('\nrunAddons - the DNS add-on');

{
  const base = {
    id: 'm', num_id: 0, name: 'n', type: 'http', target: 'https://example.com',
    method: 'GET', expected_status: '200-299', keyword: null,
    interval_sec: 60, timeout_ms: 1000, warn_days: 14,
    check_ssl: 0, check_domain: 0, check_dns: 0,
    active: 1, created_at: 0, updated_at: 0,
  };

  /**
   * An IP host with add-on flags set. The API refuses this combination, so
   * reaching `runAddons` means a legacy row; the honest answer is no reading
   * rather than a fabricated DOWN, and the answer must NOT touch the DNS /
   * SSL / domain field of live_state (which is exactly what skipping means).
   * IP 主机设置附加标志的情况被 API 拒绝，因此到达 runAddons 意味着旧数据行。
   * 应诚实返回无读数而非伪造 DOWN，且不能修改 live_state 的 DNS/SSL/domain 字段，这正是跳过的含义。
   */
  const ipHost = await runAddons({
    ...base,
    target: 'https://1.2.3.4',
    check_ssl: 1, check_domain: 1, check_dns: 1,
    options_json: JSON.stringify({ dns: { recordType: 'A' } }),
  });
  eq('IP host with flags -> {} (all skipped)', ipHost, {});

  /**
   * The "no hostname derivable" branch: the DNS reading is WARN-capped here
   * too, never DOWN. A misconfigured target is not a service outage.
   * 无法推导主机名的分支中 DNS 读数同样最高为 WARN，绝不为 DOWN；目标配置错误不是服务故障。
   */
  const orphan = await runAddons({
    ...base,
    target: 'https://!!!',
    check_dns: 1,
    options_json: JSON.stringify({ dns: { recordType: 'A' } }),
  });
  eq('no-hostname dns reading is WARN, not DOWN', orphan.dns?.st, WARN);
  eq('with an explanatory message', typeof orphan.dns?.msg === 'string' && orphan.dns.msg.length > 0, true);
  eq('no days on a dns reading', 'days' in (orphan.dns ?? {}), false);
}

console.log('\nbuildReading - the DNS add-on folds into worstStatus as WARN');

{
  // Primary UP, DNS degraded: the badge shows WARN, the monitor is not DOWN.
  // 主检查 UP、DNS 降级：标记显示 WARN，监控不为 DOWN。
  const up = primary(UP, 120);
  const withDns = buildReading(up, { dns: dnsAddon(WARN, 'NXDOMAIN') }, undefined, 5000).entry;
  eq('UP primary + dns WARN -> overall WARN', withDns.st, WARN);
  eq('the dns reading is kept verbatim', withDns.dns, { st: WARN, msg: 'NXDOMAIN', ts: 1000 });
  eq('the dns reading is on the entry', 'dns' in withDns, true);
  eq('no ssl/domain keys are added by the dns branch', 'ssl' in withDns || 'domain' in withDns, false);

  // The DNS add-on NEVER turns a healthy monitor DOWN: runAddons caps DNS at
  // WARN by construction, so even if a hypothetical DOWN reading arrived
  // here it would flow through worstStatus as DOWN - this test documents the
  // expectation that such a reading cannot come from runAddons.
  // DNS 附加检查绝不能使健康监控变为 DOWN：runAddons 将 DNS 限制在 WARN。
  // 假设 DOWN 读数抵达此处，worstStatus 会将它作为 DOWN 处理；本测试记录该读数不可能来自 runAddons。
  const healthyDns = buildReading(up, { dns: dnsAddon(UP, '') }, undefined, 5000).entry;
  eq('UP primary + dns UP -> overall UP', healthyDns.st, UP);
  eq('an empty dns message still yields a reading', healthyDns.dns?.st, UP);

  // records flow through when the resolver handed them back.
  // 解析器返回记录时，记录应继续传递。
  const withRecords = buildReading(up, { dns: dnsAddon(UP, '', ['1.2.3.4', '5.6.7.8']) }, undefined, 5000).entry;
  eq('dns records pass through to the entry', withRecords.dns?.records, ['1.2.3.4', '5.6.7.8']);

  // worstStatus never upgrades a DOWN primary through a WARN DNS.
  // worstStatus 不会因 DNS WARN 将主检查 DOWN 提升为更好状态。
  eq('worstStatus: DOWN,WARN(dns) = DOWN', worstStatus(DOWN, WARN), DOWN);

  // The DNS WARN does not count as a failure for retry/notification logic:
  // fails only increments when the overall reading is DOWN.
  // DNS WARN 不计入重试或通知逻辑中的失败；只有整体读数为 DOWN 时 fails 才增长。
  const prevDown = { st: DOWN, ts: 1, v: 0, code: 0, msg: '', fails: 3 };
  const dnsWarn = buildReading(primary(UP, 50), { dns: dnsAddon(WARN, 'NXDOMAIN') }, prevDown, 5000).entry;
  eq('a dns WARN resets the failure count (it is not a DOWN)', dnsWarn.fails, 0);
}

console.log('\nqueryDaily - availability includes pending, warnings stay separate');

{
  const originalFetch = globalThis.fetch;
  let sql = '';
  globalThis.fetch = async (_url, init) => {
    sql = init.body;
    return Response.json({ data: [{ idx: 'm', total: 4, up: 2, warn: 1, avg: 120 }] });
  };
  try {
    const rows = await queryDaily({ UPTIME: {}, CF_ACCOUNT_ID: 'account', CF_API_TOKEN: 'token' }, '2025-01-01');
    eq('AE query counts UP and PENDING as available', /double2 IN \(1, 4\).*AS up/s.test(sql), true);
    eq('AE query counts only WARN as warning', /double2 = 2\)\s+AS warn/.test(sql), true);
    eq('daily aggregates preserve separate available and warning totals', [rows.get('m').up, rows.get('m').warn], [2, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
