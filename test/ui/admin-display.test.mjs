/* 验证监控输入、状态与读数展示，以及图标选择和缓存版本。
 * Check monitor input, status and reading presentation, icon selection, and cache versions. */
import { validateAgentOptions, validateTarget, hostOfTarget } from '../../frontend/src/admin/monitors/validation';
import { readingLabel, toneForStatus } from '../../frontend/src/admin/monitors/presentation';
import { getMonitorStatusKey, selectSystemStatus } from '../../frontend/src/lib/monitor-status.ts';
import { filterMonitorByStatus } from '../../frontend/src/components/status-page/monitor-filters.ts';
import { STATUS_RAIL, beatStatus } from '../../frontend/src/components/status-page/status.ts';
import { ICON_PATH, ICON_VERSION, resolveSiteIconUrl } from '../../frontend/src/lib/icon-proxy.ts';
import { BRAND_ICON_PATH, BRAND_ICON_VERSION } from '../../backends/worker/src/lib/brand.ts';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

const counts = (total, down, pending, unknown) => ({ total, down, pending, unknown });
eq('WARN-only systems stay yellow', selectSystemStatus(counts(1, 0, 1, 0)), 'warning');
eq('all confirmed down is red', selectSystemStatus(counts(2, 2, 0, 0)), 'error');
eq('mixed confirmed down remains yellow', selectSystemStatus(counts(2, 1, 0, 1)), 'warning');
eq('all unknown stays grey', selectSystemStatus(counts(2, 0, 0, 2)), 'unknown');
eq('mixed UP and unknown is uncertain', selectSystemStatus(counts(2, 0, 0, 1)), 'warning');
eq('unknown does not create an outage', selectSystemStatus(counts(2, 0, 0, 1)), 'warning');
eq('empty agent alert options are valid', validateAgentOptions('{}'), true);
eq('invalid agent recovery hysteresis is rejected in the form', validateAgentOptions(JSON.stringify({ alerts: { cpu: { enabled: true, threshold: 90, duration_sec: 60, recovery_pct: 100 } } })), false);

console.log('\nvalidateTarget - http');

eq('empty is required', validateTarget('http', ''), 'required');
eq('whitespace only is required', validateTarget('http', '   '), 'required');
eq('full url is fine', validateTarget('http', 'https://example.com/health'), null);
eq('bare host is fine (scheme is assumed)', validateTarget('http', 'example.com'), null);
eq('port is allowed', validateTarget('http', 'example.com:8443'), null);
/* 空格和编码后的空格都必须作为无效主机输入拒绝。
 * Reject host input containing spaces or encoded spaces. */
eq('garbage is bad_url', validateTarget('http', 'not a valid url at all'), 'bad_url');
eq('percent-encoded host is bad_url', validateTarget('http', 'not%20a%20valid%20url'), 'bad_url');
eq('spaces inside a host are bad_url', validateTarget('http', 'exa mple.com'), 'bad_url');
eq('a bare word with no dot is still a host', validateTarget('http', 'localhost'), null);

console.log('\nvalidateTarget - tcp');

eq('empty is required', validateTarget('tcp', ''), 'required');
eq('host:port is fine', validateTarget('tcp', 'db.example.com:5432'), null);
eq('tcp:// prefix is stripped', validateTarget('tcp', 'tcp://db.example.com:5432'), null);
eq('ipv4:port is fine', validateTarget('tcp', '1.1.1.1:53'), null);
eq('bracketed ipv6 is fine', validateTarget('tcp', '[::1]:5432'), null);
eq('missing port is need_host_port', validateTarget('tcp', 'db.example.com'), 'need_host_port');
eq('port 0 is bad_port', validateTarget('tcp', 'db.example.com:0'), 'bad_port');
eq('port 70000 is bad_port', validateTarget('tcp', 'db.example.com:70000'), 'bad_port');
eq('non-numeric port is need_host_port', validateTarget('tcp', 'db.example.com:abc'), 'need_host_port');
eq('tls prefix matches its type', validateTarget('tls', 'tls://status.example.com:443'), null);
eq('udp rejects a tcp prefix', validateTarget('udp', 'tcp://status.example.com:53'), 'need_host_port');
eq('websocket URL is accepted', validateTarget('websocket', 'wss://status.example.com/socket'), null);
eq('websocket fragments are rejected', validateTarget('websocket', 'wss://status.example.com/socket#fragment'), 'bad_url');

