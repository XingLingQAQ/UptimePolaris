/* 验证 UTC 维护窗口、设置校验及秒到毫秒的换算。
 * Check UTC maintenance windows, settings validation, and seconds-to-milliseconds conversion. */
import assert from 'node:assert/strict';
import { windowContains, activeWindow } from '../../backends/worker/src/lib/settings/maintenance';
import { parseWindow, SPECS, SETTING_KEYS, type MaintenanceWindow } from '../../backends/worker/src/lib/settings/store';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

const at = (iso: string) => new Date(iso);

// 2026-10-18 is a Sunday, so `getUTCDay()` is 0 - asserted rather than assumed,
// because every day-based case below depends on it.
// 2026-10-18 是周日，getUTCDay() 为 0；下方按星期的测试均依赖此事实，故显式断言。
assert.equal(at('2026-10-18T12:00:00Z').getUTCDay(), 0);

check('a window contains a time inside it', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 0, start: '02:00', end: '04:00' }, at('2026-10-18T03:00:00Z')), true);
});

check('the start is inclusive', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 0, start: '02:00', end: '04:00' }, at('2026-10-18T02:00:00Z')), true);
});

check('the end is exclusive', () => {
  // Exclusive so that touching windows (02:00-04:00, 04:00-06:00) do not both
  // claim 04:00 - which would make the note attached to a held alert ambiguous.
  // 结束时间排除在外，避免相接的 02:00–04:00 和 04:00–06:00 同时匹配 04:00，
  // 导致被抑制告警附带的说明不明确。
  assert.equal(windowContains({ kind: 'weekly', day: 0, start: '02:00', end: '04:00' }, at('2026-10-18T04:00:00Z')), false);
});

check('a window excludes a time before it', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 0, start: '02:00', end: '04:00' }, at('2026-10-18T01:59:00Z')), false);
});

check('a window excludes the same time on another day', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 0, start: '02:00', end: '04:00' }, at('2026-10-19T03:00:00Z')), false);
});

/*
  A window whose end precedes its start crosses midnight.

  The naive `start <= t < end` comparison makes such a window match *nothing at
  all* - a silently dead window, which is the worst possible outcome here because
  the operator believes planned work is covered.
  结束时间早于开始时间表示跨午夜。简单的 start <= t < end 比较会使其完全不匹配，
  窗口静默失效，而操作员仍相信计划维护受保护，这是最坏结果。
*/
check('a cross-midnight window matches late evening on its named day', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 6, start: '23:00', end: '01:00' }, at('2026-10-17T23:30:00Z')), true);
});

check('a cross-midnight window starts on its named evening', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 6, start: '23:00', end: '01:00' }, at('2026-10-17T00:30:00Z')), false);
});

check('a cross-midnight window includes the following day across the week boundary', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 6, start: '23:00', end: '01:00' }, at('2026-10-18T00:30:00Z')), true);
  assert.equal(windowContains({ kind: 'weekly', day: 6, start: '23:00', end: '01:00' }, at('2026-10-18T01:00:00Z')), false);
});

check('a cross-midnight window excludes the daytime gap', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 6, start: '23:00', end: '01:00' }, at('2026-10-17T12:00:00Z')), false);
});

check('a cross-midnight window excludes the hour after its end', () => {
  assert.equal(windowContains({ kind: 'weekly', day: 6, start: '23:00', end: '01:00' }, at('2026-10-17T02:00:00Z')), false);
});

check('activeWindow picks the matching window out of several', () => {
  const many: MaintenanceWindow[] = [
    { kind: 'weekly', day: 0, start: '02:00', end: '04:00' },
    { kind: 'weekly', day: 0, start: '10:00', end: '11:00' },
  ];
  assert.equal(activeWindow(many, at('2026-10-18T10:30:00Z'))?.start, '10:00');
});

check('activeWindow is null when nothing matches', () => {
  assert.equal(activeWindow([{ kind: 'weekly', day: 0, start: '02:00', end: '04:00' }], at('2026-10-18T12:00:00Z')), null);
});

check('activeWindow is null for an empty list', () => {
  assert.equal(activeWindow([], at('2026-10-18T12:00:00Z')), null);
});

// ------------------------------------------------------------- the registry
// 设置注册表 / Settings registry

check('a zero-length window is rejected', () => {
  // It can never match a minute boundary reliably, so storing it would produce a
  // window that looks configured and does nothing.
  // 此值无法可靠匹配分钟边界，存储后窗口会看似已配置却毫无作用。
  assert.equal(parseWindow({ kind: 'weekly', day: 0, start: '03:00', end: '03:00' }), null);
});

check('an out-of-range day is rejected', () => {
  assert.equal(parseWindow({ kind: 'weekly', day: 7, start: '01:00', end: '02:00' }), null);
  assert.equal(parseWindow({ kind: 'weekly', day: -1, start: '01:00', end: '02:00' }), null);
});

check('a malformed time is rejected', () => {
  assert.equal(parseWindow({ kind: 'weekly', day: 0, start: '25:00', end: '02:00' }), null);
  assert.equal(parseWindow({ kind: 'weekly', day: 0, start: '1:00', end: '02:00' }), null);
  assert.equal(parseWindow({ kind: 'weekly', day: 0, start: '01:60', end: '02:00' }), null);
  assert.equal(parseWindow({ kind: 'weekly', day: 0, start: 'nope', end: '02:00' }), null);
});

check('a well-formed window parses', () => {
  assert.deepEqual(parseWindow({ kind: 'weekly', day: 3, start: '09:30', end: '17:00' }), { kind: 'weekly', day: 3, start: '09:30', end: '17:00' });
});