console.log('\nhostOfTarget - the add-on host');

eq('http url yields its host', hostOfTarget('http', 'https://www.cloudflare.com/health'), 'www.cloudflare.com');
eq('http bare host yields that host', hostOfTarget('http', 'example.com'), 'example.com');
eq('http with port drops the port', hostOfTarget('http', 'example.com:8443'), 'example.com');
eq('tcp yields the host without port', hostOfTarget('tcp', 'db.example.com:5432'), 'db.example.com');
eq('tcp ipv4 yields the address', hostOfTarget('tcp', '1.1.1.1:53'), '1.1.1.1');
eq('tcp bracketed ipv6 unwraps', hostOfTarget('tcp', '[::1]:5432'), '::1');
eq('tls prefix yields its host', hostOfTarget('tls', 'tls://status.example.com:443'), 'status.example.com');
eq('udp prefix yields its host', hostOfTarget('udp', 'udp://dns.example.com:53'), 'dns.example.com');
eq('websocket URL yields its host', hostOfTarget('websocket', 'wss://status.example.com/socket'), 'status.example.com');
eq('websocket IPv6 unwraps', hostOfTarget('websocket', 'wss://[::1]:8443/socket'), '::1');

/**
 * The regression. `new URL('https://' + 'not a valid url at all')` succeeds and
 * reports the percent-encoded string as the hostname, so the form offered to
 * check a host called `not%20a%20valid%20url%20at%20all`.
 * 回归场景：new URL 将无效目标的整串百分号编码后作为主机名，导致表单提示检查该字符串。
 */
eq('garbage yields null, not a percent-encoded string', hostOfTarget('http', 'not a valid url at all'), null);
eq('unparseable yields null', hostOfTarget('http', 'http://'), null);
eq('empty yields null', hostOfTarget('http', ''), null);
eq('tcp without port yields null', hostOfTarget('tcp', 'db.example.com'), null);
eq('underscore host is rejected', hostOfTarget('tcp', 'my_db.internal:5432'), null);
eq('tcp with a space in the host yields null', hostOfTarget('tcp', 'my host:5432'), null);
eq('localhost is a host', hostOfTarget('http', 'http://localhost:3000/health'), 'localhost');

// A path is not part of the host, and must not leak into the hint.
// 路径不是主机名的一部分，不得出现在提示中。
eq('path is not part of the host', hostOfTarget('http', 'https://example.com/a/b?c=1'), 'example.com');

console.log('\nreadingLabel - the Reading column is latency, always');

eq('up shows ms', readingLabel(709, 1), '709ms');
eq('warn shows ms', readingLabel(250, 2), '250ms');
// A latency is meaningful on failure: it is how long the check waited.
// 失败时的延迟仍有意义，表示检查等待了多久。
eq('down shows the timeout duration', readingLabel(10000, 0), '10000ms');
eq('never checked shows nothing', readingLabel(0, null), null);
eq('rounds to integer ms', readingLabel(128.6, 1), '129ms');

/**
 * The regression that motivated splitting the field. `v` used to be overloaded
 * - days for the old ssl/domain types - so an RDAP timeout of ~10.8 s rendered
 * as "10812d". Now that days live on the add-on readings, a value this large can
 * only ever be a latency, and it is formatted as one.
 * 导致字段拆分的回归：v 曾兼用于旧 SSL/域名类型的天数，使约 10.8 秒的 RDAP 超时显示为 10812d。
 * 天数移至附加检查读数后，如此大的值只表示延迟，应按延迟格式显示。
 */
eq('a failed expiry check reports ms, never days', readingLabel(10812, 0), '10812ms');

console.log('\ntoneForStatus');

eq('up is up', toneForStatus(1), 'up');
eq('warn is warn', toneForStatus(2), 'warn');
eq('down is down', toneForStatus(0), 'down');
eq('pending is pending', toneForStatus(4), 'pending');
// A monitor with no reading has not failed; colouring it red would report an
// outage for every freshly created monitor.
// 尚无读数的监控并未失败；标红会将每个新建监控误报为故障。
eq('never checked is idle, not down', toneForStatus(null), 'idle');

console.log('\ngetMonitorStatusKey - warn is not pending');

eq('warn reads as warn', getMonitorStatusKey(2), 'warn');
eq('pending reads as pending', getMonitorStatusKey(4), 'pending');
eq('up reads as up', getMonitorStatusKey(1), 'up');
eq('down reads as down', getMonitorStatusKey(0), 'down');
eq('missing heartbeat is unknown', getMonitorStatusKey(undefined), 'unknown');
eq('unavailable source is unknown', getMonitorStatusKey(2, false), 'unknown');
eq('unsupported status is unknown', getMonitorStatusKey(3), 'unknown');

const monitorFixture = { id: 1, sourceAvailable: true };
const heartbeat = (status, ping = 20) => ({ status, ping, time: '2026-01-01T00:00:00Z', msg: '' });
for (const [status, expected] of [[0, 'down'], [1, 'up'], [2, 'warn'], [4, 'pending']]) {
  const data = { 1: [heartbeat(status)] };
  eq(`${expected} matches its filter`, filterMonitorByStatus(monitorFixture, expected, data), true);
  eq(`${expected} does not match other filters`, filterMonitorByStatus(monitorFixture, expected === 'warn' ? 'pending' : 'warn', data), false);
}
eq('unavailable source does not match a heartbeat filter', filterMonitorByStatus({ ...monitorFixture, sourceAvailable: false }, 'warn', { 1: [heartbeat(2)] }), false);
eq('no heartbeat does not match a heartbeat filter', filterMonitorByStatus(monitorFixture, 'up', {}), false);
eq('warning rail color', STATUS_RAIL[beatStatus(heartbeat(2))], 'bg-warning');
eq('pending rail color', STATUS_RAIL[beatStatus(heartbeat(4))], 'bg-warning');

// selectSystemStatus counts a warn as attention without calling it an outage.
// selectSystemStatus 将 warn 计为需要关注，但不视为故障。
eq('a warn keeps the page yellow', selectSystemStatus({ total: 1, down: 0, warn: 1, pending: 0, unknown: 0, abnormal: 1 }), 'warning');

console.log('\nresolveSiteIconUrl - the configured icon wins');

eq('frontend and backend use the same icon endpoint', ICON_PATH, BRAND_ICON_PATH);
eq('frontend and backend use the same icon cache version', ICON_VERSION, BRAND_ICON_VERSION);

/*
  `site.icon` is a runtime setting, and the header used to ignore it: the mark
  was always the generated one, so changing the setting changed nothing
  visible. `iconCandidates` was a field with no consumer at all.
  site.icon 是运行时设置；页头过去忽略它，始终显示生成的标志，修改设置也没有可见效果。
  iconCandidates 字段则完全没有使用方。
*/
eq('the generated mark is the fallback', resolveSiteIconUrl(undefined), `${ICON_PATH}?v=${ICON_VERSION}`);
eq('an empty configured icon falls back', resolveSiteIconUrl({ icon: '' }), `${ICON_PATH}?v=${ICON_VERSION}`);
eq('whitespace is not an icon', resolveSiteIconUrl({ icon: '   ' }), `${ICON_PATH}?v=${ICON_VERSION}`);
eq('a configured https icon is used as given', resolveSiteIconUrl({ icon: 'https://cdn.example/mark.svg' }), 'https://cdn.example/mark.svg');
eq('a configured root path is used as given', resolveSiteIconUrl({ icon: '/assets/mark.png' }), '/assets/mark.png');
eq(
  'the generated endpoint keeps its version, so a new mark is not cached away',
  resolveSiteIconUrl({ icon: '/api/public/icon' }),
  `${ICON_PATH}?v=${ICON_VERSION}`,
);
eq(
  'a stale version in the setting is replaced, not trusted',
  resolveSiteIconUrl({ icon: '/api/public/icon?v=1' }),
  `${ICON_PATH}?v=${ICON_VERSION}`,
);
eq(
  'the header form keeps the page id and the tight crop',
  resolveSiteIconUrl({ icon: '/api/public/icon' }, 'page-a', { tight: true }),
  `${ICON_PATH}?v=${ICON_VERSION}&pageId=page-a&tight=1`,
);
eq(
  'iconCandidates is consulted when icon is absent',
  resolveSiteIconUrl({ icon: null, iconCandidates: ['https://cdn.example/second.svg'] }),
  'https://cdn.example/second.svg',
);
eq(
  'a blank candidate is skipped, not rendered as an empty src',
  resolveSiteIconUrl({ icon: '', iconCandidates: ['', 'https://cdn.example/third.svg'] }),
  'https://cdn.example/third.svg',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