check('one-time windows require real UTC dates and a later end', () => {
  assert.equal(parseWindow({ kind: 'once', startsAt: '2026-02-30T01:00:00Z', endsAt: '2026-03-03T01:00:00Z' }), null);
  assert.equal(parseWindow({ kind: 'once', startsAt: '2026-10-21T01:00:00', endsAt: '2026-10-21T02:00:00Z' }), null);
  assert.equal(parseWindow({ kind: 'once', startsAt: '2026-10-21T01:00:00Z', endsAt: '2026-10-21T01:00:00Z' }), null);
  assert.deepEqual(parseWindow({ kind: 'once', startsAt: '2026-10-21T01:00:00Z', endsAt: '2026-10-21T02:00:00Z' }), { kind: 'once', startsAt: '2026-10-21T01:00:00.000Z', endsAt: '2026-10-21T02:00:00.000Z' });
});

check('every key has a default that satisfies its own validator', () => {
  // A default the spec would reject is a contradiction: the registry would hand
  // out a value that `writeSetting` refuses to store, so a form showing the
  // default could not save it back unchanged.
  // 默认值若被自身规格拒绝会产生矛盾：注册表提供 writeSetting 不接受的值，
  // 显示默认值的表单无法原样保存。
  for (const key of SETTING_KEYS) {
    const spec = SPECS[key];
    assert.notEqual(
      spec.parse(spec.default),
      null,
      `${key}: default ${JSON.stringify(spec.default)} does not satisfy its own parse()`,
    );
  }
});

check('numeric bounds are enforced on both sides', () => {
  assert.equal(SPECS['monitor.defaultIntervalSec'].parse(59), null);
  assert.equal(SPECS['monitor.defaultIntervalSec'].parse(60), 60);
  assert.equal(SPECS['monitor.defaultIntervalSec'].parse(86401), null);
  assert.equal(SPECS['monitor.defaultTimeoutMs'].parse(60000), 60000);
  assert.equal(SPECS['monitor.defaultTimeoutMs'].parse(60001), null);
  assert.equal(SPECS['retention.eventDays'].parse(0), null);
  assert.equal(SPECS['retention.eventDays'].parse(90), 90);
});

check('non-integers and numeric strings are rejected', () => {
  // `Number.isInteger('60')` is false, which is what is wanted: a string in JSON
  // means the client sent the wrong type, and coercing it would hide that.
  // Number.isInteger('60') 为 false 正合预期：JSON 字符串表示客户端类型错误，强制转换会掩盖它。
  assert.equal(SPECS['monitor.defaultRetries'].parse('60'), null);
  assert.equal(SPECS['monitor.defaultRetries'].parse(1.5), null);
  assert.equal(SPECS['monitor.defaultRetries'].parse(Number.NaN), null);
});

check('booleans are not coerced from strings', () => {
  // `'false'` is truthy in JavaScript, so accepting it here would silently
  // enable remote agent commands - the one setting whose default is off for
  // safety.
  // JavaScript 中 'false' 为真值；若接受它会静默启用远程 Agent 命令，而该设置出于安全默认关闭。
  assert.equal(SPECS['security.allowAgentCommands'].parse('false'), null);
  assert.equal(SPECS['security.allowAgentCommands'].parse('true'), null);
  assert.equal(SPECS['security.allowAgentCommands'].parse(1), null);
  assert.equal(SPECS['security.allowAgentCommands'].parse(false), false);
  assert.equal(SPECS['security.allowAgentCommands'].parse(true), true);
});

check('remote agent commands default to off', () => {
  assert.equal(SPECS['security.allowAgentCommands'].default, false);
});

check('an empty site title is rejected', () => {
  assert.equal(SPECS['site.title'].parse(''), null);
  assert.equal(SPECS['site.title'].parse('   '), null);
  assert.equal(SPECS['site.title'].parse('ok'), 'ok');
});

check('the site icon accepts a relative path or an http(s) URL only', () => {
  assert.equal(SPECS['site.icon'].parse('/api/public/icon'), '/api/public/icon');
  assert.equal(SPECS['site.icon'].parse('https://example.com/i.png'), 'https://example.com/i.png');
  // A javascript: URL here would be rendered into an <img src>, and a data: URL
  // is a way to smuggle arbitrary content through a field labelled "icon".
  // javascript: URL 会被渲染进 img src；data: URL 则可借标为“图标”的字段夹带任意内容。
  assert.equal(SPECS['site.icon'].parse('javascript:alert(1)'), null);
  assert.equal(SPECS['site.icon'].parse('data:image/svg+xml,<svg/>'), null);
  assert.equal(SPECS['site.icon'].parse('ftp://example.com/i.png'), null);
});

check('the window list rejects a bad member rather than skipping it', () => {
  // Silently dropping a malformed window would leave the operator believing a
  // period is covered when it is not.
  // 静默丢弃格式错误的窗口会让操作员误以为维护期受到保护。
  assert.equal(SPECS['alerts.maintenanceWindows'].parse([{ kind: 'weekly', day: 0, start: '01:00', end: '02:00' }, { kind: 'weekly', day: 9, start: 'x', end: 'y' }]), null);
  assert.deepEqual(
    SPECS['alerts.maintenanceWindows'].parse([{ kind: 'weekly', day: 0, start: '01:00', end: '02:00' }]),
    [{ kind: 'weekly', day: 0, start: '01:00', end: '02:00' }],
  );
});

check('the tabular default for events is not zero', () => {
  // A zero default would make the prune delete every event on the first sync of
  // an unconfigured deployment.
  // 默认值为零会使未配置的部署在首次同步时清理掉所有事件。
  assert.ok(Number(SPECS['retention.eventDays'].default) >= 1);
});

console.log(`\n${passed} settings and maintenance checks passed`);
